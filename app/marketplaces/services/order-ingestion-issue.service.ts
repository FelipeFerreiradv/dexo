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

/**
 * Estados de uma pendencia.
 *
 * - `OPEN`: o reconciliador re-tenta automaticamente, com backoff.
 * - `NEEDS_ACTION`: esgotou as tentativas e SO se resolve com acao do cliente
 *   (cadastrar o produto que falta). Para de ser re-tentado, mas CONTINUA
 *   visivel na tela — o invariante proibe estado terminal silencioso, nao
 *   proibe parar de gastar chamada de API com um problema que a maquina nao
 *   resolve. O botao "Tentar novamente" segue funcionando.
 * - `RESOLVED`: o pedido entrou completo e com baixa.
 */
export const STATUS_PENDENTES = ["OPEN", "NEEDS_ACTION"] as const;

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

    // Estado ANTES do upsert, para decidir se este registro é NOVIDADE.
    //
    // Por que existe (medido em produção 30/07/2026): `open()` gravava um
    // SystemLog e uma linha de log a CADA chamada. Um pedido sem vínculo nunca
    // vira Order completo, então reaparece em toda passada do poll (15 min) e em
    // toda volta do reconciliador (10 min). Com 166 pendências abertas isso deu
    // 2.376 SystemLog em 2 horas — cerca de 28 mil por dia, crescendo sem fim,
    // pelo MESMO problema já registrado. O caminho da Magalu já tinha guarda
    // contra isso; este não tinha.
    //
    // Agora só registra quando muda alguma coisa: pendência nova, motivo
    // diferente, ou pendência que estava RESOLVED e reabriu. A linha no banco
    // continua sendo atualizada sempre — o que deixa de repetir é o AVISO.
    let anterior: { reason: string; status: string } | null = null;
    try {
      anterior = await (prisma as any).orderIngestionIssue.findUnique({
        where: {
          marketplaceAccountId_externalOrderId: {
            marketplaceAccountId: input.marketplaceAccountId,
            externalOrderId: input.externalOrderId,
          },
        },
        select: { reason: true, status: true },
      });
    } catch {
      // Não saber o estado anterior só faz o aviso sair uma vez a mais.
      anterior = null;
    }
    const novidade =
      !anterior ||
      anterior.reason !== input.reason ||
      (anterior.status !== "OPEN" && anterior.status !== "NEEDS_ACTION");

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
          // NAO rebaixa NEEDS_ACTION para OPEN. Um pedido sem vinculo reaparece
          // em toda passada do poll; sem esta guarda, a pendencia que ja foi
          // classificada como "so o cliente resolve" voltaria para a fila
          // automatica a cada 15 min e o teto de tentativas nunca valeria.
          ...(anterior?.status === "NEEDS_ACTION" ? {} : { status: "OPEN" }),
          ...(input.orderId ? { resolvedOrderId: input.orderId } : {}),
        },
      });
    } catch (err) {
      console.error(
        `[OrderIngestionIssue] Falha ao registrar quarentena de ${input.platform} #${input.externalOrderId}:`,
        err instanceof Error ? err.message : err,
      );
    }

    // Só quando algo mudou: ver a nota sobre as 2.376 linhas em 2 horas.
    if (!novidade) return;

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
          // NEEDS_ACTION tambem fecha: o cliente cadastrou o produto que
          // faltava e o pedido entrou. Sem isto, a pendencia que saiu da fila
          // automatica nunca sairia da tela.
          status: { in: [...STATUS_PENDENTES] },
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
