import { MLApiService } from "./ml-api.service";
import { MLOAuthService } from "./ml-oauth.service";
import { ShopeeApiService } from "./shopee-api.service";
import { ShopeeOAuthService } from "./shopee-oauth.service";
import { MarketplaceRepository } from "../repositories/marketplace.repository";
import { ListingRepository } from "../repositories/listing.repository";
import { normalizeListingStatus } from "../lib/listing-status";

const TOKEN_REFRESH_SAFETY_MS = 60 * 1000;
const SHOPEE_BATCH_SIZE = 50;

export type RefreshableListingRow = {
  id: string;
  status: string;
  externalListingId: string;
  marketplaceAccount: {
    id: string;
    platform: string;
    status: string;
    accessToken: string | null;
    refreshToken: string | null;
    expiresAt: Date | null;
    shopId: number | null;
  } | null;
};

type AccountShape = NonNullable<RefreshableListingRow["marketplaceAccount"]>;

/**
 * Token ML fresco. Mantida local (sem import cruzado) espelhando
 * webhook.usercase.ts / messages.usecase.ts.
 */
async function ensureFreshMLToken(account: AccountShape): Promise<string> {
  const expiresMs = account.expiresAt
    ? new Date(account.expiresAt).getTime()
    : 0;
  if (
    Number.isFinite(expiresMs) &&
    expiresMs - Date.now() > TOKEN_REFRESH_SAFETY_MS
  ) {
    return account.accessToken!;
  }
  const refreshed = await MLOAuthService.refreshAccessTokenForAccount(
    account.id,
    account.refreshToken!,
  );
  await MarketplaceRepository.updateTokens(account.id, {
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken,
    expiresAt: new Date(Date.now() + refreshed.expiresIn * 1000),
  });
  return refreshed.accessToken;
}

/**
 * Token Shopee fresco; falha ⇒ null. Mantida local (sem import cruzado)
 * espelhando webhook.usercase.ts.
 */
async function ensureFreshShopeeToken(
  account: AccountShape,
): Promise<string | null> {
  if (!account.accessToken || !account.shopId) return null;
  const expiresMs = account.expiresAt
    ? new Date(account.expiresAt).getTime()
    : 0;
  if (
    Number.isFinite(expiresMs) &&
    expiresMs - Date.now() > TOKEN_REFRESH_SAFETY_MS
  ) {
    return account.accessToken;
  }
  if (!account.refreshToken) return account.accessToken;
  try {
    const refreshed = await ShopeeOAuthService.refreshAccessToken(
      account.refreshToken,
      account.shopId,
    );
    await MarketplaceRepository.updateTokens(account.id, {
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token,
      expiresAt: ShopeeOAuthService.calculateExpiryDate(refreshed.expire_in),
    });
    return refreshed.access_token;
  } catch (err) {
    console.warn(
      `[ListingStatusRefresh] Falha ao refrescar token Shopee da conta ${account.id}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

const parseShopeeItemId = (externalListingId: string): number | null => {
  const parsed = parseInt(externalListingId.split(":")[0], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

/**
 * Consulta o status remoto ao vivo (ML/Shopee) para um conjunto de listings e
 * grava o valor normalizado nos que mudaram. Fase de espelhamento
 * marketplace→Dexo: usada pelo GET /listings/status?live=1 (dialog) e pela
 * varredura periódica. Magalu fica de fora até a leitura da API ser validada.
 * Kill-switch: LISTING_STATUS_SYNC_DISABLED=1 ⇒ Map vazio. Nunca lança.
 */
export class ListingStatusRefreshService {
  /** listingId → { status, updatedAt } (só os que mudaram). */
  static async refreshRowsBestEffort(
    rows: RefreshableListingRow[],
  ): Promise<Map<string, { status: string; updatedAt: Date }>> {
    const changed = new Map<string, { status: string; updatedAt: Date }>();
    if (process.env.LISTING_STATUS_SYNC_DISABLED === "1") return changed;

    const eligible = rows.filter(
      (row) =>
        row?.id &&
        row.externalListingId &&
        !row.externalListingId.startsWith("PENDING_") &&
        row.marketplaceAccount &&
        row.marketplaceAccount.status === "ACTIVE" &&
        row.marketplaceAccount.accessToken,
    );
    if (eligible.length === 0) return changed;

    const byAccount = new Map<string, RefreshableListingRow[]>();
    for (const row of eligible) {
      const accountId = row.marketplaceAccount!.id;
      const group = byAccount.get(accountId);
      if (group) group.push(row);
      else byAccount.set(accountId, [row]);
    }

    for (const group of byAccount.values()) {
      const account = group[0].marketplaceAccount!;
      try {
        let rawByExternalId: Map<string, string | undefined> | null = null;

        if (account.platform === "MERCADO_LIVRE") {
          const accessToken = await ensureFreshMLToken(account);
          const ids = [...new Set(group.map((r) => r.externalListingId))];
          const items = await MLApiService.getItemsDetails(accessToken, ids);
          const statusById = new Map(
            items.map((item: any) => [String(item.id), item?.status]),
          );
          rawByExternalId = new Map(
            group.map((r) => [
              r.externalListingId,
              statusById.get(r.externalListingId) as string | undefined,
            ]),
          );
        } else if (account.platform === "SHOPEE") {
          const accessToken = await ensureFreshShopeeToken(account);
          if (!accessToken) continue;
          const itemIds = [
            ...new Set(
              group
                .map((r) => parseShopeeItemId(r.externalListingId))
                .filter((id): id is number => id !== null),
            ),
          ];
          const statusByItemId = new Map<number, string | undefined>();
          for (let i = 0; i < itemIds.length; i += SHOPEE_BATCH_SIZE) {
            const batch = itemIds.slice(i, i + SHOPEE_BATCH_SIZE);
            const items = await ShopeeApiService.getItemsBaseInfo(
              accessToken,
              account.shopId!,
              batch,
            );
            for (const item of items as any[]) {
              // A API real devolve item_status; o tipo declara status.
              statusByItemId.set(
                Number(item.item_id),
                item?.item_status ?? item?.status,
              );
            }
          }
          rawByExternalId = new Map(
            group.map((r) => {
              const itemId = parseShopeeItemId(r.externalListingId);
              return [
                r.externalListingId,
                itemId !== null ? statusByItemId.get(itemId) : undefined,
              ];
            }),
          );
        } else {
          // MAGALU: leitura de status da API ainda não validada (TODO na
          // MagaluApiService) — sem espelhamento ativo nesta fase.
          continue;
        }

        for (const row of group) {
          const normalized = normalizeListingStatus(
            account.platform,
            rawByExternalId.get(row.externalListingId),
          );
          if (!normalized || normalized === row.status) continue;
          try {
            const updated = await ListingRepository.updateStatus(
              row.id,
              normalized,
            );
            changed.set(row.id, {
              status: normalized,
              updatedAt: (updated as any)?.updatedAt ?? new Date(),
            });
          } catch (err) {
            console.warn(
              `[ListingStatusRefresh] Falha ao gravar status do listing ${row.id}:`,
              err instanceof Error ? err.message : err,
            );
          }
        }
      } catch (err) {
        console.warn(
          `[ListingStatusRefresh] Falha na conta ${account.id} (${account.platform}) — demais contas seguem:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    return changed;
  }
}
