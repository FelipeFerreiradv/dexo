import prisma from "@/app/lib/prisma";
import { SystemLogService } from "@/app/services/system-log.service";

/**
 * Motivos de quarentena. String (não enum do Prisma) para que um motivo novo
 * não exija migração — o vocabulário fica documentado aqui e no schema.
 */
export type OrderIngestionIssueReason =
  /** Nenhum item do pedido casou com produto: o Order nem chegou a ser criado. */
  | "NO_LINKED_ITEMS"
  /** O Order foi criado, mas parte dos itens ficou de fora (sem baixa). */
  | "PARTIAL_LINK"
  /** O SKU veio preenchido e não bate com nenhum produto do tenant. */
  | "PRODUCT_NOT_FOUND"
  /** O item não tem SKU no marketplace e não há listing vinculado. */
  | "ITEM_WITHOUT_SKU"
  /** O Order existe e a baixa falhou — o reconciliador re-tenta só a baixa. */
  | "STOCK_DEDUCTION_FAILED"
  /** Não foi possível buscar o pedido na API do marketplace. */
  | "FETCH_FAILED"
  /** Status que a importação não conhece. */
  | "UNKNOWN_STATUS"
  /** Qualquer exceção inesperada durante a ingestão. */
  | "INGEST_FAILED";

export interface OpenIssueInput {
  marketplaceAccountId: string;
  platform: "MERCADO_LIVRE" | "SHOPEE" | "MAGALU";
  externalOrderId: string;
  reason: OrderIngestionIssueReason;
  detail?: string | null;
  payload?: unknown;
  /** Preenchido quando o pedido existe mas está parcial ou sem baixa. */
  orderId?: string | null;
}

/**
 * Backoff da re-tentativa, em segundos. Sobe rápido e para de subir em 1 h:
 * um problema que precisa de ação humana (vincular o anúncio a um produto) não
 * ganha nada sendo re-tentado de minuto em minuto, mas também não pode parar de
 * ser tentado — quando o cliente vincular o produto, o pedido entra sozinho.
 */
const BACKOFF_SECONDS = [60, 300, 900, 1800, 3600];

/**
 * Quarentena de pedidos que não puderam ser totalmente ingeridos.
 *
 * A regra que este serviço existe para sustentar: NENHUM caminho de código pode
 * descartar um pedido em silêncio. Antes, um pedido cujos itens não casassem
 * morria num `continue` mudo — sem Order, sem SystemLog, sem aparecer em
 * /pedidos, e com o SyncLog do ciclo gravado como SUCCESS.
 *
 * Todo método é best-effort: falhar ao registrar a quarentena NUNCA pode
 * derrubar a importação, porque isso trocaria um pedido incompleto por nenhum
 * pedido.
 */
export class OrderIngestionIssueService {
  static nextRetryFrom(attempts: number): Date {
    const idx = Math.min(attempts, BACKOFF_SECONDS.length - 1);
    return new Date(Date.now() + BACKOFF_SECONDS[idx] * 1000);
  }

  /**
   * Poda o detalhe cru do pedido para o que a reingestão precisa.
   *
   * Nunca guarda token nem dado do comprador. `buyer_username` foi
   * deliberadamente REMOVIDO: a reingestão re-busca o pedido na API, então o
   * payload nunca é lido para isso — guardá-lo seria PII persistida sem
   * finalidade, e sem prazo para sair.
   */
  static prunePayload(detail: any): any {
    if (!detail || typeof detail !== "object") return null;
    return {
      order_sn: detail.order_sn ?? null,
      order_status: detail.order_status ?? null,
      create_time: detail.create_time ?? null,
      update_time: detail.update_time ?? null,
      total_amount: detail.total_amount ?? null,
      item_list: Array.isArray(detail.item_list)
        ? detail.item_list.map((i: any) => ({
            item_id: i?.item_id ?? null,
            model_id: i?.model_id ?? null,
            item_sku: i?.item_sku ?? null,
            model_sku: i?.model_sku ?? null,
            model_quantity_purchased: i?.model_quantity_purchased ?? null,
            model_original_price: i?.model_original_price ?? null,
          }))
        : [],
    };
  }

