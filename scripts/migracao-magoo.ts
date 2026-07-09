import "dotenv/config";
import path from "path";
import fs from "fs";
import XLSX from "xlsx";
import { Prisma } from "@prisma/client";
import prisma from "../app/lib/prisma";
import { normalizeSku } from "../app/lib/sku";
import { MLOAuthService } from "../app/marketplaces/services/ml-oauth.service";
import { MLApiService } from "../app/marketplaces/services/ml-api.service";

/**
 * Migração do cliente "Magoo" (cmqzaf2xy…) → Dexo: cria os PRODUTOS a partir da
 * exportação de ANÚNCIOS do Mercado Livre. Não há base de estoque do sistema
 * antigo (a Vapt ainda não entregou o relatório de localizações) — então cada
 * anúncio ATIVO vira produto + ProductListing, SEM localização (liga depois).
 *
 *   Fase products → agrupa por SKU (mesmo SKU em N anúncios = 1 produto com N
 *                    anúncios). Anúncio SEM SKU → sku placeholder "VAAPT-<MLB>"
 *                    (quando a Vapt entregar, acha por "VAAPT" e liga/ajusta).
 *                    Só ATIVOS. createdFromMarketplace=true, origin=MERCADO_LIVRE.
 *   Fase listings → ProductListing p/ cada MLB do produto (VERIFY-BEFORE:
 *                    só liga se item.seller_id casa com a conta ML do cliente).
 *   Fase images   → puxa fotos dos anúncios (multiget em lote).
 *
 * Lê TODOS os .xlsx/.xls em scripts/data/migracao-magoo/ (ou --files=a,b,c),
 * dedup por MLB entre arquivos. Idempotente; sem --apply não escreve.
 *
 * Uso (chame o tsx DIRETO — `npm run -- <flags>` engole flags no PowerShell):
 *   npx tsx scripts/migracao-magoo.ts --user-id=cmqzaf2xy0000vs0ot3y4wau2 --dry-run
 *   npx tsx scripts/migracao-magoo.ts --user-id=... --apply --only=products
 *   npx tsx scripts/migracao-magoo.ts --user-id=... --apply --only=listings,images
 */

type RawRow = Record<string, unknown>;
type Phase = "products" | "listings" | "images";

const DEFAULT_USER_ID = ""; // sem default: exige --user-id
const DATA_DIR = path.resolve(__dirname, "data", "migracao-magoo");
const OUT_DIR = path.resolve(__dirname, "out");
const MAX_IMAGES = 10;
const SKU_PLACEHOLDER_PREFIX = "VAAPT-"; // anúncio sem SKU → VAAPT-<MLB>
const ALL_PHASES: Phase[] = ["products", "listings", "images"];
let TENANT = "MAGOO"; // attributes.migration + escopo das fases

interface Flags {
  userId: string;
  dryRun: boolean;
  apply: boolean;
  only: Set<Phase>;
  limit: number | null;
  offset: number;
  files: string[] | null; // null = auto (todos no DATA_DIR)
  mlAccountId: string | null;
  verifyMlInDryRun: boolean;
  includeInactive: boolean; // default false = só ATIVOS
  tenant: string;
}

