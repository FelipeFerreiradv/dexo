import prisma from "@/app/lib/prisma";
import { availableForSale } from "@/app/financeiro/lib/stock-reservation";

const RECONCILE_WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
const BATCH_LIMIT = 500;

type DriftCandidate = {
  productId: string;
  stock: number;
  listingId: string;
  marketplaceAccountId: string;
  platform: string;
};

/**
 * StockReconciliationService
 *
 * Defesa em profundidade contra drift entre o estoque local e o estoque
 * anunciado nos marketplaces. A cada 15 min varre produtos cujo estoque
 * mudou na última hora (via StockLog) e enfileira um StockSyncJob por
 * listing ativo — o upsert em (listingId, status=PENDING) garante que não
 * há inflação da fila.
 *
 * Cenários que isso corrige:
 *  - Processo caiu entre o commit do decremento e o enfileiramento.
 *  - Job FAILED terminal ficou preso sem retry manual.
 *  - Ajuste manual de estoque no banco sem passar por deductStockForOrder.
 */
export class StockReconciliationService {
  private static intervalId: NodeJS.Timeout | null = null;
  private static running = false;

  static async runOnce(): Promise<void> {
    const since = new Date(Date.now() - RECONCILE_WINDOW_MS);

    const recentLogs = await prisma.stockLog.findMany({
      where: { createdAt: { gte: since } },
      select: { productId: true },
      distinct: ["productId"],
      take: BATCH_LIMIT,
    });

    if (recentLogs.length === 0) return;

    const productIds = recentLogs.map((l) => l.productId);

    // Com o espelhamento de status ligado, listings podem carregar
    // under_review/reviewing/unlist/inactive (item ainda existe no
    // marketplace e volta a vender) — antes do espelho essas linhas ficavam
    // stale em active/paused e ENTRAVAM aqui; a ampliação preserva a
    // cobertura de drift que elas sempre tiveram.
    // "pending"/"PENDING" entram porque é o estado ESTÁVEL de um anúncio OLX
    // publicado: a OLX confirma na fila de revisão e o Dexo não espelha esse
    // status, então o anúncio fica pending indefinidamente e ficava invisível
    // para a rede de segurança de drift.
    //
    // Só no ramo COM espelhamento (o que roda em produção — a flag é vazia no
    // .env). O ramo do kill-switch fica byte-idêntico ao anterior de propósito:
    // ele existe para voltar ao filtro base, e há teste travando isso
    // (listing-status-mirror-interactions.spec.ts).
    const reconcilableStatuses =
      process.env.LISTING_STATUS_SYNC_DISABLED === "1"
        ? ["ACTIVE", "active", "paused", "PAUSED"]
        : [
            "ACTIVE",
            "active",
            "paused",
            "PAUSED",
            "pending",
            "PENDING",
            "under_review",
            "reviewing",
            "unlist",
            "inactive",
          ];

    const rows = await prisma.productListing.findMany({
      where: {
        productId: { in: productIds },
        status: { in: reconcilableStatuses },
        // Placeholders locais NUNCA existiram no canal: ML, Shopee e o
        // republish do ML criam linhas com externalListingId `PENDING_*` e
        // status exatamente "pending". Sem este filtro, admitir "pending"
        // acima passaria a enfileirar job de sync para anúncio que não existe
        // do outro lado — regressão direta em ML e Shopee.
        //
        // PAREADO com o status de propósito: excluir todo `PENDING_*` de forma
        // ampla também removeria da varredura uma linha legítima — o create da
        // Magalu sem SKU grava `PENDING_<ts>` com status "active" e entrava na
        // reconciliação antes desta entrega. Assim o ramo do kill-switch fica
        // de fato byte-idêntico ao anterior, como o comentário acima promete.
        NOT: {
          AND: [
            { status: { in: ["pending", "PENDING"] } },
            { externalListingId: { startsWith: "PENDING_" } },
          ],
        },
      },
      select: {
        id: true,
        productId: true,
        marketplaceAccountId: true,
        // BLOCO G — `reservedStock` entra no select porque o alvo do job
        // precisa ser o estoque DISPONÍVEL. Sem isto o reconciliador
        // enfileiraria o estoque BRUTO e desfaria a reserva a cada tick de
        // 15 minutos — silenciosamente, e para todos os anúncios de uma vez.
        product: { select: { stock: true, reservedStock: true } },
        marketplaceAccount: { select: { platform: true, status: true } },
      },
    });

    const candidates: DriftCandidate[] = rows
      .filter((r) => r.marketplaceAccount?.status === "ACTIVE")
      .map((r) => ({
        productId: r.productId,
        stock: availableForSale(r.product.stock, r.product.reservedStock),
        listingId: r.id,
        marketplaceAccountId: r.marketplaceAccountId,
        platform: r.marketplaceAccount.platform,
      }));

    if (candidates.length === 0) return;

    console.log(
      `[StockReconciliationService] enqueueing ${candidates.length} drift-repair job(s)`,
    );

    for (const c of candidates) {
      try {
        // Serializa com OrderUseCase.deductStockForOrder via advisory lock
        // para evitar P2002 no upsert não-atômico do Prisma. Ambos lados
        // pegam o mesmo lock por listing antes do SELECT/INSERT.
        await prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"stock_sync_job:" + c.listingId}))`;

          await (tx as any).stockSyncJob.upsert({
            where: {
              listingId_status: { listingId: c.listingId, status: "PENDING" },
            },
            create: {
              productId: c.productId,
              listingId: c.listingId,
              platform: c.platform,
              targetStock: c.stock,
              status: "PENDING",
            },
            update: {
              targetStock: c.stock,
            },
          });
        }, { timeout: 60_000, maxWait: 20_000 });
      } catch (err) {
        console.error(
          `[StockReconciliationService] upsert failed for listing ${c.listingId}:`,
          err,
        );
      }
    }
  }

  static start(intervalMs = DEFAULT_INTERVAL_MS) {
    if (this.running) return;
    this.running = true;
    this.intervalId = setInterval(() => {
      void this.runOnce().catch((err) => {
        console.error("[StockReconciliationService] runOnce failed:", err);
      });
    }, intervalMs);
    console.log(
      `[StockReconciliationService] started (interval=${intervalMs}ms)`,
    );
  }

  static stop() {
    if (this.intervalId) clearInterval(this.intervalId);
    this.intervalId = null;
    this.running = false;
  }
}
