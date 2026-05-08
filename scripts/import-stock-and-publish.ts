import "dotenv/config";
import path from "path";
import fs from "fs";
import XLSX from "xlsx";
import { Prisma } from "@prisma/client";
import prisma from "../app/lib/prisma";
import { normalizeSku } from "../app/lib/sku";
import { BulkListingJobRepository } from "../app/marketplaces/repositories/bulk-listing-job.repository";
import type {
  BulkListingItemResult,
  BulkListingPlatform,
  BulkListingRequestSpec,
} from "../app/marketplaces/repositories/bulk-listing-job.repository";
import { ListingDispatcher } from "../app/marketplaces/services/listing-dispatcher.service";
import { resolveDim } from "./_ml_dim_defaults";

type RawRow = Record<string, unknown>;

interface Flags {
  userId: string;
  xlsx: string;
  dryRun: boolean;
  skipListings: boolean;
  onlyPublish: boolean;
  limit: number | null;
  platform: "ml" | "shopee" | "all";
  chunkSize: number;
  minPrice: number | null;
  maxPrice: number | null;
  skipPriceMin: number | null;
  skipPriceMax: number | null;
  interChunkDelayMs: number;
  interAccountDelayMs: number;
}

interface ParsedRow {
  rowNumber: number;
  sku: string;
  name: string;
  price: number;
  stock: number;
  brand: string | null;
  model: string | null;
  year: string | null;
  yearFrom: number | null;
  yearTo: number | null;
  mlExternalId: string | null;
  imageUrls: string[];
  locationPath: string | null;
  gtin: string | null;
  legacyMlb: string | null;
}

interface ImportSkip {
  rowNumber: number;
  sku: string | null;
  reason: string;
  detail?: string;
}

interface ImportError {
  rowNumber: number;
  sku: string | null;
  message: string;
}

interface ImportSummary {
  totalRows: number;
  parsed: number;
  filteredOut: number;
  created: number;
  updated: number;
  compatibilitiesCreated: number;
  locationsCreated: number;
  skipped: ImportSkip[];
  errors: ImportError[];
  startedAt: string;
  finishedAt: string;
}

interface PublishSkip {
  productId: string;
  sku: string;
  accountId?: string;
  platform?: BulkListingPlatform;
  reason: string;
}

interface PublishSummary {
  totalEligible: number;
  jobs: Array<{
    jobId: string;
    productCount: number;
    requestCount: number;
    success: number;
    failed: number;
    lastError: string | null;
  }>;
  itemResults: BulkListingItemResult[];
  preSkipped: PublishSkip[];
  startedAt: string;
  finishedAt: string;
}

const DEFAULT_USER_ID = "cmordubzu0000vst0cpn3kc41";
const DEFAULT_XLSX = "C:/Users/Casa/Downloads/dexo-import-estoque.xlsx";
const OUT_DIR = path.resolve(__dirname, "out");

