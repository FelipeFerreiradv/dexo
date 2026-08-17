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

/** Entrada por PRODUTOS — usada pelos caminhos de marketplace. */
export interface ReconcileForProductsInput {
  productIds: string[];
  /**
   * Opcional. A consulta SEMPRE exige `Scrap.userId = Product.userId`, então o
   * pareamento sucata↔dono é seguro mesmo sem este filtro — e é por isso que
   * ele pode faltar: `deductStockForOrder` recebe um `Order` cujo
   * `marketplaceAccount` não carrega `userId`. Quando informado, vira um
   * filtro ADICIONAL (defense-in-depth), nunca a única garantia.
   */
  userId?: string;
  logPrefix?: string;
}

/**
 * Entrada por SUCATAS — usada quando quem muda é o VÍNCULO, não a venda.
 *
 * Existe por causa do BLOCO J (trocar a sucata de uma peça): depois do
 * `UPDATE`, o produto já não aponta para a sucata ANTIGA, então
 * `reconcileForProducts` — que resolve as sucatas a partir do produto — nunca
 * a alcançaria. A antiga é justamente a que pode ter mudado de estado (perdeu
 * a última peça em estoque, ou deixou de estar esgotada).
 *
 * Aqui `userId` é OBRIGATÓRIO: ao contrário da entrada por produtos, não há um
 * `Product.userId` para parear na consulta — o dono é a única guarda.
 */
export interface ReconcileForScrapsInput {
  scrapIds: string[];
  userId: string;
  logPrefix?: string;
}

/**
 * Quais produtos, após uma VENDA de marketplace, merecem reconciliação do lote.
 *
 * Função pura porque é a política de disparo do caminho mais sensível do
 * sistema (roda dentro da importação de pedidos) — e política que não dá para
 * testar não é política, é esperança.
 *
 * DUAS TRAVAS:
 *  1. Flag `SCRAP_RECONCILE_ON_SALE_ENABLED`. Ausente ⇒ lista vazia ⇒ a
 *     importação fica byte-idêntica. Env de BACKEND (não `NEXT_PUBLIC_`): liga
 *     e desliga com restart do pm2, sem rebuild.
 *  2. Só quem ZEROU. `deriveScrapStatus` só move o lote para DEPLETED quando o
 *     estoque somado das peças chega a zero, então reconciliar quando ninguém
 *     zerou é trabalho garantidamente inútil. Mesmo critério do `pauseOnZero`.
 *
 * Fora de escopo por decisão: AVAILABLE → IN_USE (primeira venda com estoque
 * restante). Cobri-la exigiria reconciliar em TODA venda, que é o custo que as
 * travas existem para evitar.
 */
