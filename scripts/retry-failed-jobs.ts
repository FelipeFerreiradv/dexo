import "dotenv/config";
import prisma from "../app/lib/prisma";
import { BulkListingJobRepository } from "../app/marketplaces/repositories/bulk-listing-job.repository";
import type {
  BulkListingItemResult,
  BulkListingPlatform,
  BulkListingRequestSpec,
  BulkOverrideTemplate,
} from "../app/marketplaces/repositories/bulk-listing-job.repository";
import { ListingDispatcher } from "../app/marketplaces/services/listing-dispatcher.service";

interface Args {
  userId: string;
  since: Date | null;
  parallel: number;
  delayChunkMs: number;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const flag = `--${name}=`;
    const found = argv.find((a) => a.startsWith(flag));
    return found ? found.slice(flag.length) : undefined;
  };
  const has = (name: string): boolean => argv.includes(`--${name}`);
  const userId = get("user-id") ?? process.env.IMPORT_USER_ID ?? "";
  if (!userId) throw new Error("--user-id é obrigatório");
  const sinceRaw = get("since");
  const since = sinceRaw ? new Date(sinceRaw) : null;
  const parallelRaw = get("parallel");
  const parallel = parallelRaw && /^\d+$/.test(parallelRaw) ? parseInt(parallelRaw, 10) : 4;
  const delayChunkRaw = get("delay-chunk-ms");
  const delayChunkMs = delayChunkRaw && /^\d+$/.test(delayChunkRaw) ? parseInt(delayChunkRaw, 10) : 5000;
  return { userId, since, parallel, delayChunkMs, dryRun: has("dry-run") };
}

interface FailedItem {
  productId: string;
  platform: BulkListingPlatform;
  accountId: string;
}

async function processJob(
  job: { id: string; results: unknown; requests: unknown; overrideTemplate: unknown },
  userId: string,
  delayChunkMs: number,
  dryRun: boolean,
): Promise<{ jobId: string; newJobId?: string; success: number; failed: number; total: number }> {
  const results = Array.isArray(job.results)
    ? (job.results as Array<{ productId: string; platform: BulkListingPlatform; accountId: string; success: boolean }>)
    : [];
  const failed = results.filter((r) => !r.success);
  if (failed.length === 0) {
    return { jobId: job.id, success: 0, failed: 0, total: 0 };
  }

  const originalRequests = (job.requests as BulkListingRequestSpec[]) || [];
  const findOriginal = (platform: BulkListingPlatform, accountId: string) =>
    originalRequests.find((r) => r.platform === platform && r.accountId === accountId);

  const productIdsSet = new Set<string>();
  const requestsKey = new Map<string, BulkListingRequestSpec>();
  for (const f of failed) {
    productIdsSet.add(f.productId);
    const key = `${f.platform}:${f.accountId}`;
    if (!requestsKey.has(key)) {
      const orig = findOriginal(f.platform, f.accountId);
      requestsKey.set(key, {
        platform: f.platform,
        accountId: f.accountId,
        categoryId: orig?.categoryId,
        mlSettings: orig?.mlSettings,
      });
    }
  }

  const productIds = Array.from(productIdsSet);
  const requests = Array.from(requestsKey.values());
  const total = productIds.length * requests.length;

  console.log(`[retry][${job.id.slice(-6)}] ${failed.length} failed → ${productIds.length} produtos × ${requests.length} requests = ${total}`);

  if (dryRun) {
    return { jobId: job.id, success: 0, failed: 0, total };
  }

  const newJob = await BulkListingJobRepository.create({
    userId,
    productIds,
    requests,
    overrideTemplate: (job.overrideTemplate as BulkOverrideTemplate | null) ?? null,
  });
  console.log(`[retry][${job.id.slice(-6)}] novo job ${newJob.id.slice(-6)} criado`);
  await BulkListingJobRepository.markRunning(newJob.id);

  let progressCount = 0;
  const result = await ListingDispatcher.dispatchBatch({
    userId,
    productIds,
    requests,
    overrideTemplate: (job.overrideTemplate as BulkOverrideTemplate | null) ?? null,
    onItemDone: async (item: BulkListingItemResult) => {
      await BulkListingJobRepository.appendResult(newJob.id, item);
      progressCount++;
      if (progressCount % 50 === 0) {
        console.log(`[retry][${newJob.id.slice(-6)}] ${progressCount}/${total}`);
      }
    },
  });

  await BulkListingJobRepository.markFinal(newJob.id, {
    success: result.success,
    failed: result.failed,
    lastError: result.lastError ?? null,
  });
  console.log(`[retry][${newJob.id.slice(-6)}] FIM: ${result.success}s/${result.failed}f`);

  if (delayChunkMs > 0) {
    await new Promise((r) => setTimeout(r, delayChunkMs));
  }

  return {
    jobId: job.id,
    newJobId: newJob.id,
    success: result.success,
    failed: result.failed,
    total,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `[flags] userId=${args.userId} since=${args.since?.toISOString() ?? "all"} parallel=${args.parallel} delayChunkMs=${args.delayChunkMs} dryRun=${args.dryRun}`,
  );

  const jobs = await prisma.bulkListingJob.findMany({
    where: {
      userId: args.userId,
      status: { in: ["FAILED", "FAILED_PARTIAL"] },
      ...(args.since ? { createdAt: { gte: args.since } } : {}),
    },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      results: true,
      requests: true,
      overrideTemplate: true,
      successItems: true,
      failedItems: true,
      totalItems: true,
    },
  });
  console.log(`[retry] ${jobs.length} jobs FAILED/FAILED_PARTIAL para reprocessar`);

  const totalFailed = jobs.reduce((acc, j) => acc + j.failedItems, 0);
  console.log(`[retry] total de items falhados: ${totalFailed}`);

  const accountQueues = new Map<string, typeof jobs>();
  for (const j of jobs) {
    const reqs = (j.requests as unknown as BulkListingRequestSpec[]) ?? [];
    const accountId = reqs?.[0]?.accountId ?? "unknown";
    if (!accountQueues.has(accountId)) accountQueues.set(accountId, []);
    accountQueues.get(accountId)!.push(j);
  }
  console.log(`[retry] distribuição por conta:`,
    [...accountQueues.entries()].map(([a, js]) => `${a.slice(-6)}=${js.length}j`).join(" "),
  );

  if (args.dryRun) {
    console.log("[retry] DRY-RUN: nada será enfileirado");
    let totalDryItems = 0;
    for (const queue of accountQueues.values()) {
      for (const j of queue) {
        const r = await processJob(j, args.userId, 0, true);
        totalDryItems += r.total;
      }
    }
    console.log(`[retry] dry-run total items que seriam reprocessados: ${totalDryItems}`);
    await prisma.$disconnect();
    return;
  }

  const startedAt = new Date().toISOString();
  let cumulativeS = 0;
  let cumulativeF = 0;

  await Promise.all(
    [...accountQueues.values()].map(async (queue) => {
      for (const j of queue) {
        const r = await processJob(j, args.userId, args.delayChunkMs, false);
        cumulativeS += r.success;
        cumulativeF += r.failed;
      }
    }),
  );

  const finishedAt = new Date().toISOString();
  console.log(`\n[retry] CONCLUÍDO`);
  console.log(`  início: ${startedAt}`);
  console.log(`  fim: ${finishedAt}`);
  console.log(`  jobs reprocessados: ${jobs.length}`);
  console.log(`  total success: ${cumulativeS}`);
  console.log(`  total failed: ${cumulativeF}`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("[fatal]", e);
  process.exit(1);
});