function parseFlags(argv: string[]): Flags {
  const get = (name: string): string | undefined => {
    const flag = `--${name}=`;
    const found = argv.find((a) => a.startsWith(flag));
    return found ? found.slice(flag.length) : undefined;
  };
  const has = (name: string): boolean => argv.includes(`--${name}`);

  const userId = get("user-id") ?? process.env.IMPORT_USER_ID ?? DEFAULT_USER_ID;
  const xlsx = get("xlsx") ?? process.env.IMPORT_XLSX ?? DEFAULT_XLSX;
  const limitRaw = get("limit");
  const limit = limitRaw && /^\d+$/.test(limitRaw) ? parseInt(limitRaw, 10) : null;
  const platformRaw = (get("platform") ?? "all").toLowerCase();
  const platform: Flags["platform"] =
    platformRaw === "ml" || platformRaw === "shopee" ? platformRaw : "all";
  const chunkRaw = get("chunk-size");
  const chunkSize = chunkRaw && /^\d+$/.test(chunkRaw) ? parseInt(chunkRaw, 10) : 1500;
  const parseFloatFlag = (v: string | undefined): number | null => {
    if (!v) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const skipMinRaw = get("skip-price-min");
  const skipMaxRaw = get("skip-price-max");
  const skipPriceMin = parseFloatFlag(skipMinRaw);
  const skipPriceMax = parseFloatFlag(skipMaxRaw);
  const interChunkDelayMs = (() => {
    const v = get("inter-chunk-delay-ms");
    if (!v) return 60_000;
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n >= 0 ? n : 60_000;
  })();
  const interAccountDelayMs = (() => {
    const v = get("inter-account-delay-ms");
    if (!v) return 180_000;
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n >= 0 ? n : 180_000;
  })();

  return {
    userId,
    xlsx,
    dryRun: has("dry-run"),
    skipListings: has("skip-listings"),
    onlyPublish: has("only-publish"),
    limit,
    platform,
    chunkSize,
    minPrice: parseFloatFlag(get("min-price")),
    maxPrice: parseFloatFlag(get("max-price")),
    skipPriceMin,
    skipPriceMax,
    interChunkDelayMs,
    interAccountDelayMs,
  };
}

function asString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s.length > 0 ? s : null;
}

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const s = String(value).trim();
  if (s === "") return null;
  const cleaned = s.includes(",")
    ? s.replace(/\./g, "").replace(",", ".")
    : s;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function asInt(value: unknown): number {
  const n = asNumber(value);
  if (n === null) return 0;
  return Math.max(0, Math.floor(n));
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function parseYearField(raw: string | null): {
  year: string | null;
  yearFrom: number | null;
  yearTo: number | null;
} {
  if (!raw) return { year: null, yearFrom: null, yearTo: null };
  const range = raw.match(/(\d{4})\s*(?:[Aa]|-|\/)\s*(\d{4})/);
  if (range) {
    const a = parseInt(range[1], 10);
    const b = parseInt(range[2], 10);
    return { year: raw, yearFrom: Math.min(a, b), yearTo: Math.max(a, b) };
  }
  const single = raw.match(/(\d{4})/);
  if (single) {
    const y = parseInt(single[1], 10);
    return { year: raw, yearFrom: y, yearTo: y };
  }
  return { year: raw, yearFrom: null, yearTo: null };
}

function parseImages(raw: string | null): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(";")) {
    const t = part.trim();
    if (t.startsWith("https://") && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

function parseRow(row: RawRow, rowNumber: number): ParsedRow | null {
  const sku = asString(row["Código"]);
  if (!sku) return null;
  const status = asString(row["Status"]);
  if (!status || status.toUpperCase() !== "ATIVO") return null;

  const name = asString(row["Nome do Produto"]) ?? sku;
  const price = asNumber(row["Valor de Venda"]) ?? 0;
  const stock = asInt(row["Quantidade"]);
  const brand = asString(row["Marca"]);
  const model = asString(row["Modelo"]);
  const yearRaw = asString(row["Ano"]);
  const { year, yearFrom, yearTo } = parseYearField(yearRaw);
  const mlExternalId = asString(row["MeliCategoryId"]);
  const imageUrls = parseImages(asString(row["Imagens"]));
  const locationPath = asString(row["Hierarquia Localização"]);
  const gtinRaw = asString(row["Código De Barras"]);
  const gtin = gtinRaw && gtinRaw.toUpperCase() !== "SEM GTIN" ? gtinRaw : null;
  const legacyMlb = asString(row["MLBs"]);

  return {
    rowNumber,
    sku,
    name,
    price,
    stock,
    brand,
    model,
    year,
    yearFrom,
    yearTo,
    mlExternalId,
    imageUrls,
    locationPath,
    gtin,
    legacyMlb,
  };
}

async function assertAdmin(userId: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, parentUserId: true },
  });
  if (!user) {
    throw new Error(`Usuário ${userId} não encontrado.`);
  }
  if (user.parentUserId !== null) {
    throw new Error(
      `Usuário ${userId} é colaborador (parentUserId=${user.parentUserId}). Bulk import só é permitido para admin.`,
    );
  }
  console.log(`[admin] OK: ${user.email} (${user.id})`);
}

async function loadAccounts(
  userId: string,
  platformFlag: Flags["platform"],
  minMinutesValid = 30,
): Promise<Array<{ id: string; platform: "MERCADO_LIVRE" | "SHOPEE"; accountName: string }>> {
  const accounts = await prisma.marketplaceAccount.findMany({
    where: { userId, status: "ACTIVE" },
    select: { id: true, platform: true, accountName: true, expiresAt: true },
  });
  const cutoff = new Date(Date.now() + minMinutesValid * 60 * 1000);
  const filtered = accounts.filter((a) => {
    if (platformFlag === "ml" && a.platform !== "MERCADO_LIVRE") return false;
    if (platformFlag === "shopee" && a.platform !== "SHOPEE") return false;
    if (a.expiresAt < cutoff) {
      console.warn(
        `[accounts][skip] ${a.platform}/${a.accountName}: token expira em ${a.expiresAt.toISOString()} (< ${minMinutesValid}min) — reconecte antes de usar`,
      );
      return false;
    }
    return true;
  });
  console.log(
    `[accounts] ${filtered.length} elegível(eis) com token válido por ≥${minMinutesValid}min:`,
    filtered.map((a) => `${a.platform}/${a.accountName}`).join(", ") || "(nenhuma)",
  );
  return filtered;
}