  /**
   * Abre ou atualiza a quarentena do pedido. Reentrega e re-poll ATUALIZAM o
   * mesmo registro (unique por conta + externalOrderId), nunca duplicam.
   *
   * Não mexe em `attempts`/`nextRetryAt`: quem os move é o reconciliador. Um
   * pedido que reaparece no poll não deve reiniciar o backoff.
   */
  static async open(input: OpenIssueInput): Promise<void> {
    if (process.env.ORDER_INGESTION_ISSUES_DISABLED === "1") return;

    const payload = input.payload
      ? this.prunePayload(input.payload)
      : undefined;

    try {
      await (prisma as any).orderIngestionIssue.upsert({
        where: {
          marketplaceAccountId_externalOrderId: {
            marketplaceAccountId: input.marketplaceAccountId,
            externalOrderId: input.externalOrderId,
          },
        },
        create: {
          marketplaceAccountId: input.marketplaceAccountId,
          platform: input.platform,
          externalOrderId: input.externalOrderId,
          reason: input.reason,
          detail: input.detail ?? null,
          payload: payload ?? undefined,
          status: "OPEN",
          resolvedOrderId: input.orderId ?? null,
        },
        update: {
          reason: input.reason,
          detail: input.detail ?? null,
          ...(payload ? { payload } : {}),
          status: "OPEN",
          ...(input.orderId ? { resolvedOrderId: input.orderId } : {}),
        },
      });
    } catch (err) {
      console.error(
        `[OrderIngestionIssue] Falha ao registrar quarentena de ${input.platform} #${input.externalOrderId}:`,
        err instanceof Error ? err.message : err,
      );
    }

    // Log estruturado para grep no PM2, além do registro em banco.
    console.log(
      JSON.stringify({
        event: "order_import.quarantined",
        platform: input.platform,
        accountId: input.marketplaceAccountId,
        externalOrderId: input.externalOrderId,
        reason: input.reason,
        detail: input.detail ?? null,
      }),
    );

    // Sem `userId`: log interno. A tela /logs do cliente filtra por
    // `userId IN (...)` e NULL nunca casa — quem vê a pendência do lado do
    // cliente é a aba de Pendências em /pedidos, com texto em português.
    void SystemLogService.logWarning(
      "ORDER_INGESTION_ISSUE",
      `Pedido ${input.platform} #${input.externalOrderId} nao pode ser totalmente ingerido (${input.reason}).`,
      {
        resource: "Order",
        resourceId: input.externalOrderId,
        details: {
          platform: input.platform,
          marketplaceAccountId: input.marketplaceAccountId,
          reason: input.reason,
          detail: input.detail ?? null,
        },
      },
    ).catch(() => {});
  }

  /** Fecha a quarentena quando o pedido finalmente entrou por completo. */
  static async resolve(
    marketplaceAccountId: string,
    externalOrderId: string,
    orderId: string | null,
  ): Promise<void> {
    if (process.env.ORDER_INGESTION_ISSUES_DISABLED === "1") return;

    try {
      const r = await (prisma as any).orderIngestionIssue.updateMany({
        where: {
          marketplaceAccountId,
          externalOrderId,
          status: "OPEN",
        },
        data: { status: "RESOLVED", resolvedOrderId: orderId, attempts: 0 },
      });

      if (r?.count > 0) {
        void SystemLogService.logInfo(
          "ORDER_INGESTION_ISSUE_RESOLVED",
          `Pendencia de importacao do pedido #${externalOrderId} resolvida.`,
          {
            resource: "Order",
            resourceId: externalOrderId,
            details: { marketplaceAccountId, orderId },
          },
        ).catch(() => {});
      }
    } catch (err) {
      console.error(
        `[OrderIngestionIssue] Falha ao resolver quarentena de #${externalOrderId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}
