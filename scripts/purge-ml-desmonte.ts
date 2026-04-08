import "dotenv/config";
import axios from "axios";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import prisma from "../app/lib/prisma";
import { MLApiService } from "../app/marketplaces/services/ml-api.service";
import { ML_CONSTANTS } from "../app/marketplaces/mercado-livre/ml-constants";
import {
  JB_AUTOPECAS_BLOCKLIST,
  JB_DESMONTE_TARGET,
  buildStatusCounts,
  ensureTargetAccessToken,
  fetchSellerInventorySnapshot,
  isActionableStatus,
  isLikelyAuthErrorMessage,
  parsePositiveInteger,
  refreshTargetTokens,
  resolveTargetAccount,
  selectActionableItems,
  sleep,
  type InventoryRecord,
  type StructuredLog,
  type TargetTokenContext,
} from "./lib/jb-desmonte-purge";

const DEFAULT_OUTPUT_DIR = path.resolve(process.cwd(), "scripts", "output");
const CLOSE_RETRY_ATTEMPTS = 5;
const CLOSE_THROTTLE_MS = 180;
const SAMPLE_LIMIT = 25;

export interface PurgeCliOptions {
  help: boolean;
  dryRun: boolean;
  confirmFlag: boolean;
  confirmEnv: boolean;
  reviewedAccountId?: string;
  actionableLimit?: number;
  outputDir: string;
  usedLegacyMaxAlias: boolean;
}

interface RunFiles {
  backupJsonPath: string;
  backupCsvPath: string;
  summaryJsonPath: string;
  eventsJsonlPath: string;
}

interface ExecutionCounters {
  found: number;
  actionable: number;
  selectedActionable: number;
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  wouldProcess: number;
  tokenRefreshCount: number;
}

interface CloseResponse {
  httpStatus: number;
  returnedStatus: string;
  sellerId?: string;
}

function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

function getFlagValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) {
    return undefined;
  }

  return argv[index + 1];
}

export function parsePurgeCliOptions(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): PurgeCliOptions {
  const help = hasFlag(argv, "--help") || hasFlag(argv, "-h");
  const confirmFlag = hasFlag(argv, "--confirm");
  const confirmEnv = env.CONFIRM_JB_DESMONTE_PURGE === "true";
  const forceDryRun = hasFlag(argv, "--dry-run");
  const reviewedAccountId =
    getFlagValue(argv, "--account-id") || env.ML_TARGET_ACCOUNT_ID || undefined;
  const actionableLimitFlag = getFlagValue(argv, "--actionable-limit");
  const legacyMaxFlag = getFlagValue(argv, "--max");

  if (actionableLimitFlag && legacyMaxFlag) {
    throw new Error("Use either --actionable-limit or --max, not both");
  }

  const actionableLimit = parsePositiveInteger(
    actionableLimitFlag ?? legacyMaxFlag,
    actionableLimitFlag ? "--actionable-limit" : "--max",
  );

  return {
    help,
    confirmFlag,
    confirmEnv,
    dryRun: forceDryRun || !(confirmFlag && confirmEnv),
    reviewedAccountId,
    actionableLimit,
    outputDir: path.resolve(
      getFlagValue(argv, "--output-dir") || DEFAULT_OUTPUT_DIR,
    ),
    usedLegacyMaxAlias: Boolean(legacyMaxFlag),
  };
}

export function validatePurgeCliOptions(options: PurgeCliOptions): void {
  if (options.confirmFlag && !options.confirmEnv) {
    throw new Error(
      "Confirmed execution requires CONFIRM_JB_DESMONTE_PURGE=true in the environment",
    );
  }

  if (!options.dryRun && !options.reviewedAccountId) {
    throw new Error("Confirmed execution requires --account-id");
  }
}

function printHelp(): void {
  console.log(`Safe Mercado Livre purge for JB Desmonte.

Usage:
  npx tsx scripts/purge-ml-desmonte.ts --dry-run --account-id ${JB_DESMONTE_TARGET.reviewedAccountId}
  npx tsx scripts/purge-ml-desmonte.ts --confirm --account-id ${JB_DESMONTE_TARGET.reviewedAccountId} --actionable-limit 25

Flags:
  --dry-run                 Review mode. This is the default.
  --confirm                 Enables real execution, but only with CONFIRM_JB_DESMONTE_PURGE=true.
  --account-id <id>         Reviewed MarketplaceAccount id for JB Desmonte.
  --actionable-limit <n>    Limit the number of active/paused listings selected for execution.
  --max <n>                 Legacy alias for --actionable-limit.
  --output-dir <path>       Directory for JSON, CSV, summary, and JSONL outputs.
  --help, -h                Show this help message.

Notes:
  - Target userId: ${JB_DESMONTE_TARGET.userId}
  - Target sellerId: ${JB_DESMONTE_TARGET.sellerId}
  - Blocked sellerId: ${Array.from(JB_AUTOPECAS_BLOCKLIST.sellerIds).join(", ")}
  - Dry-run writes a full backup/export before any mutation.
`);
}