function parseFlags(argv: string[]): Flags {
  const get = (name: string): string | undefined => {
    const flag = `--${name}=`;
    const found = argv.find((a) => a.startsWith(flag));
    return found ? found.slice(flag.length) : undefined;
  };
  const has = (name: string): boolean => argv.includes(`--${name}`);

  const apply = has("apply");
  const onlyRaw = get("only");
  const only = onlyRaw
    ? new Set(
        onlyRaw
          .split(/[\s,]+/)
          .map((s) => s.trim())
          .filter((s): s is Phase => (ALL_PHASES as string[]).includes(s)),
      )
    : new Set(ALL_PHASES);
  const limitRaw = get("limit");
  const offsetRaw = get("offset");
  const filesRaw = get("files");

  return {
    userId: get("user-id") ?? process.env.MIGRACAO_USER_ID ?? DEFAULT_USER_ID,
    apply,
    dryRun: has("dry-run") || !apply,
    only,
    limit: limitRaw && /^\d+$/.test(limitRaw) ? parseInt(limitRaw, 10) : null,
    offset: offsetRaw && /^\d+$/.test(offsetRaw) ? parseInt(offsetRaw, 10) : 0,
    files: filesRaw ? filesRaw.split(",").map((f) => f.trim()).filter(Boolean) : null,
    mlAccountId: get("ml-account") ?? null,
    verifyMlInDryRun: has("verify-ml-in-dry-run"),
    includeInactive: has("include-inactive"),
    tenant: get("tenant") ?? "MAGOO",
  };
}

/* ------------------------------- Helpers ------------------------------- */

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
  const cleaned = s.includes(",") ? s.replace(/\./g, "").replace(",", ".") : s;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}
function asInt(value: unknown): number {
  const n = asNumber(value);
  if (n === null) return 0;
  return Math.max(0, Math.floor(n));
}
/** Dimensão cm: 0/ausente/<=0 → null; senão inteiro. */
function asDimCm(value: unknown): number | null {
  const n = asNumber(value);
  if (n === null || n <= 0) return null;
  return Math.floor(n);
}
function asDecimalString(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  let s = String(value).trim();
  if (s === "") return null;
  s = s.includes(",") ? s.replace(/\./g, "").replace(",", ".") : s;
  s = s.replace(/[^\d.\-]/g, "");
  if (s === "" || s === "-" || s === "." || s === "-.") return null;
  return s;
}
function toDecimalOrZero(value: unknown): Prisma.Decimal {
  const s = asDecimalString(value);
  if (s === null) return new Prisma.Decimal(0);
  try {
    const d = new Prisma.Decimal(s);
    return d.isFinite() && !d.isNegative() ? d : new Prisma.Decimal(0);
  } catch {
    return new Prisma.Decimal(0);
  }
}
/** Peso kg: 0/ausente/negativo → null; >= 10000 não cabe em Decimal(6,2) → null. */
function asWeightKg(value: unknown): Prisma.Decimal | null {
  const s = asDecimalString(value);
  if (s === null) return null;
  try {
    const d = new Prisma.Decimal(s);
    if (!d.isFinite() || d.isZero() || d.isNegative() || d.gte(10000)) return null;
    return d;
  } catch {
    return null;
  }
}
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
function pushCap<T>(arr: T[], item: T, cap = 1000): void {
  if (arr.length < cap) arr.push(item);
}
function sliceRows<T>(rows: T[], flags: Flags): T[] {
  const end = flags.limit !== null ? flags.offset + flags.limit : undefined;
  return rows.slice(flags.offset, end);
}
function normMlb(v: unknown): string | null {
  const s = asString(v);
  if (!s) return null;
  const t = s.trim().toUpperCase();
  return /^MLB\d+$/.test(t) ? t : null;
}
/** Condição ML (Novo/Usado) → Quality Dexo (decisão: Novo→NOVO, Usado→SEMINOVO). */
function mapQuality(cond: unknown): "NOVO" | "SEMINOVO" {
  const s = (asString(cond) ?? "").toLowerCase();
  return s.startsWith("nov") ? "NOVO" : "SEMINOVO";
}
/** Condição ML → itemCondition do ProductListing. */
function itemConditionOf(cond: unknown): string {
  const s = (asString(cond) ?? "").toLowerCase();
  return s.startsWith("nov") ? "new" : "used";
}

/* --------------------------- Tipos internos ---------------------------- */

interface AccountLite {
  id: string;
  externalUserId: string | null;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}