function readXlsx(filePath: string): RawRow[] {
  const resolved = path.resolve(filePath);
  console.log(`[xlsx] Lendo: ${resolved}`);
  const wb = XLSX.readFile(resolved);
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new Error("Workbook sem sheets.");
  const sheet = wb.Sheets[sheetName];
  if (!sheet) throw new Error(`Sheet '${sheetName}' não encontrada.`);
  const rows = XLSX.utils.sheet_to_json<RawRow>(sheet, { defval: null });
  console.log(`[xlsx] Sheet '${sheetName}', linhas: ${rows.length}`);
  return rows;
}

async function preloadCategories(
  externalIds: string[],
): Promise<Map<string, string>> {
  if (externalIds.length === 0) return new Map();
  const unique = Array.from(new Set(externalIds));
  const cats = await prisma.marketplaceCategory.findMany({
    where: { externalId: { in: unique }, siteId: "MLB" },
    select: { id: true, externalId: true },
  });
  const map = new Map<string, string>();
  for (const c of cats) map.set(c.externalId, c.id);
  console.log(`[categories] resolvidas ${map.size} de ${unique.length} externalIds`);
  return map;
}

async function resolveLocationsTree(
  rows: ParsedRow[],
  userId: string,
  dryRun: boolean,
): Promise<{ map: Map<string, string | null>; created: number }> {
  const allPaths = new Set<string>();
  for (const r of rows) {
    if (r.locationPath) allPaths.add(r.locationPath);
  }
  const resultMap = new Map<string, string | null>();
  let created = 0;

  for (const fullPath of allPaths) {
    const parts = fullPath
      .split(">")
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    if (parts.length === 0) {
      resultMap.set(fullPath, null);
      continue;
    }
    let parentId: string | null = null;
    let currentId: string | null = null;
    for (const code of parts) {
      const existing = await prisma.location.findUnique({
        where: { userId_code: { userId, code } },
        select: { id: true },
      });
      if (existing) {
        currentId = existing.id;
      } else if (dryRun) {
        currentId = `<dry-${code}>`;
      } else {
        const createdLoc: { id: string } = await prisma.location.create({
          data: { userId, code, parentId },
          select: { id: true },
        });
        currentId = createdLoc.id;
        created++;
      }
      parentId = currentId;
    }
    resultMap.set(fullPath, currentId);
  }
  console.log(
    `[locations] caminhos: ${allPaths.size}, novos criados: ${created}${dryRun ? " (dry-run)" : ""}`,
  );
  return { map: resultMap, created };
}

async function upsertProduct(
  row: ParsedRow,
  userId: string,
  mlIdMap: Map<string, string>,
  locationMap: Map<string, string | null>,
): Promise<{ productId: string; wasCreated: boolean }> {
  const mlCategoryId = row.mlExternalId ? mlIdMap.get(row.mlExternalId) ?? null : null;
  const mlCategorySource =
    row.mlExternalId && !mlCategoryId
      ? "IMPORT_PENDING"
      : mlCategoryId
        ? "IMPORT_RESOLVED"
        : null;
  const locationId = row.locationPath ? locationMap.get(row.locationPath) ?? null : null;

  const dim = resolveDim(row.mlExternalId ?? "", row.name);

  const attributes: Prisma.InputJsonValue = {
    gtin: row.gtin,
    legacyMlb: row.legacyMlb,
    dimensionsSource: dim.source,
  };

  const baseData = {
    name: row.name,
    price: new Prisma.Decimal(row.price),
    stock: row.stock,
    brand: row.brand,
    model: row.model,
    year: row.year,
    imageUrl: row.imageUrls[0] ?? null,
    imageUrls: row.imageUrls,
    mlCategoryId,
    mlCategorySource,
    mlCategoryChosenAt: mlCategoryId ? new Date() : null,
    locationId,
    attributes,
    skuNormalized: normalizeSku(row.sku),
  };

  const existing = await prisma.product.findUnique({
    where: { userId_sku: { userId, sku: row.sku } },
    select: { id: true, heightCm: true, widthCm: true, lengthCm: true, weightKg: true },
  });

  if (existing) {
    const updateData: typeof baseData & {
      heightCm?: number;
      widthCm?: number;
      lengthCm?: number;
      weightKg?: Prisma.Decimal;
    } = { ...baseData };
    if (existing.heightCm == null) updateData.heightCm = dim.heightCm;
    if (existing.widthCm == null) updateData.widthCm = dim.widthCm;
    if (existing.lengthCm == null) updateData.lengthCm = dim.lengthCm;
    if (existing.weightKg == null) updateData.weightKg = new Prisma.Decimal(dim.weightKg);
    await prisma.product.update({
      where: { id: existing.id },
      data: updateData,
    });
    return { productId: existing.id, wasCreated: false };
  }

  const createdProd = await prisma.product.create({
    data: {
      sku: row.sku,
      userId,
      ...baseData,
      heightCm: dim.heightCm,
      widthCm: dim.widthCm,
      lengthCm: dim.lengthCm,
      weightKg: new Prisma.Decimal(dim.weightKg),
    },
    select: { id: true },
  });
  return { productId: createdProd.id, wasCreated: true };
}

