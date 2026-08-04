import axios from "axios";
import prisma from "@/app/lib/prisma";
import { MLApiService } from "./ml-api.service";
import { MLOAuthService } from "./ml-oauth.service";
import { ShopeeApiService } from "./shopee-api.service";
import { ShopeeOAuthService } from "./shopee-oauth.service";
import { MarketplaceRepository } from "../repositories/marketplace.repository";
import { ListingRepository } from "../repositories/listing.repository";
import { normalizeListingStatus } from "../lib/listing-status";
import { isPlatformDisabled } from "@/app/lib/integration-flags";
import {
  FACEBOOK_CONSTANTS,
  facebookGraphBase,
} from "../facebook/facebook-constants";

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
    fbCatalogId: string | null;
  } | null;
};

type AccountShape = NonNullable<RefreshableListingRow["marketplaceAccount"]>;

/**
 * O snapshot da conta pode estar MINUTOS velho (o sweep lê todas as contas no
 * início da rodada). Refrescar com um refresh token stale já consumido por
 * outro fluxo (webhook/mensagens) gera invalid_grant e AUTO-DESATIVA a conta
 * (single-use do ML). Reler os tokens do banco imediatamente antes da decisão
 * colapsa a janela para ~ms — mesma mitigação do processOrderWebhook.
 * Best-effort: falha na releitura mantém o snapshot.
 * EGRESS: select de 3 colunas.
 */
