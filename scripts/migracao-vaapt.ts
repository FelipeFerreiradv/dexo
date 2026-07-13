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
 * Migração do cliente "704" (sistema antigo) → Dexo.
 *
 * Importa, escopado a um `userId`, e SEM duplicar:
 *   Fase 1 — Veículos  → `Scrap`  (mapa legacyVehicleCode → scrapId)
 *   Fase 2 — Clientes  → `Customer`
 *   Fase 3 — Peças     → `Product` (linka locationId / mlCategoryId / scrapId)
 *   Fase 4 — Anúncios  → `ProductListing` (VERIFY-BEFORE: só vincula MLB cujo
 *             seller_id casa com uma conta ML ACTIVE do cliente)
 *   Fase 5 — Imagens   → puxa fotos dos anúncios p/ produtos sem imagem
 *
 * Idempotente: rodar 2× ⇒ 0 criações na 2ª. Trata P2002 como skip.
 * Segurança: sem `--apply` NÃO escreve (equivale a dry-run).
 *
 * Estilo espelhado de scripts/import-estoque-18-05-2026.ts (não modificado).
 *
 * Uso (IMPORTANTE: chame o tsx DIRETO — no PowerShell o `npm run -- <flags>`
 * engole `--apply`/`--only` como config do npm e o script roda em dry-run):
 *   npx tsx scripts/migracao-704.ts --dry-run
 *   npx tsx scripts/migracao-704.ts --apply --only=products --limit=10
 *   npx tsx scripts/migracao-704.ts --apply
 *   npx tsx scripts/migracao-704.ts --apply --only=listings,images --ml-account=<id>
 */

type RawRow = Record<string, unknown>;
type Phase = "scraps" | "customers" | "products" | "listings" | "images";

const DEFAULT_USER_ID = "cmql2zugq0000vs8g376rend5";
const DATA_DIR = path.resolve(__dirname, "data", "migracao-704");
const OUT_DIR = path.resolve(__dirname, "out");
const ML_API = "https://api.mercadolibre.com";
const MAX_IMAGES = 10;
let LEGACY_TENANT = "704"; // sobrescrito por --tenant no main (ex.: MAGOO)
const ALL_PHASES: Phase[] = [
  "scraps",
  "customers",
  "products",
  "listings",
  "images",
];

interface Flags {
  userId: string;
  dryRun: boolean;
  apply: boolean;
  only: Set<Phase>;
  limit: number | null;
  offset: number;
  mlAccountId: string | null;
  skuPrefix: string;
  status: "estocado" | "todos" | "exceto-excluido";
  skipZeroPrice: boolean;
  verifyMlInDryRun: boolean;
  pecas: string;
  veiculos: string;
  clientes: string;
  tenant: string;
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
  // Segurança: só escreve com --apply. --dry-run OU ausência de --apply ⇒ dry-run.
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
  const limit =
    limitRaw && /^\d+$/.test(limitRaw) ? parseInt(limitRaw, 10) : null;
  const offsetRaw = get("offset");
  const offset = offsetRaw && /^\d+$/.test(offsetRaw) ? parseInt(offsetRaw, 10) : 0;

  const statusRaw = (get("status") ?? "estocado").toLowerCase();
  const status: Flags["status"] =
    statusRaw === "todos" || statusRaw === "exceto-excluido"
      ? statusRaw
      : "estocado";