export function scrapReconcileTargetsAfterSale(
  deductions: { productId: string; newStock: number }[],
  env: Record<string, string | undefined> = process.env,
): string[] {
  if (env.SCRAP_RECONCILE_ON_SALE_ENABLED !== "1") return [];
  return deductions.filter((d) => d.newStock === 0).map((d) => d.productId);
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

  /**
   * Agenda a reconciliação a partir de PRODUTOS (não-bloqueante).
   *
   * Existe porque o serviço só tinha entrada pela conta a receber, e os dois
   * únicos chamadores eram `markPaid` e `reverse` — então **cancelar um pedido
   * de marketplace restaurava o estoque mas deixava o lote marcado "Esgotada"
   * para sempre**. O rótulo por peça se autocura (é derivado de estoque em
   * tempo real), mas `Scrap.status` é coluna persistida: a peça voltava a
   * aparecer "Em estoque" dentro de um lote "Esgotado".
   *
   * A query de fatos já sabia ler os dois canais (marketplace + balcão); só
   * faltava alguém disparar pelo lado do marketplace.
   *
   * Mesmo contrato do irmão: `void`, best-effort, `setImmediate`, e cada sucata
   * reconciliada sob advisory lock próprio.
   */
  static reconcileForProducts(input: ReconcileForProductsInput): void {
    const logPrefix = input.logPrefix ?? "[ScrapStatusReconcile]";
    const productIds = Array.from(new Set(input.productIds ?? [])).filter(
      Boolean,
    );
    if (productIds.length === 0) return;
    setImmediate(() => {
      void ScrapStatusReconcileService.runForProducts({
        ...input,
        productIds,
      }).catch((err) =>
        console.error(
          `${logPrefix} Falha ao reconciliar status de sucata (best-effort):`,
          err,
        ),
      );
    });
  }

  /**
   * Agenda a reconciliação de sucatas INFORMADAS pelo chamador (não-bloqueante).
   *
   * Mesmo contrato das irmãs: `void`, best-effort, `setImmediate`, uma sucata
   * por advisory lock. A diferença é de onde vem a lista — aqui o chamador já
   * sabe quais lotes mexeram (a origem e o destino de um vínculo), e é isso
   * que permite alcançar a sucata que o produto ACABOU DE DEIXAR.
   */
  static reconcileForScraps(input: ReconcileForScrapsInput): void {
    const logPrefix = input.logPrefix ?? "[ScrapStatusReconcile]";
    const scrapIds = Array.from(new Set(input.scrapIds ?? [])).filter(Boolean);
    if (scrapIds.length === 0 || !input.userId) return;
    setImmediate(() => {
      void ScrapStatusReconcileService.runForScraps({
        ...input,
        scrapIds,
      }).catch((err) =>
        console.error(
          `${logPrefix} Falha ao reconciliar status de sucata (best-effort):`,
          err,
        ),
      );
    });
  }

  private static async runForScraps(
    input: ReconcileForScrapsInput,
  ): Promise<void> {
    const { scrapIds, userId } = input;
    const logPrefix = input.logPrefix ?? "[ScrapStatusReconcile]";

    // O dono é resolvido NA CONSULTA, nunca confiado ao chamador: um id de
    // outro tenant simplesmente não volta da lista e portanto não é tocado.
    const rows = await prisma.$queryRaw<{ scrapId: string }[]>(Prisma.sql`
      SELECT s."id" AS "scrapId"
        FROM "Scrap" s
       WHERE s."id" IN (${Prisma.join(scrapIds)})
         AND s."userId" = ${userId}
    `);

    await ScrapStatusReconcileService.reconcileMany(rows, userId, logPrefix);
  }

  private static async runForProducts(
    input: ReconcileForProductsInput,
  ): Promise<void> {
    const { productIds, userId } = input;
    const logPrefix = input.logPrefix ?? "[ScrapStatusReconcile]";

    // Sucatas DISTINTAS dos produtos tocados, com o dono resolvido na própria
    // consulta. `s."userId" = p."userId"` é o que garante o pareamento: um
    // produto de outro tenant apontando para esta sucata não arrasta a
    // reconciliação para fora do dono. O filtro por `userId` do chamador, quando
    // existe, é camada extra — não a única garantia.
    const scrapRows = await prisma.$queryRaw<
      { scrapId: string; userId: string }[]
    >(Prisma.sql`
      SELECT DISTINCT p."scrapId" AS "scrapId", s."userId" AS "userId"
        FROM "Product" p
        JOIN "Scrap" s ON s."id" = p."scrapId"
       WHERE p."id" IN (${Prisma.join(productIds)})
         AND s."userId" = p."userId"
         AND p."scrapId" IS NOT NULL
         ${userId ? Prisma.sql`AND p."userId" = ${userId}` : Prisma.empty}
    `);

    // Cada linha carrega o próprio dono — um pedido nunca mistura tenants, mas
    // agrupar por linha é o que torna isso verdadeiro por construção.
    for (const row of scrapRows) {
      await ScrapStatusReconcileService.reconcileMany(
        [{ scrapId: row.scrapId }],
        row.userId,
        logPrefix,
      );
    }
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

    await ScrapStatusReconcileService.reconcileMany(
      scrapRows,
      userId,
      logPrefix,
    );
  }

  /** Laço compartilhado pelas duas entradas. Uma sucata que falha não derruba as outras. */
  private static async reconcileMany(
    scrapRows: { scrapId: string }[],
    userId: string,
    logPrefix: string,
  ): Promise<void> {
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
