import prisma from "@/app/lib/prisma";
import { SystemLogService } from "@/app/services/system-log.service";
import type { OrderReturnPendencyReason } from "./order-outcome.service";

/**
 * Estados de uma pendência de devolução.
 *
 * - `OPEN`: aparece na tela e o reconciliador reconsulta o marketplace com
 *   backoff (para ver se o desfecho mudou). Nunca decide sozinho que a peça
 *   voltou — a reposição de estoque é sempre de gente.
 * - `NEEDS_ACTION`: o marketplace parou de dar informação nova. Sai da fila
 *   automática, CONTINUA na tela.
 * - `RESOLVED`: alguém decidiu (ou o marketplace manteve a venda).
 *
 * Mesma regra do `OrderIngestionIssue`: nada vira estado terminal SILENCIOSO.
 * Uma pendência esquecida é peça boa parada fora do estoque — ela tem que
 * continuar sendo contada até que alguém decida.
 */
export const RETURN_STATUS_PENDENTES = ["OPEN", "NEEDS_ACTION"] as const;

/** Desfecho registrado no fechamento da pendência. */
export type OrderReturnOutcome =
  /** A peça voltou ao pátio: estoque `+1` com reason própria. */
  | "RECEBIDA"
  /** A peça não volta (comprador ficou, marketplace bancou, extraviou). */
  | "NAO_RECEBIDA"
  /** O marketplace desfez a devolução e manteve a venda. */
  | "VENDA_MANTIDA";

export interface OpenReturnPendencyInput {
  marketplaceAccountId: string;
  platform: "MERCADO_LIVRE" | "SHOPEE" | "MAGALU";
  externalOrderId: string;
  reason: OrderReturnPendencyReason;
  detail?: string | null;
  /** Evidência já podada pelo classificador. Nunca token, nunca PII. */
  evidencia?: Record<string, unknown> | null;
}

/**
 * Backoff da reconsulta ao marketplace, em segundos. Sobe rápido e para de
 * subir em 6 h: o desfecho de uma devolução muda em dias, não em minutos —
 * bater de hora em hora seria gastar chamada de API à toa. Mais lento que o
 * `OrderIngestionIssue` (teto de 1 h) exatamente por isso.
 */
const BACKOFF_SECONDS = [900, 3600, 10800, 21600];

/**
 * Pendência de DEVOLUÇÃO: o marketplace encerrou o pedido, mas a peça não está
 * no pátio.
 *
 * A regra que este serviço sustenta: DEPOIS QUE A PEÇA SAI DO PÁTIO, NENHUMA
 * ROTINA REPÕE ESTOQUE. O estorno automático que existia tratava devolução
 * como cancelamento e recriava estoque inexistente — 51 dos 68 cancelamentos
 * de um tenant real (01/09/2026) eram desse tipo, com 20 peças à venda naquele
 * instante que a loja não tinha.
 *
 * Todo método é best-effort: falhar ao registrar a pendência NUNCA pode
 * derrubar o cancelamento. O pedido já foi marcado CANCELLED e o estoque já
 * ficou (corretamente) sem voltar — perder o registro é ruim, desfazer o
 * cancelamento seria pior.
 */
export class OrderReturnPendencyService {
  static nextRetryFrom(attempts: number): Date {
    const idx = Math.min(attempts, BACKOFF_SECONDS.length - 1);
    return new Date(Date.now() + BACKOFF_SECONDS[idx] * 1000);
  }