  return {
    userId,
    dryRun,
    apply,
    only,
    limit,
    offset,
    mlAccountId: get("ml-account") ?? null,
    skuPrefix: get("sku-prefix") ?? "",
    status,
    skipZeroPrice: has("skip-zero-price"),
    verifyMlInDryRun: has("verify-ml-in-dry-run"),
    pecas: get("pecas") ?? path.join(DATA_DIR, "Backup Pecas - 704.xlsx"),
    veiculos: get("veiculos") ?? path.join(DATA_DIR, "Backup Veiculos - 704.xlsx"),
    clientes: get("clientes") ?? path.join(DATA_DIR, "Clientes - 704.xlsx"),
    tenant: get("tenant") ?? "704",
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
  if (!sheet) throw new Error(`Sheet '${sheetName}' não encontrada.`);
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

/* --------------------------- Sanitizadores ----------------------------- */

function onlyDigits(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).replace(/\D/g, "");
}

function isAllSameDigit(s: string): boolean {
  return s.length > 0 && /^(\d)\1*$/.test(s);
}

/** Recupera zero à esquerda cortado pelo Excel (num→string) e valida comprimento. */
function padDoc(raw: unknown, len: number): string | null {
  let d = onlyDigits(raw);
  if (d.length === 0) return null;
  if (d.length < len && len - d.length <= 2) d = d.padStart(len, "0");
  if (d.length !== len) return null;
  if (isAllSameDigit(d)) return null; // placeholders: 000..., 999..., 111...
  return d;
}

const validCPF = (raw: unknown): string | null => padDoc(raw, 11);
const validCNPJ = (raw: unknown): string | null => padDoc(raw, 14);

function toCep(raw: unknown): string | null {
  let d = onlyDigits(raw);
  if (d.length === 0) return null;
  if (d.length < 8 && 8 - d.length <= 2) d = d.padStart(8, "0");
  return d.length === 8 ? d : null;
}

const UFS = new Set([
  "AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS",
  "MG", "PA", "PB", "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC",
  "SP", "SE", "TO",
]);

function toUf(raw: unknown): string | null {
  const s = asString(raw);
  if (!s) return null;
  const u = s.trim().toUpperCase();
  return UFS.has(u) ? u : null;
}

function toEmail(raw: unknown): string | null {
  const s = asString(raw);
  if (!s) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
}

/** Trata o literal "undefined" (comum na base 704) como vazio. */
function cleanUndefined(raw: unknown): string | null {
  const s = asString(raw);
  if (!s) return null;
  return s.toLowerCase() === "undefined" ? null : s;
}

function normName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();
}

function isPlaceholderName(name: string): boolean {
  const n = normName(name);
  return (
    n.length === 0 ||
    n.includes("NAO IDENTIFICADO") ||
    n === "UNDEFINED UNDEFINED" ||
    n === "UNDEFINED"
  );
}

function cleanChassis(raw: unknown): string | null {
  const s = asString(raw);
  if (!s) return null;
  const up = s.toUpperCase().replace(/\s+/g, "");
  if (!/^[A-Z0-9]+$/.test(up)) return null; // aspas/lixo (ex.: 0000000'0)
  if (up.length < 11) return null; // VIN tem 17; curto demais = lixo
  if (/^(.)\1*$/.test(up)) return null; // caractere repetido
  return up;
}

function cleanPlate(raw: unknown): string | null {
  const s = asString(raw);
  if (!s) return null;
  const up = s.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (up.length < 6 || up.length > 8) return null;
  return up;
}

function normalizeCode(raw: unknown): string | null {
  const s = asString(raw);
  if (!s) return null;
  return s.toUpperCase().replace(/\s+/g, "");
}

function parseMlb(raw: unknown): string | null {
  const s = asString(raw);
  if (!s) return null;
  let t = s.trim().toUpperCase();
  if (/^\d+$/.test(t)) t = "MLB" + t;
  return /^MLB\d+$/.test(t) ? t : null;
}

/* --------------------------- Tipos internos ---------------------------- */

interface AccountLite {
  id: string;
  externalUserId: string | null;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

interface ScrapRef {
  id: string; // pode ser sintético "<dry-scrap-...>" em dry-run
  brand: string;
  model: string;
  year: string | null;
  version: string | null;
}

interface CreatedProduct {
  id: string; // pode ser sintético "<dry-...>" em dry-run
  sku: string;
  mlb: string | null;
  warrantyDays: number;
  condicao: string | null;
  legacyListingStatus: string | null;
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

/** Busca item ML. Retorna null em 404 (item inexistente/fechado). */
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
    if (st === 404) return null;
    throw e;
  }
}

/* ------------------------------ Relatório ------------------------------ */

const reportRef: Record<string, unknown> = {
  scraps: null,
  customers: null,
  products: null,
  listings: null,
  images: null,
};

async function counts(userId: string): Promise<Record<string, number>> {
  const [products, customers, scraps, locations] = await Promise.all([
    prisma.product.count({ where: { userId } }),
    prisma.customer.count({ where: { userId } }),
    prisma.scrap.count({ where: { userId } }),
    prisma.location.count({ where: { userId } }),
  ]);
  return { products, customers, scraps, locations };
}

