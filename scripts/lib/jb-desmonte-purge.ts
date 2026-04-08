import prisma from "../../app/lib/prisma";
import { Platform, type MarketplaceAccount } from "@prisma/client";
import { MLApiService } from "../../app/marketplaces/services/ml-api.service";
import { MLOAuthService } from "../../app/marketplaces/services/ml-oauth.service";
import type { MLItemDetails } from "../../app/marketplaces/types/ml-api.types";

export const JB_DESMONTE_TARGET = {
  userId: "cmn5yc4rn0000vsasmwv9m8nc",
  reviewedAccountId: "cmnp6utcf1goj18ighujy0vz1",
  sellerId: "2985478180",
  accountNameHint: "JOTABEDESMONTE",
  platform: Platform.MERCADO_LIVRE,
} as const;

export const JB_AUTOPECAS_BLOCKLIST = {
  accountIds: new Set<string>(["cmn5yipye002n18yma21ge2jx"]),
  sellerIds: new Set<string>(["1289108824"]),
  accountNameHints: ["JOTABE AUTOPECAS", "JB AUTOPECAS"],
} as const;

export type InventoryStatus = MLItemDetails["status"];

export interface InventoryRecord {
  id: string;
  seller_id: number;
  status: InventoryStatus;
  sub_status: string[];
  title: string;
  price: number;
  available_quantity: number;
  seller_custom_field: string | null;
  permalink: string;
  date_created: string;
  last_updated: string;
}

export interface SafeAccountSummary {
  id: string;
  userId: string;
  accountName: string;
  externalUserId: string | null;
  status: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
  listingCount: number;
  orderCount: number;
}

export interface ResolvedTargetAccount {
  account: MarketplaceAccount;
  allUserAccounts: SafeAccountSummary[];
  blockedUserAccounts: SafeAccountSummary[];
}

export interface TargetTokenContext {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  tokenUser: {
    id: string;
    nickname?: string;
    email?: string;
  };
}

export type StructuredLog = (entry: Record<string, unknown>) => void;