async function upsertCompatibility(
  productId: string,
  row: ParsedRow,
): Promise<boolean> {
  if (!row.brand || !row.model) return false;
  const yf = row.yearFrom;
  const yt = row.yearTo;
  const dup = await prisma.productCompatibility.findFirst({
    where: {
      productId,
      brand: row.brand,
      model: row.model,
      yearFrom: yf,
      yearTo: yt,
    },
    select: { id: true },
  });
  if (dup) return false;
  await prisma.productCompatibility.create({
    data: {
      productId,
      brand: row.brand,
      model: row.model,
      yearFrom: yf,
      yearTo: yt,
    },
  });
  return true;
}

async function runImport(
  parsed: ParsedRow[],
  userId: string,
  dryRun: boolean,
): Promise<{ summary: ImportSummary; productIds: string[] }> {
  const startedAt = new Date().toISOString();
  const externalIds = parsed
    .map((r) => r.mlExternalId)
    .filter((v): v is string => Boolean(v));
  const mlIdMap = await preloadCategories(externalIds);
  const { map: locationMap, created: locationsCreated } = await resolveLocationsTree(
    parsed,
    userId,
    dryRun,
  );

  const summary: ImportSummary = {
    totalRows: parsed.length,
    parsed: parsed.length,
    filteredOut: 0,
    created: 0,
    updated: 0,
    compatibilitiesCreated: 0,
    locationsCreated,
    skipped: [],
    errors: [],
    startedAt,
    finishedAt: "",
  };

  const productIds: string[] = [];

  if (dryRun) {
    for (const row of parsed) {
      const ext = row.mlExternalId;
      const resolvedMlCat = ext ? mlIdMap.get(ext) ?? null : null;
      if (ext && !resolvedMlCat) {
        summary.skipped.push({
          rowNumber: row.rowNumber,
          sku: row.sku,
          reason: "ml_category_not_found",
          detail: ext,
        });
      }
    }
    summary.finishedAt = new Date().toISOString();
    console.log(
      `[import] DRY-RUN: parsed=${summary.parsed}, ml_categories_missing=${summary.skipped.length}`,
    );
    return { summary, productIds: [] };
  }

  const batches = chunk(parsed, 200);
  let processed = 0;
  for (const batch of batches) {
    let bCreated = 0;
    let bUpdated = 0;
    let bCompat = 0;
    let bErrors = 0;
    for (const row of batch) {
      let attempt = 0;
      const maxAttempts = 3;
      let lastErr: unknown = null;
      while (attempt < maxAttempts) {
        try {
          const { productId, wasCreated } = await upsertProduct(
            row,
            userId,
            mlIdMap,
            locationMap,
          );
          productIds.push(productId);
          if (wasCreated) bCreated++;
          else bUpdated++;
          const compatAdded = await upsertCompatibility(productId, row);
          if (compatAdded) bCompat++;
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          attempt++;
          if (attempt < maxAttempts) {
            await new Promise((r) => setTimeout(r, 300 * attempt));
          }
        }
      }
      if (lastErr) {
        bErrors++;
        const message = lastErr instanceof Error ? lastErr.message : String(lastErr);
        summary.errors.push({ rowNumber: row.rowNumber, sku: row.sku, message });
        console.warn(`[import][warn] row=${row.rowNumber} sku=${row.sku}: ${message.slice(0, 200)}`);
      }
    }
    summary.created += bCreated;
    summary.updated += bUpdated;
    summary.compatibilitiesCreated += bCompat;
    processed += batch.length;
    console.log(
      `[import] [${processed}/${parsed.length}] criados=${bCreated} atualizados=${bUpdated} compat=${bCompat} errors=${bErrors}`,
    );
  }
  summary.finishedAt = new Date().toISOString();
  return { summary, productIds };
}

