import prisma from "@/app/lib/prisma";
import { Prisma } from "@prisma/client";

/**
 * Reconciliação best-effort do `ScrapStatus` (inventário) a partir de uma venda
 * balcão (Conta a Receber). Espelha o padrão de `StockDeductionService.
 * firePostEffects`: TODO o trabalho roda em `setImmediate`, o método público
 * retorna `void` e nunca lança no chamador. É chamado como IRMÃO, logo após o
 * `firePostEffects`, em `FinanceUseCase.markPaid` e `reverse` — sempre DEPOIS
 * do commit da `$transaction` financeira. Portanto:
 *  - NÃO trava nem reverte o pagamento (não há transação aberta a reverter).
 *  - Só escreve em `Scrap.status` (via UPDATE guardado). Nunca toca
 *    Receivable/ReceivableItem/Product/estoque.
 *
 * Regra de transição (derivada do estado atual — "projeção derivada"):
 *  - sem venda atribuída (nenhum canal) → AVAILABLE
 *  - com venda + 0 produtos cadastrados (só-manual) → IN_USE (nunca DEPLETED)
 *  - com venda + estoque > 0 das peças cadastradas → IN_USE
 *  - com venda + todas as peças cadastradas em estoque 0 → DEPLETED
 * Nunca toca ARCHIVED; só transita entre {AVAILABLE, IN_USE, DEPLETED}.
 *
 * Idempotente: o UPDATE só escreve quando `status <> alvo` (e nunca em
 * ARCHIVED). `pay-twice` já é no-op upstream (markPaid retorna cedo em PAGA,
 * reverse em CANCELADA). Concorrência: `pg_advisory_xact_lock` por sucata
 * serializa reconciles simultâneos do MESMO lote (chaves distintas por lote).
 */

type ScrapTarget = "AVAILABLE" | "IN_USE" | "DEPLETED";

/**
 * Deriva o ScrapStatus alvo a partir do estado atual (função pura — base da
 * decision table). DEPLETED exige regCount>=1 (só-manual nunca depleta).
 */
export function deriveScrapStatus(
  hasSales: boolean,
  regCount: number,
  sumStock: number,
): ScrapTarget {
  if (!hasSales) return "AVAILABLE";
  if (regCount >= 1 && sumStock === 0) return "DEPLETED";
  return "IN_USE";
}

export interface ReconcileForReceivableInput {
  receivableId: string;
  userId: string;
  /** Prefixo de log do chamador (ex.: "[FinanceUseCase]"). */
  logPrefix?: string;
}

export class ScrapStatusReconcileService {
  /**
   * Agenda a reconciliação (não-bloqueante). Retorna imediatamente; todo o
   * trabalho — inclusive a query (A) — roda dentro do `setImmediate`, então não
   * adiciona latência ao markPaid/reverse.
   */
  static reconcileForReceivable(input: ReconcileForReceivableInput): void {
    const logPrefix = input.logPrefix ?? "[ScrapStatusReconcile]";
    setImmediate(() => {
      void ScrapStatusReconcileService.run(input).catch((err) =>
        console.error(
          `${logPrefix} Falha ao reconciliar status de sucata (best-effort):`,
          err,
        ),
      );
    });
  }

  private static async run(
    input: ReconcileForReceivableInput,
  ): Promise<void> {
    const { receivableId, userId } = input;
    const logPrefix = input.logPrefix ?? "[ScrapStatusReconcile]";

    // (A) Sucatas EFETIVAS tocadas por esta conta — COALESCE(ri.scrapId,
    // p.scrapId), tenant-scoped via JOIN Scrap.userId. Itens sem sucata
    // efetiva (manual sem override e sem produto) saem NULL e são filtrados.
    const scrapRows = await prisma.$queryRaw<{ scrapId: string }[]>(Prisma.sql`
      SELECT DISTINCT COALESCE(ri."scrapId", p."scrapId") AS "scrapId"
        FROM "ReceivableItem" ri
        LEFT JOIN "Product" p ON p."id" = ri."productId"
        JOIN "Scrap" s ON s."id" = COALESCE(ri."scrapId", p."scrapId")
       WHERE ri."receivableId" = ${receivableId}
         AND s."userId" = ${userId}
         AND COALESCE(ri."scrapId", p."scrapId") IS NOT NULL
    `);

    for (const { scrapId } of scrapRows) {
      try {
        await ScrapStatusReconcileService.reconcileScrap(scrapId, userId);
      } catch (err) {
        console.error(
          `${logPrefix} Falha ao reconciliar sucata ${scrapId} (best-effort):`,
          err,
        );
      }
    }
  }