const DETAIL_BATCH_SIZE = 200;
const READ_RETRY_ATTEMPTS = 3;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function normalizeMarketplaceLabel(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

export function isBlockedAccountName(accountName: string | null | undefined): boolean {
  const normalized = normalizeMarketplaceLabel(accountName);
  return JB_AUTOPECAS_BLOCKLIST.accountNameHints.some((hint) =>
    normalized.includes(hint),
  );
}

export function isActionableStatus(status: string): boolean {
  return status === "active" || status === "paused";
}

export function buildStatusCounts<T extends { status: string }>(
  items: T[],
): Record<string, number> {
  return items.reduce<Record<string, number>>((counts, item) => {
    counts[item.status] = (counts[item.status] ?? 0) + 1;
    return counts;
  }, {});
}

export function selectActionableItems(
  items: InventoryRecord[],
  actionableLimit?: number,
): {
  actionable: InventoryRecord[];
  selected: InventoryRecord[];
  skippedNonActionable: InventoryRecord[];
  skippedByLimit: InventoryRecord[];
} {
  const actionable = items.filter((item) => isActionableStatus(item.status));
  const skippedNonActionable = items.filter(
    (item) => !isActionableStatus(item.status),
  );

  if (!actionableLimit) {
    return {
      actionable,
      selected: actionable,
      skippedNonActionable,
      skippedByLimit: [],
    };
  }

  return {
    actionable,
    selected: actionable.slice(0, actionableLimit),
    skippedNonActionable,
    skippedByLimit: actionable.slice(actionableLimit),
  };
}

export function parsePositiveInteger(
  rawValue: string | undefined,
  flagName: string,
): number | undefined {
  if (rawValue === undefined) {
    return undefined;
  }

  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flagName} must be a positive integer`);
  }

  return parsed;
}

export function isLikelyAuthErrorMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("invalid access token") ||
    normalized.includes("invalid_token") ||
    normalized.includes("unauthorized") ||
    normalized.includes("401") ||
    normalized.includes("token expirado") ||
    normalized.includes("expired")
  );
}

function assertTargetAccount(account: MarketplaceAccount): void {
  if (account.id && JB_AUTOPECAS_BLOCKLIST.accountIds.has(account.id)) {
    throw new Error(`Resolved account ${account.id} is explicitly blocked`);
  }

  if (
    account.externalUserId &&
    JB_AUTOPECAS_BLOCKLIST.sellerIds.has(String(account.externalUserId))
  ) {
    throw new Error(
      `Resolved seller ${account.externalUserId} is explicitly blocked`,
    );
  }

  if (isBlockedAccountName(account.accountName)) {
    throw new Error(
      `Resolved account name "${account.accountName}" matches the blocked account`,
    );
  }

  if (account.userId !== JB_DESMONTE_TARGET.userId) {
    throw new Error(
      `Resolved account userId mismatch: expected ${JB_DESMONTE_TARGET.userId}, got ${account.userId}`,
    );
  }

  if (account.platform !== JB_DESMONTE_TARGET.platform) {
    throw new Error(
      `Resolved account platform mismatch: expected ${JB_DESMONTE_TARGET.platform}, got ${account.platform}`,
    );
  }

  if (String(account.externalUserId) !== JB_DESMONTE_TARGET.sellerId) {
    throw new Error(
      `Resolved seller mismatch: expected ${JB_DESMONTE_TARGET.sellerId}, got ${account.externalUserId}`,
    );
  }
}

export function assertInventoryOwnership(items: InventoryRecord[]): void {
  const mismatches = items.filter(
    (item) => String(item.seller_id) !== JB_DESMONTE_TARGET.sellerId,
  );

  if (mismatches.length === 0) {
    return;
  }

  const sample = mismatches.slice(0, 5).map((item) => ({
    id: item.id,
    seller_id: item.seller_id,
  }));

  throw new Error(
    `Fetched inventory contains ${mismatches.length} items outside seller ${JB_DESMONTE_TARGET.sellerId}: ${JSON.stringify(sample)}`,
  );
}

export async function withRetry<T>(
  operationName: string,
  operation: () => Promise<T>,
  log?: StructuredLog,
  attempts = READ_RETRY_ATTEMPTS,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) {
        break;
      }

      const waitMs = attempt * 750;
      log?.({
        level: "warn",
        event: "retry_scheduled",
        operation: operationName,
        attempt,
        waitMs,
        error: error instanceof Error ? error.message : String(error),
      });
      await sleep(waitMs);
    }
  }

  throw lastError;
}

export async function resolveTargetAccount(
  reviewedAccountId?: string,
): Promise<ResolvedTargetAccount> {
  const [matchingAccounts, allUserAccounts] = await Promise.all([
    prisma.marketplaceAccount.findMany({
      where: {
        userId: JB_DESMONTE_TARGET.userId,
        platform: JB_DESMONTE_TARGET.platform,
        externalUserId: JB_DESMONTE_TARGET.sellerId,
      },
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
    }),
    prisma.marketplaceAccount.findMany({
      where: {
        userId: JB_DESMONTE_TARGET.userId,
        platform: JB_DESMONTE_TARGET.platform,
      },
      select: {
        id: true,
        userId: true,
        accountName: true,
        externalUserId: true,
        status: true,
        expiresAt: true,
        createdAt: true,
        updatedAt: true,
        _count: {
          select: {
            listings: true,
            orders: true,
          },
        },
      },
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
    }),
  ]);

  if (matchingAccounts.length === 0) {
    throw new Error(
      `No Mercado Livre account found for user ${JB_DESMONTE_TARGET.userId} and seller ${JB_DESMONTE_TARGET.sellerId}`,
    );
  }

  const accountSummaries: SafeAccountSummary[] = allUserAccounts.map((account) => ({
    id: account.id,
    userId: account.userId,
    accountName: account.accountName,
    externalUserId: account.externalUserId,
    status: account.status,
    expiresAt: account.expiresAt,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    listingCount: account._count.listings,
    orderCount: account._count.orders,
  }));

  const blockedUserAccounts = accountSummaries.filter(
    (account) =>
      JB_AUTOPECAS_BLOCKLIST.accountIds.has(account.id) ||
      JB_AUTOPECAS_BLOCKLIST.sellerIds.has(String(account.externalUserId)) ||
      isBlockedAccountName(account.accountName),
  );

  const latestMatchingAccount = matchingAccounts[0];
  assertTargetAccount(latestMatchingAccount);

  if (!reviewedAccountId) {
    return {
      account: latestMatchingAccount,
      allUserAccounts: accountSummaries,
      blockedUserAccounts,
    };
  }

  const reviewedAccount = await prisma.marketplaceAccount.findUnique({
    where: { id: reviewedAccountId },
  });

  if (!reviewedAccount) {
    throw new Error(`Reviewed account ${reviewedAccountId} was not found`);
  }

  assertTargetAccount(reviewedAccount);

  if (latestMatchingAccount.id !== reviewedAccountId) {
    throw new Error(
      `Reviewed account ${reviewedAccountId} is no longer the latest target account. Current target account is ${latestMatchingAccount.id}. Run a fresh dry-run review before confirming execution.`,
    );
  }

  return {
    account: reviewedAccount,
    allUserAccounts: accountSummaries,
    blockedUserAccounts,
  };
}

async function validateTokenOwner(
  accessToken: string,
): Promise<TargetTokenContext["tokenUser"]> {
  const userInfo = await MLOAuthService.getUserInfo(accessToken);
  const tokenUserId = String(userInfo.id);

  if (tokenUserId !== JB_DESMONTE_TARGET.sellerId) {
    throw new Error(
      `Token owner mismatch: expected seller ${JB_DESMONTE_TARGET.sellerId}, got ${tokenUserId}`,
    );
  }

  if (JB_AUTOPECAS_BLOCKLIST.sellerIds.has(tokenUserId)) {
    throw new Error(`Token owner ${tokenUserId} is explicitly blocked`);
  }

  return {
    id: tokenUserId,
    nickname: userInfo.nickname,
    email: userInfo.email,
  };
}

export async function refreshTargetTokens(
  account: Pick<MarketplaceAccount, "id" | "externalUserId">,
  refreshToken: string,
  log?: StructuredLog,
): Promise<TargetTokenContext> {
  log?.({
    level: "warn",
    event: "refreshing_target_token",
    accountId: account.id,
    sellerId: account.externalUserId,
  });

  const refreshed = await MLOAuthService.refreshAccessToken(refreshToken);
  const expiresAt = new Date(Date.now() + refreshed.expiresIn * 1000);

  await prisma.marketplaceAccount.update({
    where: { id: account.id },
    data: {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt,
    },
  });

  const tokenUser = await validateTokenOwner(refreshed.accessToken);

  return {
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken,
    expiresAt,
    tokenUser,
  };
}

export async function ensureTargetAccessToken(
  account: MarketplaceAccount,
  log?: StructuredLog,
): Promise<TargetTokenContext> {
  if (!account.accessToken) {
    throw new Error(`Account ${account.id} does not have an access token`);
  }

  const expired = account.expiresAt.getTime() <= Date.now();
  if (expired) {
    if (!account.refreshToken) {
      throw new Error(
        `Account ${account.id} is expired and does not have a refresh token`,
      );
    }
    return refreshTargetTokens(account, account.refreshToken, log);
  }

  try {
    const tokenUser = await validateTokenOwner(account.accessToken);
    return {
      accessToken: account.accessToken,
      refreshToken: account.refreshToken,
      expiresAt: account.expiresAt,
      tokenUser,
    };
  } catch (error) {
    if (!account.refreshToken) {
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);
    if (!isLikelyAuthErrorMessage(message)) {
      throw error;
    }

    return refreshTargetTokens(account, account.refreshToken, log);
  }
}

export async function fetchSellerInventorySnapshot(
  accessToken: string,
  sellerId: string,
  log?: StructuredLog,
): Promise<InventoryRecord[]> {
  const itemIds = await withRetry(
    "fetch_seller_item_ids",
    () => MLApiService.getSellerItemIds(accessToken, sellerId),
    log,
  );

  const uniqueIds = Array.from(new Set(itemIds)).sort((left, right) =>
    left.localeCompare(right),
  );

  log?.({
    level: "info",
    event: "seller_item_ids_fetched",
    totalIds: uniqueIds.length,
  });

  const inventory: InventoryRecord[] = [];

  for (let offset = 0; offset < uniqueIds.length; offset += DETAIL_BATCH_SIZE) {
    const batchIds = uniqueIds.slice(offset, offset + DETAIL_BATCH_SIZE);
    const batchDetails = await withRetry(
      "fetch_item_details_batch",
      () => MLApiService.getItemsDetails(accessToken, batchIds),
      log,
    );

    inventory.push(
      ...batchDetails.map((item) => ({
        id: item.id,
        seller_id: item.seller_id,
        status: item.status,
        sub_status: item.sub_status ?? [],
        title: item.title,
        price: item.price,
        available_quantity: item.available_quantity,
        seller_custom_field: item.seller_custom_field,
        permalink: item.permalink,
        date_created: item.date_created,
        last_updated: item.last_updated,
      })),
    );

    log?.({
      level: "info",
      event: "inventory_batch_fetched",
      processed: Math.min(offset + batchIds.length, uniqueIds.length),
      totalIds: uniqueIds.length,
    });

    await sleep(125);
  }

  inventory.sort((left, right) => left.id.localeCompare(right.id));
  assertInventoryOwnership(inventory);

  return inventory;
}