async function reloadFreshTokens(account: AccountShape): Promise<void> {
  try {
    const fresh = await (prisma as any).marketplaceAccount.findUnique({
      where: { id: account.id },
      select: { accessToken: true, refreshToken: true, expiresAt: true },
    });
    if (fresh) {
      account.accessToken = fresh.accessToken;
      account.refreshToken = fresh.refreshToken;
      account.expiresAt = fresh.expiresAt;
    }
  } catch (err) {
    console.warn(
      `[ListingStatusRefresh] Falha ao reler tokens da conta ${account.id} (segue com snapshot):`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Token ML fresco. Mantida local (sem import cruzado) espelhando
 * webhook.usercase.ts / messages.usecase.ts.
 */
async function ensureFreshMLToken(account: AccountShape): Promise<string> {
  await reloadFreshTokens(account);
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
  const newExpiresAt = new Date(Date.now() + refreshed.expiresIn * 1000);
  await MarketplaceRepository.updateTokens(account.id, {
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken,
    expiresAt: newExpiresAt,
  });
  account.accessToken = refreshed.accessToken;
  account.refreshToken = refreshed.refreshToken;
  account.expiresAt = newExpiresAt;
  return refreshed.accessToken;
}

/**
 * Token Shopee fresco; falha ⇒ null. Mantida local (sem import cruzado)
 * espelhando webhook.usercase.ts.
 */
async function ensureFreshShopeeToken(
  account: AccountShape,
): Promise<string | null> {
  await reloadFreshTokens(account);
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
    const newExpiresAt = ShopeeOAuthService.calculateExpiryDate(
      refreshed.expire_in,
    );
    await MarketplaceRepository.updateTokens(account.id, {
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token,
      expiresAt: newExpiresAt,
    });
    account.accessToken = refreshed.access_token;
    account.refreshToken = refreshed.refresh_token;
    account.expiresAt = newExpiresAt;
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
 * Lê o status remoto dos itens do catálogo Meta (retailer_id → availability/
 * review_status) via GET /{catalog_id}/products?filter=... A Meta não tem
 * refresh de token (long-lived; expira ⇒ re-OAuth), então usa o token salvo —
 * expirado ⇒ a chamada falha e o try/catch do grupo isola. review_status
 * (rejected/pending) tem prioridade sobre availability no espelho: um item
 * barrado/em revisão importa mais que a disponibilidade. Item ausente ⇒ omitido.
 */
async function getFacebookItemStatuses(
  accessToken: string,
  retailerIds: string[],
  catalogId?: string | null,
): Promise<Map<string, string | undefined>> {
  const out = new Map<string, string | undefined>();
  // Catálogo por conta (env só fallback) p/ não ler o catálogo global do .env.
  const catalog = catalogId ?? FACEBOOK_CONSTANTS.CATALOG_ID;
  if (retailerIds.length === 0 || !catalog) return out;

  const filter = JSON.stringify({ retailer_id: { is_any: retailerIds } });
  const url = new URL(`${facebookGraphBase()}/${catalog}/products`);
  url.searchParams.set("fields", "retailer_id,availability,review_status");
  url.searchParams.set("filter", filter);
  url.searchParams.set("limit", String(retailerIds.length));

  const response = await axios.get<{
    data?: Array<{
      retailer_id?: string;
      availability?: string;
      review_status?: string;
    }>;
  }>(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: FACEBOOK_CONSTANTS.REQUEST_TIMEOUT,
  });

  for (const item of response.data?.data ?? []) {
    if (!item?.retailer_id) continue;
    const reviewBlocked =
      item.review_status &&
      item.review_status.toLowerCase() !== "approved" &&
      item.review_status.toLowerCase() !== "active";
    out.set(item.retailer_id, reviewBlocked ? item.review_status : item.availability);
  }
  return out;
}

/**
 * Consulta o status remoto ao vivo (ML/Shopee/Facebook) para um conjunto de
 * listings e grava o valor normalizado nos que mudaram. Fase de espelhamento
 * marketplace→Dexo: usada pelo GET /listings/status?live=1 (dialog) e pela
 * varredura periódica. Magalu e OLX ficam de fora até a leitura de status da
 * API ser validada/implementada.
 * Kill-switch: LISTING_STATUS_SYNC_DISABLED=1 ⇒ Map vazio. Nunca lança.
 *
 * EGRESS/PERF: fetch ML via multiget lean (attributes=id,status), writes via
 * updateStatusLean (3 colunas), e os grupos por conta rodam em PARALELO —
 * cada grupo é try/catch isolado, então uma conta lenta/quebrada não atrasa
 * nem derruba as demais (importa no live=1, que responde ao dialog).
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
        row.marketplaceAccount.accessToken &&
        // Kill-switch: não consulta status ao vivo de plataforma desligada
        // (cobre o live=1 do dialog, que escapava do kill-switch).
        !isPlatformDisabled(row.marketplaceAccount.platform),
    );
    if (eligible.length === 0) return changed;

    const byAccount = new Map<string, RefreshableListingRow[]>();
    for (const row of eligible) {
      const accountId = row.marketplaceAccount!.id;
      const group = byAccount.get(accountId);
      if (group) group.push(row);
      else byAccount.set(accountId, [row]);
    }

    const processGroup = async (group: RefreshableListingRow[]) => {
      const account = group[0].marketplaceAccount!;
      try {
        let rawByExternalId: Map<string, string | undefined> | null = null;

        if (account.platform === "MERCADO_LIVRE") {
          const accessToken = await ensureFreshMLToken(account);
          const ids = [...new Set(group.map((r) => r.externalListingId))];
          const items = await MLApiService.getItemsStatuses(accessToken, ids);
          const statusById = new Map(
            items.map((item) => [String(item.id), item.status]),
          );
          rawByExternalId = new Map(
            group.map((r) => [
              r.externalListingId,
              statusById.get(r.externalListingId),
            ]),
          );
        } else if (account.platform === "SHOPEE") {
          const accessToken = await ensureFreshShopeeToken(account);
          if (!accessToken) return;
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
        } else if (account.platform === "FACEBOOK") {
          await reloadFreshTokens(account);
          if (!account.accessToken) return;
          const retailerIds = [
            ...new Set(group.map((r) => r.externalListingId)),
          ];
          const statusByRetailerId = await getFacebookItemStatuses(
            account.accessToken,
            retailerIds,
            account.fbCatalogId,
          );
          rawByExternalId = new Map(
            group.map((r) => [
              r.externalListingId,
              statusByRetailerId.get(r.externalListingId),
            ]),
          );
        } else {
          // MAGALU: leitura de status da API ainda não validada (TODO na
          // MagaluApiService) — sem espelhamento ativo nesta fase. OLX: a
          // leitura de status do anúncio publicado ainda não existe (fase
          // futura do autoupload) — sem espelhamento ativo.
          return;
        }

        for (const row of group) {
          const normalized = normalizeListingStatus(
            account.platform,
            rawByExternalId.get(row.externalListingId),
          );
          if (!normalized || normalized === row.status) continue;
          try {
            const updated = await ListingRepository.updateStatusLean(
              row.id,
              normalized,
            );
            changed.set(row.id, {
              status: normalized,
              updatedAt: updated?.updatedAt ?? new Date(),
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
    };

    await Promise.all([...byAccount.values()].map(processGroup));

    return changed;
  }
}
