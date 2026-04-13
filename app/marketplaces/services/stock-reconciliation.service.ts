import prisma from "@/app/lib/prisma";

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

    const rows = await prisma.productListing.findMany({
      where: {
        productId: { in: productIds },
        status: { in: ["ACTIVE", "active", "paused", "PAUSED"] },
      },
      select: {
        id: true,
        productId: true,
        marketplaceAccountId: true,
        product: { select: { stock: true } },
        marketplaceAccount: { select: { platform: true, status: true } },
      },
    });

    const candidates: DriftCandidate[] = rows
      .filter((r) => r.marketplaceAccount?.status === "ACTIVE")
      .map((r) => ({
        productId: r.productId,
        stock: r.product.stock,
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
          await tx.$queryRaw<
            unknown[]
          >`SELECT pg_advisory_xact_lock(hashtext(${"stock_sync_job:" + c.listingId}))`;

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
        });
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