function ensureOutputDir(outputDir: string): void {
  fs.mkdirSync(outputDir, { recursive: true });
}

function createRunFiles(outputDir: string): RunFiles {
  ensureOutputDir(outputDir);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const prefix = path.join(outputDir, `jb-desmonte-${timestamp}`);

  return {
    backupJsonPath: `${prefix}-backup.json`,
    backupCsvPath: `${prefix}-backup.csv`,
    summaryJsonPath: `${prefix}-summary.json`,
    eventsJsonlPath: `${prefix}-events.jsonl`,
  };
}

function createJsonlLogger(eventsJsonlPath: string): {
  log: StructuredLog;
  close: () => Promise<void>;
} {
  const stream = fs.createWriteStream(eventsJsonlPath, { flags: "a" });

  const shouldEchoToConsole = (eventName: unknown) => {
    if (typeof eventName !== "string") {
      return true;
    }

    return ![
      "listing_skipped",
      "listing_would_close",
      "listing_closed",
    ].includes(eventName);
  };

  const log: StructuredLog = (entry) => {
    const payload = {
      timestamp: new Date().toISOString(),
      ...entry,
    };
    const line = `${JSON.stringify(payload)}\n`;
    stream.write(line);
    if (shouldEchoToConsole(entry.event)) {
      console.log(JSON.stringify(payload));
    }
  };

  const close = async () => {
    await new Promise<void>((resolve, reject) => {
      stream.end(() => resolve());
      stream.on("error", reject);
    });
  };

  return { log, close };
}

function escapeCsvValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  const text = Array.isArray(value) ? value.join("|") : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function writeBackupFiles(
  files: RunFiles,
  metadata: Record<string, unknown>,
  inventory: InventoryRecord[],
): void {
  const backupPayload = {
    metadata,
    items: inventory,
  };

  fs.writeFileSync(files.backupJsonPath, JSON.stringify(backupPayload, null, 2));

  const headers = [
    "id",
    "seller_id",
    "status",
    "sub_status",
    "title",
    "price",
    "available_quantity",
    "seller_custom_field",
    "permalink",
    "date_created",
    "last_updated",
  ];

  const lines = [
    headers.join(","),
    ...inventory.map((item) =>
      [
        item.id,
        item.seller_id,
        item.status,
        item.sub_status,
        item.title,
        item.price,
        item.available_quantity,
        item.seller_custom_field,
        item.permalink,
        item.date_created,
        item.last_updated,
      ]
        .map(escapeCsvValue)
        .join(","),
    ),
  ];

  fs.writeFileSync(files.backupCsvPath, lines.join("\n"));
}

function sampleItems(items: InventoryRecord[], limit = SAMPLE_LIMIT): Array<Record<string, unknown>> {
  return items.slice(0, limit).map((item) => ({
    id: item.id,
    seller_id: item.seller_id,
    status: item.status,
    sub_status: item.sub_status,
    title: item.title,
  }));
}

