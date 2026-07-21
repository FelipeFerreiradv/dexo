import "dotenv/config";
import path from "path";
import fs from "fs";
import XLSX from "xlsx";
import axios from "axios";
import { Prisma } from "@prisma/client";
import prisma from "../app/lib/prisma";
import { normalizeSku } from "../app/lib/sku";
import { MLOAuthService } from "../app/marketplaces/services/ml-oauth.service";

/**
 * Migração do cliente "IBR" (sistema antigo, formato diferente do 704) → Dexo.
 *
 *   Fase 1 — Sucatas  → `Scrap`  (índice lote/placa/chassi → scrapId)
 *   Fase 2 — Produtos → `Product` (linka locationId + scrapId por Lote→Placa→Chassi)
 *   Fase 3 — Anúncios → `ProductListing` (VERIFY-BEFORE por seller_id)
 *   Fase 4 — Imagens  → puxa fotos dos anúncios ML
 *   Fase 5 — NF-e     → `NfeEmitida` (registro histórico) + avança NfeSequence
 *
 * NÃO há base de clientes no IBR. Idempotente; sem `--apply` não escreve.
 * Espelha scripts/migracao-704.ts; reusa o split hierárquico de localização
 * (`A > B > C`) do scripts/import-estoque-18-05-2026.ts.
 *
 * Uso (chame o tsx DIRETO — `npm run -- <flags>` engole os flags no PowerShell):
 *   npx tsx scripts/migracao-ibr.ts --user-id=<ID_IBR> --dry-run
 *   npx tsx scripts/migracao-ibr.ts --user-id=<ID_IBR> --apply --only=scraps,products
 *   npx tsx scripts/migracao-ibr.ts --user-id=<ID_IBR> --apply --only=listings,images
 */

type RawRow = Record<string, unknown>;
type Phase = "locations" | "scraps" | "products" | "listings" | "images" | "nfes";

const DEFAULT_USER_ID = ""; // sem default: exige --user-id=<id do cliente>
const DATA_DIR = path.resolve(__dirname, "data", "migracao-ibr");
const OUT_DIR = path.resolve(__dirname, "out");
const ML_API = "https://api.mercadolibre.com";
const MAX_IMAGES = 10;
let LEGACY_TENANT = "IBR"; // default; sobrescrito por --tenant no main (ex.: MESQUITA)
const ALL_PHASES: Phase[] = ["locations", "scraps", "products", "listings", "images", "nfes"];

interface Flags {
  userId: string;
  dryRun: boolean;
  apply: boolean;
  only: Set<Phase>;
  limit: number | null;
  offset: number;
  mlAccountId: string | null;
  skuPrefix: string;
  skipZeroPrice: boolean;
  verifyMlInDryRun: boolean;
  skipSeqAdvance: boolean;
  tenant: string;
  produtos: string;
  sucatas: string;
  nfes: string;
  locationsFile: string;
}

function parseFlags(argv: string[]): Flags {
  const get = (name: string): string | undefined => {
    const flag = `--${name}=`;
    const found = argv.find((a) => a.startsWith(flag));
    return found ? found.slice(flag.length) : undefined;
  };
  const has = (name: string): boolean => argv.includes(`--${name}`);

  const userId = get("user-id") ?? process.env.MIGRACAO_USER_ID ?? DEFAULT_USER_ID;
  const apply = has("apply");
  const dryRun = has("dry-run") || !apply;

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
  const limit = limitRaw && /^\d+$/.test(limitRaw) ? parseInt(limitRaw, 10) : null;
  const offsetRaw = get("offset");
  const offset = offsetRaw && /^\d+$/.test(offsetRaw) ? parseInt(offsetRaw, 10) : 0;

  return {
    userId,
    dryRun,
    apply,
    only,
    limit,
    offset,
    mlAccountId: get("ml-account") ?? null,
    skuPrefix: get("sku-prefix") ?? "",
    skipZeroPrice: has("skip-zero-price"),
    verifyMlInDryRun: has("verify-ml-in-dry-run"),
    skipSeqAdvance: has("skip-seq-advance"),
    tenant: get("tenant") ?? "IBR",
    produtos: get("produtos") ?? path.join(DATA_DIR, "produtos.xlsx"),
    sucatas: get("sucatas") ?? path.join(DATA_DIR, "sucatas.xlsx"),
    nfes: get("nfes") ?? path.join(DATA_DIR, "notas-emitidas.xlsx"),
    locationsFile: get("locations-file") ?? path.join(DATA_DIR, "localizacoes.xlsx"),
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
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : null;
  }
  let s = String(value).trim();
  if (s === "") return null;
  s = s.includes(",") ? s.replace(/\./g, "").replace(",", ".") : s;
  s = s.replace(/[^\d.\-]/g, "");
  if (s === "" || s === "-" || s === "." || s === "-.") return null;
  return s;
}