interface Unit {
  sku: string;
  mlbs: string[];
  rep: RawRow; // 1ª ocorrência (nome/preço/dimensões/categoria)
  maxStock: number; // maior QUANTITY do grupo (estoque compartilhado)
  isPlaceholder: boolean;
}
interface MlDetail {
  id: string;
  seller_id: number;
  status: string;
  permalink: string;
  pictures: Array<{ secure_url?: string; url?: string }>;
}

/* ------------------------------- ML API -------------------------------- */

const tokenCache = new Map<string, string>();
const pictureCache = new Map<string, string[]>(); // productId → fotos

async function getValidToken(account: AccountLite, dryRun: boolean): Promise<string> {
  const cached = tokenCache.get(account.id);
  if (cached) return cached;
  if (new Date(account.expiresAt).getTime() > Date.now() + 60_000) {
    tokenCache.set(account.id, account.accessToken);
    return account.accessToken;
  }
  const refreshed = await MLOAuthService.refreshAccessTokenForAccount(account.id, account.refreshToken);
  if (!dryRun) {
    await prisma.marketplaceAccount.update({
      where: { id: account.id },
      data: {
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: new Date(Date.now() + refreshed.expiresIn * 1000),
      },
    });
  }
  tokenCache.set(account.id, refreshed.accessToken);
  return refreshed.accessToken;
}

/** Multiget em lote com 1 retry em 401 (refresh) — só itens code 200 voltam. */
async function fetchDetails(
  account: AccountLite,
  mlbs: string[],
  dryRun: boolean,
): Promise<Map<string, MlDetail>> {
  const byMlb = new Map<string, MlDetail>();
  if (mlbs.length === 0) return byMlb;
  let token = await getValidToken(account, dryRun);
  let details: MlDetail[];
  try {
    details = (await MLApiService.getItemsDetails(token, mlbs)) as unknown as MlDetail[];
  } catch (e) {
    const st = (e as { response?: { status?: number } }).response?.status;
    if (st === 401) {
      tokenCache.delete(account.id);
      token = await getValidToken(account, dryRun);
      details = (await MLApiService.getItemsDetails(token, mlbs)) as unknown as MlDetail[];
    } else {
      throw e;
    }
  }
  for (const d of details) {
    if (d && d.id) byMlb.set(String(d.id).toUpperCase(), d);
  }
  return byMlb;
}

function picturesOf(d: MlDetail): string[] {
  return (d.pictures ?? [])
    .map((p) => p.secure_url ?? p.url ?? "")
    .filter((u): u is string => typeof u === "string" && u.length > 0)
    .slice(0, MAX_IMAGES);
}

/* ------------------------------- Leitura ------------------------------- */

function listInputFiles(flags: Flags): string[] {
  if (flags.files) return flags.files.map((f) => path.resolve(f));
  if (!fs.existsSync(DATA_DIR)) return [];
  return fs
    .readdirSync(DATA_DIR)
    .filter((f) => /\.(xlsx|xls)$/i.test(f) && !f.startsWith("~$"))
    .sort()
    .map((f) => path.join(DATA_DIR, f));
}

/** Linhas de anúncio REAIS (ITEM_ID = MLB) da sheet de anúncios de um arquivo. */
function readAnuncioRows(file: string): RawRow[] {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) throw new Error(`Arquivo não encontrado: ${resolved}`);
  const wb = XLSX.readFile(resolved);
  const sheetName =
    wb.SheetNames.find((n) =>
      n
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .includes("anuncio"),
    ) ?? wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json<RawRow>(wb.Sheets[sheetName], { defval: null });
  const real = rows.filter((r) => normMlb(r["ITEM_ID"]) !== null);
  console.log(`[sheet] ${path.basename(resolved)} '${sheetName}': ${rows.length} linhas → ${real.length} anúncios reais`);
  return real;
}

interface LoadResult {
  bySku: Map<string, Unit>;
  stats: {
    files: number;
    anuncios_total: number;
    inativos_pulados: number;
    dup_mlb_entre_arquivos: number;
    sem_sku: number;
    com_sku: number;
    skus_distintos: number;
    skus_multi_anuncio: number;
  };
}

