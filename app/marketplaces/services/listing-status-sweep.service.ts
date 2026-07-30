import prisma from "@/app/lib/prisma";
import {
  ListingStatusRefreshService,
  type RefreshableListingRow,
} from "./listing-status-refresh.service";
import { isFacebookDisabled } from "@/app/lib/integration-flags";

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
const PAGE_SIZE = 100;

/**
 * ListingStatusSweepService
 *
 * Varredura periódica do espelhamento de status marketplace→Dexo. O webhook
 * (ML) e o live=1 do dialog cobrem o "agora"; esta varredura cura o resto:
 * badges/listas desatualizados, eventos de webhook perdidos e a Shopee (que
 * não tem webhook de item). A cada rodada processa uma página de listings
 * por conta ativa (ML/Shopee/Facebook) e delega ao ListingStatusRefreshService.
 *
 * Cursor keyset em memória por conta: rodadas sucessivas percorrem todo o
 * catálogo; página incompleta reinicia a rotação. Restart do processo só
 * recomeça a varredura (eventual consistency preservada).
 *
 * Kill-switch: LISTING_STATUS_SYNC_DISABLED=1 (o start é gated no api.ts e
 * o runOnce também checa, para cobrir mudança de env em runtime via pm2).
 */
export class ListingStatusSweepService {
  private static intervalId: NodeJS.Timeout | null = null;
  private static running = false;
  private static cursors = new Map<string, string>();

  static async runOnce(): Promise<void> {
    if (process.env.LISTING_STATUS_SYNC_DISABLED === "1") return;

    // Kill-switch de runtime: Facebook sai da varredura de espelhamento quando
    // FACEBOOK_INTEGRATION_DISABLED=1. (OLX não espelha status nesta fase.)
    const mirrorPlatforms = ["MERCADO_LIVRE", "SHOPEE"];
    if (!isFacebookDisabled()) mirrorPlatforms.push("FACEBOOK");

    const accounts = await (prisma as any).marketplaceAccount.findMany({
      where: {
        status: "ACTIVE",
        platform: { in: mirrorPlatforms },
      },
      select: {
        id: true,
        platform: true,
        status: true,
        accessToken: true,
        refreshToken: true,
        expiresAt: true,
        shopId: true,
      },
    });

    for (const account of accounts) {
      try {
        const cursor = this.cursors.get(account.id);
        const rows = await (prisma as any).productListing.findMany({
          where: {
            marketplaceAccountId: account.id,
            NOT: { externalListingId: { startsWith: "PENDING_" } },
            ...(cursor ? { id: { gt: cursor } } : {}),
          },
          orderBy: { id: "asc" },
          take: PAGE_SIZE,
          select: {
            id: true,
            status: true,
            externalListingId: true,
          },
        });

        if (rows.length > 0) {
          const refreshable: RefreshableListingRow[] = rows.map((r: any) => ({
            ...r,
            marketplaceAccount: account,
          }));
          const changed =
            await ListingStatusRefreshService.refreshRowsBestEffort(
              refreshable,
            );
          if (changed.size > 0) {
            console.log(
              `[ListingStatusSweep] conta ${account.id}: ${changed.size} listing(s) com status atualizado`,
            );
          }
        }

        if (rows.length < PAGE_SIZE) {
          this.cursors.delete(account.id); // fim da rotação → recomeça
        } else {
          this.cursors.set(account.id, rows[rows.length - 1].id);
        }
      } catch (err) {
        console.warn(
          `[ListingStatusSweep] Falha na conta ${account.id} — demais contas seguem:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  static start(intervalMs = DEFAULT_INTERVAL_MS) {
    if (this.running) return;
    this.running = true;
    this.intervalId = setInterval(() => {
      void this.runOnce().catch((err) => {
        console.error("[ListingStatusSweep] runOnce failed:", err);
      });
    }, intervalMs);
    console.log(`[ListingStatusSweep] started (interval=${intervalMs}ms)`);
  }

  static stop() {
    if (this.intervalId) clearInterval(this.intervalId);
    this.intervalId = null;
    this.running = false;
  }
}