function toDecimalOrNull(value: unknown): Prisma.Decimal | null {
  const s = asDecimalString(value);
  if (s === null) return null;
  try {
    const d = new Prisma.Decimal(s);
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

/** Peso kg: 0/ausente/negativo → null; >= 10000 não cabe em Decimal(6,2) → null. */
function asWeightKg(value: unknown): Prisma.Decimal | null {
  const d = toDecimalOrNull(value);
  if (d === null || d.isZero() || d.isNegative()) return null;
  if (d.gte(10000)) return null; // Decimal(6,2) → máx 9999.99; peso inválido, dropa
  return d;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function normKey(s: string): string {
  return s
    .replace(/\([^)]*\)/g, " ")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function makeRowGetter(row: RawRow): (name: string) => unknown {
  const map = new Map<string, unknown>();
  for (const k of Object.keys(row)) map.set(normKey(k), row[k]);
  return (name: string) => {
    const v = map.get(normKey(name));
    return v === undefined ? null : v;
  };
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002"
  );
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

function readSheet(filePath: string): RawRow[] {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Arquivo de origem não encontrado: ${resolved}`);
  }
  const wb = XLSX.readFile(resolved);
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new Error(`Workbook sem sheets: ${resolved}`);
  const sheet = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<RawRow>(sheet, { defval: null });
  console.log(
    `[sheet] ${path.basename(resolved)} '${sheetName}': ${rows.length} linhas`,
  );
  return rows;
}

function sliceRows<T>(rows: T[], flags: Flags): T[] {
  const end = flags.limit !== null ? flags.offset + flags.limit : undefined;
  return rows.slice(flags.offset, end);
}

function pushCap<T>(arr: T[], item: T, cap = 1000): void {
  if (arr.length < cap) arr.push(item);
}

function normName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();
}

function cleanChassis(raw: unknown): string | null {
  const s = asString(raw);
  if (!s) return null;
  const up = s.toUpperCase().replace(/\s+/g, "");
  if (!/^[A-Z0-9]+$/.test(up)) return null;
  if (up.length < 11) return null;
  if (/^(.)\1*$/.test(up)) return null;
  return up;
}

function cleanPlate(raw: unknown): string | null {
  const s = asString(raw);
  if (!s) return null;
  const up = s.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (up.length < 6 || up.length > 8) return null;
  return up;
}

/** Lote → chave de vínculo. Vazio ou "0" (lixo) → null. Preserva zeros à esq. */
function normLote(raw: unknown): string | null {
  const s = asString(raw);
  if (!s) return null;
  const t = s.trim().toUpperCase();
  if (t === "0" || t === "") return null;
  return t;
}

function parseMlb(raw: unknown): string | null {
  const s = asString(raw);
  if (!s) return null;
  // Pode vir múltiplos separados por "/" (ex.: "MLB123 / MLB456") — usa o 1º válido.
  for (const part of s.split("/")) {
    let t = part.trim().toUpperCase();
    if (/^\d+$/.test(t)) t = "MLB" + t;
    if (/^MLB\d+$/.test(t)) return t;
  }
  return null;
}

/** Extrai o chassi embutido em "Informações Complementares". */
function parseChassiFromInfo(raw: unknown): string | null {
  const s = asString(raw);
  if (!s) return null;
  const m = s.match(/Chassi:\s*([A-Za-z0-9]+)/i);
  return m ? cleanChassis(m[1]) : null;
}

/** "22/05/2026 15:11:26" → Date. */
function parseBrDateTime(raw: unknown): Date | null {
  const s = asString(raw);
  if (!s) return null;
  const m = s.match(
    /^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?/,
  );
  if (!m) return null;
  const d = new Date(
    Number(m[3]),
    Number(m[2]) - 1,
    Number(m[1]),
    Number(m[4] ?? "0"),
    Number(m[5] ?? "0"),
    Number(m[6] ?? "0"),
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Chave de acesso NF-e (44 díg): cUF(2) AAMM(4) CNPJ(14) mod(2) serie(3)
 * nNF(9) tpEmis(1) cNF(8) cDV(1). Extrai série/número/CNPJ do emitente.
 */
function parseChave(
  chave: string,
): { cnpj: string; serie: number; numero: number } | null {
  if (!/^\d{44}$/.test(chave)) return null;
  return {
    cnpj: chave.slice(6, 20),
    serie: parseInt(chave.slice(22, 25), 10),
    numero: parseInt(chave.slice(25, 34), 10),
  };
}

/** Situação (IBR) → status Dexo. Corrigida (CC-e) segue AUTORIZADA. */
function mapNfeStatus(situacao: string | null): string {
  const s = (situacao ?? "").toLowerCase();
  if (s.includes("cancel")) return "CANCELLED";
  return "AUTHORIZED";
}

/* --------------------------- Tipos internos ---------------------------- */

interface AccountLite {
  id: string;
  externalUserId: string | null;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

interface ScrapIndex {
  byLote: Map<string, string>;
  byPlaca: Map<string, string>;
  byChassi: Map<string, string>;
}

interface CreatedProduct {
  id: string;
  sku: string;
  mlb: string | null;
}

interface MlItem {
  id?: string;
  seller_id?: number;
  status?: string;
  permalink?: string;
  condition?: string;
  pictures: string[];
}

/* ------------------------------- ML API -------------------------------- */

const tokenCache = new Map<string, string>();
const pictureCache = new Map<string, string[]>();

async function getValidToken(
  account: AccountLite,
  dryRun: boolean,
): Promise<string> {
  const cached = tokenCache.get(account.id);
  if (cached) return cached;

  if (new Date(account.expiresAt).getTime() > Date.now() + 60_000) {
    tokenCache.set(account.id, account.accessToken);
    return account.accessToken;
  }

  const refreshed = await MLOAuthService.refreshAccessTokenForAccount(
    account.id,
    account.refreshToken,
  );
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

async function fetchMlItem(
  itemId: string,
  token: string,
): Promise<MlItem | null> {
  try {
    const r = await axios.get<{
      id?: string;
      seller_id?: number;
      status?: string;
      permalink?: string;
      condition?: string;
      pictures?: Array<{ secure_url?: string; url?: string }>;
    }>(`${ML_API}/items/${itemId}`, {
      headers: { Authorization: `Bearer ${token}` },
      params: { attributes: "id,seller_id,status,permalink,condition,pictures" },
      timeout: 20_000,
    });
    const d = r.data ?? {};
    const pics = (d.pictures ?? [])
      .map((p) => p.secure_url ?? p.url ?? "")
      .filter((u): u is string => typeof u === "string" && u.length > 0)
      .slice(0, MAX_IMAGES);
    return {
      id: d.id,
      seller_id: d.seller_id,
      status: d.status,
      permalink: d.permalink,
      condition: d.condition,
      pictures: pics,
    };
  } catch (e) {
    const st = (e as { response?: { status?: number } }).response?.status;
    // 404 = anúncio não existe; 403 = token não tem acesso (anúncio de outra
    // conta/antigo) → em ambos não dá p/ verificar posse: trata como skip.
    if (st === 404 || st === 403) return null;
    throw e;
  }
}

/* ------------------------------ Relatório ------------------------------ */

const reportRef: Record<string, unknown> = {
  scraps: null,
  products: null,
  listings: null,
  images: null,
  nfes: null,
};

async function counts(userId: string): Promise<Record<string, number>> {
  const [products, scraps, locations, nfes] = await Promise.all([
    prisma.product.count({ where: { userId } }),
    prisma.scrap.count({ where: { userId } }),
    prisma.location.count({ where: { userId } }),
    prisma.nfeEmitida.count({ where: { userId } }),
  ]);
  return { products, scraps, locations, nfes };
}

async function assertUser(userId: string): Promise<void> {
  if (!userId) {
    throw new Error(
      "Informe o usuário: --user-id=<cuid do cliente IBR no Dexo>. Abortando.",
    );
  }
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, role: true, parentUserId: true },
  });
  if (!user) throw new Error(`Usuário ${userId} não encontrado. Abortando.`);
  console.log(
    `[preflight] user=${user.email} role=${user.role} parentUserId=${user.parentUserId ?? "(null)"}`,
  );
  if (user.parentUserId !== null) {
    console.warn(
      `[preflight][warn] usuário é COLABORADOR (parentUserId=${user.parentUserId}). Prosseguindo.`,
    );
  }
}

/* ------------------------ Localização hierárquica ---------------------- */

/**
 * Sigla "BARRACÃO 1 > R1 > T2 > A1 > CX-3" → cadeia de `Location`, cada nó com
 * `code` = caminho cumulativo (único) e `parentId` encadeado. Devolve o id da
 * folha. Cache pré-carregado com todas as locations do user → miss = nova.
 */
async function resolveLocationHierarchy(
  rawSigla: string | null,
  userId: string,
  dryRun: boolean,
  cache: Map<string, string>,
  counter: { created: number },
): Promise<string | null> {
  if (!rawSigla) return null;
  const segs = rawSigla
    .split(">")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 0);
  if (segs.length === 0) return null;

  let parentId: string | null = null;
  let currentId: string | null = null;
  const pathParts: string[] = [];

  for (let i = 0; i < segs.length; i++) {
    pathParts.push(segs[i]);
    const code = pathParts.join(" > ").toUpperCase();
    const cached = cache.get(code);
    if (cached !== undefined) {
      currentId = cached;
      parentId = currentId;
      continue;
    }

    let id: string;
    if (dryRun) {
      id = `<dry-loc-${code}>`;
      counter.created++;
    } else {
      try {
        const created = await prisma.location.create({
          data: {
            userId,
            code,
            description: segs[i],
            parentId:
              parentId && !parentId.startsWith("<dry-") ? parentId : null,
          } as Prisma.LocationUncheckedCreateInput,
          select: { id: true },
        });
        id = created.id;
        counter.created++;
      } catch (err) {
        if (isUniqueViolation(err)) {
          const ex = await prisma.location.findUnique({
            where: { userId_code: { userId, code } },
            select: { id: true },
          });
          id = ex?.id ?? code;
        } else {
          throw err;
        }
      }
    }
    cache.set(code, id);
    currentId = id;
    parentId = id;
  }
  return currentId;
}

/* ------------------------------- Fase 1 -------------------------------- */

async function phase1Scraps(flags: Flags): Promise<ScrapIndex> {
  const rows = readSheet(flags.sucatas);
  const idx: ScrapIndex = {
    byLote: new Map(),
    byPlaca: new Map(),
    byChassi: new Map(),
  };
  const sum = {
    rows: rows.length,
    created: 0,
    skipped_existing: 0,
    ambiguous_lote: 0,
    errors: 0,
    details: [] as unknown[],
  };

  // Lotes ambíguos (aparecem em >1 sucata) não entram no índice por lote →
  // as peças com esse lote caem p/ placa/chassi.
  const loteCount = new Map<string, number>();
  for (const r of rows) {
    const l = normLote(makeRowGetter(r)("Lote"));
    if (l) loteCount.set(l, (loteCount.get(l) ?? 0) + 1);
  }

  for (let i = 0; i < rows.length; i++) {
    const get = makeRowGetter(rows[i]);
    const brand = asString(get("Marca")) ?? "INDEFINIDO";
    const model = asString(get("Modelo")) ?? "INDEFINIDO";
    const year = asString(get("Ano"));
    const plate = cleanPlate(get("Placa"));
    const chassis = cleanChassis(get("Chassi"));
    const color = asString(get("Cor"));
    const loteRaw = asString(get("Lote"));
    const cert = asString(get("Certidão de Baixa"));
    const cost = toDecimalOrNull(get("Valor de Compra"));
    const fornecedor = asString(get("Fornecedor"));
    const grupo = asString(get("Modelo de Grupo de Peças"));

    let existing: { id: string } | null = null;
    if (chassis) {
      existing = await prisma.scrap.findFirst({
        where: { userId: flags.userId, chassis },
        select: { id: true },
      });
    } else if (plate) {
      existing = await prisma.scrap.findFirst({
        where: { userId: flags.userId, plate },
        select: { id: true },
      });
    }

    let scrapId: string;
    if (existing) {
      scrapId = existing.id;
      sum.skipped_existing++;
    } else if (flags.dryRun) {
      scrapId = `<dry-scrap-${i}>`;
      sum.created++;
    } else {
      const notesParts = [`Legado ${LEGACY_TENANT} · sucata`];
      if (loteRaw) notesParts.push(`lote ${loteRaw}`);
      if (grupo) notesParts.push(grupo);
      if (fornecedor) notesParts.push(`fornecedor: ${fornecedor}`);
      try {
        const created = await prisma.scrap.create({
          data: {
            userId: flags.userId,
            brand,
            model,
            year,
            plate,
            chassis,
            color,
            lot: loteRaw,
            deregistrationCert: cert,
            cost,
            status: "AVAILABLE",
            logisticsStatus: "ON_LIFT",
            notes: notesParts.join(" · "),
          } as Prisma.ScrapUncheckedCreateInput,
          select: { id: true },
        });
        scrapId = created.id;
        sum.created++;
      } catch (err) {
        if (isUniqueViolation(err)) {
          sum.skipped_existing++;
          continue;
        }
        sum.errors++;
        pushCap(sum.details, {
          i,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
    }

    const nl = normLote(loteRaw);
    if (nl && loteCount.get(nl) === 1) idx.byLote.set(nl, scrapId);
    else if (nl) sum.ambiguous_lote++;
    if (plate) idx.byPlaca.set(plate, scrapId);
    if (chassis) idx.byChassi.set(chassis, scrapId);
  }

  reportRef.scraps = sum;
  console.log(
    `[scraps] criados=${sum.created} pulados=${sum.skipped_existing} ambLote=${sum.ambiguous_lote} idx(lote/placa/chassi)=${idx.byLote.size}/${idx.byPlaca.size}/${idx.byChassi.size}`,
  );
  return idx;
}

/** Reconstrói o índice a partir das sucatas IBR já no banco. */
async function loadScrapIndex(flags: Flags): Promise<ScrapIndex> {
  const scraps = await prisma.scrap.findMany({
    where: {
      userId: flags.userId,
      notes: { contains: `Legado ${LEGACY_TENANT} · sucata` },
    },
    select: { id: true, lot: true, plate: true, chassis: true },
  });
  const idx: ScrapIndex = {
    byLote: new Map(),
    byPlaca: new Map(),
    byChassi: new Map(),
  };
  const loteCount = new Map<string, number>();
  for (const s of scraps) {
    const l = normLote(s.lot);
    if (l) loteCount.set(l, (loteCount.get(l) ?? 0) + 1);
  }
  for (const s of scraps) {
    const l = normLote(s.lot);
    if (l && loteCount.get(l) === 1) idx.byLote.set(l, s.id);
    if (s.plate) idx.byPlaca.set(s.plate.toUpperCase(), s.id);
    if (s.chassis) idx.byChassi.set(s.chassis.toUpperCase(), s.id);
  }
  console.log(
    `[scraps] loadScrapIndex: ${scraps.length} sucatas IBR (lote/placa/chassi=${idx.byLote.size}/${idx.byPlaca.size}/${idx.byChassi.size})`,
  );
  return idx;
}

function linkScrap(
  idx: ScrapIndex,
  lote: string | null,
  plate: string | null,
  chassi: string | null,
): string | null {
  const nl = normLote(lote);
  if (nl && idx.byLote.has(nl)) return idx.byLote.get(nl)!;
  if (plate && idx.byPlaca.has(plate)) return idx.byPlaca.get(plate)!;
  if (chassi && idx.byChassi.has(chassi)) return idx.byChassi.get(chassi)!;
  return null;
}

/* ------------------------------- Fase 2 -------------------------------- */

async function phase2Products(
  flags: Flags,
  idx: ScrapIndex,
): Promise<CreatedProduct[]> {
  const rows = readSheet(flags.produtos);
  const sliced = sliceRows(rows, flags);
  const sum = {
    rows: rows.length,
    processed: sliced.length,
    created: 0,
    skipped_no_sku: 0,
    skipped_existing_sku: 0,
    skipped_anuncio_existente: 0,
    skipped_duplicate_in_sheet: 0,
    soft_possible_dup: 0,
    zero_price: 0,
    scrap_linked: 0,
    scrap_pendente: 0,
    locations_created: 0,
    errors: 0,
    details: [] as unknown[],
  };

  const mlAccountIds = (
    await prisma.marketplaceAccount.findMany({
      where: { userId: flags.userId, status: "ACTIVE", platform: "MERCADO_LIVRE" },
      select: { id: true },
    })
  ).map((a) => a.id);

  const existingProducts = await prisma.product.findMany({
    where: { userId: flags.userId },
    select: { sku: true, skuNormalized: true, name: true, locationId: true, id: true },
  });
  const existingSkuSet = new Set(existingProducts.map((p) => p.sku));
  const existingSkuNorm = new Map<string, string>();
  const existingNameLoc = new Map<string, string>();
  for (const p of existingProducts) {
    if (p.skuNormalized) existingSkuNorm.set(p.skuNormalized, p.id);
    if (p.name) existingNameLoc.set(`${normName(p.name)}|${p.locationId ?? ""}`, p.id);
  }
  const existingLocations = await prisma.location.findMany({
    where: { userId: flags.userId },
    select: { id: true, code: true },
  });
  const locationCache = new Map<string, string>();
  for (const l of existingLocations) locationCache.set(l.code, l.id);

  console.log(
    `[products] preload: ${existingProducts.length} produtos, ${existingLocations.length} locations, ${mlAccountIds.length} contas ML`,
  );

  const seenSku = new Set<string>();
  const locCounter = { created: 0 };
  const created: CreatedProduct[] = [];
  let processed = 0;

  for (const batch of chunk(sliced, 200)) {
    const linkedMlbMap = new Map<string, string>();
    if (mlAccountIds.length) {
      const batchMlbs = Array.from(
        new Set(
          batch
            .map((r) => parseMlb(makeRowGetter(r)("Código MLB")))
            .filter((v): v is string => v !== null),
        ),
      );
      for (const c of chunk(batchMlbs, 1000)) {
        if (c.length === 0) continue;
        const linked = await prisma.productListing.findMany({
          where: {
            externalListingId: { in: c },
            marketplaceAccountId: { in: mlAccountIds },
          },
          select: { externalListingId: true, productId: true },
        });
        for (const l of linked) {
          if (!linkedMlbMap.has(l.externalListingId)) {
            linkedMlbMap.set(l.externalListingId, l.productId);
          }
        }
      }
    }

    for (const row of batch) {
      processed++;
      const get = makeRowGetter(row);
      const rawCodigo = asString(get("Código"));
      if (!rawCodigo) {
        sum.skipped_no_sku++;
        continue;
      }
      const sku = flags.skuPrefix + rawCodigo;
      const skuNorm = normalizeSku(sku);
      const mlb = parseMlb(get("Código MLB"));

      if (existingSkuSet.has(sku)) {
        sum.skipped_existing_sku++;
        continue;
      }
      if (mlb && linkedMlbMap.has(mlb)) {
        sum.skipped_anuncio_existente++;
        pushCap(sum.details, {
          sku,
          mlb,
          existingProductId: linkedMlbMap.get(mlb),
          reason: "anuncio_existente",
        });
        continue;
      }
      if (seenSku.has(sku)) {
        sum.skipped_duplicate_in_sheet++;
        continue;
      }
      seenSku.add(sku);

      const name = asString(get("Produto")) ?? "(sem nome)";
      const priceDec = toDecimalOrNull(get("Valor Venda")) ?? new Prisma.Decimal(0);
      if (priceDec.isZero()) {
        sum.zero_price++;
        if (flags.skipZeroPrice) {
          pushCap(sum.details, { sku, reason: "zero_price_skipped" });
          continue;
        }
      }

      const rawSigla = asString(get("Sigla"));
      const locId = await resolveLocationHierarchy(
        rawSigla,
        flags.userId,
        flags.dryRun,
        locationCache,
        locCounter,
      );
      const realLocId = locId && !locId.startsWith("<dry-") ? locId : null;

      const softId =
        (skuNorm ? existingSkuNorm.get(skuNorm) : undefined) ??
        (realLocId
          ? existingNameLoc.get(`${normName(name)}|${realLocId}`)
          : undefined);
      if (softId) {
        sum.soft_possible_dup++;
        pushCap(sum.details, { sku, reason: "soft_possible_dup", existingProductId: softId });
      }

      const lote = asString(get("Lote"));
      const plate = cleanPlate(get("Placa"));
      const info = asString(get("Informações Complementares"));
      const chassiFromInfo = parseChassiFromInfo(info);
      const scrapId = linkScrap(idx, lote, plate, chassiFromInfo);
      if (scrapId) sum.scrap_linked++;
      else sum.scrap_pendente++;

      const attributes = {
        migration: LEGACY_TENANT,
        legacyCodigo: rawCodigo,
        mlb,
        mercadoLivreFlag: asString(get("Mercado Livre")),
        fotoFlag: asString(get("Foto")),
        unit: asString(get("Unidade")),
        ncm: asString(get("NCM")),
        lote,
        placa: asString(get("Placa")),
        localizacao: asString(get("Localização")),
        infoComplementar: info,
        legacyCreatedAtSerial: asNumber(get("Data de Criação")),
        legacyEstoque: asInt(get("Estoque")),
      };

      const data: Prisma.ProductUncheckedCreateInput = {
        userId: flags.userId,
        sku,
        skuNormalized: skuNorm,
        name,
        price: priceDec,
        costPrice: toDecimalOrNull(get("Custo")),
        stock: asInt(get("Estoque")),
        quality: "SEMINOVO",
        brand: asString(get("Marca")),
        model: asString(get("Modelo")),
        year: asString(get("Ano")),
        partNumber: asString(get("PartNumber")),
        weightKg: asWeightKg(get("Peso")),
        lengthCm: asDimCm(get("Comprimento")),
        widthCm: asDimCm(get("Largura")),
        heightCm: asDimCm(get("Altura")),
        location: rawSigla,
        locationId: realLocId,
        scrapId,
        attributes: attributes as unknown as Prisma.InputJsonValue,
      };

      if (flags.dryRun) {
        created.push({ id: `<dry-${sku}>`, sku, mlb });
        sum.created++;
        continue;
      }
      try {
        const c = await prisma.product.create({ data, select: { id: true } });
        created.push({ id: c.id, sku, mlb });
        sum.created++;
      } catch (err) {
        if (isUniqueViolation(err)) {
          sum.skipped_existing_sku++;
        } else {
          sum.errors++;
          pushCap(sum.details, {
            sku,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
    console.log(
      `[products] ${processed}/${sliced.length} criados=${sum.created} skuExist=${sum.skipped_existing_sku} anuncio=${sum.skipped_anuncio_existente} scrapLink=${sum.scrap_linked}`,
    );
  }

  sum.locations_created = locCounter.created;
  reportRef.products = sum;
  console.log(
    `[products] criados=${sum.created} scrap_linked=${sum.scrap_linked} scrap_pendente=${sum.scrap_pendente} zero_price=${sum.zero_price} locations=${sum.locations_created}`,
  );
  return created;
}

/* ------------------------------- Fase 3 -------------------------------- */

function deriveListingStatus(itemStatus: string | undefined): string {
  return itemStatus ?? "unknown";
}

async function phase3Listings(flags: Flags): Promise<void> {
  const migProducts = await prisma.product.findMany({
    where: {
      userId: flags.userId,
      attributes: { path: ["migration"], equals: LEGACY_TENANT },
    },
    select: { id: true, attributes: true },
  });
  const allWithMlb: CreatedProduct[] = [];
  for (const p of migProducts) {
    const a = (p.attributes ?? {}) as Record<string, unknown>;
    const mlb = parseMlb(a.mlb);
    if (!mlb) continue;
    allWithMlb.push({ id: p.id, sku: "", mlb });
  }
  const withMlb = sliceRows(allWithMlb, flags);
  const sum = {
    candidates: withMlb.length,
    linked: 0,
    already_linked: 0,
    not_owned: 0,
    item_not_found: 0,
    no_ml_account: 0,
    errors: 0,
    details: [] as unknown[],
  };

  const accounts: AccountLite[] = await prisma.marketplaceAccount.findMany({
    where: { userId: flags.userId, status: "ACTIVE", platform: "MERCADO_LIVRE" },
    select: {
      id: true,
      externalUserId: true,
      accessToken: true,
      refreshToken: true,
      expiresAt: true,
    },
  });
  const scoped = flags.mlAccountId
    ? accounts.filter((a) => a.id === flags.mlAccountId)
    : accounts;

  if (scoped.length === 0) {
    sum.no_ml_account = withMlb.length;
    reportRef.listings = sum;
    console.log("[listings] 0 contas ML ACTIVE — fase pulada (mantém attributes.mlb)");
    return;
  }

  const accountIds = scoped.map((a) => a.id);
  const bySeller = new Map<string, AccountLite>();
  for (const a of scoped) if (a.externalUserId) bySeller.set(String(a.externalUserId), a);

  const alreadyLinkedSet = new Set<string>();
  const candidateMlbs = Array.from(new Set(withMlb.map((c) => c.mlb as string)));
  for (const c of chunk(candidateMlbs, 1000)) {
    const linked = await prisma.productListing.findMany({
      where: { externalListingId: { in: c }, marketplaceAccountId: { in: accountIds } },
      select: { externalListingId: true },
    });
    for (const l of linked) alreadyLinkedSet.add(l.externalListingId);
  }

  for (let i = 0; i < withMlb.length; i++) {
    const c = withMlb[i];
    const mlb = c.mlb as string;

    if (alreadyLinkedSet.has(mlb)) {
      sum.already_linked++;
      continue;
    }
    if (flags.dryRun && !flags.verifyMlInDryRun) continue;

    let item: MlItem | null = null;
    try {
      let token = await getValidToken(scoped[0], flags.dryRun);
      try {
        item = await fetchMlItem(mlb, token);
      } catch (e) {
        const st = (e as { response?: { status?: number } }).response?.status;
        if (st === 401) {
          tokenCache.delete(scoped[0].id);
          token = await getValidToken(scoped[0], flags.dryRun);
          item = await fetchMlItem(mlb, token);
        } else if (st === 429) {
          await sleep(2000);
          item = await fetchMlItem(mlb, token);
        } else {
          throw e;
        }
      }
    } catch (e) {
      sum.errors++;
      pushCap(sum.details, { mlb, error: e instanceof Error ? e.message : String(e) });
      continue;
    }

    if (!item) {
      sum.item_not_found++;
      continue;
    }
    const owner =
      item.seller_id != null ? bySeller.get(String(item.seller_id)) : undefined;
    if (!owner) {
      sum.not_owned++;
      pushCap(sum.details, { mlb, seller_id: item.seller_id ?? null });
      continue;
    }

    if (flags.dryRun) {
      sum.linked++;
      alreadyLinkedSet.add(mlb);
      if (!c.id.startsWith("<dry-")) pictureCache.set(c.id, item.pictures);
      continue;
    }

    try {
      const data: Prisma.ProductListingUncheckedCreateInput = {
        productId: c.id,
        marketplaceAccountId: owner.id,
        externalListingId: mlb,
        status: deriveListingStatus(item.status),
        permalink: item.permalink ?? null,
        itemCondition: item.condition ?? "used",
      };
      await prisma.productListing.create({ data, select: { id: true } });
      sum.linked++;
      alreadyLinkedSet.add(mlb);
      pictureCache.set(c.id, item.pictures);
    } catch (err) {
      if (isUniqueViolation(err)) {
        sum.already_linked++;
      } else {
        sum.errors++;
        pushCap(sum.details, { mlb, error: err instanceof Error ? err.message : String(err) });
      }
    }

    await sleep(120);
    if ((i + 1) % 50 === 0) {
      console.log(
        `[listings] ${i + 1}/${withMlb.length} linked=${sum.linked} not_owned=${sum.not_owned} already=${sum.already_linked} notFound=${sum.item_not_found}`,
      );
    }
  }

  reportRef.listings = sum;
  console.log(
    `[listings] candidatos=${sum.candidates} linked=${sum.linked} already=${sum.already_linked} not_owned=${sum.not_owned} notFound=${sum.item_not_found} erros=${sum.errors}`,
  );
}

/* ------------------------------- Fase 4 -------------------------------- */

async function phase4Images(flags: Flags): Promise<void> {
  const sum = {
    candidates: 0,
    imagens_preenchidas: 0,
    sem_listing: 0,
    listing_sem_foto: 0,
    ja_tinha_foto: 0,
    errors: 0,
  };

  const products = await prisma.product.findMany({
    where: {
      userId: flags.userId,
      attributes: { path: ["migration"], equals: LEGACY_TENANT },
    },
    select: {
      id: true,
      sku: true,
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
            select: {
              id: true,
              externalUserId: true,
              accessToken: true,
              refreshToken: true,
              expiresAt: true,
            },
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
  sum.candidates = noPhoto.length;
  sum.ja_tinha_foto = products.length - noPhoto.length;

  for (let i = 0; i < noPhoto.length; i++) {
    const p = noPhoto[i];
    if (p.listings.length === 0) {
      sum.sem_listing++;
      continue;
    }
    let pics = pictureCache.get(p.id) ?? [];
    if (pics.length === 0) {
      for (const l of p.listings) {
        try {
          const token = await getValidToken(l.marketplaceAccount, flags.dryRun);
          const item = await fetchMlItem(l.externalListingId, token);
          if (item && item.pictures.length > 0) {
            pics = item.pictures;
            break;
          }
        } catch {
          // tenta o próximo
        }
        await sleep(120);
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
      await prisma.product.update({
        where: { id: p.id },
        data: { imageUrl: pics[0], imageUrls: pics },
      });
      sum.imagens_preenchidas++;
    } catch {
      sum.errors++;
    }
    if ((i + 1) % 50 === 0) {
      console.log(
        `[images] ${i + 1}/${noPhoto.length} preenchidas=${sum.imagens_preenchidas} semListing=${sum.sem_listing} semFoto=${sum.listing_sem_foto}`,
      );
    }
  }

  reportRef.images = sum;
  console.log(
    `[images] candidatos=${sum.candidates} preenchidas=${sum.imagens_preenchidas} semListing=${sum.sem_listing} semFoto=${sum.listing_sem_foto} jaTinha=${sum.ja_tinha_foto}`,
  );
}

/* ------------------------------- Fase NF-e ----------------------------- */

/**
 * Importa as NF-e emitidas como REGISTRO HISTÓRICO (a base é só um resumo:
 * número/chave/destinatário/data/situação/valor — sem itens/CNPJ/XML/impostos).
 * serie/numero derivam da Chave de Acesso. Campos fiscais obrigatórios sem
 * dado na origem entram com placeholder. Idempotente por chaveAcesso.
 *
 * Ao fim, AVANÇA `NfeSequence.proximoNumero` p/ (max numero + 1) por série —
 * continua a numeração real do cliente e evita colisão na próxima emissão.
 * Desligável com --skip-seq-advance.
 */
async function phaseNfes(flags: Flags): Promise<void> {
  const rows = readSheet(flags.nfes);
  const sliced = sliceRows(rows, flags);
  const sum = {
    rows: rows.length,
    processed: sliced.length,
    created: 0,
    skipped_existing: 0,
    skipped_invalid: 0,
    cancelled: 0,
    corrigida: 0,
    errors: 0,
    sequence_advanced: [] as unknown[],
    details: [] as unknown[],
  };

  const chaves = sliced
    .map((r) => asString(makeRowGetter(r)("Chave de Acesso")))
    .filter((v): v is string => v !== null);
  const existing = new Set(
    chaves.length
      ? (
          await prisma.nfeEmitida.findMany({
            where: { userId: flags.userId, chaveAcesso: { in: chaves } },
            select: { chaveAcesso: true },
          })
        )
          .map((n) => n.chaveAcesso)
          .filter((v): v is string => v !== null)
      : [],
  );

  const seen = new Set<string>();
  const maxNumeroBySerie = new Map<string, number>(); // `${ambiente}|${serie}` → max

  for (const row of sliced) {
    const get = makeRowGetter(row);
    const chave = asString(get("Chave de Acesso"));
    if (!chave) {
      sum.skipped_invalid++;
      continue;
    }
    const parsed = parseChave(chave);
    if (!parsed) {
      sum.skipped_invalid++;
      pushCap(sum.details, { chave, reason: "chave_invalida" });
      continue;
    }
    if (existing.has(chave) || seen.has(chave)) {
      sum.skipped_existing++;
      continue;
    }
    seen.add(chave);

    const ambiente = "PRODUCAO";
    const { serie, numero, cnpj } = parsed;
    const situacao = asString(get("Situação"));
    const status = mapNfeStatus(situacao);
    const isCorrigida = (situacao ?? "").toLowerCase().includes("corrig");
    if (status === "CANCELLED") sum.cancelled++;
    if (isCorrigida) sum.corrigida++;

    const valor = asNumber(get("Valor")) ?? 0;
    const dataEmissao = parseBrDateTime(get("Data"));
    const nome = asString(get("Destinatário")) ?? "";

    const key = `${ambiente}|${serie}`;
    maxNumeroBySerie.set(key, Math.max(maxNumeroBySerie.get(key) ?? 0, numero));

    const infoParts = [`Migração ${LEGACY_TENANT} · registro histórico`];
    if (isCorrigida) infoParts.push("corrigida (CC-e) no sistema antigo");
    if (status === "CANCELLED") infoParts.push("cancelada no sistema antigo");

    if (flags.dryRun) {
      sum.created++;
      continue;
    }
    try {
      const data: Prisma.NfeEmitidaUncheckedCreateInput = {
        userId: flags.userId,
        ambiente,
        modelo: "55",
        serie,
        numero,
        chaveAcesso: chave,
        tipoOperacao: "SAIDA",
        finalidade: "NORMAL",
        destinoOperacao: "INTERNA", // placeholder (origem não traz UF do destinatário)
        naturezaOperacao: "VENDA", // placeholder
        indPresenca: "9", // placeholder (não informado)
        informacoesComplementares: infoParts.join(" · "),
        dataEmissao,
        dataAutorizacao: status === "AUTHORIZED" ? dataEmissao : null,
        destinatarioJson: {
          tipoPessoa: "PF",
          cpfCnpj: "",
          nome,
        } as unknown as Prisma.InputJsonValue,
        emitenteJson: { cnpj } as unknown as Prisma.InputJsonValue,
        totaisJson: {
          totalNota: valor,
          totalProdutos: valor,
          totalIcms: 0,
          totalPis: 0,
          totalCofins: 0,
          totalDesconto: 0,
          totalFrete: 0,
        } as unknown as Prisma.InputJsonValue,
        status,
        emittedByUserId: flags.userId,
      };
      await prisma.nfeEmitida.create({ data, select: { id: true } });
      sum.created++;
    } catch (err) {
      if (isUniqueViolation(err)) {
        sum.skipped_existing++;
      } else {
        sum.errors++;
        pushCap(sum.details, {
          chave,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // Avança a numeração p/ continuar de onde o cliente parou (só p/ frente).
  for (const [key, maxN] of maxNumeroBySerie) {
    const [ambiente, serieStr] = key.split("|");
    const serie = parseInt(serieStr, 10);
    const target = maxN + 1;
    if (flags.dryRun) {
      sum.sequence_advanced.push({ ambiente, serie, para: target, dryRun: true });
      continue;
    }
    if (flags.skipSeqAdvance) continue;
    // Multi-CNPJ: o @@unique composto saiu do schema — findFirst + update por
    // id (forma válida no client velho E novo). Migração é de tenant 1-CNPJ.
    const existingSeq = await prisma.nfeSequence.findFirst({
      where: { userId: flags.userId, ambiente, serie, modelo: "55" },
      select: { id: true, proximoNumero: true },
    });
    const current = existingSeq?.proximoNumero ?? 1;
    const novo = Math.max(current, target);
    if (!existingSeq || novo !== current) {
      if (existingSeq) {
        await prisma.nfeSequence.update({
          where: { id: existingSeq.id },
          data: { proximoNumero: novo },
        });
      } else {
        await prisma.nfeSequence.create({
          data: { userId: flags.userId, ambiente, serie, proximoNumero: novo },
        });
      }
      sum.sequence_advanced.push({ ambiente, serie, de: current, para: novo });
    }
  }

  reportRef.nfes = sum;
  console.log(
    `[nfes] criados=${sum.created} pulados=${sum.skipped_existing} inválidos=${sum.skipped_invalid} canceladas=${sum.cancelled} corrigidas=${sum.corrigida} erros=${sum.errors} seq=${JSON.stringify(sum.sequence_advanced)}`,
  );
}

/* -------------------------------- Saída -------------------------------- */

function writeReport(
  flags: Flags,
  baseline: Record<string, number>,
  final: Record<string, number>,
  startedAt: string,
): void {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const p = path.join(OUT_DIR, `migracao-ibr-${stamp}.json`);
  const report = {
    userId: flags.userId,
    mode: flags.dryRun ? "dry-run" : "apply",
    startedAt,
    finishedAt: new Date().toISOString(),
    flags: {
      only: [...flags.only],
      limit: flags.limit,
      offset: flags.offset,
      skuPrefix: flags.skuPrefix,
      mlAccountId: flags.mlAccountId,
      skipZeroPrice: flags.skipZeroPrice,
      verifyMlInDryRun: flags.verifyMlInDryRun,
    },
    baseline,
    final,
    phases: reportRef,
  };
  fs.writeFileSync(p, JSON.stringify(report, null, 2), "utf8");
  console.log(`[report] ${p}`);
}

function printSummary(
  flags: Flags,
  baseline: Record<string, number>,
  final: Record<string, number>,
): void {
  console.log("\n===== RESUMO =====");
  console.log(`modo: ${flags.dryRun ? "DRY-RUN (0 escritas)" : "APPLY"}`);
  for (const k of ["products", "scraps", "locations", "nfes"]) {
    console.log(
      `  ${k.padEnd(10)} ${String(baseline[k]).padStart(7)} → ${String(final[k]).padStart(7)}  (Δ ${final[k] - baseline[k]})`,
    );
  }
  console.log("==================\n");
}

/* -------------------------- Fase Localizações -------------------------- */

/** Cria (idempotente) as localizações listadas num arquivo de 1 coluna. */
async function phaseLocations(flags: Flags): Promise<void> {
  const resolved = path.resolve(flags.locationsFile);
  if (!fs.existsSync(resolved)) {
    console.log(`[locations] arquivo não encontrado (${resolved}) — pulando`);
    return;
  }
  const wb = XLSX.readFile(resolved);
  const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], {
    header: 1,
    defval: null,
  });
  const codes = Array.from(
    new Set(
      rows
        .flat()
        .map((v) => {
          const s = asString(v);
          return s ? s.toUpperCase().replace(/\s+/g, " ").trim() : null;
        })
        .filter((c): c is string => !!c),
    ),
  );
  const existing = new Set(
    (
      await prisma.location.findMany({
        where: { userId: flags.userId },
        select: { code: true },
      })
    ).map((l) => l.code),
  );
  let created = 0;
  let skipped = 0;
  for (const code of codes) {
    if (existing.has(code)) {
      skipped++;
      continue;
    }
    if (flags.dryRun) {
      created++;
      continue;
    }
    try {
      await prisma.location.create({
        data: { userId: flags.userId, code, description: code } as Prisma.LocationUncheckedCreateInput,
        select: { id: true },
      });
      created++;
    } catch (err) {
      if (isUniqueViolation(err)) skipped++;
      else throw err;
    }
  }
  reportRef.locations = { total: codes.length, created, skipped };
  console.log(
    `[locations] códigos=${codes.length} criadas=${created} puladas(existentes)=${skipped}`,
  );
}

/* -------------------------------- Main --------------------------------- */

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const flags = parseFlags(process.argv.slice(2));
  LEGACY_TENANT = flags.tenant; // marcador por cliente (attributes.migration, notes, filtros)
  console.log(
    `[migracao-ibr] userId=${flags.userId || "(vazio)"} tenant=${flags.tenant} modo=${flags.dryRun ? "DRY-RUN" : "APPLY"} only=${[...flags.only].join(",")}`,
  );

  await assertUser(flags.userId);
  const baseline = await counts(flags.userId);
  console.log("[baseline]", JSON.stringify(baseline));

  if (flags.only.has("locations")) await phaseLocations(flags);

  let idx: ScrapIndex = { byLote: new Map(), byPlaca: new Map(), byChassi: new Map() };
  if (flags.only.has("scraps")) {
    idx = await phase1Scraps(flags);
  } else if (flags.only.has("products")) {
    idx = await loadScrapIndex(flags);
  }

  if (flags.only.has("products")) await phase2Products(flags, idx);
  if (flags.only.has("listings")) await phase3Listings(flags);
  if (flags.only.has("images")) await phase4Images(flags);
  if (flags.only.has("nfes")) await phaseNfes(flags);

  const final = await counts(flags.userId);
  writeReport(flags, baseline, final, startedAt);
  printSummary(flags, baseline, final);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("[migracao-ibr][fatal]", e);
  await prisma.$disconnect();
  process.exit(1);
});