  // Reconcilia UMA sucata: computa os fatos sob advisory lock e aplica o
  // UPDATE guardado. (compute + write) na mesma tx curta para consistência.
  private static async reconcileScrap(
    scrapId: string,
    userId: string,
  ): Promise<void> {
    await prisma.$transaction(
      async (tx) => {
        // Serializa reconciles concorrentes da MESMA sucata (lotes distintos
        // usam chaves distintas → sem contenção cruzada). Namespace próprio
        // 'scrap_status:' (distinto de 'stock_sync_job:').
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"scrap_status:" + scrapId}))`;

        // (B) Fatos por sucata, tenant self-contained. hasSales abrange OS DOIS
        // canais (balcão PAGA + marketplace PAID/SHIPPED/DELIVERED) — sem isso,
        // estornar uma venda balcão pequena rebaixaria indevidamente uma sucata
        // esgotada via marketplace.
        const rows = await tx.$queryRaw<
          { hasSales: boolean; regCount: number; sumStock: number }[]
        >(Prisma.sql`
          SELECT
            ( EXISTS (
                SELECT 1 FROM "ReceivableItem" ri2
                  LEFT JOIN "Product" p2 ON p2."id" = ri2."productId"
                  JOIN "Receivable" r2 ON r2."id" = ri2."receivableId"
                 WHERE COALESCE(ri2."scrapId", p2."scrapId") = ${scrapId}
                   AND r2."status"::text = 'PAGA'
                   AND r2."userId" = ${userId}
              )
              OR EXISTS (
                SELECT 1 FROM "OrderItem" oi
                  JOIN "Product" p5 ON p5."id" = oi."productId"
                  JOIN "Order" o ON o."id" = oi."orderId"
                  JOIN "MarketplaceAccount" ma ON ma."id" = o."marketplaceAccountId"
                 WHERE p5."scrapId" = ${scrapId}
                   AND o."status"::text IN ('PAID','SHIPPED','DELIVERED')
                   AND ma."userId" = ${userId}
              )
            ) AS "hasSales",
            -- Bloco F: peças avulsas promovidas (autoCreatedFromSale) ficam
            -- FORA da contagem de catálogo. Elas nascem e morrem com estoque 0
            -- na mesma operação; contá-las levaria deriveScrapStatus de
            -- (true, 0, 0)=IN_USE para (true, 1, 0)=DEPLETED, marcando como
            -- esgotado um lote que sequer foi catalogado. A coluna é false em
            -- 100% das linhas pré-existentes => resultado idêntico ao de hoje.
            (SELECT COUNT(*)::int FROM "Product" p3
               WHERE p3."scrapId" = ${scrapId}
                 AND p3."userId" = ${userId}
                 AND p3."autoCreatedFromSale" = false) AS "regCount",
            (SELECT COALESCE(SUM(p4."stock"), 0)::int FROM "Product" p4
               WHERE p4."scrapId" = ${scrapId}
                 AND p4."userId" = ${userId}
                 AND p4."autoCreatedFromSale" = false) AS "sumStock"
          FROM "Scrap" s
          WHERE s."id" = ${scrapId} AND s."userId" = ${userId}
        `);

        const row = rows[0];
        if (!row) return; // sucata inexistente/não-própria → no-op defensivo

        const hasSales = Boolean(row.hasSales);
        const regCount = Number(row.regCount) || 0;
        const sumStock = Number(row.sumStock) || 0;

        const target = deriveScrapStatus(hasSales, regCount, sumStock);

        // (C) UPDATE guardado: idempotente (no-op se já no alvo) e ARCHIVED-safe.
        await tx.$executeRaw(Prisma.sql`
          UPDATE "Scrap"
             SET "status" = ${target}::"ScrapStatus", "updatedAt" = NOW()
           WHERE "id" = ${scrapId}
             AND "status" <> ${target}::"ScrapStatus"
             AND "status" <> 'ARCHIVED'
        `);
      },
      { timeout: 60_000, maxWait: 20_000 },
    );
  }
}
