import "dotenv/config";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import XLSX from "xlsx";
import {
  DEFAULT_SHEET_NAME,
  buildPath,
  extractProductsFromRows,
  normalizeCode,
  readSheetRows,
} from "./location-sync-helpers";

const prisma = new PrismaClient();

const TARGET_USER_ID =
  process.env.LOC_SYNC_USER_ID ?? process.env.PRODUCTS_USER_ID ?? "cmn5yc4rn0000vsasmwv9m8nc";
const INPUT_PATH = path.resolve(
  process.env.LOC_SYNC_XLSX ?? process.env.PRODUCTS_XLSX ?? "C:/Users/Casa/Downloads/Report.xlsx",
);
const SHEET_NAME = process.env.LOC_SYNC_SHEET ?? DEFAULT_SHEET_NAME;
const DRY_RUN = process.argv.includes("--dry-run");
const BATCH = Number(process.env.LOC_SYNC_BATCH ?? 200);
const MAX_UPDATES = process.env.LOC_SYNC_MAX_UPDATES
  ? Number(process.env.LOC_SYNC_MAX_UPDATES)
  : Infinity;

type LocationNode = {
  id: string;
  code: string;
  parentId: string | null;
};

type LocationEnsureResult = {
  leafId?: string;
  created: string[];
  conflicts: Array<{ code: string; expectedParent: string | null; actualParent: string | null }>;
};

function chunk<T>(items: T[], size: number): T[][] {
  const parts: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    parts.push(items.slice(i, i + size));
  }
  return parts;
}