async function runPublish(
  productIds: string[],
  userId: string,
  accounts: Array<{ id: string; platform: "MERCADO_LIVRE" | "SHOPEE"; accountName: string }>,
  chunkSize: number,
  dryRun: boolean,
  flags: Flags,
): Promise<PublishSummary> {
  const startedAt = new Date().toISOString();
  const summary: PublishSummary = {
    totalEligible: 0,
    jobs: [],
    itemResults: [],
    preSkipped: [],
    startedAt,
    finishedAt: "",
  };

  if (productIds.length === 0 || accounts.length === 0) {
    console.log("[publish] nada a publicar (sem produtos ou sem contas).");
    summary.finishedAt = new Date().toISOString();
    return summary;
  }

  const products = await prisma.product.findMany({
    where: { id: { in: productIds }, userId },
    select: {
      id: true,
      sku: true,
      stock: true,
      price: true,
      imageUrls: true,
      mlCategoryId: true,
      shopeeCategoryId: true,
    },
  });

  const eligibleByPlatform = new Map<BulkListingPlatform, Set<string>>([
    ["MERCADO_LIVRE", new Set()],
    ["SHOPEE", new Set()],
  ]);

  for (const p of products) {
    const priceNum = Number(p.price);
    if (
      flags.skipPriceMin !== null &&
      flags.skipPriceMax !== null &&
      priceNum >= flags.skipPriceMin &&
      priceNum <= flags.skipPriceMax
    ) {
      summary.preSkipped.push({
        productId: p.id,
        sku: p.sku,
        reason: `skip_price_band_${flags.skipPriceMin}_${flags.skipPriceMax}`,
      });
      continue;
    }
    if (flags.minPrice !== null && priceNum < flags.minPrice) {
      summary.preSkipped.push({ productId: p.id, sku: p.sku, reason: "skip_below_min_price" });
      continue;
    }
    if (flags.maxPrice !== null && priceNum > flags.maxPrice) {
      summary.preSkipped.push({ productId: p.id, sku: p.sku, reason: "skip_above_max_price" });
      continue;
    }
    if (p.stock < 1) {
      summary.preSkipped.push({ productId: p.id, sku: p.sku, reason: "skip_stock" });
      continue;
    }
    if (!Number.isFinite(priceNum) || priceNum <= 0) {
      summary.preSkipped.push({ productId: p.id, sku: p.sku, reason: "skip_price" });
      continue;
    }
    if (!Array.isArray(p.imageUrls) || p.imageUrls.length < 1) {
      summary.preSkipped.push({ productId: p.id, sku: p.sku, reason: "skip_no_image" });
      continue;
    }
    if (p.mlCategoryId) {
      eligibleByPlatform.get("MERCADO_LIVRE")?.add(p.id);
    } else {
      summary.preSkipped.push({
        productId: p.id,
        sku: p.sku,
        platform: "MERCADO_LIVRE",
        reason: "skip_no_ml_category",
      });
    }
    if (p.shopeeCategoryId) {
      eligibleByPlatform.get("SHOPEE")?.add(p.id);
    } else {
      summary.preSkipped.push({
        productId: p.id,
        sku: p.sku,
        platform: "SHOPEE",
        reason: "skip_no_shopee_category",
      });
    }
  }

  const accountIds = accounts.map((a) => a.id);
  const existingListings = await prisma.productListing.findMany({
    where: {
      productId: { in: productIds },
      marketplaceAccountId: { in: accountIds },
      status: { notIn: ["ERROR", "CLOSED"] },
    },
    select: { productId: true, marketplaceAccountId: true, status: true },
  });
  const alreadyListedKey = new Set<string>();
  for (const l of existingListings) {
    alreadyListedKey.add(`${l.productId}::${l.marketplaceAccountId}`);
  }

  const productSkuById = new Map<string, string>();
  for (const p of products) productSkuById.set(p.id, p.sku);

  const buildEligiblePerAccount = (
    accountId: string,
    platform: BulkListingPlatform,
  ): string[] => {
    const base = eligibleByPlatform.get(platform);
    if (!base) return [];
    const out: string[] = [];
    for (const pid of base) {
      const key = `${pid}::${accountId}`;
      if (alreadyListedKey.has(key)) {
        summary.preSkipped.push({
          productId: pid,
          sku: productSkuById.get(pid) ?? "",
          accountId,
          platform,
          reason: "skip_already_listed",
        });
        continue;
      }
      out.push(pid);
    }
    return out;
  };

  type AccountPlan = {
    accountId: string;
    platform: BulkListingPlatform;
    productIds: string[];
  };
  const accountPlans: AccountPlan[] = accounts.map((a) => ({
    accountId: a.id,
    platform: a.platform,
    productIds: buildEligiblePerAccount(a.id, a.platform),
  }));

  const totalEligible = accountPlans.reduce((acc, p) => acc + p.productIds.length, 0);
  summary.totalEligible = totalEligible;
  console.log(
    `[publish] elegíveis por conta:`,
    accountPlans
      .map((p) => `${p.platform}/${p.accountId.slice(-6)}=${p.productIds.length}`)
      .join(", "),
  );
  console.log(`[publish] total pares (productId × accountId): ${totalEligible}`);
  console.log(`[publish] pré-skip: ${summary.preSkipped.length}`);

  if (dryRun) {
    summary.finishedAt = new Date().toISOString();
    console.log(`[publish] DRY-RUN: nenhum job criado.`);
    return summary;
  }

  const sleep = (ms: number) =>
    new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

  let firstAccount = true;
  for (const plan of accountPlans) {
    if (plan.productIds.length === 0) continue;
    if (!firstAccount && flags.interAccountDelayMs > 0) {
      console.log(
        `[publish] aguardando ${Math.round(flags.interAccountDelayMs / 1000)}s antes da próxima conta (rate limit)…`,
      );
      await sleep(flags.interAccountDelayMs);
    }
    firstAccount = false;
    const planChunks = chunk(plan.productIds, chunkSize);
    let firstChunk = true;
    for (const productChunk of planChunks) {
      if (!firstChunk && flags.interChunkDelayMs > 0) {
        console.log(
          `[publish] aguardando ${Math.round(flags.interChunkDelayMs / 1000)}s antes do próximo chunk (rate limit)…`,
        );
        await sleep(flags.interChunkDelayMs);
      }
      firstChunk = false;
      const requests: BulkListingRequestSpec[] = [
        {
          platform: plan.platform,
          accountId: plan.accountId,
        },
      ];
      const job = await BulkListingJobRepository.create({
        userId,
        productIds: productChunk,
        requests,
        overrideTemplate: null,
      });
      console.log(
        `[publish] job criado ${job.id}: ${plan.platform}/${plan.accountId.slice(-6)} produtos=${productChunk.length}`,
      );
      await BulkListingJobRepository.markRunning(job.id);

      const itemsForThisJob: BulkListingItemResult[] = [];
      const result = await ListingDispatcher.dispatchBatch({
        userId,
        productIds: productChunk,
        requests,
        overrideTemplate: null,
        onItemDone: async (item) => {
          itemsForThisJob.push(item);
          summary.itemResults.push(item);
          await BulkListingJobRepository.appendResult(job.id, item);
          if (itemsForThisJob.length % 50 === 0) {
            console.log(
              `[publish] job=${job.id} progresso: ${itemsForThisJob.length}/${productChunk.length}`,
            );
          }
        },
      });
      await BulkListingJobRepository.markFinal(job.id, {
        success: result.success,
        failed: result.failed,
        lastError: result.lastError ?? null,
      });
      summary.jobs.push({
        jobId: job.id,
        productCount: productChunk.length,
        requestCount: requests.length,
        success: result.success,
        failed: result.failed,
        lastError: result.lastError ?? null,
      });
      console.log(
        `[publish] job ${job.id} finalizado: success=${result.success} failed=${result.failed}`,
      );
    }
  }

  summary.finishedAt = new Date().toISOString();
  return summary;
}