function trimValue(value: unknown, maxLength = 500): string {
  const text =
    typeof value === "string" ? value : JSON.stringify(value ?? null);
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function parseRetryAfterMs(headerValue: string | string[] | undefined): number | undefined {
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (!raw) {
    return undefined;
  }

  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const asDate = new Date(raw);
  if (!Number.isNaN(asDate.getTime())) {
    return Math.max(asDate.getTime() - Date.now(), 0);
  }

  return undefined;
}

async function closeRemoteListing(
  accessToken: string,
  itemId: string,
  log: StructuredLog,
): Promise<CloseResponse> {
  for (let attempt = 1; attempt <= CLOSE_RETRY_ATTEMPTS; attempt += 1) {
    const response = await axios.put(
      `${ML_CONSTANTS.API_URL}/items/${itemId}`,
      { status: "closed" },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        timeout: 15_000,
        validateStatus: () => true,
      },
    );

    if (response.status >= 200 && response.status < 300) {
      const returnedStatus = String(response.data?.status ?? "");
      const sellerId =
        response.data?.seller_id === undefined
          ? undefined
          : String(response.data.seller_id);

      if (sellerId && sellerId !== JB_DESMONTE_TARGET.sellerId) {
        throw new Error(
          `Close response seller mismatch for ${itemId}: expected ${JB_DESMONTE_TARGET.sellerId}, got ${sellerId}`,
        );
      }

      if (returnedStatus !== "closed") {
        throw new Error(
          `Close response for ${itemId} returned status "${returnedStatus}" instead of "closed"`,
        );
      }

      return {
        httpStatus: response.status,
        returnedStatus,
        sellerId,
      };
    }

    const retryAfterMs = parseRetryAfterMs(response.headers["retry-after"]);
    const retriable = response.status === 429 || response.status >= 500;
    if (retriable && attempt < CLOSE_RETRY_ATTEMPTS) {
      const waitMs = retryAfterMs ?? attempt * 1_250;
      log({
        level: "warn",
        event: "close_retry_scheduled",
        itemId,
        attempt,
        httpStatus: response.status,
        waitMs,
        responseBody: trimValue(response.data),
      });
      await sleep(waitMs);
      continue;
    }

    throw new Error(
      `Close failed for ${itemId} with HTTP ${response.status}: ${trimValue(response.data)}`,
    );
  }

  throw new Error(`Close failed for ${itemId}: retry budget exhausted`);
}

async function refetchCurrentStatus(
  accessToken: string,
  itemId: string,
): Promise<InventoryRecord | null> {
  try {
    const currentItem = await MLApiService.getItemDetails(accessToken, itemId);
    return {
      id: currentItem.id,
      seller_id: currentItem.seller_id,
      status: currentItem.status,
      sub_status: currentItem.sub_status ?? [],
      title: currentItem.title,
      price: currentItem.price,
      available_quantity: currentItem.available_quantity,
      seller_custom_field: currentItem.seller_custom_field,
      permalink: currentItem.permalink,
      date_created: currentItem.date_created,
      last_updated: currentItem.last_updated,
    };
  } catch {
    return null;
  }
}