/** Lê todos os arquivos, dedup por MLB, agrupa por SKU. */
function loadUnits(flags: Flags): LoadResult {
  const files = listInputFiles(flags);
  const bySku = new Map<string, Unit>();
  const seenMlb = new Set<string>();
  const stats = {
    files: files.length,
    anuncios_total: 0,
    inativos_pulados: 0,
    dup_mlb_entre_arquivos: 0,
    sem_sku: 0,
    com_sku: 0,
    skus_distintos: 0,
    skus_multi_anuncio: 0,
  };
  if (files.length === 0) {
    console.warn(`[load][warn] nenhum arquivo em ${DATA_DIR} (nem --files=). 0 anúncios.`);
    return { bySku, stats };
  }

  for (const file of files) {
    for (const r of readAnuncioRows(file)) {
      const mlb = normMlb(r["ITEM_ID"]);
      if (!mlb) continue;
      const active = (asString(r["STATUS"]) ?? "").toLowerCase() === "ativo";
      if (!active && !flags.includeInactive) {
        stats.inativos_pulados++;
        continue;
      }
      if (seenMlb.has(mlb)) {
        stats.dup_mlb_entre_arquivos++;
        continue;
      }
      seenMlb.add(mlb);
      stats.anuncios_total++;

      const skuRaw = asString(r["SKU"]);
      const isPlaceholder = skuRaw === null;
      const sku = skuRaw ?? `${SKU_PLACEHOLDER_PREFIX}${mlb}`;
      if (isPlaceholder) stats.sem_sku++;
      else stats.com_sku++;

      const stock = asInt(r["QUANTITY"]);
      const existing = bySku.get(sku);
      if (existing) {
        existing.mlbs.push(mlb);
        if (stock > existing.maxStock) existing.maxStock = stock;
      } else {
        bySku.set(sku, { sku, mlbs: [mlb], rep: r, maxStock: stock, isPlaceholder });
      }
    }
  }
  stats.skus_distintos = bySku.size;
  for (const u of bySku.values()) if (u.mlbs.length > 1) stats.skus_multi_anuncio++;
  return { bySku, stats };
}

/* ------------------------------ Relatório ------------------------------ */

const reportRef: Record<string, unknown> = { products: null, listings: null, images: null };

async function counts(userId: string): Promise<Record<string, number>> {
  const [products, listings] = await Promise.all([
    prisma.product.count({ where: { userId } }),
    prisma.productListing.count({ where: { product: { userId } } }),
  ]);
  return { products, listings };
}

async function assertUser(userId: string): Promise<void> {
  if (!userId) throw new Error("Informe o usuário: --user-id=<cuid do cliente Magoo>. Abortando.");
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, role: true, parentUserId: true },
  });
  if (!user) throw new Error(`Usuário ${userId} não encontrado. Abortando.`);
  console.log(
    `[preflight] user=${user.email} role=${user.role} parentUserId=${user.parentUserId ?? "(null)"}`,
  );
}

/* ------------------------------ Fase products -------------------------- */