  /**
   * Abre ou atualiza a pendência do pedido. Reentrega e re-poll ATUALIZAM o
   * mesmo registro (unique por conta + externalOrderId), nunca duplicam.
   *
   * Não mexe em `attempts`/`nextRetryAt`: quem os move é o reconciliador — um
   * webhook repetido não pode reiniciar o backoff.
   *
   * NÃO reabre pendência já RESOLVED. Se o operador já decidiu ("a peça não
   * voltou"), um webhook repetido do mesmo cancelamento não pode ressuscitar a
   * pergunta: seria pedir a mesma decisão para sempre.
   */
  static async open(input: OpenReturnPendencyInput): Promise<void> {
    if (process.env.ORDER_RETURN_HOLD_DISABLED === "1") return;

    let anterior: { reason: string; status: string } | null = null;
    let leituraFalhou = false;
    try {
      anterior = await (prisma as any).orderReturnPendency.findUnique({
        where: {
          marketplaceAccountId_externalOrderId: {
            marketplaceAccountId: input.marketplaceAccountId,
            externalOrderId: input.externalOrderId,
          },
        },
        select: { reason: true, status: true },
      });
    } catch {
      // Não saber o estado anterior não pode virar tempestade de log. Sob
      // falha SUSTENTADA do banco (e não uma falha isolada), `anterior = null`
      // faria toda reentrega parecer novidade: com o poll da Shopee a 15 min,
      // isso são 96 avisos por pedido por dia enquanto o banco estiver ruim.
      // É a mesma classe do incidente das 2.376 linhas em 2 horas, por outra
      // porta. O upsert abaixo continua acontecendo — o que é suprimido é só
      // o AVISO, que nesse cenário não informaria nada de novo.
      anterior = null;
      leituraFalhou = true;
    }

    // Já decidida ⇒ não pergunta de novo. Ver o doc acima.
    if (anterior?.status === "RESOLVED") return;

    const novidade = !leituraFalhou && (!anterior || anterior.reason !== input.reason);

    try {
      await (prisma as any).orderReturnPendency.upsert({
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
          payload: input.evidencia ?? undefined,
          status: "OPEN",
        },
        update: {
          reason: input.reason,
          detail: input.detail ?? null,
          ...(input.evidencia ? { payload: input.evidencia } : {}),
          // NÃO rebaixa NEEDS_ACTION para OPEN — mesma guarda do irmão: a
          // pendência que já saiu da fila automática não pode voltar para ela
          // a cada reentrega de webhook.
          ...(anterior?.status === "NEEDS_ACTION" ? {} : { status: "OPEN" }),
        },
      });
    } catch (err) {
      console.error(
        `[OrderReturnPendency] Falha ao registrar devolução de ${input.platform} #${input.externalOrderId}:`,
        err instanceof Error ? err.message : err,
      );
    }

    if (!novidade) return;

    // Log estruturado para grep no PM2, além do registro em banco.
    console.log(
      JSON.stringify({
        event: "order_cancel.return_hold",
        platform: input.platform,
        accountId: input.marketplaceAccountId,
        externalOrderId: input.externalOrderId,
        reason: input.reason,
      }),
    );

    // Sem `userId`: log interno, como o irmão. Quem vê isto do lado do cliente
    // é a aba de Devoluções em /pedidos, com texto em português.
    void SystemLogService.logWarning(
      "ORDER_RETURN_HOLD",
      `Pedido ${input.platform} #${input.externalOrderId}: estorno de estoque retido — a peça não está no pátio (${input.reason}).`,
      {
        resource: "Order",
        resourceId: input.externalOrderId,
        details: {
          platform: input.platform,
          marketplaceAccountId: input.marketplaceAccountId,
          reason: input.reason,
          detail: input.detail ?? null,
          evidencia: input.evidencia ?? null,
        },
      },
    ).catch(() => {});
  }

  /**
   * Fecha a pendência com um desfecho.
   *
   * NÃO mexe em estoque — quem mexe é `OrderUseCase.resolveReturnPendency`,
   * que precisa de transação, lock e `StockLog`. Este método é só o registro,
   * e é `updateMany` com filtro de status para ser idempotente: dois cliques
   * no mesmo botão fecham uma vez só (`count === 0` no segundo).
   *
   * Devolve `true` só quando ESTA chamada foi a que fechou.
   */
  static async resolve(
    marketplaceAccountId: string,
    externalOrderId: string,
    outcome: OrderReturnOutcome,
    resolvedByUserId: string | null,
  ): Promise<boolean> {
    try {
      const r = await (prisma as any).orderReturnPendency.updateMany({
        where: {
          marketplaceAccountId,
          externalOrderId,
          status: { in: [...RETURN_STATUS_PENDENTES] },
        },
        data: {
          status: "RESOLVED",
          outcome,
          resolvedByUserId,
          resolvedAt: new Date(),
        },
      });
      return (r?.count ?? 0) > 0;
    } catch (err) {
      console.error(
        `[OrderReturnPendency] Falha ao fechar devolução de #${externalOrderId}:`,
        err instanceof Error ? err.message : err,
      );
      return false;
    }
  }
}
