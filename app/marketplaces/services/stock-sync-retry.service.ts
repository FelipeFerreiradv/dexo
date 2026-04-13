import prisma from "@/app/lib/prisma";
import { SyncUseCase } from "../usecases/sync.usercase";
import { SystemLogService } from "@/app/services/system-log.service";

const BACKOFF_SECONDS = [30, 60, 120, 300, 900, 1800];
const MAX_ATTEMPTS = BACKOFF_SECONDS.length;
const BATCH_LIMIT = 100;

const errMsg = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

const TERMINAL_PATTERNS = [
  /invalid_token/i,
  /token revoked/i,
  /item does not exist/i,
  /item_not_found/i,
  /listing not found/i,
  /unauthorized/i,
];

const isTerminalError = (message: string) =>
  TERMINAL_PATTERNS.some((re) => re.test(message));

type StockSyncJobRow = {
  id: string;
  productId: string;
  listingId: string;
  platform: string;
  targetStock: number;
  attempts: number;
  status: string;
};

/**
 * StockSyncRetryService
 *
 * Processa jobs duráveis de sincronização de estoque cross-marketplace.
 * Jobs são enfileirados por `OrderUseCase.deductStockForOrder` dentro da
 * mesma transação que decrementa o estoque local, garantindo que nenhum
 * decremento fique sem propagação aos marketplaces.
 *
 * Retry com backoff exponencial [30s, 60s, 120s, 300s, 900s, 1800s].
 * Falhas terminais (token revogado, listing inexistente) viram status FAILED
 * e disparam SystemLog de alerta.
 */
export class StockSyncRetryService {
  private static running = false;
  private static intervalId: NodeJS.Timeout | null = null;

  static async runOnce(): Promise<void> {
    const now = new Date();

    const jobs: StockSyncJobRow[] = await (prisma as any).stockSyncJob.findMany({
      where: {
        status: "PENDING",
        nextRunAt: { lte: now },
      },
      orderBy: { nextRunAt: "asc" },
      take: BATCH_LIMIT,
    });

    if (jobs.length === 0) return;

    console.log(`[StockSyncRetryService] processing ${jobs.length} job(s)`);

    // Agrupar por productId para chamar syncProductStock uma única vez por produto.
    const byProduct = new Map<string, StockSyncJobRow[]>();
    for (const job of jobs) {
      const arr = byProduct.get(job.productId) ?? [];
      arr.push(job);
      byProduct.set(job.productId, arr);
    }

    for (const [productId, productJobs] of byProduct) {
      let results: Awaited<ReturnType<typeof SyncUseCase.syncProductStock>>;
      try {
        results = await SyncUseCase.syncProductStock(productId);
      } catch (err) {
        const message = errMsg(err);
        console.error(
          `[StockSyncRetryService] syncProductStock threw for ${productId}: ${message}`,
        );
        await Promise.all(
          productJobs.map((job) => this.handleFailure(job, message)),
        );
        continue;
      }

      // Indexar resultados por externalListingId.
      const resultByListingId = new Map<
        string,
        (typeof results)[number]
      >();
      for (const r of results) {
        if (r.externalListingId) resultByListingId.set(r.externalListingId, r);
      }

      // Match de cada job com o resultado correspondente via listing.externalListingId.
      const listingRows = await prisma.productListing.findMany({
        where: { id: { in: productJobs.map((j) => j.listingId) } },
        select: { id: true, externalListingId: true },
      });
      const listingMap = new Map(listingRows.map((l) => [l.id, l]));

      for (const job of productJobs) {
        const listing = listingMap.get(job.listingId);
        if (!listing) {
          await this.markFailed(job, "Listing removido");
          continue;
        }
        const r = resultByListingId.get(listing.externalListingId);
        if (!r) {
          await this.handleFailure(job, "Sem resultado da sincronização");
          continue;
        }
        if (r.success) {
          await (prisma as any).stockSyncJob.delete({
            where: { id: job.id },
          });
        } else {
          await this.handleFailure(job, r.error ?? "Erro desconhecido");
        }
      }
    }
  }

  private static async handleFailure(
    job: { id: string; attempts: number; productId: string; listingId: string },
    message: string,
  ): Promise<void> {
    if (isTerminalError(message)) {
      await this.markFailed(job, message);
      return;
    }

    const nextAttempts = job.attempts + 1;
    if (nextAttempts >= MAX_ATTEMPTS) {
      await this.markFailed(job, message);
      return;
    }

    const delaySec = BACKOFF_SECONDS[nextAttempts] ?? BACKOFF_SECONDS[MAX_ATTEMPTS - 1];
    const nextRunAt = new Date(Date.now() + delaySec * 1000);

    await (prisma as any).stockSyncJob.update({
      where: { id: job.id },
      data: {
        attempts: nextAttempts,
        nextRunAt,
        lastError: message.slice(0, 500),
      },
    });
  }

  private static async markFailed(
    job: { id: string; productId: string; listingId: string },
    message: string,
  ): Promise<void> {
    // Deleta o job em vez de transicionar status — o unique constraint
    // @@unique([listingId, status]) em StockSyncJob impede manter linhas
    // históricas FAILED/SUCCESS na mesma listing (colide com próximo enqueue).
    // Histórico de falha terminal fica preservado em SystemLog (logError abaixo).
    await (prisma as any).stockSyncJob.delete({
      where: { id: job.id },
    });

    try {
      await SystemLogService.logError(
        "STOCK_SYNC_FAILED",
        `Sincronização de estoque falhou em definitivo para listing ${job.listingId}: ${message}`,
        {
          resource: "ProductListing",
          resourceId: job.listingId,
          details: { productId: job.productId, error: message },
        },
      );
    } catch (logErr) {
      console.error(
        "[StockSyncRetryService] Falha ao registrar log terminal:",
        logErr,
      );
    }
  }

  static start(intervalMs = 30 * 1000) {
    if (this.running) return;
    this.running = true;
    this.intervalId = setInterval(() => {
      void this.runOnce().catch((err) => {
        console.error("[StockSyncRetryService] runOnce failed:", err);
      });
    }, intervalMs);
    console.log(
      `[StockSyncRetryService] started (interval=${intervalMs}ms, maxAttempts=${MAX_ATTEMPTS})`,
    );
  }

  static stop() {
    if (this.intervalId) clearInterval(this.intervalId);
    this.intervalId = null;
    this.running = false;
  }
}