async function closeSelectedItem(
  account: { id: string; externalUserId: string | null },
  item: InventoryRecord,
  tokenContext: TargetTokenContext,
  log: StructuredLog,
): Promise<{
  outcome: "closed" | "skipped";
  tokenContext: TargetTokenContext;
  reason?: string;
  httpStatus?: number;
  currentStatus?: string;
}> {
  if (String(item.seller_id) !== JB_DESMONTE_TARGET.sellerId) {
    throw new Error(
      `Refusing to close ${item.id} because seller_id=${item.seller_id} does not match ${JB_DESMONTE_TARGET.sellerId}`,
    );
  }

  if (!isActionableStatus(item.status)) {
    return {
      outcome: "skipped",
      tokenContext,
      reason: `non_actionable_status_${item.status}`,
      currentStatus: item.status,
    };
  }

  let workingTokenContext = tokenContext;

  try {
    const closeResponse = await closeRemoteListing(
      workingTokenContext.accessToken,
      item.id,
      log,
    );
    await sleep(CLOSE_THROTTLE_MS);
    return {
      outcome: "closed",
      tokenContext: workingTokenContext,
      httpStatus: closeResponse.httpStatus,
      currentStatus: closeResponse.returnedStatus,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    if (
      workingTokenContext.refreshToken &&
      isLikelyAuthErrorMessage(errorMessage)
    ) {
      workingTokenContext = await refreshTargetTokens(
        account,
        workingTokenContext.refreshToken,
        log,
      );

      const retryResponse = await closeRemoteListing(
        workingTokenContext.accessToken,
        item.id,
        log,
      );
      await sleep(CLOSE_THROTTLE_MS);
      return {
        outcome: "closed",
        tokenContext: workingTokenContext,
        httpStatus: retryResponse.httpStatus,
        currentStatus: retryResponse.returnedStatus,
      };
    }

    const currentItem = await refetchCurrentStatus(
      workingTokenContext.accessToken,
      item.id,
    );

    if (
      currentItem &&
      String(currentItem.seller_id) === JB_DESMONTE_TARGET.sellerId &&
      !isActionableStatus(currentItem.status)
    ) {
      return {
        outcome: "skipped",
        tokenContext: workingTokenContext,
        reason: `status_changed_to_${currentItem.status}`,
        currentStatus: currentItem.status,
      };
    }

    throw error;
  }
}

function buildInitialSummary(
  options: PurgeCliOptions,
  files: RunFiles,
  inventory: InventoryRecord[],
  selected: InventoryRecord[],
  skippedByLimit: InventoryRecord[],
  blockedAccounts: unknown[],
  resolvedAccount: {
    id: string;
    accountName: string;
    externalUserId: string | null;
  },
  tokenUser: TargetTokenContext["tokenUser"],
) {
  const statusCounts = buildStatusCounts(inventory);
  const actionableTotal = inventory.filter((item) =>
    isActionableStatus(item.status),
  ).length;

  return {
    mode: options.dryRun ? "dry_run" : "confirmed",
    target: {
      userId: JB_DESMONTE_TARGET.userId,
      sellerId: JB_DESMONTE_TARGET.sellerId,
      reviewedAccountId: options.reviewedAccountId ?? null,
      resolvedAccountId: resolvedAccount.id,
      resolvedAccountName: resolvedAccount.accountName,
      resolvedExternalUserId: resolvedAccount.externalUserId,
      tokenUser,
    },
    blocklist: {
      blockedAccountIds: Array.from(JB_AUTOPECAS_BLOCKLIST.accountIds),
      blockedSellerIds: Array.from(JB_AUTOPECAS_BLOCKLIST.sellerIds),
      detectedBlockedAccounts: blockedAccounts,
    },
    files,
    inventory: {
      total: inventory.length,
      statusCounts,
      actionableTotal,
      selectedActionableTotal: selected.length,
      skippedByLimitTotal: skippedByLimit.length,
      actionablePreview: sampleItems(selected),
    },
  };
}

function isDirectExecution(moduleUrl: string): boolean {
  const entrypoint = process.argv[1];
  if (!entrypoint) {
    return false;
  }

  return pathToFileURL(path.resolve(entrypoint)).href === moduleUrl;
}

async function main(): Promise<void> {
  const options = parsePurgeCliOptions();
  if (options.help) {
    printHelp();
    return;
  }

  validatePurgeCliOptions(options);

  const files = createRunFiles(options.outputDir);
  const { log, close } = createJsonlLogger(files.eventsJsonlPath);

  try {
    log({
      level: "info",
      event: "purge_started",
      dryRun: options.dryRun,
      reviewedAccountId: options.reviewedAccountId ?? null,
      actionableLimit: options.actionableLimit ?? null,
      outputDir: options.outputDir,
      legacyMaxAliasUsed: options.usedLegacyMaxAlias,
    });

    const resolvedTarget = await resolveTargetAccount(options.reviewedAccountId);
    const targetToken = await ensureTargetAccessToken(resolvedTarget.account, log);

    log({
      level: "info",
      event: "target_account_resolved",
      targetAccount: {
        id: resolvedTarget.account.id,
        accountName: resolvedTarget.account.accountName,
        externalUserId: resolvedTarget.account.externalUserId,
        expiresAt: resolvedTarget.account.expiresAt,
      },
      allUserAccounts: resolvedTarget.allUserAccounts,
      blockedUserAccounts: resolvedTarget.blockedUserAccounts,
      tokenUser: targetToken.tokenUser,
    });

    const inventory = await fetchSellerInventorySnapshot(
      targetToken.accessToken,
      JB_DESMONTE_TARGET.sellerId,
      log,
    );

    const selection = selectActionableItems(inventory, options.actionableLimit);
    const initialSummary = buildInitialSummary(
      options,
      files,
      inventory,
      selection.selected,
      selection.skippedByLimit,
      resolvedTarget.blockedUserAccounts,
      {
        id: resolvedTarget.account.id,
        accountName: resolvedTarget.account.accountName,
        externalUserId: resolvedTarget.account.externalUserId,
      },
      targetToken.tokenUser,
    );

    writeBackupFiles(
      files,
      {
        generatedAt: new Date().toISOString(),
        ...initialSummary,
      },
      inventory,
    );

    log({
      level: "info",
      event: "backup_written",
      backupJsonPath: files.backupJsonPath,
      backupCsvPath: files.backupCsvPath,
      totalInventory: inventory.length,
      actionableTotal: selection.actionable.length,
      selectedActionableTotal: selection.selected.length,
    });

    const counters: ExecutionCounters = {
      found: inventory.length,
      actionable: selection.actionable.length,
      selectedActionable: selection.selected.length,
      processed: 0,
      succeeded: 0,
      failed: 0,
      skipped: selection.skippedNonActionable.length + selection.skippedByLimit.length,
      wouldProcess: 0,
      tokenRefreshCount: 0,
    };

    const failureSamples: Array<Record<string, unknown>> = [];
    const skippedSamples: Array<Record<string, unknown>> = [];
    const startedAt = Date.now();

    for (const item of selection.skippedNonActionable) {
      log({
        level: "info",
        event: "listing_skipped",
        itemId: item.id,
        sellerId: item.seller_id,
        status: item.status,
        reason: "non_actionable_status",
      });
    }

    for (const item of selection.skippedByLimit) {
      log({
        level: "info",
        event: "listing_skipped",
        itemId: item.id,
        sellerId: item.seller_id,
        status: item.status,
        reason: "actionable_limit_excluded",
      });
    }

    let workingTokenContext = targetToken;

    for (const item of selection.selected) {
      if (options.dryRun) {
        counters.wouldProcess += 1;
        log({
          level: "info",
          event: "listing_would_close",
          itemId: item.id,
          sellerId: item.seller_id,
          status: item.status,
        });
        if (counters.wouldProcess % 1000 === 0) {
          log({
            level: "info",
            event: "dry_run_progress",
            wouldProcess: counters.wouldProcess,
            selectedActionable: counters.selectedActionable,
          });
        }
        continue;
      }

      try {
        const previousToken = workingTokenContext.accessToken;
        const result = await closeSelectedItem(
          resolvedTarget.account,
          item,
          workingTokenContext,
          log,
        );
        workingTokenContext = result.tokenContext;
        if (workingTokenContext.accessToken !== previousToken) {
          counters.tokenRefreshCount += 1;
        }

        if (result.outcome === "skipped") {
          counters.processed += 1;
          counters.skipped += 1;
          log({
            level: "warn",
            event: "listing_skipped_during_execution",
            itemId: item.id,
            sellerId: item.seller_id,
            originalStatus: item.status,
            currentStatus: result.currentStatus ?? null,
            reason: result.reason ?? "unknown",
          });

          if (skippedSamples.length < SAMPLE_LIMIT) {
            skippedSamples.push({
              id: item.id,
              reason: result.reason ?? "unknown",
              currentStatus: result.currentStatus ?? null,
            });
          }
          if (counters.processed % 100 === 0) {
            log({
              level: "info",
              event: "execution_progress",
              processed: counters.processed,
              selectedActionable: counters.selectedActionable,
              succeeded: counters.succeeded,
              failed: counters.failed,
              skipped: counters.skipped,
            });
          }
          continue;
        }

        counters.processed += 1;
        counters.succeeded += 1;
        log({
          level: "info",
          event: "listing_closed",
          itemId: item.id,
          sellerId: item.seller_id,
          httpStatus: result.httpStatus ?? null,
        });
        if (counters.processed % 100 === 0) {
          log({
            level: "info",
            event: "execution_progress",
            processed: counters.processed,
            selectedActionable: counters.selectedActionable,
            succeeded: counters.succeeded,
            failed: counters.failed,
            skipped: counters.skipped,
          });
        }
      } catch (error) {
        counters.processed += 1;
        counters.failed += 1;
        const message = error instanceof Error ? error.message : String(error);

        log({
          level: "error",
          event: "listing_close_failed",
          itemId: item.id,
          sellerId: item.seller_id,
          status: item.status,
          error: message,
        });

        if (failureSamples.length < SAMPLE_LIMIT) {
          failureSamples.push({
            id: item.id,
            status: item.status,
            error: message,
          });
        }

        if (counters.processed % 100 === 0) {
          log({
            level: "info",
            event: "execution_progress",
            processed: counters.processed,
            selectedActionable: counters.selectedActionable,
            succeeded: counters.succeeded,
            failed: counters.failed,
            skipped: counters.skipped,
          });
        }
      }
    }

    const finishedAt = Date.now();
    const finalSummary = {
      ...initialSummary,
      execution: {
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: new Date(finishedAt).toISOString(),
        durationMs: finishedAt - startedAt,
        counters,
        failureSamples,
        skippedSamples,
      },
    };

    fs.writeFileSync(files.summaryJsonPath, JSON.stringify(finalSummary, null, 2));

    log({
      level: "info",
      event: "purge_finished",
      summaryJsonPath: files.summaryJsonPath,
      counters,
    });
  } finally {
    await close();
    await prisma.$disconnect();
  }
}

if (isDirectExecution(import.meta.url)) {
  main().catch((error) => {
    const payload = {
      timestamp: new Date().toISOString(),
      level: "error",
      event: "purge_fatal",
      error: error instanceof Error ? error.message : String(error),
    };
    console.error(JSON.stringify(payload));
    process.exitCode = 1;
  });
}
