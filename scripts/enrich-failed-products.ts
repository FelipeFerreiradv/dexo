import "dotenv/config";
import { Prisma } from "@prisma/client";
import prisma from "../app/lib/prisma";

interface Args {
  userId: string;
  since: Date | null;
  dryRun: boolean;
  limit: number | null;
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
  const limitRaw = get("limit");
  const limit = limitRaw && /^\d+$/.test(limitRaw) ? parseInt(limitRaw, 10) : null;
  return { userId, since, dryRun: has("dry-run"), limit };
}

interface Derived {
  familyName: string;
  partNumber: string | null;
}

function deriveFamilyAndPart(
  name: string,
  sku: string,
  brand: string | null,
  model: string | null,
): Derived {
  const cleaned = name
    .replace(/[^\p{L}\p{N}\s.\-/]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Part number: alphanumérico ≥ 7 chars com pelo menos 4 dígitos seguidos
  const allMatches = [...cleaned.matchAll(/\b([A-Za-z0-9]{7,})\b/g)]
    .map((m) => m[1])
    .filter((t) => /\d{4,}/.test(t));
  const partNumber = allMatches.length > 0 ? allMatches[allMatches.length - 1] : null;

  const tokens = cleaned.split(" ");
  const familyTokens: string[] = [];
  for (const t of tokens) {
    if (familyTokens.length >= 5) break;
    if (/^\d{4}$/.test(t)) break;
    if (/^\d{4}\/\d{2,4}$/.test(t)) break;
    if (/^\d{4}-\d{2,4}$/.test(t)) break;
    if (/^[Aa]$/.test(t) && familyTokens.length > 0) break;
    if (partNumber && t === partNumber) break;
    if (/^\d/.test(t) && t.length >= 6) break;
    if (t.length === 1 && !/[a-zA-Z]/.test(t)) continue;
    familyTokens.push(t);
  }
  let familyName = familyTokens.join(" ").trim();
  if (familyName.length > 60) familyName = familyName.slice(0, 60).trim();
  if (!familyName) familyName = brand && model ? `${brand} ${model}` : sku;
  return { familyName, partNumber };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(`[enrich] userId=${args.userId} since=${args.since?.toISOString() ?? "all"} dryRun=${args.dryRun}`);

  // Coletar productIds que falharam em algum job
  const jobs = await prisma.bulkListingJob.findMany({
    where: {
      userId: args.userId,
      status: { in: ["FAILED", "FAILED_PARTIAL"] },
      ...(args.since ? { createdAt: { gte: args.since } } : {}),
    },
    select: { results: true },
  });

  const failedProductIds = new Set<string>();
  for (const j of jobs) {
    const results = Array.isArray(j.results)
      ? (j.results as Array<{ productId: string; success: boolean }>)
      : [];
    for (const r of results) {
      if (!r.success) failedProductIds.add(r.productId);
    }
  }
  console.log(`[enrich] ${jobs.length} jobs, ${failedProductIds.size} productIds distintos com falha`);

  let productIds = Array.from(failedProductIds);
  if (args.limit) productIds = productIds.slice(0, args.limit);

  let processed = 0;
  let updatedFamily = 0;
  let updatedPart = 0;
  const batchSize = 200;

  for (let i = 0; i < productIds.length; i += batchSize) {
    const batch = productIds.slice(i, i + batchSize);
    const products = await prisma.product.findMany({
      where: { id: { in: batch } },
      select: {
        id: true,
        sku: true,
        name: true,
        brand: true,
        model: true,
        partNumber: true,
        attributes: true,
      },
    });

    if (args.dryRun) {
      for (const p of products) {
        const { familyName, partNumber } = deriveFamilyAndPart(
          p.name,
          p.sku,
          p.brand,
          p.model,
        );
        const wouldSetFamily = !((p.attributes as { familyName?: string } | null)?.familyName);
        const wouldSetPart = !p.partNumber && !!partNumber;
        if (wouldSetFamily) updatedFamily++;
        if (wouldSetPart) updatedPart++;
      }
      processed += products.length;
      continue;
    }

    const updates = products.map((p) => {
      const { familyName, partNumber } = deriveFamilyAndPart(
        p.name,
        p.sku,
        p.brand,
        p.model,
      );
      const currentAttrs =
        (p.attributes as Record<string, unknown> | null) ?? {};
      const hasFamilyName = typeof currentAttrs["familyName"] === "string" && (currentAttrs["familyName"] as string).length > 0;
      const newAttrs: Record<string, unknown> = { ...currentAttrs };
      let touched = false;
      if (!hasFamilyName) {
        newAttrs["familyName"] = familyName;
        touched = true;
        updatedFamily++;
      }
      const newPart = !p.partNumber && partNumber ? partNumber : p.partNumber;
      const willUpdatePart = !p.partNumber && !!partNumber;
      if (willUpdatePart) updatedPart++;

      if (!touched && !willUpdatePart) return null;

      const data: Record<string, unknown> = {};
      if (touched) data.attributes = newAttrs as Prisma.InputJsonValue;
      if (willUpdatePart) data.partNumber = newPart;
      return prisma.product.update({ where: { id: p.id }, data });
    });

    const validUpdates = updates.filter(
      (u): u is NonNullable<typeof u> => u !== null,
    );
    if (validUpdates.length > 0) {
      await prisma.$transaction(validUpdates);
    }
    processed += products.length;
    if (i % (batchSize * 5) === 0) {
      console.log(`[enrich] processados=${processed}/${productIds.length} updatedFamily=${updatedFamily} updatedPart=${updatedPart}`);
    }
  }

  console.log(`\n[enrich] CONCLUÍDO`);
  console.log(`  productIds processados: ${processed}`);
  console.log(`  attributes.familyName setado em: ${updatedFamily}`);
  console.log(`  partNumber setado em: ${updatedPart}`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("[fatal]", e);
  process.exit(1);
});