async function main() {
  console.log(
    `[config] user=${TARGET_USER_ID} file=${INPUT_PATH} sheet=${SHEET_NAME} dryRun=${DRY_RUN}`,
  );

  const workbook = XLSX.readFile(INPUT_PATH);
  const rows = readSheetRows(workbook, SHEET_NAME);
  const { products, duplicatePathConflicts } = extractProductsFromRows(rows);

  console.log(
    `[parse] rows=${rows.length} uniqueSKUs=${products.length} duplicatePathConflicts=${duplicatePathConflicts.length}`,
  );

  const uniquePaths = new Map<string, string[]>();
  for (const { segments } of products) {
    if (segments.length === 0) continue;
    const key = buildPath(segments);
    if (!uniquePaths.has(key)) uniquePaths.set(key, segments);
  }

  // Load existing locations for the user once
  const existingLocations = await prisma.location.findMany({
    where: { userId: TARGET_USER_ID },
    select: { id: true, code: true, parentId: true },
  });

  const locationsByCode = new Map<string, LocationNode>();
  existingLocations.forEach((loc) =>
    locationsByCode.set(normalizeCode(loc.code), {
      id: loc.id,
      code: normalizeCode(loc.code),
      parentId: loc.parentId,
    }),
  );

  const ensureCache = new Map<string, string>(); // pathKey -> leafId
  const locationConflicts: LocationEnsureResult["conflicts"] = [];
  const createdLocations: string[] = [];

  const ensurePath = async (segments: string[]): Promise<LocationEnsureResult> => {
    const created: string[] = [];
    const conflicts: LocationEnsureResult["conflicts"] = [];
    let parentId: string | null = null;
    let leafId: string | undefined;

    for (const seg of segments) {
      const code = normalizeCode(seg);
      const existing = locationsByCode.get(code);
      if (existing) {
        if (existing.parentId !== parentId && parentId !== null) {
          conflicts.push({
            code,
            expectedParent: parentId,
            actualParent: existing.parentId,
          });
        }
        leafId = existing.id;
        parentId = existing.id;
        continue;
      }

      if (DRY_RUN) {
        // In dry-run, simulate ids to keep path continuity
        const fakeId = `dry-${code}-${Math.random().toString(16).slice(2, 8)}`;
        locationsByCode.set(code, { id: fakeId, code, parentId });
        leafId = fakeId;
        parentId = fakeId;
        created.push(code);
        continue;
      }

      // Double-check in DB in case another run created it meanwhile
      const preexisting = await prisma.location.findFirst({
        where: { userId: TARGET_USER_ID, code },
        select: { id: true, code: true, parentId: true },
      });
      if (preexisting) {
        locationsByCode.set(code, {
          id: preexisting.id,
          code,
          parentId: preexisting.parentId,
        });
        leafId = preexisting.id;
        parentId = preexisting.id;
        continue;
      }

      let createdLoc;
      try {
        createdLoc = await prisma.location.create({
          data: {
            userId: TARGET_USER_ID,
            code,
            description: null,
            maxCapacity: 0,
            parentId,
          },
          select: { id: true, code: true, parentId: true },
        });
      } catch (err: any) {
        // If unique constraint hit due to race, reload and continue
        if (err?.code === "P2002") {
          const fallback = await prisma.location.findFirst({
            where: { userId: TARGET_USER_ID, code },
            select: { id: true, code: true, parentId: true },
          });
          if (fallback) {
            locationsByCode.set(code, {
              id: fallback.id,
              code,
              parentId: fallback.parentId,
            });
            leafId = fallback.id;
            parentId = fallback.id;
            continue;
          }
        }
        throw err;
      }

      locationsByCode.set(code, {
        id: createdLoc.id,
        code,
        parentId: createdLoc.parentId,
      });
      leafId = createdLoc.id;
      parentId = createdLoc.id;
      created.push(code);
      createdLocations.push(buildPath(segments.slice(0, created.length)));
    }

    return { leafId, created, conflicts };
  };

  // Ensure all locations up-front to detect conflicts before touching products
  for (const [, segments] of uniquePaths) {
    const pathKey = buildPath(segments);
    if (ensureCache.has(pathKey)) continue;
    const res = await ensurePath(segments);
    if (res.leafId) ensureCache.set(pathKey, res.leafId);
    locationConflicts.push(...res.conflicts);
  }
  console.log(`[stage] locations ensured (unique paths: ${uniquePaths.size})`);

  // Fetch target user products for SKUs in the sheet
  const skus = products.map((p) => p.sku);
  const productDb = await prisma.product.findMany({
    where: { userId: TARGET_USER_ID, sku: { in: skus } },
    select: { id: true, sku: true, locationId: true, location: true },
  });
  const productMap = new Map(productDb.map((p) => [p.sku, p]));

  const missingSkus: string[] = [];
  const missingPaths: string[] = [];
  const updates: Array<{ id: string; sku: string; locationId: string; locationText: string }> = [];

  for (const row of products) {
    if (row.segments.length === 0) {
      missingPaths.push(row.sku);
      continue;
    }
    const product = productMap.get(row.sku);
    if (!product) {
      missingSkus.push(row.sku);
      continue;
    }

    const pathKey = buildPath(row.segments);
    const leafId = ensureCache.get(pathKey);
    if (!leafId) {
      locationConflicts.push({
        code: row.segments[row.segments.length - 1],
        expectedParent: row.segments.length > 1 ? row.segments[row.segments.length - 2] : null,
        actualParent: null,
      });
      continue;
    }

    const locationText = pathKey;
  if (product.locationId === leafId && product.location === locationText) {
      continue; // already in sync
    }

    updates.push({ id: product.id, sku: row.sku, locationId: leafId, locationText });
  }

  if (Number.isFinite(MAX_UPDATES) && updates.length > MAX_UPDATES) {
    updates.splice(MAX_UPDATES);
  }

  console.log(`[plan] toUpdate=${updates.length} missingSkus=${missingSkus.length} missingPaths=${missingPaths.length}`);
  if (locationConflicts.length > 0) {
    console.warn(`[warn] ${locationConflicts.length} location parent conflicts detected (will not re-parent).`);
  }

  if (!DRY_RUN) {
    const batches = chunk(updates, BATCH);
    let idx = 0;
    for (const part of batches) {
      await prisma.$transaction(
        part.map((u) =>
          prisma.product.update({
            where: { id: u.id },
            data: { locationId: u.locationId, location: u.locationText },
          }),
        ),
      );
      idx += 1;
      console.log(`[write] batch ${idx}/${batches.length} updated ${part.length} products`);
    }
  } else {
    console.log("[dry-run] no database writes executed.");
  }

  console.log("--- Summary ---");
  console.log(`Locations created: ${createdLocations.length}`);
  console.log(`Products updated:  ${updates.length}`);
  console.log(`Missing SKUs:     ${missingSkus.length}`);
  console.log(`Missing paths:    ${missingPaths.length}`);
  console.log(`Path conflicts:   ${locationConflicts.length}`);

  if (missingSkus.length) console.log("Missing SKU list:", missingSkus.slice(0, 20));
  if (missingPaths.length) console.log("Missing path list:", missingPaths.slice(0, 20));
  if (duplicatePathConflicts.length) {
    console.log(
      "Duplicate path conflicts (first 5):",
      duplicatePathConflicts.slice(0, 5),
    );
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("[fatal]", err);
  await prisma.$disconnect();
  process.exitCode = 1;
});
