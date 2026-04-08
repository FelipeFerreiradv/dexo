import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import prisma from "../app/lib/prisma";
import {
  JB_DESMONTE_TARGET,
  buildStatusCounts,
  ensureTargetAccessToken,
  fetchSellerInventorySnapshot,
  isActionableStatus,
  parsePositiveInteger,
  resolveTargetAccount,
} from "./lib/jb-desmonte-purge";

const DEFAULT_OUTPUT_DIR = path.resolve(process.cwd(), "scripts", "output");
const DEFAULT_SAMPLE_LIMIT = 25;

interface VerifyCliOptions {
  help: boolean;
  reviewedAccountId?: string;
  outputDir: string;
  sampleLimit: number;
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

function parseVerifyCliOptions(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): VerifyCliOptions {
  return {
    help: hasFlag(argv, "--help") || hasFlag(argv, "-h"),
    reviewedAccountId:
      getFlagValue(argv, "--account-id") ||
      env.ML_TARGET_ACCOUNT_ID ||
      JB_DESMONTE_TARGET.reviewedAccountId,
    outputDir: path.resolve(
      getFlagValue(argv, "--output-dir") || DEFAULT_OUTPUT_DIR,
    ),
    sampleLimit:
      parsePositiveInteger(getFlagValue(argv, "--sample-limit"), "--sample-limit") ??
      DEFAULT_SAMPLE_LIMIT,
  };
}

function printHelp(): void {
  console.log(`Read-only verification for the JB Desmonte Mercado Livre purge.

Usage:
  npx tsx scripts/verify-ml-desmonte-purge.ts --account-id ${JB_DESMONTE_TARGET.reviewedAccountId}

Flags:
  --account-id <id>       Reviewed MarketplaceAccount id for JB Desmonte.
  --sample-limit <n>      Number of active/paused items to include in the failure sample.
  --output-dir <path>     Directory for the verification JSON report.
  --help, -h              Show this help message.
`);
}

function createReportPath(outputDir: string): string {
  fs.mkdirSync(outputDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(outputDir, `jb-desmonte-verify-${timestamp}.json`);
}

function isDirectExecution(moduleUrl: string): boolean {
  const entrypoint = process.argv[1];
  if (!entrypoint) {
    return false;
  }

  return pathToFileURL(path.resolve(entrypoint)).href === moduleUrl;
}

async function main(): Promise<void> {
  const options = parseVerifyCliOptions();
  if (options.help) {
    printHelp();
    return;
  }

  const resolvedTarget = await resolveTargetAccount(options.reviewedAccountId);
  const tokenContext = await ensureTargetAccessToken(resolvedTarget.account);
  const inventory = await fetchSellerInventorySnapshot(
    tokenContext.accessToken,
    JB_DESMONTE_TARGET.sellerId,
  );

  const statusCounts = buildStatusCounts(inventory);
  const actionable = inventory.filter((item) => isActionableStatus(item.status));
  const report = {
    generatedAt: new Date().toISOString(),
    target: {
      userId: JB_DESMONTE_TARGET.userId,
      sellerId: JB_DESMONTE_TARGET.sellerId,
      reviewedAccountId: options.reviewedAccountId ?? null,
      resolvedAccountId: resolvedTarget.account.id,
      resolvedAccountName: resolvedTarget.account.accountName,
      tokenUser: tokenContext.tokenUser,
    },
    blockedAccounts: resolvedTarget.blockedUserAccounts,
    inventory: {
      total: inventory.length,
      statusCounts,
      actionableRemaining: actionable.length,
      actionableSample: actionable.slice(0, options.sampleLimit).map((item) => ({
        id: item.id,
        status: item.status,
        sub_status: item.sub_status,
        seller_id: item.seller_id,
        title: item.title,
      })),
    },
    verdict: actionable.length === 0 ? "pass" : "fail",
  };

  const reportPath = createReportPath(options.outputDir);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      event: "jb_desmonte_verify_complete",
      reportPath,
      verdict: report.verdict,
      statusCounts,
      actionableRemaining: actionable.length,
      blockedAccounts: resolvedTarget.blockedUserAccounts,
    }),
  );

  if (actionable.length > 0) {
    throw new Error(
      `Verification failed: ${actionable.length} active/paused listings still remain for seller ${JB_DESMONTE_TARGET.sellerId}`,
    );
  }
}

if (isDirectExecution(import.meta.url)) {
  main()
    .catch((error) => {
      console.error(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: "error",
          event: "jb_desmonte_verify_failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