function ensureOutDir(): void {
  if (!fs.existsSync(OUT_DIR)) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
  }
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

interface PriceMismatch {
  sku: string;
  expected: number;
  actual: number;
}

async function sanityCheckPrices(
  userId: string,
  parsed: ParsedRow[],
): Promise<PriceMismatch[]> {
  if (parsed.length === 0) return [];
  const sample: ParsedRow[] = [];
  const stride = Math.max(1, Math.floor(parsed.length / 200));
  for (let i = 0; i < parsed.length; i += stride) sample.push(parsed[i]);
  const skus = sample.map((r) => r.sku);
  const dbRows = await prisma.product.findMany({
    where: { userId, sku: { in: skus } },
    select: { sku: true, price: true },
  });
  const dbMap = new Map<string, number>();
  for (const p of dbRows) dbMap.set(p.sku, Number(p.price));
  const mismatches: PriceMismatch[] = [];
  for (const r of sample) {
    const actual = dbMap.get(r.sku);
    if (actual === undefined) continue;
    if (Math.abs(actual - r.price) > 0.01) {
      mismatches.push({ sku: r.sku, expected: r.price, actual });
    }
  }
  return mismatches;
}

function writeImportReports(userId: string, ts: string, summary: ImportSummary): void {
  ensureOutDir();
  const jsonPath = path.join(OUT_DIR, `import-stock-${userId}-${ts}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(summary, null, 2), "utf8");

  const skippedByReason = new Map<string, ImportSkip[]>();
  for (const s of summary.skipped) {
    const list = skippedByReason.get(s.reason) ?? [];
    list.push(s);
    skippedByReason.set(s.reason, list);
  }
  const md: string[] = [
    `# Import stock report — ${userId}`,
    ``,
    `- Início: ${summary.startedAt}`,
    `- Fim: ${summary.finishedAt}`,
    `- Linhas processadas: ${summary.parsed}`,
    `- Criados: ${summary.created}`,
    `- Atualizados: ${summary.updated}`,
    `- Compatibilidades novas: ${summary.compatibilitiesCreated}`,
    `- Localizações criadas: ${summary.locationsCreated}`,
    `- Skipados: ${summary.skipped.length}`,
    `- Erros: ${summary.errors.length}`,
    ``,
    `## Skipados por motivo`,
    ...Array.from(skippedByReason.entries()).map(
      ([reason, list]) => `- **${reason}**: ${list.length}`,
    ),
    ``,
    `## Erros (top 50)`,
    ...summary.errors.slice(0, 50).map(
      (e) => `- linha ${e.rowNumber} sku=${e.sku ?? "?"}: ${e.message}`,
    ),
  ];
  const mdPath = path.join(OUT_DIR, `import-stock-${userId}-${ts}.md`);
  fs.writeFileSync(mdPath, md.join("\n"), "utf8");
  console.log(`[report] ${jsonPath}`);
  console.log(`[report] ${mdPath}`);
}