async function assertUser(userId: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, role: true, parentUserId: true },
  });
  if (!user) {
    throw new Error(`Usuário ${userId} não encontrado. Abortando.`);
  }
  console.log(
    `[preflight] user=${user.email} role=${user.role} parentUserId=${user.parentUserId ?? "(null)"}`,
  );
  if (user.parentUserId !== null) {
    console.warn(
      `[preflight][warn] usuário é COLABORADOR (parentUserId=${user.parentUserId}). Prosseguindo — foi o alvo solicitado.`,
    );
  }
}

/* ------------------------------- Fase 1 -------------------------------- */

async function phase1Scraps(flags: Flags): Promise<Map<string, ScrapRef>> {
  const rows = readSheet(flags.veiculos);
  const map = new Map<string, ScrapRef>();
  const sum = {
    rows: rows.length,
    created: 0,
    skipped_existing: 0,
    duplicate_chassis_in_sheet: 0,
    errors: 0,
    details: [] as unknown[],
  };
  const seenChassis = new Set<string>();
  const seenPlate = new Set<string>();

  for (let i = 0; i < rows.length; i++) {
    const get = makeRowGetter(rows[i]);
    const cod = asString(get("# Codigo Veiculo"));
    if (!cod) {
      sum.errors++;
      pushCap(sum.details, { row: i + 1, error: "sem # Codigo Veiculo" });
      continue;
    }
    const brand = asString(get("Marca")) ?? "INDEFINIDO";
    const model = asString(get("Modelo")) ?? "INDEFINIDO";
    const chassis = cleanChassis(get("Chassi"));
    const plate = cleanPlate(get("Placa"));
    const version = asString(get("Apelido"));
    const color = asString(get("Cor"));
    const year = asString(get("Ano modelo"));
    const cost = toDecimalOrNull(get("Valor da compra"));

    if (chassis && seenChassis.has(chassis)) sum.duplicate_chassis_in_sheet++;
    const chassisForDedup =
      chassis && !seenChassis.has(chassis) ? chassis : null;
    const plateForDedup = plate && !seenPlate.has(plate) ? plate : null;

    let existing: {
      id: string;
      brand: string;
      model: string;
      year: string | null;
      version: string | null;
    } | null = null;
    if (chassisForDedup) {
      existing = await prisma.scrap.findFirst({
        where: { userId: flags.userId, chassis: chassisForDedup },
        select: { id: true, brand: true, model: true, year: true, version: true },
      });
    } else if (plateForDedup) {
      existing = await prisma.scrap.findFirst({
        where: { userId: flags.userId, plate: plateForDedup },
        select: { id: true, brand: true, model: true, year: true, version: true },
      });
    } else {
      existing = await prisma.scrap.findFirst({
        where: { userId: flags.userId, brand, model, year },
        select: { id: true, brand: true, model: true, year: true, version: true },
      });
    }

    if (chassis) seenChassis.add(chassis);
    if (plate) seenPlate.add(plate);

    if (existing) {
      map.set(cod, {
        id: existing.id,
        brand: existing.brand,
        model: existing.model,
        year: existing.year,
        version: existing.version,
      });
      sum.skipped_existing++;
      continue;
    }

    if (flags.dryRun) {
      map.set(cod, { id: `<dry-scrap-${cod}>`, brand, model, year, version });
      sum.created++;
      continue;
    }

    try {
      const data: Prisma.ScrapUncheckedCreateInput = {
        userId: flags.userId,
        brand,
        model,
        year,
        version,
        color,
        plate,
        chassis,
        cost,
        status: "AVAILABLE",
        logisticsStatus: "DISMANTLED",
        notes: `Legado ${LEGACY_TENANT} · veículo #${cod}`,
      };
      const created = await prisma.scrap.create({ data, select: { id: true } });
      map.set(cod, { id: created.id, brand, model, year, version });
      sum.created++;
    } catch (err) {
      if (isUniqueViolation(err)) {
        sum.skipped_existing++;
      } else {
        sum.errors++;
        pushCap(sum.details, {
          cod,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  console.log(
    `[scraps] criados=${sum.created} pulados=${sum.skipped_existing} dupChassi=${sum.duplicate_chassis_in_sheet} erros=${sum.errors}`,
  );
  reportRef.scraps = sum;
  return map;
}

/** Reconstrói o mapa a partir dos Scrap 704 já no banco (parse do notes). */
async function loadScrapMap(flags: Flags): Promise<Map<string, ScrapRef>> {
  const scraps = await prisma.scrap.findMany({
    where: {
      userId: flags.userId,
      notes: { contains: `Legado ${LEGACY_TENANT} · veículo #` },
    },
    select: { id: true, brand: true, model: true, year: true, version: true, notes: true },
  });
  const map = new Map<string, ScrapRef>();
  for (const s of scraps) {
    const m = s.notes?.match(/veículo #(\d+)/);
    if (m) {
      map.set(m[1], {
        id: s.id,
        brand: s.brand,
        model: s.model,
        year: s.year,
        version: s.version,
      });
    }
  }
  console.log(`[scraps] loadScrapMap: ${map.size} sucatas 704 no banco`);
  return map;
}

/* ------------------------------- Fase 2 -------------------------------- */

async function phase2Customers(flags: Flags): Promise<void> {
  const allRows = readSheet(flags.clientes);
  const rows = sliceRows(allRows, flags);
  const sum = {
    rows: allRows.length,
    processed: rows.length,
    created: 0,
    skipped_existing_legacy: 0,
    skipped_existing_cpf: 0,
    skipped_existing_cnpj: 0,
    skipped_existing_heuristic: 0,
    skipped_duplicate_in_sheet: 0,
    skipped_placeholder: 0,
    errors: 0,
    details: [] as unknown[],
  };
  const seenCpf = new Set<string>();
  const seenCnpj = new Set<string>();
  const seenCod = new Set<string>();

  // Preload ÚNICO dos clientes existentes → dedup 100% em memória.
  const existingCustomers = await prisma.customer.findMany({
    where: { userId: flags.userId },
    select: { cpf: true, cnpj: true, name: true, phone: true, notes: true },
  });
  const exCpf = new Set(
    existingCustomers.map((c) => c.cpf).filter((v): v is string => !!v),
  );
  const exCnpj = new Set(
    existingCustomers.map((c) => c.cnpj).filter((v): v is string => !!v),
  );
  const exNamePhone = new Set(
    existingCustomers
      .filter((c) => c.name && c.phone)
      .map((c) => `${normName(c.name as string)}|${onlyDigits(c.phone)}`),
  );
  // Código legado (# Cod Cliente) gravado em notes → chave de idempotência p/
  // clientes sem CPF/CNPJ/telefone (senão seriam recriados num 2º --apply).
  const exLegacyCod = new Set<string>();
  for (const c of existingCustomers) {
    const m = c.notes?.match(/cliente #(\d+)/);
    if (m) exLegacyCod.add(m[1]);
  }
  console.log(`[customers] preload: ${existingCustomers.length} clientes existentes`);

  let done = 0;
  for (const batch of chunk(rows, 500)) {
    for (const row of batch) {
      done++;
      const get = makeRowGetter(row);
      const cod = asString(get("# Cod Cliente"));
      const rawName = asString(get("Nome Cliente"));
      const personType =
        (asString(get("TipoPessoa")) ?? "PF").toUpperCase() === "PJ"
          ? "PJ"
          : "PF";
      const cpf = validCPF(get("CPF"));
      const cnpj = validCNPJ(get("CNPJ"));

      if (!rawName || isPlaceholderName(rawName)) {
        sum.skipped_placeholder++;
        continue;
      }
      // intra-planilha
      if (
        (cod && seenCod.has(cod)) ||
        (cpf && seenCpf.has(cpf)) ||
        (cnpj && seenCnpj.has(cnpj))
      ) {
        sum.skipped_duplicate_in_sheet++;
        continue;
      }
      if (cod) seenCod.add(cod);
      if (cpf) seenCpf.add(cpf);
      if (cnpj) seenCnpj.add(cnpj);

      // dedup no banco (em memória)
      if (cod && exLegacyCod.has(cod)) {
        sum.skipped_existing_legacy++;
        continue;
      }
      if (cpf && exCpf.has(cpf)) {
        sum.skipped_existing_cpf++;
        continue;
      }
      if (!cpf && cnpj && exCnpj.has(cnpj)) {
        sum.skipped_existing_cnpj++;
        continue;
      }
      if (!cpf && !cnpj) {
        const phone = onlyDigits(get("Telefone"));
        if (phone && exNamePhone.has(`${normName(rawName)}|${phone}`)) {
          sum.skipped_existing_heuristic++;
          continue;
        }
      }

      const ie = asString(get("IE"));
      const data: Prisma.CustomerUncheckedCreateInput = {
        userId: flags.userId,
        personType,
        name: rawName,
        razaoSocial: personType === "PJ" ? rawName : null,
        cpf,
        cnpj,
        rg: asString(get("RG")),
        inscricaoEstadual: ie,
        indicadorIE: personType === "PJ" && ie ? "1" : "9",
        email: toEmail(get("Email")),
        phone: onlyDigits(get("Telefone")) || null,
        cep: toCep(get("CEP")),
        street: asString(get("Endereco")),
        number: cleanUndefined(get("Numero")),
        complement: cleanUndefined(get("Complemento")),
        neighborhood: asString(get("Bairro")),
        city: asString(get("Cidade")),
        state: toUf(get("UF")),
        notes: cod
          ? `Legado ${LEGACY_TENANT} · cliente #${cod}`
          : `Legado ${LEGACY_TENANT}`,
      };

      if (flags.dryRun) {
        sum.created++;
        continue;
      }
      try {
        await prisma.customer.create({ data, select: { id: true } });
        sum.created++;
      } catch (err) {
        if (isUniqueViolation(err)) {
          sum.skipped_existing_cpf++;
        } else {
          sum.errors++;
          pushCap(sum.details, {
            cod,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
    console.log(
      `[customers] ${done}/${rows.length} criados=${sum.created} pulados(leg/cpf/cnpj/heur/dup/ph)=${sum.skipped_existing_legacy}/${sum.skipped_existing_cpf}/${sum.skipped_existing_cnpj}/${sum.skipped_existing_heuristic}/${sum.skipped_duplicate_in_sheet}/${sum.skipped_placeholder}`,
    );
  }
  reportRef.customers = sum;
}

/* ------------------------------- Fase 3 -------------------------------- */

const STOCKED_STATUS = new Set([
  "Cadastro completo - Estocado",
  "Cadastro parcial - Estocado",
]);

function statusPasses(statusRaw: string | null, mode: Flags["status"]): boolean {
  const s = (statusRaw ?? "").trim();
  if (mode === "todos") return true;
  if (mode === "exceto-excluido") return s.toLowerCase() !== "excluído";
  return STOCKED_STATUS.has(s);
}

async function resolveLocationId(
  rawLoc: string | null,
  userId: string,
  dryRun: boolean,
  cache: Map<string, string>,
  counter: { created: number },
): Promise<string | null> {
  const code = normalizeCode(rawLoc);
  if (!code) return null;
  const cached = cache.get(code);
  if (cached !== undefined) return cached;

  // O cache é pré-carregado com TODAS as locations do user → miss = nova.
  let id: string;
  if (dryRun) {
    id = `<dry-loc-${code}>`;
    counter.created++;
  } else {
    try {
      const c = await prisma.location.create({
        data: { userId, code, description: rawLoc } as Prisma.LocationUncheckedCreateInput,
        select: { id: true },
      });
      id = c.id;
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
  return id;
}

/** Resolve a categoria ML a partir do mapa pré-carregado (externalId → id). */
function resolveMlCategoryId(
  rawCat: string | null,
  catByExternal: Map<string, string>,
): string | null {
  if (!rawCat) return null;
  const direct = catByExternal.get(rawCat);
  if (direct) return direct;
  if (/^\d+$/.test(rawCat)) return catByExternal.get(`MLB${rawCat}`) ?? null;
  return null;
}

async function phase3Products(
  flags: Flags,
  scrapMap: Map<string, ScrapRef>,
): Promise<CreatedProduct[]> {
  const rows = readSheet(flags.pecas);
  const sum = {
    rows: rows.length,
    eligible: 0,
    created: 0,
    skipped_status: 0,
    skipped_no_sku: 0,
    skipped_existing_sku: 0,
    skipped_anuncio_existente: 0,
    skipped_duplicate_in_sheet: 0,
    soft_possible_dup: 0,
    zero_price: 0,
    category_not_found: 0,
    scrap_linked: 0,
    scrap_pendente: 0,
    locations_created: 0,
    errors: 0,
    details: [] as unknown[],
  };

  // 1) Filtro de Status → elegíveis (preserva a linha).
  const eligible: Array<{ idx: number; row: RawRow }> = [];
  for (let idx = 0; idx < rows.length; idx++) {
    const statusRaw = asString(makeRowGetter(rows[idx])("Status"));
    if (!statusPasses(statusRaw, flags.status)) {
      sum.skipped_status++;
      continue;
    }
    eligible.push({ idx, row: rows[idx] });
  }
  sum.eligible = eligible.length;
  const sliced = sliceRows(eligible, flags);

  // 2) Contas ML ACTIVE p/ pré-skip "anúncio já vinculado".
  const mlAccountIds = (
    await prisma.marketplaceAccount.findMany({
      where: { userId: flags.userId, status: "ACTIVE", platform: "MERCADO_LIVRE" },
      select: { id: true },
    })
  ).map((a) => a.id);

  const seenSku = new Set<string>();
  const locationCache = new Map<string, string>();
  const locCounter = { created: 0 };
  const created: CreatedProduct[] = [];
  let processed = 0;

  // Preload ÚNICO dos produtos existentes do user (a conta já tem estoque) p/
  // dedup de SKU e checagem suave em memória — evita milhares de queries.
  // (Assume catálogo do user cabendo em memória; hoje ~3k, folgado.)
  const existingProducts = await prisma.product.findMany({
    where: { userId: flags.userId },
    select: { id: true, sku: true, skuNormalized: true, name: true, locationId: true },
  });
  const existingSkuSet = new Set(existingProducts.map((p) => p.sku));
  const existingSkuNorm = new Map<string, string>();
  const existingNameLoc = new Map<string, string>();
  for (const p of existingProducts) {
    if (p.skuNormalized) existingSkuNorm.set(p.skuNormalized, p.id);
    if (p.name) {
      existingNameLoc.set(`${normName(p.name)}|${p.locationId ?? ""}`, p.id);
    }
  }

  // Preload das locations existentes → cache (miss = nova, sem query no loop).
  const existingLocations = await prisma.location.findMany({
    where: { userId: flags.userId },
    select: { id: true, code: true },
  });
  for (const l of existingLocations) locationCache.set(l.code, l.id);

  // Preload das categorias ML (resolve todos os externalId em poucas queries).
  const distinctCats = Array.from(
    new Set(
      sliced
        .map((s) => asString(makeRowGetter(s.row)("Categoria")))
        .filter((v): v is string => v !== null),
    ),
  );
  const catKeys = new Set<string>();
  for (const rc of distinctCats) {
    catKeys.add(rc);
    if (/^\d+$/.test(rc)) catKeys.add(`MLB${rc}`);
  }
  const catByExternal = new Map<string, string>();
  for (const c of chunk([...catKeys], 1000)) {
    if (c.length === 0) continue;
    const found = await prisma.marketplaceCategory.findMany({
      where: { externalId: { in: c } },
      select: { id: true, externalId: true },
    });
    for (const f of found) catByExternal.set(f.externalId, f.id);
  }
  console.log(
    `[products] preload: ${existingProducts.length} produtos, ${existingLocations.length} locations, ${catByExternal.size}/${distinctCats.length} categorias`,
  );

  for (const batch of chunk(sliced, 200)) {
    // Preload: MLBs já vinculados (por lote).
    const linkedMlbMap = new Map<string, string>();
    if (mlAccountIds.length) {
      const batchMlbs = Array.from(
        new Set(
          batch
            .map((b) => parseMlb(makeRowGetter(b.row)("MLB")))
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

    for (const { idx, row } of batch) {
      processed++;
      const get = makeRowGetter(row);
      const rawSku = asString(get("# Cod Peca"));
      if (!rawSku) {
        sum.skipped_no_sku++;
        continue;
      }
      const sku = flags.skuPrefix + rawSku;
      const mlb = parseMlb(get("MLB"));

      // Dedup em camadas — para no 1º match.
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

      const name = asString(get("Nome peca")) ?? "(sem nome)";
      const skuNorm = normalizeSku(sku);
      const condicao = asString(get("Condicao"));
      const isNovo = condicao?.toLowerCase() === "novo";
      const quality: "NOVO" | "SUCATA" = isNovo ? "NOVO" : "SUCATA";
      const priceDec = toDecimalOrNull(get("Preco")) ?? new Prisma.Decimal(0);
      if (priceDec.isZero()) {
        sum.zero_price++;
        if (flags.skipZeroPrice) {
          pushCap(sum.details, { sku, reason: "zero_price_skipped" });
          continue;
        }
      }

      const rawLoc = asString(get("Localizacao"));
      const locId = await resolveLocationId(
        rawLoc,
        flags.userId,
        flags.dryRun,
        locationCache,
        locCounter,
      );

      const rawCat = asString(get("Categoria"));
      const mlCategoryId = resolveMlCategoryId(rawCat, catByExternal);
      if (rawCat && !mlCategoryId) sum.category_not_found++;

      const legacyVeh = asString(get("Cod Veiculo"));
      let scrapId: string | null = null;
      let brand: string | null = null;
      let model: string | null = null;
      let year: string | null = null;
      let sourceVehicle: string | null = null;
      if (legacyVeh && scrapMap.has(legacyVeh)) {
        const ref = scrapMap.get(legacyVeh)!;
        scrapId = ref.id.startsWith("<dry-") ? null : ref.id;
        brand = ref.brand;
        model = ref.model;
        year = ref.year;
        sourceVehicle = ref.version;
        sum.scrap_linked++;
      } else {
        sum.scrap_pendente++;
      }

      const warrantyDays = asInt(get("Garantia"));
      const gradeRaw = asString(get("Qualidade"));
      const grade =
        gradeRaw && (gradeRaw.toUpperCase() === "A" || gradeRaw.toUpperCase() === "B")
          ? gradeRaw.toUpperCase()
          : null;
      const legacyListingStatus = asString(get("Status anuncio"));
      const etiqueta = asString(get("Numero etiqueta"));

      const attributes = {
        migration: LEGACY_TENANT,
        legacyPecaCode: rawSku,
        legacyVehicleCode: legacyVeh,
        legacyStatus: asString(get("Status")),
        legacyListingStatus,
        mlb,
        condicao,
        itemCondition: isNovo ? "new" : "used",
        grade,
        unit: asString(get("Unidade medida")),
        etiqueta,
        legacyQty: {
          inicial: asInt(get("Quantidade Inicial")),
          disponivel: asInt(get("Quantidade Disponivel")),
          vendida: asInt(get("Quantidade Vendida")),
        },
        warrantyDays,
      };

      // Checagem suave (não bloqueia): mesmo skuNormalized, ou mesmo nome+location.
      const realLocId = locId && !locId.startsWith("<dry-") ? locId : null;
      const softId =
        (skuNorm ? existingSkuNorm.get(skuNorm) : undefined) ??
        (realLocId
          ? existingNameLoc.get(`${normName(name)}|${realLocId}`)
          : undefined);
      if (softId) {
        sum.soft_possible_dup++;
        pushCap(sum.details, {
          sku,
          reason: "soft_possible_dup",
          existingProductId: softId,
        });
      }

      const data: Prisma.ProductUncheckedCreateInput = {
        userId: flags.userId,
        sku,
        skuNormalized: skuNorm,
        name,
        price: priceDec,
        stock: 1,
        quality,
        partNumber: etiqueta,
        category: rawCat,
        mlCategoryId,
        location: rawLoc,
        locationId: realLocId,
        scrapId,
        brand,
        model,
        year,
        sourceVehicle,
        attributes: attributes as unknown as Prisma.InputJsonValue,
      };

      if (flags.dryRun) {
        created.push({
          id: `<dry-${sku}>`,
          sku,
          mlb,
          warrantyDays,
          condicao,
          legacyListingStatus,
        });
        sum.created++;
        continue;
      }
      try {
        const c = await prisma.product.create({ data, select: { id: true } });
        created.push({
          id: c.id,
          sku,
          mlb,
          warrantyDays,
          condicao,
          legacyListingStatus,
        });
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
      `[products] ${processed}/${sliced.length} criados=${sum.created} skuExist=${sum.skipped_existing_sku} anuncio=${sum.skipped_anuncio_existente} dupSheet=${sum.skipped_duplicate_in_sheet} catNF=${sum.category_not_found}`,
    );
  }

  sum.locations_created = locCounter.created;
  reportRef.products = sum;
  console.log(
    `[products] elegíveis=${sum.eligible} criados=${sum.created} scrap_linked=${sum.scrap_linked} scrap_pendente=${sum.scrap_pendente} locations=${sum.locations_created}`,
  );
  return created;
}

/* ------------------------------- Fase 4 -------------------------------- */

function deriveListingStatus(
  itemStatus: string | undefined,
  legacy: string | null,
): string {
  if (itemStatus) return itemStatus;
  if (legacy && /não estocado/i.test(legacy)) return "paused";
  if (legacy && /anunciado/i.test(legacy)) return "active";
  return "unknown";
}

async function phase4Listings(flags: Flags): Promise<void> {
  // Candidatos vêm do BANCO (produtos 704 com attributes.mlb) — assim a fase
  // roda standalone via --only=listings, sem depender do que a Fase 3 criou
  // nesta execução (num re-run a Fase 3 não cria nada e a lista viria vazia).
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
    allWithMlb.push({
      id: p.id,
      sku: "",
      mlb,
      warrantyDays:
        typeof a.warrantyDays === "number" ? a.warrantyDays : asInt(a.warrantyDays),
      condicao: typeof a.condicao === "string" ? a.condicao : null,
      legacyListingStatus:
        typeof a.legacyListingStatus === "string" ? a.legacyListingStatus : null,
    });
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

  // Preload em lote dos MLBs já vinculados (evita 1 findFirst por candidato).
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

    // Dry-run sem verificação: só contabilidade via DB (o resto "seria verificado").
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
      pushCap(sum.details, {
        mlb,
        error: e instanceof Error ? e.message : String(e),
      });
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
        status: deriveListingStatus(item.status, c.legacyListingStatus),
        permalink: item.permalink ?? null,
        itemCondition:
          item.condition ?? (c.condicao?.toLowerCase() === "novo" ? "new" : "used"),
        hasWarranty: c.warrantyDays > 0,
        warrantyUnit: c.warrantyDays > 0 ? "dias" : null,
        warrantyDuration: c.warrantyDays > 0 ? c.warrantyDays : null,
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
        pushCap(sum.details, {
          mlb,
          error: err instanceof Error ? err.message : String(err),
        });
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

/* ------------------------------- Fase 5 -------------------------------- */

async function phase5Images(flags: Flags): Promise<void> {
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
          // tenta o próximo listing
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

/* -------------------------------- Saída -------------------------------- */

function writeReport(
  flags: Flags,
  baseline: Record<string, number>,
  final: Record<string, number>,
  startedAt: string,
): void {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const p = path.join(OUT_DIR, `migracao-704-${stamp}.json`);
  const report = {
    userId: flags.userId,
    mode: flags.dryRun ? "dry-run" : "apply",
    startedAt,
    finishedAt: new Date().toISOString(),
    flags: {
      only: [...flags.only],
      limit: flags.limit,
      offset: flags.offset,
      status: flags.status,
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
  for (const k of ["products", "customers", "scraps", "locations"]) {
    console.log(
      `  ${k.padEnd(10)} ${String(baseline[k]).padStart(7)} → ${String(final[k]).padStart(7)}  (Δ ${final[k] - baseline[k]})`,
    );
  }
  console.log("==================\n");
}

/* -------------------------------- Main --------------------------------- */

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const flags = parseFlags(process.argv.slice(2));
  LEGACY_TENANT = flags.tenant; // marcador por cliente (attributes.migration, notes)
  console.log(
    `[migracao-704] userId=${flags.userId} tenant=${LEGACY_TENANT} modo=${flags.dryRun ? "DRY-RUN" : "APPLY"} only=${[...flags.only].join(",")}`,
  );

  await assertUser(flags.userId);
  const baseline = await counts(flags.userId);
  console.log("[baseline]", JSON.stringify(baseline));

  let scrapMap = new Map<string, ScrapRef>();
  if (flags.only.has("scraps")) {
    scrapMap = await phase1Scraps(flags);
  } else if (flags.only.has("products")) {
    scrapMap = await loadScrapMap(flags);
  }

  if (flags.only.has("customers")) await phase2Customers(flags);

  if (flags.only.has("products")) await phase3Products(flags, scrapMap);
  if (flags.only.has("listings")) await phase4Listings(flags);
  if (flags.only.has("images")) await phase5Images(flags);

  const final = await counts(flags.userId);
  writeReport(flags, baseline, final, startedAt);
  printSummary(flags, baseline, final);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("[migracao-704][fatal]", e);
  await prisma.$disconnect();
  process.exit(1);
});