async function phaseProducts(flags: Flags, load: LoadResult): Promise<void> {
  const units = sliceRows([...load.bySku.values()], flags);
  const sum = {
    grupos: load.bySku.size,
    processed: units.length,
    created: 0,
    skipped_existing_sku: 0,
    zero_price: 0,
    no_stock: 0,
    placeholders: 0,
    errors: 0,
    details: [] as unknown[],
  };

  const existing = await prisma.product.findMany({
    where: { userId: flags.userId },
    select: { sku: true },
  });
  const existingSku = new Set(existing.map((p) => p.sku));
  console.log(`[products] preload: ${existingSku.size} SKUs já no banco | grupos a processar=${units.length}`);

  let i = 0;
  for (const u of units) {
    i++;
    if (u.isPlaceholder) sum.placeholders++;
    if (existingSku.has(u.sku)) {
      sum.skipped_existing_sku++;
      continue;
    }

    const rep = u.rep;
    const name = asString(rep["TITLE"]) ?? "(sem título)";
    const price = toDecimalOrZero(rep["PRICE"]);
    if (price.isZero()) sum.zero_price++;
    if (u.maxStock === 0) sum.no_stock++;
    const quality = mapQuality(rep["CONDITION"]);
    const category = asString(rep["CATEGORY"]);

    const attributes = {
      migration: TENANT,
      mlbs: u.mlbs,
      skuOriginal: u.isPlaceholder ? null : u.sku,
      pendingVaapt: u.isPlaceholder, // sem SKU no ML → Vapt liga/ajusta depois
      condition: asString(rep["CONDITION"]),
      listingType: asString(rep["LISTING_TYPE"]),
      warrantyType: asString(rep["WARRANTY_TYPE"]),
      warrantyTime: asString(rep["WARRANTY_TIME"]),
      warrantyUnit: asString(rep["WARRANTY_TIME_UNIT"]),
      currency: asString(rep["CURRENCY_ID"]),
      categoryName: category,
      legacyStatus: asString(rep["STATUS"]),
    };

    const data: Prisma.ProductUncheckedCreateInput = {
      userId: flags.userId,
      sku: u.sku,
      skuNormalized: normalizeSku(u.sku),
      name,
      price,
      stock: u.maxStock,
      quality,
      category,
      weightKg: asWeightKg(rep["SHIPPING_WEIGHT"]),
      heightCm: asDimCm(rep["SHIPPING_HEIGHT"]),
      widthCm: asDimCm(rep["SHIPPING_WIDTH"]),
      lengthCm: asDimCm(rep["SHIPPING_DEPTH"]),
      createdFromMarketplace: true,
      originPlatform: "MERCADO_LIVRE",
      attributes: attributes as unknown as Prisma.InputJsonValue,
    };

    if (flags.dryRun) {
      sum.created++;
      continue;
    }
    try {
      await prisma.product.create({ data, select: { id: true } });
      existingSku.add(u.sku);
      sum.created++;
    } catch (err) {
      if (isUniqueViolation(err)) sum.skipped_existing_sku++;
      else {
        sum.errors++;
        pushCap(sum.details, { sku: u.sku, error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (i % 500 === 0) {
      console.log(`[products] ${i}/${units.length} criados=${sum.created} skuExist=${sum.skipped_existing_sku}`);
    }
  }

  reportRef.products = sum;
  console.log(
    `[products] grupos=${sum.grupos} criados=${sum.created} skuExist=${sum.skipped_existing_sku} placeholders=${sum.placeholders} zero_price=${sum.zero_price} no_stock=${sum.no_stock} erros=${sum.errors}`,
  );
}

/* ------------------------------ Fase listings -------------------------- */

interface Candidate {
  mlb: string;
  sku: string;
  productId: string | null;
  itemCondition: string;
}

async function phaseListings(flags: Flags, load: LoadResult): Promise<void> {
  // sku → productId (todos os produtos do user; inclui os criados nesta fase).
  const products = await prisma.product.findMany({
    where: { userId: flags.userId },
    select: { id: true, sku: true },
  });
  const skuToPid = new Map(products.map((p) => [p.sku, p.id]));

  const allCandidates: Candidate[] = [];
  for (const u of load.bySku.values()) {
    const pid = skuToPid.get(u.sku) ?? null;
    const cond = itemConditionOf(u.rep["CONDITION"]);
    for (const mlb of u.mlbs) allCandidates.push({ mlb, sku: u.sku, productId: pid, itemCondition: cond });
  }
  const candidates = sliceRows(allCandidates, flags);
  const sum = {
    candidates: candidates.length,
    linked: 0,
    already_linked: 0,
    item_not_found: 0, // de nenhuma conta conectada (403 em todas) ou removido
    no_product: 0,
    no_ml_account: 0,
    errors: 0,
    details: [] as unknown[],
  };

  const accounts: AccountLite[] = await prisma.marketplaceAccount.findMany({
    where: { userId: flags.userId, status: "ACTIVE", platform: "MERCADO_LIVRE" },
    select: { id: true, externalUserId: true, accessToken: true, refreshToken: true, expiresAt: true },
  });
  const scoped = flags.mlAccountId ? accounts.filter((a) => a.id === flags.mlAccountId) : accounts;
  if (scoped.length === 0) {
    sum.no_ml_account = candidates.length;
    reportRef.listings = sum;
    console.log("[listings] 0 contas ML ACTIVE — fase pulada (produtos mantêm attributes.mlbs)");
    return;
  }
  const accountIds = scoped.map((a) => a.id);
  console.log(`[listings] contas ML: ${scoped.map((a) => `${a.externalUserId}`).join(", ")}`);

  // Já vinculados (idempotência).
  const alreadyLinked = new Set<string>();
  const candidateMlbs = Array.from(new Set(candidates.map((c) => c.mlb)));
  for (const c of chunk(candidateMlbs, 1000)) {
    const linked = await prisma.productListing.findMany({
      where: { externalListingId: { in: c }, marketplaceAccountId: { in: accountIds } },
      select: { externalListingId: true },
    });
    for (const l of linked) alreadyLinked.add(l.externalListingId);
  }

  if (flags.dryRun && !flags.verifyMlInDryRun) {
    // Sem tocar a API: contabiliza o que seria vinculado (menos já vinculados / sem produto).
    for (const c of candidates) {
      if (alreadyLinked.has(c.mlb)) sum.already_linked++;
      else if (!c.productId) sum.no_product++;
      else sum.linked++;
    }
    reportRef.listings = sum;
    console.log(
      `[listings] (dry, sem ML) candidatos=${sum.candidates} linkaria=${sum.linked} already=${sum.already_linked} semProduto=${sum.no_product}`,
    );
    return;
  }

  // Verify-before MULTI-CONTA: cada token só enxerga os PRÓPRIOS anúncios (200);
  // os das outras contas dão 403 (silenciosamente descartados no multiget). Busca
  // por conta, na ordem, atribuindo cada MLB à conta que o retornou como dono
  // (seller_id == externalUserId). O que sobra = de nenhuma conta conectada.
  const toFetch = new Set(
    candidates.filter((c) => !alreadyLinked.has(c.mlb) && c.productId).map((c) => c.mlb),
  );
  console.log(`[listings] verify-before multi-conta: ${toFetch.size} MLBs a resolver...`);
  const ownedByMlb = new Map<string, { d: MlDetail; owner: AccountLite }>();
  for (const account of scoped) {
    if (toFetch.size === 0) break;
    let m = new Map<string, MlDetail>();
    try {
      m = await fetchDetails(account, Array.from(toFetch), flags.dryRun);
    } catch (e) {
      console.error(`[listings][fetch conta ${account.externalUserId}]`, e instanceof Error ? e.message : String(e));
      throw e;
    }
    let got = 0;
    for (const [mlb, d] of m) {
      if (String(d.seller_id) === String(account.externalUserId)) {
        ownedByMlb.set(mlb, { d, owner: account });
        toFetch.delete(mlb);
        got++;
      }
    }
    console.log(`[listings] conta ${account.externalUserId}: +${got} anúncios (restam ${toFetch.size})`);
  }

  let i = 0;
  for (const c of candidates) {
    i++;
    if (alreadyLinked.has(c.mlb)) {
      sum.already_linked++;
      continue;
    }
    if (!c.productId) {
      sum.no_product++;
      pushCap(sum.details, { mlb: c.mlb, sku: c.sku, reason: "produto_nao_criado" });
      continue;
    }
    const owned = ownedByMlb.get(c.mlb);
    if (!owned) {
      // Nenhuma conta conectada é dona (403 em todas), ou anúncio removido.
      sum.item_not_found++;
      continue;
    }
    const { d, owner } = owned;
    const pics = picturesOf(d);
    if (pics.length && !pictureCache.has(c.productId)) pictureCache.set(c.productId, pics);

    if (flags.dryRun) {
      sum.linked++;
      alreadyLinked.add(c.mlb);
      continue;
    }
    try {
      const data: Prisma.ProductListingUncheckedCreateInput = {
        productId: c.productId,
        marketplaceAccountId: owner.id,
        externalListingId: c.mlb,
        status: d.status ?? "unknown",
        permalink: d.permalink ?? null,
        itemCondition: c.itemCondition,
      };
      await prisma.productListing.create({ data, select: { id: true } });
      sum.linked++;
      alreadyLinked.add(c.mlb);
    } catch (err) {
      if (isUniqueViolation(err)) sum.already_linked++;
      else {
        sum.errors++;
        pushCap(sum.details, { mlb: c.mlb, error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (i % 1000 === 0) {
      console.log(
        `[listings] ${i}/${candidates.length} linked=${sum.linked} already=${sum.already_linked} notFound=${sum.item_not_found}`,
      );
    }
  }

  reportRef.listings = sum;
  console.log(
    `[listings] candidatos=${sum.candidates} linked=${sum.linked} already=${sum.already_linked} notFound=${sum.item_not_found} semProduto=${sum.no_product} erros=${sum.errors}`,
  );
}

/* ------------------------------ Fase images ---------------------------- */

async function phaseImages(flags: Flags): Promise<void> {
  const sum = {
    candidates: 0,
    ja_tinha_foto: 0,
    imagens_preenchidas: 0,
    sem_listing: 0,
    listing_sem_foto: 0,
    errors: 0,
  };

  const products = await prisma.product.findMany({
    where: { userId: flags.userId, attributes: { path: ["migration"], equals: TENANT } },
    select: {
      id: true,
      imageUrl: true,
      imageUrls: true,
      listings: {
        where: {
          marketplaceAccount: { platform: "MERCADO_LIVRE" },
          externalListingId: { startsWith: "MLB" },
        },
        select: {
          externalListingId: true,
          marketplaceAccount: {
            select: { id: true, externalUserId: true, accessToken: true, refreshToken: true, expiresAt: true },
          },
        },
        orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      },
    },
  });

  const noPhoto = products.filter(
    (p) =>
      !(p.imageUrl && p.imageUrl.trim().length > 0) &&
      !(Array.isArray(p.imageUrls) && p.imageUrls.length > 0),
  );
  sum.ja_tinha_foto = products.length - noPhoto.length;
  const targets = sliceRows(noPhoto, flags);
  sum.candidates = targets.length;

  // Coleta MLBs dos que ainda não têm foto no cache; batch por conta.
  const need = targets.filter((p) => !pictureCache.has(p.id) && p.listings.length > 0);
  const byAccount = new Map<string, { account: AccountLite; mlbs: string[] }>();
  for (const p of need) {
    for (const l of p.listings) {
      const acc = l.marketplaceAccount as AccountLite;
      const entry = byAccount.get(acc.id) ?? { account: acc, mlbs: [] };
      entry.mlbs.push(l.externalListingId);
      byAccount.set(acc.id, entry);
    }
  }
  const detailByMlb = new Map<string, MlDetail>();
  for (const { account, mlbs } of byAccount.values()) {
    try {
      const m = await fetchDetails(account, Array.from(new Set(mlbs)), flags.dryRun);
      for (const [k, v] of m) detailByMlb.set(k, v);
    } catch (e) {
      console.error("[images][fetch]", e instanceof Error ? e.message : String(e));
    }
  }

  let i = 0;
  for (const p of targets) {
    i++;
    if (p.listings.length === 0) {
      sum.sem_listing++;
      continue;
    }
    let pics = pictureCache.get(p.id) ?? [];
    if (pics.length === 0) {
      for (const l of p.listings) {
        const d = detailByMlb.get(l.externalListingId.toUpperCase());
        if (d) {
          const ps = picturesOf(d);
          if (ps.length) {
            pics = ps;
            break;
          }
        }
      }
    }
    if (pics.length === 0) {
      sum.listing_sem_foto++;
      continue;
    }
    if (flags.dryRun) {
      sum.imagens_preenchidas++;
      continue;
    }
    try {
      await prisma.product.update({ where: { id: p.id }, data: { imageUrl: pics[0], imageUrls: pics } });
      sum.imagens_preenchidas++;
    } catch {
      sum.errors++;
    }
    if (i % 500 === 0) {
      console.log(`[images] ${i}/${targets.length} preenchidas=${sum.imagens_preenchidas} semFoto=${sum.listing_sem_foto}`);
    }
  }

  reportRef.images = sum;
  console.log(
    `[images] candidatos=${sum.candidates} preenchidas=${sum.imagens_preenchidas} semListing=${sum.sem_listing} semFoto=${sum.listing_sem_foto} jaTinha=${sum.ja_tinha_foto}`,
  );
}

/* -------------------------------- Saída -------------------------------- */

function writeReport(
  flags: Flags,
  load: LoadResult,
  baseline: Record<string, number>,
  final: Record<string, number>,
  startedAt: string,
): void {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const p = path.join(OUT_DIR, `migracao-magoo-${stamp}.json`);
  const report = {
    userId: flags.userId,
    tenant: TENANT,
    mode: flags.dryRun ? "dry-run" : "apply",
    startedAt,
    finishedAt: new Date().toISOString(),
    flags: { only: [...flags.only], limit: flags.limit, offset: flags.offset, includeInactive: flags.includeInactive },
    load: load.stats,
    baseline,
    final,
    phases: reportRef,
  };
  fs.writeFileSync(p, JSON.stringify(report, null, 2), "utf8");
  console.log(`[report] ${p}`);
}

/* -------------------------------- Main --------------------------------- */

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const flags = parseFlags(process.argv.slice(2));
  TENANT = flags.tenant;
  console.log(
    `[migracao-magoo] userId=${flags.userId || "(vazio)"} tenant=${TENANT} modo=${flags.dryRun ? "DRY-RUN" : "APPLY"} only=${[...flags.only].join(",")}`,
  );

  await assertUser(flags.userId);
  const baseline = await counts(flags.userId);
  console.log("[baseline]", JSON.stringify(baseline));

  const load = loadUnits(flags);
  console.log("[load]", JSON.stringify(load.stats));

  if (flags.only.has("products")) await phaseProducts(flags, load);
  if (flags.only.has("listings")) await phaseListings(flags, load);
  if (flags.only.has("images")) await phaseImages(flags);

  const final = await counts(flags.userId);
  writeReport(flags, load, baseline, final, startedAt);

  console.log("\n===== RESUMO MAGOO =====");
  console.log(`modo: ${flags.dryRun ? "DRY-RUN (0 escritas)" : "APPLY"}`);
  console.log(`  anúncios (ativos):     ${load.stats.anuncios_total}  (sem SKU=${load.stats.sem_sku}, inativos pulados=${load.stats.inativos_pulados})`);
  console.log(`  grupos/produtos:       ${load.stats.skus_distintos}  (multi-anúncio=${load.stats.skus_multi_anuncio})`);
  for (const k of ["products", "listings"]) {
    console.log(`  ${k.padEnd(10)} ${String(baseline[k]).padStart(7)} → ${String(final[k]).padStart(7)}  (Δ ${final[k] - baseline[k]})`);
  }
  console.log("========================\n");

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("[migracao-magoo][fatal]", e);
  await prisma.$disconnect();
  process.exit(1);
});