function writePublishReports(
  userId: string,
  ts: string,
  summary: PublishSummary,
): void {
  ensureOutDir();
  const jsonPath = path.join(OUT_DIR, `publish-${userId}-${ts}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(summary, null, 2), "utf8");

  const platformAgg = new Map<string, { ok: number; fail: number }>();
  for (const it of summary.itemResults) {
    const k = it.platform;
    const cur = platformAgg.get(k) ?? { ok: 0, fail: 0 };
    if (it.success) cur.ok++;
    else cur.fail++;
    platformAgg.set(k, cur);
  }

  const errorsByMessage = new Map<string, number>();
  for (const it of summary.itemResults) {
    if (!it.success && it.error) {
      errorsByMessage.set(it.error, (errorsByMessage.get(it.error) ?? 0) + 1);
    }
  }
  const skipsByReason = new Map<string, number>();
  for (const s of summary.preSkipped) {
    skipsByReason.set(s.reason, (skipsByReason.get(s.reason) ?? 0) + 1);
  }

  const md: string[] = [
    `# Publish report — ${userId}`,
    ``,
    `- Início: ${summary.startedAt}`,
    `- Fim: ${summary.finishedAt}`,
    `- Pares elegíveis: ${summary.totalEligible}`,
    `- Pré-skipados: ${summary.preSkipped.length}`,
    `- Jobs criados: ${summary.jobs.length}`,
    ``,
    `## Por plataforma`,
    ...Array.from(platformAgg.entries()).map(
      ([p, agg]) => `- **${p}**: ok=${agg.ok}, falhas=${agg.fail}`,
    ),
    ``,
    `## Pré-skips por motivo`,
    ...Array.from(skipsByReason.entries()).map(
      ([r, n]) => `- **${r}**: ${n}`,
    ),
    ``,
    `## Top erros (agrupados por mensagem)`,
    ...Array.from(errorsByMessage.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30)
      .map(([m, n]) => `- (${n}×) ${m}`),
    ``,
    `## Jobs`,
    ...summary.jobs.map(
      (j) =>
        `- ${j.jobId}: produtos=${j.productCount} success=${j.success} failed=${j.failed}${
          j.lastError ? ` lastError="${j.lastError}"` : ""
        }`,
    ),
  ];
  const mdPath = path.join(OUT_DIR, `publish-${userId}-${ts}.md`);
  fs.writeFileSync(mdPath, md.join("\n"), "utf8");
  console.log(`[report] ${jsonPath}`);
  console.log(`[report] ${mdPath}`);
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  console.log(
    `[flags] userId=${flags.userId} xlsx=${flags.xlsx} dryRun=${flags.dryRun} skipListings=${flags.skipListings} limit=${flags.limit ?? "none"} platform=${flags.platform} chunk=${flags.chunkSize} skipPriceBand=[${flags.skipPriceMin ?? "-"},${flags.skipPriceMax ?? "-"}] minPrice=${flags.minPrice ?? "-"} maxPrice=${flags.maxPrice ?? "-"} interChunkDelayMs=${flags.interChunkDelayMs} interAccountDelayMs=${flags.interAccountDelayMs}`,
  );

  await assertAdmin(flags.userId);
  const accounts = await loadAccounts(flags.userId, flags.platform);
  const ts = timestamp();

  if (flags.onlyPublish) {
    console.log("[only-publish] pulando Phase 1 — buscando productIds direto do banco");
    const dbRows = await prisma.product.findMany({
      where: { userId: flags.userId },
      select: { id: true },
    });
    const publishProductIds = dbRows.map((p) => p.id);
    console.log(`[only-publish] ${publishProductIds.length} produtos encontrados no banco`);
    const publishSummary = await runPublish(
      publishProductIds,
      flags.userId,
      accounts,
      flags.chunkSize,
      flags.dryRun,
      flags,
    );
    writePublishReports(flags.userId, ts, publishSummary);
    console.log(
      `[summary][publish] elegíveis=${publishSummary.totalEligible} jobs=${publishSummary.jobs.length} preSkip=${publishSummary.preSkipped.length}`,
    );
    return;
  }

  const rawRows = readXlsx(flags.xlsx);
  const parsed: ParsedRow[] = [];
  let filteredOut = 0;
  for (let i = 0; i < rawRows.length; i++) {
    const r = parseRow(rawRows[i], i + 2);
    if (r) parsed.push(r);
    else filteredOut++;
  }
  const limited = flags.limit !== null ? parsed.slice(0, flags.limit) : parsed;
  console.log(
    `[parse] linhas raw=${rawRows.length}, parsed=${parsed.length}, filtradas=${filteredOut}, em uso=${limited.length}`,
  );

  const { summary: importSummary, productIds } = await runImport(
    limited,
    flags.userId,
    flags.dryRun,
  );
  importSummary.filteredOut = filteredOut;
  writeImportReports(flags.userId, ts, importSummary);

  console.log(
    `[summary][import] criados=${importSummary.created} atualizados=${importSummary.updated} skipados=${importSummary.skipped.length} erros=${importSummary.errors.length}`,
  );

  if (!flags.dryRun) {
    const sanityErrors = await sanityCheckPrices(flags.userId, limited);
    if (sanityErrors.length > 0) {
      const detail = sanityErrors.slice(0, 10)
        .map((e) => `sku=${e.sku} xlsx=${e.expected} db=${e.actual}`)
        .join("; ");
      console.error(
        `[sanity][FAIL] ${sanityErrors.length} preços divergem entre XLSX e banco. Exemplos: ${detail}. Abortando antes de publicar.`,
      );
      throw new Error(`sanity_check_failed: ${sanityErrors.length} divergências de preço`);
    }
    console.log(`[sanity][OK] preços conferem (amostra de ${Math.min(limited.length, 200)} SKUs)`);
  }

  if (flags.skipListings) {
    console.log("[publish] pulado por --skip-listings");
    return;
  }

  const publishProductIds =
    productIds.length > 0
      ? productIds
      : (
          await prisma.product.findMany({
            where: {
              userId: flags.userId,
              sku: { in: limited.map((r) => r.sku) },
            },
            select: { id: true },
          })
        ).map((p) => p.id);

  const publishSummary = await runPublish(
    publishProductIds,
    flags.userId,
    accounts,
    flags.chunkSize,
    flags.dryRun,
    flags,
  );
  writePublishReports(flags.userId, ts, publishSummary);

  console.log(
    `[summary][publish] elegíveis=${publishSummary.totalEligible} jobs=${publishSummary.jobs.length} preSkip=${publishSummary.preSkipped.length}`,
  );
}

main()
  .catch((err) => {
    console.error("[fatal]", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
