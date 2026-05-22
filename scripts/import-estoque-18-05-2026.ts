import "dotenv/config";
import path from "path";
import fs from "fs";
import XLSX from "xlsx";
import { Prisma } from "@prisma/client";
import prisma from "../app/lib/prisma";
import { normalizeSku } from "../app/lib/sku";

/**
 * Importação do "Relatório Estoque 18.05.2026" + vínculo de anúncios já existentes.
 *
 * Fase 1 — cria `Product` (escopado a userId) SEM nunca duplicar `(userId, sku)`:
 *   se já existe um Product com aquele sku para o userId, PULA (não atualiza).
 *   Reconstrói a hierarquia de `Location` a partir da coluna `Sigla` e cria
 *   uma `ProductCompatibility` (aninhada no create) quando marca+modelo existem.
 *
 * Fase 2 — amarra (sem publicar nada externo) os produtos a anúncios que JÁ
 *   existem fora: Mercado Livre via coluna `CódigoMLB` → cria `ProductListing`.
 *   Shopee é AUDIT-ONLY (zero escritas): `ProductListing.productId` é NOT NULL,
 *   então o ramo "se productId IS NULL atualiza" do spec nunca dispara, e a
 *   planilha não traz externalListingId de Shopee — então só auditamos.
 *
 * Idempotente: rodar 2x sobre a mesma planilha → created=0, skippedExisting=N.
 * Estilo espelhado de scripts/import-stock-and-publish.ts (NÃO modificado).
 *
 * Uso:
 *   npx tsx scripts/import-estoque-18-05-2026.ts --dry-run --limit=50
 *   npx tsx scripts/import-estoque-18-05-2026.ts --limit=200
 *   npx tsx scripts/import-estoque-18-05-2026.ts
 *   npx tsx scripts/import-estoque-18-05-2026.ts --only-links --platform=ml
 */

type RawRow = Record<string, unknown>;

interface Flags {
  userId: string;
  src: string;
  dryRun: boolean;
  limit: number | null;
  // Pula as N primeiras linhas (com sku) antes de aplicar --limit. Útil p/
  // preview em fatia "fresca" e p/ retomar uma corrida grande por partes.
  offset: number;
  skipLinks: boolean;
  onlyLinks: boolean;
  platform: "ml" | "shopee" | "all";
  // Desambiguação EXPLÍCITA da conta ML (não é "adivinhar"): quando há >1 conta
  // ML ativa, força todos os MLBs da planilha para esta conta. Vazio = regra
  // do spec (1 conta → usa; >1 → inferir por ProductListing; senão pular).
  mlAccountId: string | null;
  // Modo read-only: descobre a conta ML dona dos MLBs da planilha cruzando
  // com ProductListing existente. Não escreve nada e encerra após o relatório.
  diagnoseMl: boolean;
  // Modo read-only: roda as 3 queries de validação do plano e encerra.
  validate: boolean;
  // Modo read-only: imprime detalhes (sku/nome/preço/listings) dos productIds
  // informados (CSV) e encerra. Para investigar conflitos de anúncio.
  inspectIds: string[] | null;
  // Desvio do spec (opt-in): antes de criar, se algum MLB da linha já está
  // vinculado a um Product existente do user (qualquer conta ML ACTIVE), PULA
  // a linha (anúncio já existe no Dexo) em vez de criar produto duplicado.
  skipExistingAnuncio: boolean;
  // Read-only: cruza planilha×MLB×produtos existentes e reporta quantos
  // produtos seriam enriquecidos e quantos ganhariam cada campo. Zero escrita.
  enrichAnalyze: boolean;
  // Modo enriquecimento: atualiza campos VAZIOS dos produtos esqueleto a partir
  // da planilha primária (--xlsx), casando por MLB. Default = dry-run (não grava).
  // --apply efetiva. --xlsx-fallback usa uma 2ª planilha como fallback para
  // year e imageUrl (campos que sumiram da exportação nova do Dexo).
  enrich: boolean;
  apply: boolean;
  xlsxFallback: string | null;
  // Read-only: para cada conta Shopee, classifica ProductListings em
  // alreadyLinked / needsRelink / noMatch / noSku via externalSku=Product.sku.
  shopeeAnalyze: boolean;
  // Read-only: matriz de cobertura produto × ML × Shopee. Conta quantos
  // produtos têm anúncio em cada conta, em ambos canais, ou em nenhum.
  coverageAnalyze: boolean;
}

interface EstoqueRow {
  rowNumber: number; // linha na planilha (1-based, +1 do header)
  sku: string; // valor canônico: String(Código).trim()
  name: string;
  priceStr: string | null; // string numérica saneada (ou null)
  costStr: string | null;
  stock: number;
  brand: string | null;
  model: string | null;
  year: string | null;
  yearFrom: number | null;
  yearTo: number | null;
  partNumber: string | null;
  description: string | null;
  imageUrl: string | null;
  imageUrls: string[];
  weightKg: Prisma.Decimal | null;
  lengthCm: number | null;
  widthCm: number | null;
  heightCm: number | null;
  sigla: string | null; // hierarquia de Location
  localizacao: string | null; // descritivo do nó folha
  attributes: Record<string, string> | null;
  mlbCodes: string[];
  mercadoLivre: boolean;
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
  userId: string;
  startedAt: string;
  finishedAt: string;
  totals: {
    rows: number;
    created: number;
    skippedExisting: number;
    skippedZeroPrice: number;
    skippedDuplicateInSheet: number;
    skippedNoSku: number;
    skippedAnuncioExists: number;
    errors: number;
  };
  locationsCreated: number;
  compatibilitiesCreated: number;
  createdProductIds: string[];
  skippedExisting: Array<{ sku: string; existingProductId: string }>;
  skippedAnuncioExists: Array<{
    sku: string;
    mlb: string;
    existingProductId: string;
  }>;
  errors: ImportError[];
  otherSkips: ImportSkip[];
}

interface LinkSummary {
  userId: string;
  startedAt: string;
  finishedAt: string;
  dryRun: boolean;
  ml: {
    linked: number;
    alreadyLinked: number;
    externalIdConflict: number;
    accountAmbiguous: number;
    noAccount: number;
    invalidMlb: number;
  };
  shopee: {
    linked: number; // sempre 0 (audit-only) — mantido por paridade de schema
    alreadyLinked: number;
    noListing: number;
    conflict: number;
    multipleListings: number;
    noActiveAccount: number;
  };
  details: Record<string, string[]>;
}

const DEFAULT_USER_ID = "cmn5yc4rn0000vsasmwv9m8nc";
// Fonte padrão = CSV em Downloads (decisão do usuário). O script é agnóstico
// de formato: aceita .csv ou .xlsx (sheet "Result 1") via --xlsx=<path>.
const DEFAULT_SRC = "C:/Users/Casa/Downloads/Relatório Estoque 18.05.2026 (1).csv";
const OUT_DIR = path.resolve(__dirname, "out");
const DATA_DIR = path.resolve(__dirname, "data");
const CANONICAL_BASENAME = "estoque-18-05-2026";
const LINK_STATUS = "linked_import_18_05_2026";

function parseFlags(argv: string[]): Flags {
  const get = (name: string): string | undefined => {
    const flag = `--${name}=`;
    const found = argv.find((a) => a.startsWith(flag));
    return found ? found.slice(flag.length) : undefined;
  };
  const has = (name: string): boolean => argv.includes(`--${name}`);

  const userId = get("user-id") ?? process.env.IMPORT_USER_ID ?? DEFAULT_USER_ID;
  // --xlsx é o nome do flag exigido pelo spec; aceita .csv ou .xlsx.
  const src = get("xlsx") ?? get("csv") ?? process.env.IMPORT_SRC ?? DEFAULT_SRC;
  const limitRaw = get("limit");
  const limit = limitRaw && /^\d+$/.test(limitRaw) ? parseInt(limitRaw, 10) : null;
  const offsetRaw = get("offset");
  const offset = offsetRaw && /^\d+$/.test(offsetRaw) ? parseInt(offsetRaw, 10) : 0;
  const platformRaw = (get("platform") ?? "all").toLowerCase();
  const platform: Flags["platform"] =
    platformRaw === "ml" || platformRaw === "shopee" ? platformRaw : "all";
  const mlAccountId = get("ml-account") ?? null;

  return {
    userId,
    src,
    dryRun: has("dry-run"),
    limit,
    offset,
    skipLinks: has("skip-links"),
    onlyLinks: has("only-links"),
    platform,
    mlAccountId,
    diagnoseMl: has("diagnose-ml"),
    validate: has("validate"),
    inspectIds: (() => {
      const v = get("inspect");
      if (!v) return null;
      const ids = v
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      return ids.length > 0 ? ids : null;
    })(),
    skipExistingAnuncio: has("skip-existing-anuncio"),
    enrichAnalyze: has("enrich-analyze"),
    enrich: has("enrich"),
    apply: has("apply"),
    xlsxFallback: get("xlsx-fallback") ?? null,
    shopeeAnalyze: has("shopee-analyze"),
    coverageAnalyze: has("coverage-analyze"),
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
  // BR-tolerante: se tem vírgula, '.' é separador de milhar e ',' decimal.
  const cleaned = s.includes(",") ? s.replace(/\./g, "").replace(",", ".") : s;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function asInt(value: unknown): number {
  const n = asNumber(value);
  if (n === null) return 0;
  return Math.max(0, Math.floor(n));
}

/** Dimensão em cm: 0/ausente/<=0 → null; senão inteiro. */
function asDimCm(value: unknown): number | null {
  const n = asNumber(value);
  if (n === null || n <= 0) return null;
  return Math.floor(n);
}

/**
 * Converte célula para string numérica saneada (sem drift IEEE-754):
 * BR-tolerante + strip defensivo. Retorna null se não-numérico/vazio.
 */
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

function parseMlbCodes(raw: string | null): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  // Aceita múltiplos MLBs separados por vírgula, barra, ponto-e-vírgula ou
  // espaço (vimos os 3 padrões em exportações diferentes do Dexo).
  for (const part of raw.split(/[\s,/;]+/)) {
    const t = part.trim().toUpperCase();
    if (/^MLB\d+$/.test(t) && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/** Normaliza nome de coluna p/ casar headers independentemente de acento/encoding.
 * Conteúdo entre parênteses é removido antes (ex.: "Custo (R$)" vira "Custo"). */
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

async function assertAdmin(userId: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, parentUserId: true, role: true },
  });
  if (!user) {
    throw new Error(`Usuário ${userId} não encontrado. Abortando.`);
  }
  if (user.parentUserId !== null) {
    throw new Error(
      `Usuário ${userId} é colaborador (parentUserId=${user.parentUserId}). Importação só é permitida para admin.`,
    );
  }
  if (user.role !== "ADMIN") {
    console.warn(
      `[admin][warn] role=${user.role} (esperado ADMIN). Prosseguindo pois parentUserId é NULL.`,
    );
  }
  console.log(`[admin] OK: ${user.email} (${user.id})`);
}

function readSheet(filePath: string): RawRow[] {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Arquivo de origem não encontrado: ${resolved}`);
  }
  const ext = path.extname(resolved).toLowerCase();
  console.log(`[sheet] Lendo: ${resolved} (ext=${ext || "?"})`);

  let wb: XLSX.WorkBook;
  if (ext === ".csv") {
    const buf = fs.readFileSync(resolved);
    // codepage 65001 = UTF-8 (headers com acento: Código, DataCriação, etc.)
    wb = XLSX.read(buf, { type: "buffer", codepage: 65001, raw: false });
  } else {
    wb = XLSX.readFile(resolved);
  }

  let sheetName = wb.SheetNames[0];
  if (ext !== ".csv") {
    if (wb.SheetNames.includes("Result 1")) {
      sheetName = "Result 1";
    } else {
      console.warn(
        `[sheet][warn] sheet 'Result 1' não encontrada; usando primeira: '${sheetName}'`,
      );
    }
  }
  if (!sheetName) throw new Error("Workbook sem sheets.");
  const sheet = wb.Sheets[sheetName];
  if (!sheet) throw new Error(`Sheet '${sheetName}' não encontrada.`);
  const rows = XLSX.utils.sheet_to_json<RawRow>(sheet, { defval: null });
  console.log(`[sheet] '${sheetName}' linhas de dados: ${rows.length}`);
  return rows;
}

/**
 * Constrói as linhas tipadas + o sheetMap (sku → {mlbCodes, mercadoLivre}).
 * Linhas sem `Código` são contadas como skippedNoSku e descartadas.
 * Primeira ocorrência de cada sku vence no sheetMap (consistente com a dedup).
 */
function buildRows(rawRows: RawRow[]): {
  rows: EstoqueRow[];
  skippedNoSku: number;
  sheetMap: Map<string, { mlbCodes: string[]; mercadoLivre: boolean }>;
} {
  const rows: EstoqueRow[] = [];
  const sheetMap = new Map<string, { mlbCodes: string[]; mercadoLivre: boolean }>();
  let skippedNoSku = 0;

  for (let i = 0; i < rawRows.length; i++) {
    const get = makeRowGetter(rawRows[i]);
    const rowNumber = i + 2; // +1 header, +1 base-1

    const sku = asString(get("Código"));
    if (!sku) {
      skippedNoSku++;
      continue;
    }

    const name = asString(get("Produto")) ?? sku;
    const priceStr = asDecimalString(get("Valor_Venda"));
    const costStr = asDecimalString(get("Custo"));
    const stock = asInt(get("Estoque"));
    const brand = asString(get("Marca"));
    const model = asString(get("Modelo"));
    const yearRaw = asString(get("Ano"));
    const { year, yearFrom, yearTo } = parseYearField(yearRaw);
    const partNumber = asString(get("PartNumber"));
    const description = asString(get("InformaçõesComplementares"));

    const url = asString(get("URLIMAGEM"));
    const validUrl = url && url.startsWith("https://") ? url : null;

    const pesoG = asNumber(get("Peso"));
    let weightKg: Prisma.Decimal | null = null;
    if (pesoG !== null && pesoG > 0) {
      try {
        const kg = new Prisma.Decimal(pesoG).div(1000).toDecimalPlaces(2);
        // Decimal(6,2) → máximo 9999.99 kg. Acima disso é dado inválido → null.
        weightKg = kg.gt("9999.99") ? null : kg;
      } catch {
        weightKg = null;
      }
    }

    const lengthCm = asDimCm(get("Comprimento"));
    const widthCm = asDimCm(get("Largura"));
    const heightCm = asDimCm(get("Altura"));

    const sigla = asString(get("Sigla"));
    const localizacao = asString(get("Localização"));

    const unit = asString(get("Unidade"));
    const lote = asString(get("Lote"));
    const placa = asString(get("Placa"));
    const ncm = asString(get("NCM"));
    const attrs: Record<string, string> = {};
    if (unit) attrs.unit = unit;
    if (lote) attrs.lote = lote;
    if (placa) attrs.licensePlate = placa;
    if (ncm && ncm !== "00000000") attrs.ncm = ncm;
    const attributes = Object.keys(attrs).length > 0 ? attrs : null;

    const mlbCodes = parseMlbCodes(asString(get("CódigoMLB")));
    const mercadoLivre = (asString(get("MercadoLivre")) ?? "").toUpperCase() === "SIM";

    rows.push({
      rowNumber,
      sku,
      name,
      priceStr,
      costStr,
      stock,
      brand,
      model,
      year,
      yearFrom,
      yearTo,
      partNumber,
      description,
      imageUrl: validUrl,
      imageUrls: validUrl ? [validUrl] : [],
      weightKg,
      lengthCm,
      widthCm,
      heightCm,
      sigla,
      localizacao,
      attributes,
      mlbCodes,
      mercadoLivre,
    });

    if (!sheetMap.has(sku)) {
      sheetMap.set(sku, { mlbCodes, mercadoLivre });
    }
  }

  return { rows, skippedNoSku, sheetMap };
}

/**
 * Resolve a hierarquia de Location a partir de `Sigla` (split em `>`).
 * - cache por `code` (DB é @@unique([userId, code]) — por segmento, não por path)
 * - find-then-create: NUNCA reparenta/altera Location existente
 * - leaf recebe description = coluna `Localização` (só na criação)
 * - dry-run: ids sintéticos `<dry-...>`, sem escrita
 */
async function resolveLocationId(
  row: EstoqueRow,
  userId: string,
  dryRun: boolean,
  cache: Map<string, string>,
  counter: { created: number },
): Promise<string | null> {
  if (!row.sigla) return null;
  const parts = row.sigla
    .split(">")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) return null;

  let parentId: string | null = null;
  let currentId: string | null = null;

  for (let i = 0; i < parts.length; i++) {
    const code = parts[i];
    const isLeaf = i === parts.length - 1;

    const cached = cache.get(code);
    if (cached !== undefined) {
      currentId = cached;
      parentId = currentId;
      continue;
    }

    const existing = await prisma.location.findUnique({
      where: { userId_code: { userId, code } },
      select: { id: true },
    });

    let resolvedId: string;
    if (existing) {
      resolvedId = existing.id;
    } else if (dryRun) {
      resolvedId = `<dry-${code}>`;
      counter.created++;
    } else {
      const createdLoc: { id: string } = await prisma.location.create({
        data: {
          userId,
          code,
          // parentId só quando o pai é um id real (não sintético de dry-run)
          parentId:
            parentId && !parentId.startsWith("<dry-") ? parentId : null,
          description: isLeaf ? row.localizacao : null,
        },
        select: { id: true },
      });
      resolvedId = createdLoc.id;
      counter.created++;
    }

    currentId = resolvedId;
    cache.set(code, resolvedId);
    parentId = resolvedId;
  }

  return currentId;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002"
  );
}

async function runImport(
  rows: EstoqueRow[],
  flags: Flags,
): Promise<{ summary: ImportSummary; createdPairs: Array<{ id: string; sku: string }> }> {
  const startedAt = new Date().toISOString();
  const summary: ImportSummary = {
    userId: flags.userId,
    startedAt,
    finishedAt: "",
    totals: {
      rows: rows.length,
      created: 0,
      skippedExisting: 0,
      skippedZeroPrice: 0,
      skippedDuplicateInSheet: 0,
      skippedNoSku: 0,
      skippedAnuncioExists: 0,
      errors: 0,
    },
    locationsCreated: 0,
    compatibilitiesCreated: 0,
    createdProductIds: [],
    skippedExisting: [],
    skippedAnuncioExists: [],
    errors: [],
    otherSkips: [],
  };

  const createdPairs: Array<{ id: string; sku: string }> = [];
  const seenInSheet = new Set<string>();
  const locationCache = new Map<string, string>();
  const locationCounter = { created: 0 };

  // Pré-skip por MLB (opt-in): contas ML ACTIVE do user p/ checar se o anúncio
  // da linha já está vinculado a algum Product existente.
  let mlAccountIds: string[] = [];
  if (flags.skipExistingAnuncio) {
    const mlAccts = await prisma.marketplaceAccount.findMany({
      where: {
        userId: flags.userId,
        status: "ACTIVE",
        platform: "MERCADO_LIVRE",
      },
      select: { id: true },
    });
    mlAccountIds = mlAccts.map((a) => a.id);
    console.log(
      `[import] --skip-existing-anuncio ON: ${mlAccountIds.length} conta(s) ML p/ checagem de anúncio`,
    );
  }

  const batches = chunk(rows, 200);
  let processed = 0;

  for (const batch of batches) {
    const t0 = Date.now();
    const batchSkus = Array.from(new Set(batch.map((r) => r.sku)));
    const existingRows = await prisma.product.findMany({
      where: { userId: flags.userId, sku: { in: batchSkus } },
      select: { sku: true, id: true },
    });
    const existingMap = new Map<string, string>();
    for (const e of existingRows) existingMap.set(e.sku, e.id);

    // Preload por lote: MLBs deste lote que JÁ estão vinculados a algum Product
    // (qualquer conta ML ACTIVE do user) → mlb -> productId existente.
    const linkedMlbMap = new Map<string, string>();
    if (flags.skipExistingAnuncio && mlAccountIds.length > 0) {
      const batchMlbs = Array.from(
        new Set(batch.flatMap((r) => r.mlbCodes)),
      );
      for (const mlbChunk of chunk(batchMlbs, 1000)) {
        if (mlbChunk.length === 0) continue;
        const linked = await prisma.productListing.findMany({
          where: {
            externalListingId: { in: mlbChunk },
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

    let bCreated = 0;
    let bSkuSkip = 0;
    let bPriceSkip = 0;
    let bDup = 0;
    let bAnuncioSkip = 0;
    let bErrors = 0;

    for (const row of batch) {
      // 2) preço obrigatório > 0
      const priceDec = toDecimalOrNull(row.priceStr);
      if (priceDec === null || priceDec.lte(0)) {
        summary.totals.skippedZeroPrice++;
        bPriceSkip++;
        summary.otherSkips.push({
          rowNumber: row.rowNumber,
          sku: row.sku,
          reason: "skipped_zero_price",
          detail: row.priceStr ?? "(vazio)",
        });
        continue;
      }

      // 3) dedup intra-planilha (primeira ocorrência importável vence)
      if (seenInSheet.has(row.sku)) {
        summary.totals.skippedDuplicateInSheet++;
        bDup++;
        summary.otherSkips.push({
          rowNumber: row.rowNumber,
          sku: row.sku,
          reason: "skipped_duplicate_in_sheet",
        });
        continue;
      }
      seenInSheet.add(row.sku);

      // 4) já existe no banco p/ esse userId → PULA (não atualiza)
      const existingId = existingMap.get(row.sku);
      if (existingId) {
        summary.totals.skippedExisting++;
        bSkuSkip++;
        summary.skippedExisting.push({
          sku: row.sku,
          existingProductId: existingId,
        });
        continue;
      }

      // 4b) [opt-in] anúncio (MLB) já vinculado a outro Product → PULA
      //     (não cria produto duplicado). Desvio consciente do spec.
      if (flags.skipExistingAnuncio && linkedMlbMap.size > 0) {
        let hitMlb: string | null = null;
        let hitProductId: string | null = null;
        for (const mlb of row.mlbCodes) {
          const pid = linkedMlbMap.get(mlb);
          if (pid) {
            hitMlb = mlb;
            hitProductId = pid;
            break;
          }
        }
        if (hitMlb && hitProductId) {
          summary.totals.skippedAnuncioExists++;
          bAnuncioSkip++;
          summary.skippedAnuncioExists.push({
            sku: row.sku,
            mlb: hitMlb,
            existingProductId: hitProductId,
          });
          continue;
        }
      }

      // 5) resolve locationId (cache hierárquico por code)
      let locationId: string | null = null;
      try {
        locationId = await resolveLocationId(
          row,
          flags.userId,
          flags.dryRun,
          locationCache,
          locationCounter,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        summary.totals.errors++;
        bErrors++;
        summary.errors.push({
          rowNumber: row.rowNumber,
          sku: row.sku,
          message: `location: ${message}`,
        });
        continue;
      }

      // 6) cria Product (+ ProductCompatibility aninhada) — write atômico/linha
      const hasCompat = Boolean(row.brand && row.model);
      const costDec = toDecimalOrNull(row.costStr);

      if (flags.dryRun) {
        bCreated++;
        if (hasCompat) summary.compatibilitiesCreated++;
        createdPairs.push({ id: `<dry-${row.sku}>`, sku: row.sku });
        continue;
      }

      let attempt = 0;
      const maxAttempts = 3;
      let done = false;
      let lastErr: unknown = null;

      while (attempt < maxAttempts && !done) {
        try {
          const created = await prisma.product.create({
            data: {
              sku: row.sku,
              skuNormalized: normalizeSku(row.sku),
              userId: flags.userId,
              name: row.name,
              description: row.description,
              price: priceDec,
              stock: row.stock,
              costPrice: costDec,
              brand: row.brand,
              model: row.model,
              year: row.year,
              partNumber: row.partNumber,
              imageUrl: row.imageUrl,
              imageUrls: row.imageUrls,
              weightKg: row.weightKg,
              lengthCm: row.lengthCm,
              widthCm: row.widthCm,
              heightCm: row.heightCm,
              locationId,
              attributes: row.attributes ?? Prisma.JsonNull,
              compatibilities: hasCompat
                ? {
                    create: [
                      {
                        brand: row.brand as string,
                        model: row.model as string,
                        yearFrom: row.yearFrom,
                        yearTo: row.yearTo,
                      },
                    ],
                  }
                : undefined,
            },
            select: { id: true },
          });
          createdPairs.push({ id: created.id, sku: row.sku });
          summary.createdProductIds.push(created.id);
          bCreated++;
          if (hasCompat) summary.compatibilitiesCreated++;
          done = true;
        } catch (err) {
          lastErr = err;
          // P2002 = corrida com (userId,sku) já existente → trata como skip,
          // não retenta (importador idempotente: "se existe, não toca").
          if (isUniqueViolation(err)) {
            const ex = await prisma.product.findUnique({
              where: { userId_sku: { userId: flags.userId, sku: row.sku } },
              select: { id: true },
            });
            summary.totals.skippedExisting++;
            bSkuSkip++;
            summary.skippedExisting.push({
              sku: row.sku,
              existingProductId: ex?.id ?? "(desconhecido)",
            });
            done = true;
            lastErr = null;
            break;
          }
          attempt++;
          if (attempt < maxAttempts) {
            await new Promise((r) => setTimeout(r, 300 * attempt));
          }
        }
      }

      if (!done && lastErr) {
        summary.totals.errors++;
        bErrors++;
        const message = lastErr instanceof Error ? lastErr.message : String(lastErr);
        summary.errors.push({
          rowNumber: row.rowNumber,
          sku: row.sku,
          message,
        });
        console.warn(
          `[import][warn] row=${row.rowNumber} sku=${row.sku}: ${message.slice(0, 200)}`,
        );
      }
    }

    summary.totals.created += bCreated;
    processed += batch.length;
    const elapsed = Date.now() - t0;
    console.log(
      `[import] [${processed}/${rows.length}] criados=${bCreated} pulados_sku=${bSkuSkip} pulados_anuncio=${bAnuncioSkip} pulados_preco=${bPriceSkip} dup=${bDup} erros=${bErrors} elapsed=${elapsed}ms`,
    );
  }

  summary.locationsCreated = locationCounter.created;
  summary.finishedAt = new Date().toISOString();
  return { summary, createdPairs };
}

/**
 * Fase 2 — vincula produtos a anúncios já existentes.
 * ML: cria ProductListing a partir de CódigoMLB. Shopee: AUDIT-ONLY (zero escritas).
 */
async function runLinks(
  eligible: Array<{ id: string; sku: string }>,
  sheetMap: Map<string, { mlbCodes: string[]; mercadoLivre: boolean }>,
  flags: Flags,
): Promise<LinkSummary> {
  const startedAt = new Date().toISOString();
  const summary: LinkSummary = {
    userId: flags.userId,
    startedAt,
    finishedAt: "",
    dryRun: flags.dryRun,
    ml: {
      linked: 0,
      alreadyLinked: 0,
      externalIdConflict: 0,
      accountAmbiguous: 0,
      noAccount: 0,
      invalidMlb: 0,
    },
    shopee: {
      linked: 0,
      alreadyLinked: 0,
      noListing: 0,
      conflict: 0,
      multipleListings: 0,
      noActiveAccount: 0,
    },
    details: {},
  };

  const addDetail = (sku: string, msg: string) => {
    (summary.details[sku] ??= []).push(msg);
  };

  if (eligible.length === 0) {
    console.log("[links] nenhum produto elegível — nada a vincular.");
    summary.finishedAt = new Date().toISOString();
    return summary;
  }

  // Contas ACTIVE do userId. NÃO filtrar por expiração de token: Fase 2 não
  // chama API externa, só grava ProductListing local.
  const accounts = await prisma.marketplaceAccount.findMany({
    where: { userId: flags.userId, status: "ACTIVE" },
    select: { id: true, platform: true, accountName: true },
  });
  const mlAccounts = accounts.filter((a) => a.platform === "MERCADO_LIVRE");
  const shopeeAccounts = accounts.filter((a) => a.platform === "SHOPEE");
  const mlAccountIds = mlAccounts.map((a) => a.id);
  console.log(
    `[links] contas ACTIVE: ML=${mlAccounts.length} Shopee=${shopeeAccounts.length}`,
  );
  for (const a of mlAccounts) {
    console.log(`[links][ml-account] id=${a.id} nome="${a.accountName}"`);
  }
  for (const a of shopeeAccounts) {
    console.log(`[links][shopee-account] id=${a.id} nome="${a.accountName}"`);
  }

  const doMl = flags.platform !== "shopee";
  const doShopee = flags.platform !== "ml";

  // ───────────────────────── Mercado Livre ─────────────────────────
  let mlEnabled = doMl;
  if (doMl && mlAccounts.length === 0) {
    console.error(
      "[links][ml][erro] Nenhuma conta ML ativa para o usuário — Fase 2 ML abortada.",
    );
    summary.ml.noAccount = 1;
    mlEnabled = false;
  }

  // Desambiguação explícita via --ml-account=<id>: valida que é uma conta ML
  // ACTIVE deste usuário; se não for, aborta a Fase 2 ML (não adivinha).
  let forcedMlAccountId: string | null = null;
  if (mlEnabled && flags.mlAccountId) {
    const match = mlAccounts.find((a) => a.id === flags.mlAccountId);
    if (!match) {
      console.error(
        `[links][ml][erro] --ml-account=${flags.mlAccountId} não é uma conta ML ACTIVE deste usuário (${mlAccounts.map((a) => a.id).join(", ") || "nenhuma"}). Fase 2 ML abortada.`,
      );
      summary.ml.noAccount = 1;
      mlEnabled = false;
    } else {
      forcedMlAccountId = match.id;
      console.log(
        `[links][ml] conta ML forçada via --ml-account: ${match.id} ("${match.accountName}")`,
      );
    }
  }

  if (mlEnabled) {
    // Conjunto de contas a consultar no batch (forçada/única → 1; senão todas).
    const queryAccountIds = forcedMlAccountId
      ? [forcedMlAccountId]
      : mlAccounts.length === 1
        ? [mlAccounts[0].id]
        : mlAccountIds;

    const mlTotal = eligible.length;
    let mlProcessed = 0;
    // Processa em blocos de 500 produtos: 1 findMany + 1 createMany por bloco
    // (em vez de 1 consulta por anúncio). Mantém a mesma semântica de
    // already/conflito/linked e a segurança de não sobrescrever.
    for (const chunkProducts of chunk(eligible, 500)) {
      const t0 = Date.now();

      // 1) Monta as requisições (produto, mlb) deste bloco.
      type Req = { product: { id: string; sku: string }; mlb: string };
      const reqs: Req[] = [];
      const chunkMlbs = new Set<string>();
      for (const product of chunkProducts) {
        const info = sheetMap.get(product.sku);
        const codes = info?.mlbCodes ?? [];
        if (codes.length === 0) {
          if (info?.mercadoLivre) {
            summary.ml.invalidMlb++;
            addDetail(product.sku, "ml_no_valid_mlb");
          }
          continue;
        }
        for (const mlb of codes) {
          reqs.push({ product, mlb });
          chunkMlbs.add(mlb);
        }
      }

      if (reqs.length === 0) {
        mlProcessed += chunkProducts.length;
        continue;
      }

      // 2) UMA consulta: listings existentes desses MLBs nas contas relevantes.
      const existingByKey = new Map<string, string>(); // accId::mlb -> productId
      const ownersByMlb = new Map<string, Set<string>>(); // mlb -> Set<accId>
      for (const mlbChunk of chunk(Array.from(chunkMlbs), 1000)) {
        const found = await prisma.productListing.findMany({
          where: {
            externalListingId: { in: mlbChunk },
            marketplaceAccountId: { in: queryAccountIds },
          },
          select: {
            externalListingId: true,
            marketplaceAccountId: true,
            productId: true,
          },
        });
        for (const f of found) {
          existingByKey.set(
            `${f.marketplaceAccountId}::${f.externalListingId}`,
            f.productId,
          );
          const set = ownersByMlb.get(f.externalListingId) ?? new Set<string>();
          set.add(f.marketplaceAccountId);
          ownersByMlb.set(f.externalListingId, set);
        }
      }

      // 3) Decide por requisição (sem ir ao banco). Acumula o que criar.
      const toCreate: Array<{
        productId: string;
        marketplaceAccountId: string;
        externalListingId: string;
        externalSku: string;
        status: string;
      }> = [];
      const plannedKeys = new Set<string>(); // evita 2 creates do mesmo (acc,mlb)

      for (const { product, mlb } of reqs) {
        // Resolve a conta dona.
        let accountId: string | null = null;
        if (forcedMlAccountId) {
          accountId = forcedMlAccountId;
        } else if (mlAccounts.length === 1) {
          accountId = mlAccounts[0].id;
        } else {
          const owners = ownersByMlb.get(mlb);
          const distinct = owners ? Array.from(owners) : [];
          if (distinct.length === 1) {
            accountId = distinct[0];
          } else {
            summary.ml.accountAmbiguous++;
            addDetail(product.sku, `ml_account_ambiguous:${mlb}`);
            continue;
          }
        }

        const key = `${accountId}::${mlb}`;
        const existingPid = existingByKey.get(key);
        if (existingPid !== undefined) {
          if (existingPid === product.id) {
            summary.ml.alreadyLinked++;
          } else {
            summary.ml.externalIdConflict++;
            addDetail(
              product.sku,
              `ml_externalid_conflict:${mlb}:existing=${existingPid}:this=${product.id}`,
            );
          }
          continue;
        }

        // Não existe no banco. Evita duplicar dentro do próprio bloco.
        if (plannedKeys.has(key)) {
          summary.ml.externalIdConflict++;
          addDetail(
            product.sku,
            `ml_externalid_conflict:${mlb}:existing=<pendente-no-lote>:this=${product.id}`,
          );
          continue;
        }
        plannedKeys.add(key);

        if (flags.dryRun) {
          summary.ml.linked++;
          addDetail(product.sku, `ml_would_link:${mlb}@${accountId}`);
          continue;
        }

        toCreate.push({
          productId: product.id,
          marketplaceAccountId: accountId,
          externalListingId: mlb,
          externalSku: product.sku,
          status: LINK_STATUS,
        });
      }

      // 4) UMA escrita em lote (skipDuplicates protege o unique).
      if (toCreate.length > 0) {
        const res = await prisma.productListing.createMany({
          data: toCreate,
          skipDuplicates: true,
        });
        summary.ml.linked += res.count;
        for (const c of toCreate) {
          addDetail(
            c.externalSku,
            `ml_linked:${c.externalListingId}@${c.marketplaceAccountId}`,
          );
        }
        if (res.count !== toCreate.length) {
          console.warn(
            `[links][ml][warn] createMany inseriu ${res.count} de ${toCreate.length} (skipDuplicates) — corrida/duplicata no lote`,
          );
        }
      }

      mlProcessed += chunkProducts.length;
      const dt = Date.now() - t0;
      console.log(
        `[links][ml] ${mlProcessed}/${mlTotal} processados — linked=${summary.ml.linked} already=${summary.ml.alreadyLinked} conflito=${summary.ml.externalIdConflict} (${dt}ms/${chunkProducts.length})`,
      );
    }
  }

  // ─────────────────────── Shopee (AUDIT-ONLY) ───────────────────────
  // INVARIANTE: este ramo NÃO contém create/update/upsert/delete. Apenas
  // findMany de leitura. ProductListing.productId é NOT NULL no schema, então
  // não há "placeholder com productId NULL" para re-apontar; e a planilha não
  // traz externalListingId de Shopee — então só auditamos.
  if (doShopee) {
    if (shopeeAccounts.length === 0) {
      summary.shopee.noActiveAccount = 1;
      console.log("[links][shopee] nenhuma conta Shopee ACTIVE — auditoria vazia.");
    } else {
      const shTotal = eligible.length;
      let shProcessed = 0;
      // Audita em blocos de 500: 1 findMany por conta Shopee por bloco
      // (em vez de 1 por produto×conta). Mesma classificação 0/1/>1.
      for (const chunkProducts of chunk(eligible, 500)) {
        const chunkSkus = Array.from(
          new Set(chunkProducts.map((p) => p.sku)),
        );
        for (const acc of shopeeAccounts) {
          // sku -> productIds com listing nessa conta Shopee
          const bySku = new Map<string, string[]>();
          for (const skuChunk of chunk(chunkSkus, 1000)) {
            const listings = await prisma.productListing.findMany({
              where: {
                marketplaceAccountId: acc.id,
                externalSku: { in: skuChunk },
              },
              select: { externalSku: true, productId: true },
            });
            for (const l of listings) {
              if (l.externalSku == null) continue;
              const arr = bySku.get(l.externalSku) ?? [];
              arr.push(l.productId);
              bySku.set(l.externalSku, arr);
            }
          }
          for (const product of chunkProducts) {
            const pids = bySku.get(product.sku) ?? [];
            if (pids.length === 0) {
              summary.shopee.noListing++;
            } else if (pids.length === 1) {
              if (pids[0] === product.id) {
                summary.shopee.alreadyLinked++;
              } else {
                summary.shopee.conflict++;
                addDetail(
                  product.sku,
                  `shopee_conflict:acc=${acc.id}:existing=${pids[0]}:this=${product.id}`,
                );
              }
            } else {
              summary.shopee.multipleListings++;
              const allThis = pids.every((p) => p === product.id);
              const noneThis = pids.every((p) => p !== product.id);
              const kind = allThis
                ? "all_this"
                : noneThis
                  ? "none_this"
                  : "mixed";
              addDetail(
                product.sku,
                `shopee_multiple_listings:acc=${acc.id}:n=${pids.length}:${kind}`,
              );
            }
          }
        }
        shProcessed += chunkProducts.length;
        console.log(
          `[links][shopee] auditados ${shProcessed}/${shTotal} — already=${summary.shopee.alreadyLinked} semListing=${summary.shopee.noListing} conflito=${summary.shopee.conflict}`,
        );
      }
    }
  }

  summary.finishedAt = new Date().toISOString();
  return summary;
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function snapshotSource(src: string): void {
  const resolved = path.resolve(src);
  const ext = path.extname(resolved).toLowerCase() || ".csv";
  ensureDir(DATA_DIR);
  const dest = path.join(DATA_DIR, `${CANONICAL_BASENAME}${ext}`);
  fs.copyFileSync(resolved, dest);
  console.log(`[snapshot] cópia canônica: ${dest}`);
}

function printImportSummary(s: ImportSummary, dryRun: boolean): void {
  const tag = dryRun ? "DRY-RUN " : "";
  console.log(`\n========== ${tag}RESUMO FASE 1 (import) ==========`);
  console.log(`userId:                 ${s.userId}`);
  console.log(`linhas consideradas:    ${s.totals.rows}`);
  console.log(`criados:                ${s.totals.created}`);
  console.log(`pulados (sku existe):   ${s.totals.skippedExisting}`);
  console.log(`pulados (anúncio existe):${s.totals.skippedAnuncioExists}`);
  console.log(`pulados (preço ≤ 0):    ${s.totals.skippedZeroPrice}`);
  console.log(`pulados (dup planilha): ${s.totals.skippedDuplicateInSheet}`);
  console.log(`pulados (sem sku):      ${s.totals.skippedNoSku}`);
  console.log(`erros:                  ${s.totals.errors}`);
  console.log(`locations criadas:      ${s.locationsCreated}${dryRun ? " (simuladas)" : ""}`);
  console.log(`compatibilidades:       ${s.compatibilitiesCreated}`);
  if (s.errors.length > 0) {
    console.log(`\n-- amostra de erros (até 20) --`);
    for (const e of s.errors.slice(0, 20)) {
      console.log(`  linha ${e.rowNumber} sku=${e.sku ?? "?"}: ${e.message.slice(0, 160)}`);
    }
  }
  console.log(`==================================================\n`);
}

function printLinkSummary(s: LinkSummary): void {
  const tag = s.dryRun ? "DRY-RUN " : "";
  console.log(`========== ${tag}RESUMO FASE 2 (links) ==========`);
  console.log(
    `ML:     linked=${s.ml.linked} already=${s.ml.alreadyLinked} conflito=${s.ml.externalIdConflict} ambiguo=${s.ml.accountAmbiguous} semConta=${s.ml.noAccount} mlbInvalido=${s.ml.invalidMlb}`,
  );
  console.log(
    `Shopee: already=${s.shopee.alreadyLinked} semListing=${s.shopee.noListing} conflito=${s.shopee.conflict} multiplos=${s.shopee.multipleListings} semConta=${s.shopee.noActiveAccount} (audit-only, linked=${s.shopee.linked})`,
  );
  console.log(`==================================================\n`);
}

/**
 * READ-ONLY: imprime detalhes dos productIds informados, lado a lado, para
 * investigar conflitos (produto antigo vs produto novo do mesmo anúncio).
 */
async function inspectProducts(ids: string[]): Promise<void> {
  const prods = await prisma.product.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      sku: true,
      skuNormalized: true,
      name: true,
      price: true,
      costPrice: true,
      stock: true,
      brand: true,
      model: true,
      year: true,
      createdAt: true,
      locationId: true,
      userId: true,
      listings: {
        select: {
          marketplaceAccountId: true,
          externalListingId: true,
          status: true,
        },
      },
    },
  });
  const byId = new Map(prods.map((p) => [p.id, p]));
  console.log(`\n========== INSPECT (${ids.length} ids) ==========`);
  for (const id of ids) {
    const p = byId.get(id);
    if (!p) {
      console.log(`\n[inspect] ${id}: NÃO ENCONTRADO`);
      continue;
    }
    console.log(`\n[inspect] ${p.id}  (userId=${p.userId})`);
    console.log(`  sku="${p.sku}"  skuNorm="${p.skuNormalized ?? "-"}"`);
    console.log(`  name="${p.name}"`);
    console.log(
      `  price=${p.price} cost=${p.costPrice ?? "-"} stock=${p.stock} brand=${p.brand ?? "-"} model=${p.model ?? "-"} year=${p.year ?? "-"}`,
    );
    console.log(
      `  createdAt=${p.createdAt.toISOString()} locationId=${p.locationId ?? "-"}`,
    );
    if (p.listings.length === 0) {
      console.log(`  listings: (nenhum)`);
    }
    for (const l of p.listings) {
      console.log(
        `  listing: acc=${l.marketplaceAccountId} ext=${l.externalListingId} status=${l.status}`,
      );
    }
  }
  console.log(`\n=================================================\n`);
}

/**
 * READ-ONLY: roda as 3 queries de validação do plano via $queryRaw.
 * (1) total de Product do userId; (2) SKUs duplicados (DEVE ser 0);
 * (3) ProductListing com status do import. Não escreve nada.
 */
async function validateDb(flags: Flags): Promise<void> {
  const uid = flags.userId;
  const totalRows = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS count FROM "Product" WHERE "userId" = ${uid}`;
  const dups = await prisma.$queryRaw<Array<{ sku: string; count: bigint }>>`
    SELECT "sku", COUNT(*)::bigint AS count FROM "Product"
    WHERE "userId" = ${uid} GROUP BY "sku" HAVING COUNT(*) > 1`;
  const linked = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS count FROM "ProductListing" pl
    JOIN "Product" p ON p."id" = pl."productId"
    WHERE p."userId" = ${uid} AND pl."status" = ${LINK_STATUS}`;

  const productCount = Number(totalRows[0]?.count ?? 0);
  const dupCount = dups.length;
  const linkedCount = Number(linked[0]?.count ?? 0);

  console.log(`\n========== VALIDAÇÃO SQL ==========`);
  console.log(`userId:                              ${uid}`);
  console.log(`Product (total do userId):           ${productCount}`);
  console.log(`SKUs duplicados (DEVE ser 0):        ${dupCount}`);
  for (const d of dups.slice(0, 20)) {
    console.log(`  DUP sku=${d.sku} count=${Number(d.count)}`);
  }
  console.log(`ProductListing status=${LINK_STATUS}: ${linkedCount}`);
  console.log(
    `RESULTADO: ${dupCount === 0 ? "OK — sem duplicatas de (userId,sku)" : "FALHA — duplicatas encontradas!"}`,
  );
  console.log(`===================================\n`);
}

/**
 * READ-ONLY: descobre a conta ML dona dos MLBs da planilha cruzando todos os
 * códigos MLB com o ProductListing já existente das contas ML ACTIVE do user.
 * Não escreve nada. Imprime distribuição por conta + recomendação.
 */
/**
 * READ-ONLY: estima o impacto do enriquecimento. Cruza planilha×MLB×produtos
 * existentes (linkados nas contas ML ACTIVE do user) e conta quantos produtos
 * ganhariam cada campo (só campos hoje vazios). Não escreve nada.
 */
async function analyzeEnrichment(
  rows: EstoqueRow[],
  flags: Flags,
): Promise<void> {
  // mlb -> linha da planilha (primeira ocorrência vence)
  const mlbToRow = new Map<string, EstoqueRow>();
  for (const r of rows) {
    for (const m of r.mlbCodes) if (!mlbToRow.has(m)) mlbToRow.set(m, r);
  }
  const allMlbs = Array.from(mlbToRow.keys());
  console.log(
    `[enrich-analyze] MLBs únicos na planilha: ${allMlbs.length}`,
  );

  const mlAccts = await prisma.marketplaceAccount.findMany({
    where: {
      userId: flags.userId,
      status: "ACTIVE",
      platform: "MERCADO_LIVRE",
    },
    select: { id: true, accountName: true },
  });
  const mlAccountIds = mlAccts.map((a) => a.id);
  console.log(
    `[enrich-analyze] contas ML ACTIVE: ${mlAccts.map((a) => a.accountName).join(", ") || "(nenhuma)"}`,
  );
  if (mlAccountIds.length === 0) {
    console.log("[enrich-analyze] sem conta ML — nada a analisar.");
    return;
  }

  // mlb -> productId existente (listing nas contas ML do user)
  const mlbToProduct = new Map<string, string>();
  let scanned = 0;
  for (const part of chunk(allMlbs, 1000)) {
    const found = await prisma.productListing.findMany({
      where: {
        externalListingId: { in: part },
        marketplaceAccountId: { in: mlAccountIds },
      },
      select: { externalListingId: true, productId: true },
    });
    for (const f of found) {
      if (!mlbToProduct.has(f.externalListingId)) {
        mlbToProduct.set(f.externalListingId, f.productId);
      }
    }
    scanned += part.length;
    console.log(`[enrich-analyze] varridos ${scanned}/${allMlbs.length} MLBs…`);
  }

  // productId -> linha (via o 1º MLB que o aponta)
  const productToRow = new Map<string, EstoqueRow>();
  for (const [mlb, pid] of mlbToProduct) {
    if (!productToRow.has(pid)) {
      const r = mlbToRow.get(mlb);
      if (r) productToRow.set(pid, r);
    }
  }
  const productIds = Array.from(productToRow.keys());
  console.log(
    `[enrich-analyze] produtos existentes ligados a MLB da planilha: ${productIds.length}`,
  );

  const fieldFill: Record<string, number> = {
    costPrice: 0,
    brand: 0,
    model: 0,
    year: 0,
    weightKg: 0,
    heightCm: 0,
    widthCm: 0,
    lengthCm: 0,
    partNumber: 0,
    description: 0,
    imageUrl: 0,
    locationId: 0,
    attributes: 0,
  };
  let productsEnrichable = 0;
  let productsNothing = 0;
  let productsMissing = 0;

  const isEmptyStr = (v: unknown): boolean =>
    v === null || v === undefined || String(v).trim() === "";

  for (const part of chunk(productIds, 500)) {
    const prods = await prisma.product.findMany({
      where: { id: { in: part } },
      select: {
        id: true,
        costPrice: true,
        brand: true,
        model: true,
        year: true,
        weightKg: true,
        heightCm: true,
        widthCm: true,
        lengthCm: true,
        partNumber: true,
        description: true,
        imageUrl: true,
        locationId: true,
        attributes: true,
      },
    });
    const byId = new Map(prods.map((p) => [p.id, p]));
    for (const pid of part) {
      const p = byId.get(pid);
      if (!p) {
        productsMissing++;
        continue;
      }
      const r = productToRow.get(pid);
      if (!r) continue;
      let any = false;
      if (p.costPrice == null && r.costStr !== null) {
        fieldFill.costPrice++;
        any = true;
      }
      if (isEmptyStr(p.brand) && r.brand) {
        fieldFill.brand++;
        any = true;
      }
      if (isEmptyStr(p.model) && r.model) {
        fieldFill.model++;
        any = true;
      }
      if (isEmptyStr(p.year) && r.year) {
        fieldFill.year++;
        any = true;
      }
      if (p.weightKg == null && r.weightKg !== null) {
        fieldFill.weightKg++;
        any = true;
      }
      if (p.heightCm == null && r.heightCm !== null) {
        fieldFill.heightCm++;
        any = true;
      }
      if (p.widthCm == null && r.widthCm !== null) {
        fieldFill.widthCm++;
        any = true;
      }
      if (p.lengthCm == null && r.lengthCm !== null) {
        fieldFill.lengthCm++;
        any = true;
      }
      if (isEmptyStr(p.partNumber) && r.partNumber) {
        fieldFill.partNumber++;
        any = true;
      }
      if (isEmptyStr(p.description) && r.description) {
        fieldFill.description++;
        any = true;
      }
      if (isEmptyStr(p.imageUrl) && r.imageUrl) {
        fieldFill.imageUrl++;
        any = true;
      }
      if (p.locationId == null && r.sigla) {
        fieldFill.locationId++;
        any = true;
      }
      if (p.attributes == null && r.attributes) {
        fieldFill.attributes++;
        any = true;
      }
      if (any) productsEnrichable++;
      else productsNothing++;
    }
  }

  console.log(`\n========== ANÁLISE DE ENRIQUECIMENTO (read-only) ==========`);
  console.log(`Produtos ligados a MLB da planilha:        ${productIds.length}`);
  console.log(`  ganhariam ≥1 campo (enriquecíveis):      ${productsEnrichable}`);
  console.log(`  já completos (nada a preencher):         ${productsNothing}`);
  console.log(`  não encontrados:                         ${productsMissing}`);
  console.log(`-- por campo (produtos que ganhariam o campo) --`);
  for (const [k, v] of Object.entries(fieldFill)) {
    console.log(`  ${k.padEnd(13)}: ${v}`);
  }
  console.log(`===========================================================\n`);

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const ts = timestamp();
  const outPath = path.join(OUT_DIR, `enrich-analyze-18-05-2026-${ts}.json`);
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        userId: flags.userId,
        mlbsInSheet: allMlbs.length,
        productsLinkedToSheetMlb: productIds.length,
        productsEnrichable,
        productsNothing,
        productsMissing,
        fieldFill,
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log(`[report] ${outPath}`);
}

/**
 * READ-ONLY: matriz de cobertura por produto × canal × conta.
 * Para cada Product do user, classifica em: ML+Shopee, só ML, só Shopee, nenhum.
 * Por conta, conta quantos produtos têm pelo menos 1 ProductListing nela.
 * Considera apenas contas ACTIVE.
 */
async function analyzeCoverage(flags: Flags): Promise<void> {
  const accounts = await prisma.marketplaceAccount.findMany({
    where: { userId: flags.userId, status: "ACTIVE" },
    select: { id: true, platform: true, accountName: true },
  });
  const mlAcctIds = new Set(
    accounts.filter((a) => a.platform === "MERCADO_LIVRE").map((a) => a.id),
  );
  const shopeeAcctIds = new Set(
    accounts.filter((a) => a.platform === "SHOPEE").map((a) => a.id),
  );
  const acctNameById = new Map(
    accounts.map((a) => [a.id, `${a.platform}/${a.accountName}`]),
  );
  const allAcctIds = [...mlAcctIds, ...shopeeAcctIds];
  console.log(
    `[coverage] contas ACTIVE: ML=${mlAcctIds.size} Shopee=${shopeeAcctIds.size}`,
  );
  for (const a of accounts) {
    console.log(`[coverage]   ${a.platform}/${a.accountName} → ${a.id}`);
  }
  if (allAcctIds.length === 0) return;

  console.log(`[coverage] carregando ProductListings…`);
  const allListings = await prisma.productListing.findMany({
    where: { marketplaceAccountId: { in: allAcctIds } },
    select: { productId: true, marketplaceAccountId: true },
  });
  console.log(`[coverage] ProductListings carregados: ${allListings.length}`);

  const byProduct = new Map<
    string,
    { mlAccts: Set<string>; shopeeAccts: Set<string> }
  >();
  for (const l of allListings) {
    let p = byProduct.get(l.productId);
    if (!p) {
      p = { mlAccts: new Set(), shopeeAccts: new Set() };
      byProduct.set(l.productId, p);
    }
    if (mlAcctIds.has(l.marketplaceAccountId)) p.mlAccts.add(l.marketplaceAccountId);
    if (shopeeAcctIds.has(l.marketplaceAccountId))
      p.shopeeAccts.add(l.marketplaceAccountId);
  }

  console.log(`[coverage] carregando produtos do user…`);
  const products = await prisma.product.findMany({
    where: { userId: flags.userId },
    select: { id: true, sku: true },
  });
  console.log(`[coverage] produtos do user: ${products.length}`);

  let bothMlShopee = 0;
  let mlOnly = 0;
  let shopeeOnly = 0;
  let neither = 0;
  const perAcct = new Map<string, number>();
  let mlInBothAccounts = 0;
  let shopeeInBothAccounts = 0;
  let bothMlBothShopee = 0;
  let bothMlOneShopee = 0;
  let oneMlBothShopee = 0;
  let oneMlOneShopee = 0;

  const sampleSets = {
    neither: [] as Array<{ id: string; sku: string }>,
    mlOnly: [] as Array<{ id: string; sku: string }>,
    shopeeOnly: [] as Array<{ id: string; sku: string }>,
  };
  const SAMPLE_MAX = 10;

  for (const p of products) {
    const cov = byProduct.get(p.id);
    const hasMl = !!cov && cov.mlAccts.size > 0;
    const hasShopee = !!cov && cov.shopeeAccts.size > 0;
    if (hasMl && hasShopee) {
      bothMlShopee++;
      const mlBoth = (cov?.mlAccts.size ?? 0) >= 2;
      const shBoth = (cov?.shopeeAccts.size ?? 0) >= 2;
      if (mlBoth && shBoth) bothMlBothShopee++;
      else if (mlBoth && !shBoth) bothMlOneShopee++;
      else if (!mlBoth && shBoth) oneMlBothShopee++;
      else oneMlOneShopee++;
    } else if (hasMl) {
      mlOnly++;
      if (sampleSets.mlOnly.length < SAMPLE_MAX)
        sampleSets.mlOnly.push({ id: p.id, sku: p.sku });
    } else if (hasShopee) {
      shopeeOnly++;
      if (sampleSets.shopeeOnly.length < SAMPLE_MAX)
        sampleSets.shopeeOnly.push({ id: p.id, sku: p.sku });
    } else {
      neither++;
      if (sampleSets.neither.length < SAMPLE_MAX)
        sampleSets.neither.push({ id: p.id, sku: p.sku });
    }
    if (cov) {
      for (const acctId of cov.mlAccts)
        perAcct.set(acctId, (perAcct.get(acctId) ?? 0) + 1);
      for (const acctId of cov.shopeeAccts)
        perAcct.set(acctId, (perAcct.get(acctId) ?? 0) + 1);
      if (cov.mlAccts.size >= 2) mlInBothAccounts++;
      if (cov.shopeeAccts.size >= 2) shopeeInBothAccounts++;
    }
  }

  const pct = (n: number) =>
    products.length > 0 ? ((n / products.length) * 100).toFixed(1) : "0.0";

  console.log(`\n========== COBERTURA DE PUBLICAÇÃO ==========`);
  console.log(`Total de produtos do user:         ${products.length}`);
  console.log(`\n-- canais --`);
  console.log(`Em AMBOS ML e Shopee:              ${bothMlShopee} (${pct(bothMlShopee)}%)`);
  console.log(`Só ML (não tem Shopee):            ${mlOnly} (${pct(mlOnly)}%)`);
  console.log(`Só Shopee (não tem ML):            ${shopeeOnly} (${pct(shopeeOnly)}%)`);
  console.log(`Nem ML nem Shopee (sem anúncio):   ${neither} (${pct(neither)}%)`);
  console.log(`\n-- detalhe de quem está em AMBOS canais --`);
  console.log(`  em 2 contas ML + 2 contas Shopee: ${bothMlBothShopee}`);
  console.log(`  em 2 contas ML + 1 conta Shopee:  ${bothMlOneShopee}`);
  console.log(`  em 1 conta ML + 2 contas Shopee:  ${oneMlBothShopee}`);
  console.log(`  em 1 conta ML + 1 conta Shopee:   ${oneMlOneShopee}`);
  console.log(`\n-- cobertura múltipla --`);
  console.log(`Em ambas contas ML:                ${mlInBothAccounts}`);
  console.log(`Em ambas contas Shopee:            ${shopeeInBothAccounts}`);
  console.log(`\n-- por conta (produtos com ≥1 listing nela) --`);
  for (const [acctId, count] of perAcct) {
    console.log(`  ${acctNameById.get(acctId) ?? acctId}: ${count}`);
  }
  console.log(`\n-- amostras (até 10 cada) --`);
  console.log(`Sem nenhum anúncio (gap total):`);
  for (const s of sampleSets.neither) console.log(`  sku=${s.sku} id=${s.id}`);
  console.log(`Só ML (oportunidade de publicar na Shopee):`);
  for (const s of sampleSets.mlOnly) console.log(`  sku=${s.sku} id=${s.id}`);
  console.log(`Só Shopee (oportunidade de publicar no ML):`);
  for (const s of sampleSets.shopeeOnly) console.log(`  sku=${s.sku} id=${s.id}`);
  console.log(`==============================================\n`);

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const ts = timestamp();
  const outPath = path.join(OUT_DIR, `coverage-18-05-2026-${ts}.json`);
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        userId: flags.userId,
        generatedAt: new Date().toISOString(),
        totals: {
          products: products.length,
          bothMlShopee,
          mlOnly,
          shopeeOnly,
          neither,
          bothMlBothShopee,
          bothMlOneShopee,
          oneMlBothShopee,
          oneMlOneShopee,
          mlInBothAccounts,
          shopeeInBothAccounts,
        },
        perAccount: Array.from(perAcct.entries()).map(([id, count]) => ({
          accountId: id,
          accountName: acctNameById.get(id) ?? id,
          productsWithListing: count,
        })),
        samples: sampleSets,
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log(`[report] ${outPath}`);
}

/**
 * READ-ONLY: para cada conta Shopee ACTIVE, classifica todos os `ProductListing`
 * em 4 categorias via match `externalSku` ↔ `Product.sku` do mesmo userId:
 *   - alreadyLinked: productId já bate com o produto local de mesmo sku
 *   - needsRelink:   externalSku casa com produto local, mas productId aponta para OUTRO produto
 *   - noLocalMatch:  externalSku não casa com nenhum sku local do user
 *   - noSku:         externalSku é nulo/vazio (não dá pra casar)
 * Imprime contadores + amostra de needsRelink + grava JSON com a lista cheia.
 */
async function analyzeShopee(flags: Flags): Promise<void> {
  const shopeeAccounts = await prisma.marketplaceAccount.findMany({
    where: { userId: flags.userId, status: "ACTIVE", platform: "SHOPEE" },
    select: {
      id: true,
      accountName: true,
      shopId: true,
      externalUserId: true,
    },
  });
  console.log(
    `[shopee-analyze] contas Shopee ACTIVE: ${shopeeAccounts.length}`,
  );
  for (const a of shopeeAccounts) {
    console.log(
      `[shopee-analyze]   id=${a.id} nome="${a.accountName}" shopId=${a.shopId ?? "-"} externalUserId=${a.externalUserId ?? "-"}`,
    );
  }
  if (shopeeAccounts.length === 0) return;

  const reportPerAccount: Array<{
    accountId: string;
    accountName: string;
    shopId: number | null;
    totals: {
      listings: number;
      withSku: number;
      withoutSku: number;
      uniqueSkus: number;
      skusWithLocalMatch: number;
      alreadyLinked: number;
      needsRelink: number;
      noLocalMatch: number;
      noSku: number;
    };
    relinkSamples: Array<{
      listingId: string;
      externalListingId: string;
      sku: string;
      currentProductId: string;
      correctProductId: string;
      status: string;
    }>;
    relinkAll: Array<{
      listingId: string;
      externalListingId: string;
      sku: string;
      currentProductId: string;
      correctProductId: string;
      status: string;
    }>;
  }> = [];

  for (const acc of shopeeAccounts) {
    console.log(
      `\n=== conta ${acc.id} "${acc.accountName}" (shopId=${acc.shopId ?? "-"}) ===`,
    );
    const listings = await prisma.productListing.findMany({
      where: { marketplaceAccountId: acc.id },
      select: {
        id: true,
        externalListingId: true,
        externalSku: true,
        productId: true,
        status: true,
      },
    });
    console.log(`total ProductListings: ${listings.length}`);

    let withSku = 0;
    let withoutSku = 0;
    const skusFromListings = new Set<string>();
    for (const l of listings) {
      const s = l.externalSku?.trim() ?? "";
      if (s.length > 0) {
        withSku++;
        skusFromListings.add(s);
      } else {
        withoutSku++;
      }
    }
    console.log(`com externalSku populado: ${withSku}`);
    console.log(`sem externalSku:          ${withoutSku}`);
    console.log(`SKUs únicos extraídos:    ${skusFromListings.size}`);

    // Bulk lookup local Products
    const localBySku = new Map<string, string>();
    for (const part of chunk(Array.from(skusFromListings), 1000)) {
      if (part.length === 0) continue;
      const rows = await prisma.product.findMany({
        where: { userId: flags.userId, sku: { in: part } },
        select: { sku: true, id: true },
      });
      for (const r of rows) localBySku.set(r.sku, r.id);
    }
    console.log(`SKUs c/ produto local match: ${localBySku.size}`);

    let alreadyLinked = 0;
    let needsRelink = 0;
    let noLocalMatch = 0;
    let noSku = 0;
    const relinkAll: Array<{
      listingId: string;
      externalListingId: string;
      sku: string;
      currentProductId: string;
      correctProductId: string;
      status: string;
    }> = [];

    for (const l of listings) {
      const sku = l.externalSku?.trim() ?? "";
      if (sku.length === 0) {
        noSku++;
        continue;
      }
      const localId = localBySku.get(sku);
      if (!localId) {
        noLocalMatch++;
        continue;
      }
      if (l.productId === localId) {
        alreadyLinked++;
      } else {
        needsRelink++;
        relinkAll.push({
          listingId: l.id,
          externalListingId: l.externalListingId,
          sku,
          currentProductId: l.productId,
          correctProductId: localId,
          status: l.status,
        });
      }
    }

    console.log(`\nclassificação:`);
    console.log(`  alreadyLinked (já correto):       ${alreadyLinked}`);
    console.log(`  needsRelink (sku→produto errado):  ${needsRelink}`);
    console.log(`  noLocalMatch (sku sem produto):    ${noLocalMatch}`);
    console.log(`  noSku (externalSku vazio):         ${noSku}`);
    console.log(`  total:                             ${listings.length}`);

    const relinkSamples = relinkAll.slice(0, 10);
    if (relinkSamples.length > 0) {
      console.log(`\namostra needsRelink (até 10):`);
      for (const s of relinkSamples) {
        console.log(
          `  listingId=${s.listingId} ext=${s.externalListingId} sku="${s.sku}" current=${s.currentProductId} correto=${s.correctProductId} status=${s.status}`,
        );
      }
    }

    reportPerAccount.push({
      accountId: acc.id,
      accountName: acc.accountName,
      shopId: acc.shopId,
      totals: {
        listings: listings.length,
        withSku,
        withoutSku,
        uniqueSkus: skusFromListings.size,
        skusWithLocalMatch: localBySku.size,
        alreadyLinked,
        needsRelink,
        noLocalMatch,
        noSku,
      },
      relinkSamples,
      relinkAll,
    });
  }

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const ts = timestamp();
  const outPath = path.join(
    OUT_DIR,
    `shopee-analyze-18-05-2026-${ts}.json`,
  );
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        userId: flags.userId,
        generatedAt: new Date().toISOString(),
        accounts: reportPerAccount,
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log(`\n[report] ${outPath}`);
}

/**
 * Modo --enrich: atualiza campos VAZIOS dos produtos esqueleto a partir das
 * planilhas (primária + fallback opcional), casando por MLB. Default = dry-run.
 * --apply efetiva. Idempotente (campos já preenchidos não são tocados).
 *
 * Regra de merge: TODOS os campos vêm da fonte primária, EXCETO `year` e
 * `imageUrl`, que aceitam fallback caso a primária esteja vazia.
 */
async function runEnrich(
  primary: EstoqueRow[],
  fallback: EstoqueRow[] | null,
  flags: Flags,
): Promise<void> {
  const startedAt = new Date().toISOString();
  const isDry = !flags.apply;
  console.log(
    `[enrich] modo: ${isDry ? "DRY-RUN (não grava)" : "APLICAR (VAI GRAVAR)"}`,
  );

  // mlb -> linha (primeira ocorrência vence) — primária e fallback separados
  const mlbToPrimary = new Map<string, EstoqueRow>();
  for (const r of primary) {
    for (const m of r.mlbCodes) if (!mlbToPrimary.has(m)) mlbToPrimary.set(m, r);
  }
  const mlbToFallback = new Map<string, EstoqueRow>();
  if (fallback) {
    for (const r of fallback) {
      for (const m of r.mlbCodes) if (!mlbToFallback.has(m)) mlbToFallback.set(m, r);
    }
  }
  const allMlbs = new Set<string>([
    ...mlbToPrimary.keys(),
    ...mlbToFallback.keys(),
  ]);
  console.log(
    `[enrich] MLBs: primária=${mlbToPrimary.size} fallback=${mlbToFallback.size} total único=${allMlbs.size}`,
  );

  const mlAccts = await prisma.marketplaceAccount.findMany({
    where: {
      userId: flags.userId,
      status: "ACTIVE",
      platform: "MERCADO_LIVRE",
    },
    select: { id: true },
  });
  const mlAccountIds = mlAccts.map((a) => a.id);
  if (mlAccountIds.length === 0) {
    console.log("[enrich] sem conta ML ACTIVE — nada a enriquecer.");
    return;
  }

  // mlb -> productId existente
  const mlbToProduct = new Map<string, string>();
  for (const part of chunk(Array.from(allMlbs), 1000)) {
    const found = await prisma.productListing.findMany({
      where: {
        externalListingId: { in: part },
        marketplaceAccountId: { in: mlAccountIds },
      },
      select: { externalListingId: true, productId: true },
    });
    for (const f of found) {
      if (!mlbToProduct.has(f.externalListingId)) {
        mlbToProduct.set(f.externalListingId, f.productId);
      }
    }
  }

  // productId -> { primary, fallback }
  const plansById = new Map<
    string,
    { primary: EstoqueRow | undefined; fallback: EstoqueRow | undefined }
  >();
  for (const [mlb, pid] of mlbToProduct) {
    if (plansById.has(pid)) continue;
    plansById.set(pid, {
      primary: mlbToPrimary.get(mlb),
      fallback: mlbToFallback.get(mlb),
    });
  }
  const productIds = Array.from(plansById.keys());
  console.log(`[enrich] produtos casados por MLB: ${productIds.length}`);

  // Limita p/ teste se --limit
  const targetIds =
    flags.limit !== null ? productIds.slice(0, flags.limit) : productIds;
  if (flags.limit !== null) {
    console.log(`[enrich] --limit=${flags.limit} → processando ${targetIds.length}`);
  }

  const fieldCounters: Record<string, number> = {
    costPrice: 0,
    brand: 0,
    model: 0,
    year: 0,
    weightKg: 0,
    heightCm: 0,
    widthCm: 0,
    lengthCm: 0,
    partNumber: 0,
    description: 0,
    imageUrl: 0,
    locationId: 0,
    attributes: 0,
  };
  const planned: Array<{ id: string; sku: string; fields: string[] }> = [];
  const failed: Array<{ id: string; sku: string; error: string }> = [];
  let nothingToDo = 0;
  let applied = 0;
  const locationCache = new Map<string, string>();
  const locationCounter = { created: 0 };

  // Pré-load de TODAS as Locations do user (1 consulta) — evita milhares de
  // findUnique sequenciais no loop. Por código, primeira vence (DB já é unique).
  const allLocs = await prisma.location.findMany({
    where: { userId: flags.userId },
    select: { code: true, id: true },
  });
  for (const l of allLocs) locationCache.set(l.code, l.id);
  console.log(`[enrich] preload Locations: ${allLocs.length} (cache aquecido)`);

  const isEmptyStr = (v: unknown): boolean =>
    v === null || v === undefined || String(v).trim() === "";

  for (const part of chunk(targetIds, 200)) {
    const t0 = Date.now();
    const prods = await prisma.product.findMany({
      where: { id: { in: part } },
      select: {
        id: true,
        sku: true,
        userId: true,
        costPrice: true,
        brand: true,
        model: true,
        year: true,
        weightKg: true,
        heightCm: true,
        widthCm: true,
        lengthCm: true,
        partNumber: true,
        description: true,
        imageUrl: true,
        imageUrls: true,
        locationId: true,
        attributes: true,
      },
    });
    const byId = new Map(prods.map((p) => [p.id, p]));

    // Unchecked update permite setar a FK escalar `locationId` direto
    // (sem precisar do connect via productLocation).
    type UpdateItem = {
      id: string;
      sku: string;
      data: Prisma.ProductUncheckedUpdateInput;
      fields: string[];
    };
    const updates: UpdateItem[] = [];

    for (const pid of part) {
      const p = byId.get(pid);
      if (!p) continue;
      const plan = plansById.get(pid);
      if (!plan) continue;
      const { primary: pri, fallback: fb } = plan;
      if (!pri && !fb) {
        nothingToDo++;
        continue;
      }

      const data: Prisma.ProductUncheckedUpdateInput = {};
      const fields: string[] = [];

      if (p.costPrice == null && pri?.costStr != null) {
        try {
          const d = new Prisma.Decimal(pri.costStr);
          if (d.isFinite()) {
            data.costPrice = d;
            fields.push("costPrice");
            fieldCounters.costPrice++;
          }
        } catch {
          /* ignora cost inválido */
        }
      }
      if (isEmptyStr(p.brand) && pri?.brand) {
        data.brand = pri.brand;
        fields.push("brand");
        fieldCounters.brand++;
      }
      if (isEmptyStr(p.model) && pri?.model) {
        data.model = pri.model;
        fields.push("model");
        fieldCounters.model++;
      }
      // year: primária OU fallback
      if (isEmptyStr(p.year)) {
        const y = pri?.year ?? fb?.year ?? null;
        if (y) {
          data.year = y;
          fields.push("year");
          fieldCounters.year++;
        }
      }
      if (p.weightKg == null && pri?.weightKg != null) {
        data.weightKg = pri.weightKg;
        fields.push("weightKg");
        fieldCounters.weightKg++;
      }
      if (p.heightCm == null && pri?.heightCm != null) {
        data.heightCm = pri.heightCm;
        fields.push("heightCm");
        fieldCounters.heightCm++;
      }
      if (p.widthCm == null && pri?.widthCm != null) {
        data.widthCm = pri.widthCm;
        fields.push("widthCm");
        fieldCounters.widthCm++;
      }
      if (p.lengthCm == null && pri?.lengthCm != null) {
        data.lengthCm = pri.lengthCm;
        fields.push("lengthCm");
        fieldCounters.lengthCm++;
      }
      if (isEmptyStr(p.partNumber) && pri?.partNumber) {
        data.partNumber = pri.partNumber;
        fields.push("partNumber");
        fieldCounters.partNumber++;
      }
      if (isEmptyStr(p.description) && pri?.description) {
        data.description = pri.description;
        fields.push("description");
        fieldCounters.description++;
      }
      // imageUrl: primária OU fallback
      if (isEmptyStr(p.imageUrl)) {
        const url = pri?.imageUrl ?? fb?.imageUrl ?? null;
        if (url) {
          data.imageUrl = url;
          if (!p.imageUrls || p.imageUrls.length === 0) {
            data.imageUrls = [url];
          }
          fields.push("imageUrl");
          fieldCounters.imageUrl++;
        }
      }
      // locationId: usa sigla da primária (ou fallback se primária vazia)
      if (p.locationId == null) {
        const loc = pri?.sigla ? pri : fb?.sigla ? fb : null;
        if (loc) {
          const locId = await resolveLocationId(
            loc,
            flags.userId,
            isDry,
            locationCache,
            locationCounter,
          );
          if (locId && !locId.startsWith("<dry-")) {
            data.locationId = locId;
            fields.push("locationId");
            fieldCounters.locationId++;
          } else if (locId && isDry) {
            // em dry-run, conta mas não atribui (id sintético)
            fields.push("locationId");
            fieldCounters.locationId++;
          }
        }
      }
      if (p.attributes == null && pri?.attributes) {
        data.attributes = pri.attributes as Prisma.InputJsonValue;
        fields.push("attributes");
        fieldCounters.attributes++;
      }

      if (Object.keys(data).length === 0 && fields.length === 0) {
        nothingToDo++;
        continue;
      }
      updates.push({ id: p.id, sku: p.sku, data, fields });
      planned.push({ id: p.id, sku: p.sku, fields });
    }

    if (!isDry && updates.length > 0) {
      // Paraleliza em 4 sub-transações concorrentes (pool tem 15 conexões;
      // 4 concorrentes deixa folga). Cada sub-transação é independente —
      // falha de uma não rola back as outras (UPDATEs são idempotentes).
      const PARALLELISM = 4;
      const subSize = Math.max(1, Math.ceil(updates.length / PARALLELISM));
      const subs = chunk(updates, subSize);
      const results = await Promise.allSettled(
        subs.map((sub) =>
          prisma.$transaction(
            sub.map((u) =>
              prisma.product.update({ where: { id: u.id }, data: u.data }),
            ),
          ),
        ),
      );
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (r.status === "fulfilled") {
          applied += subs[i].length;
        } else {
          // Fallback: tenta 1-a-1 só o sub-lote que falhou.
          const message =
            r.reason instanceof Error ? r.reason.message : String(r.reason);
          console.warn(
            `[enrich][warn] sub-transação ${i + 1}/${subs.length} falhou: ${message.slice(0, 160)} — tentando 1-a-1`,
          );
          for (const u of subs[i]) {
            try {
              await prisma.product.update({
                where: { id: u.id },
                data: u.data,
              });
              applied++;
            } catch (e) {
              failed.push({
                id: u.id,
                sku: u.sku,
                error: e instanceof Error ? e.message : String(e),
              });
            }
          }
        }
      }
    }

    const dt = Date.now() - t0;
    console.log(
      `[enrich] lote ${planned.length}/${targetIds.length} planejados — nothing=${nothingToDo}${isDry ? "" : ` aplicados=${applied} falhas=${failed.length}`} (${dt}ms/${part.length})`,
    );
  }

  console.log(`\n========== ${isDry ? "DRY-RUN " : ""}RESUMO ENRICH ==========`);
  console.log(`Produtos casados por MLB:       ${productIds.length}`);
  console.log(`Em processamento (após limit):  ${targetIds.length}`);
  console.log(`Com algo a preencher:           ${planned.length}`);
  console.log(`Nada a preencher / sem fonte:   ${nothingToDo}`);
  console.log(
    `Locations criadas:              ${locationCounter.created}${isDry ? " (simuladas)" : ""}`,
  );
  if (!isDry) {
    console.log(`Aplicados (UPDATE):             ${applied}`);
    console.log(`Falhas:                         ${failed.length}`);
  }
  console.log(`-- por campo --`);
  for (const [k, v] of Object.entries(fieldCounters)) {
    console.log(`  ${k.padEnd(13)}: ${v}`);
  }
  console.log(`============================================\n`);

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const ts = timestamp();
  const outPath = path.join(
    OUT_DIR,
    `enrich-${isDry ? "dryrun" : "apply"}-18-05-2026-${ts}.json`,
  );
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        startedAt,
        finishedAt: new Date().toISOString(),
        dryRun: isDry,
        userId: flags.userId,
        counts: {
          productsMatched: productIds.length,
          inScope: targetIds.length,
          planned: planned.length,
          nothingToDo,
          applied,
          failed: failed.length,
          locationsCreated: locationCounter.created,
        },
        fieldCounters,
        planned,
        failed,
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log(`[report] ${outPath}`);
}

async function diagnoseMlAccounts(
  sheetMap: Map<string, { mlbCodes: string[]; mercadoLivre: boolean }>,
  flags: Flags,
): Promise<void> {
  const mlAccounts = await prisma.marketplaceAccount.findMany({
    where: { userId: flags.userId, status: "ACTIVE", platform: "MERCADO_LIVRE" },
    select: { id: true, accountName: true },
  });
  console.log(`[diagnose-ml] contas ML ACTIVE: ${mlAccounts.length}`);
  for (const a of mlAccounts) {
    console.log(`[diagnose-ml]   id=${a.id} nome="${a.accountName}"`);
  }
  if (mlAccounts.length === 0) {
    console.log("[diagnose-ml] nenhuma conta ML — nada a diagnosticar.");
    return;
  }
  const mlAccountIds = mlAccounts.map((a) => a.id);
  const nameById = new Map(mlAccounts.map((a) => [a.id, a.accountName]));

  // Todos os MLBs únicos da planilha.
  const allMlbs = new Set<string>();
  let skusComMlb = 0;
  for (const v of sheetMap.values()) {
    if (v.mlbCodes.length > 0) skusComMlb++;
    for (const m of v.mlbCodes) allMlbs.add(m);
  }
  const mlbList = Array.from(allMlbs);
  console.log(
    `[diagnose-ml] SKUs com MLB=${skusComMlb} | MLBs únicos na planilha=${mlbList.length}`,
  );

  const mlbToAccounts = new Map<string, Set<string>>();
  let scanned = 0;
  for (const part of chunk(mlbList, 1000)) {
    const found = await prisma.productListing.findMany({
      where: {
        externalListingId: { in: part },
        marketplaceAccountId: { in: mlAccountIds },
      },
      select: { externalListingId: true, marketplaceAccountId: true },
    });
    for (const f of found) {
      const set = mlbToAccounts.get(f.externalListingId) ?? new Set<string>();
      set.add(f.marketplaceAccountId);
      mlbToAccounts.set(f.externalListingId, set);
    }
    scanned += part.length;
    console.log(`[diagnose-ml] varridos ${scanned}/${mlbList.length} MLBs…`);
  }

  const perAccount = new Map<string, number>();
  let known = 0;
  let crossAccount = 0;
  for (const accounts of mlbToAccounts.values()) {
    known++;
    if (accounts.size > 1) crossAccount++;
    for (const acc of accounts) {
      perAccount.set(acc, (perAccount.get(acc) ?? 0) + 1);
    }
  }
  const unknown = mlbList.length - known;

  console.log(`\n========== DIAGNÓSTICO CONTA ML ==========`);
  console.log(`MLBs únicos na planilha:        ${mlbList.length}`);
  console.log(`  já em ProductListing:         ${known}`);
  console.log(`  desconhecidos (sem listing):  ${unknown}`);
  console.log(`  em >1 conta (cross-account):  ${crossAccount}`);
  console.log(`-- distribuição por conta (MLBs da planilha já vinculados) --`);
  const ranked = Array.from(perAccount.entries()).sort((a, b) => b[1] - a[1]);
  for (const [accId, count] of ranked) {
    const pct = known > 0 ? ((count / known) * 100).toFixed(1) : "0.0";
    console.log(
      `  ${accId} ("${nameById.get(accId) ?? "?"}"): ${count} (${pct}% dos conhecidos)`,
    );
  }
  if (ranked.length > 0) {
    const [topId, topCount] = ranked[0];
    const share = known > 0 ? (topCount / known) * 100 : 0;
    console.log(
      `\nRECOMENDAÇÃO: --ml-account=${topId}  ("${nameById.get(topId) ?? "?"}")`,
    );
    console.log(
      `  base: ${topCount}/${known} MLBs conhecidos (${share.toFixed(1)}%) pertencem a essa conta.`,
    );
    if (share < 90) {
      console.log(
        `  [atenção] menos de 90% — verifique cross-account/conflitos antes de forçar.`,
      );
    }
  }
  console.log(`==========================================\n`);
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  console.log(
    `[flags] userId=${flags.userId} src=${flags.src} dryRun=${flags.dryRun} limit=${flags.limit ?? "none"} offset=${flags.offset} skipLinks=${flags.skipLinks} onlyLinks=${flags.onlyLinks} platform=${flags.platform} mlAccount=${flags.mlAccountId ?? "(auto)"} skipExistingAnuncio=${flags.skipExistingAnuncio} diagnoseMl=${flags.diagnoseMl} validate=${flags.validate}`,
  );

  await assertAdmin(flags.userId);

  // Modo inspeção (read-only): detalha productIds e encerra.
  if (flags.inspectIds) {
    await inspectProducts(flags.inspectIds);
    return;
  }

  // Modo validação (read-only): roda as 3 queries do plano e encerra.
  if (flags.validate) {
    await validateDb(flags);
    return;
  }

  // Modo análise Shopee (read-only): não precisa de planilha, encerra.
  if (flags.shopeeAnalyze) {
    await analyzeShopee(flags);
    return;
  }

  // Modo cobertura (read-only): matriz produto × ML × Shopee, encerra.
  if (flags.coverageAnalyze) {
    await analyzeCoverage(flags);
    return;
  }

  const rawRows = readSheet(flags.src);
  const { rows, skippedNoSku, sheetMap } = buildRows(rawRows);
  console.log(
    `[parse] raw=${rawRows.length} comSku=${rows.length} semSku=${skippedNoSku} skusUnicos=${sheetMap.size}`,
  );

  // Modo diagnóstico (read-only): descobre a conta ML dona e encerra.
  if (flags.diagnoseMl) {
    await diagnoseMlAccounts(sheetMap, flags);
    return;
  }

  // Modo análise de enriquecimento (read-only): encerra após o relatório.
  if (flags.enrichAnalyze) {
    await analyzeEnrichment(rows, flags);
    return;
  }

  // Modo enriquecimento (dry-run por padrão; --apply para gravar).
  if (flags.enrich) {
    let fallbackRows: EstoqueRow[] | null = null;
    if (flags.xlsxFallback) {
      console.log(`[enrich] lendo fallback: ${flags.xlsxFallback}`);
      const fbRaw = readSheet(flags.xlsxFallback);
      const built = buildRows(fbRaw);
      fallbackRows = built.rows;
      console.log(`[enrich] fallback parseado: ${fallbackRows.length} linhas com sku`);
    }
    await runEnrich(rows, fallbackRows, flags);
    return;
  }

  // Snapshot canônico só em corrida real (dry-run não escreve NADA).
  if (!flags.dryRun) {
    try {
      snapshotSource(flags.src);
    } catch (err) {
      console.warn(
        `[snapshot][warn] não foi possível copiar a planilha: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const ts = timestamp();
  let importSummary: ImportSummary | null = null;
  let createdPairs: Array<{ id: string; sku: string }> = [];

  // ───────────────────── Fase 1 ─────────────────────
  if (!flags.onlyLinks) {
    const sliceEnd =
      flags.limit !== null ? flags.offset + flags.limit : undefined;
    const limited = rows.slice(flags.offset, sliceEnd);
    console.log(
      `[import] processando ${limited.length} linha(s) (offset=${flags.offset}${flags.limit !== null ? `, limit=${flags.limit}` : ""})…`,
    );
    const res = await runImport(limited, flags);
    importSummary = res.summary;
    importSummary.totals.skippedNoSku = skippedNoSku;
    createdPairs = res.createdPairs;

    if (!flags.dryRun) {
      ensureDir(OUT_DIR);
      const jsonPath = path.join(
        OUT_DIR,
        `import-estoque-18-05-2026-${ts}.json`,
      );
      fs.writeFileSync(jsonPath, JSON.stringify(importSummary, null, 2), "utf8");
      console.log(`[report] ${jsonPath}`);
    }
    printImportSummary(importSummary, flags.dryRun);
  } else {
    console.log("[import] pulado por --only-links");
  }

  if (flags.skipLinks) {
    console.log("[links] pulado por --skip-links");
    return;
  }

  // ───────────────────── Fase 2 ─────────────────────
  let eligible: Array<{ id: string; sku: string }>;
  if (flags.onlyLinks) {
    // Todos os Product do userId cujo sku aparece na planilha.
    const sheetSkus = Array.from(sheetMap.keys());
    const found: Array<{ id: string; sku: string }> = [];
    for (const skuChunk of chunk(sheetSkus, 1000)) {
      const part = await prisma.product.findMany({
        where: { userId: flags.userId, sku: { in: skuChunk } },
        select: { id: true, sku: true },
      });
      found.push(...part);
    }
    eligible = flags.limit !== null ? found.slice(0, flags.limit) : found;
    console.log(
      `[links] --only-links: ${eligible.length} produto(s) do userId ∩ planilha`,
    );
  } else {
    // Produtos recém-criados na Fase 1 (dry-run usa ids sintéticos).
    eligible = flags.dryRun
      ? []
      : createdPairs.filter((p) => !p.id.startsWith("<dry-"));
    if (flags.dryRun) {
      console.log(
        "[links] dry-run sem --only-links: sem produtos reais criados; Fase 2 só audita contas.",
      );
    }
  }

  const linkSummary = await runLinks(eligible, sheetMap, flags);
  if (!flags.dryRun) {
    ensureDir(OUT_DIR);
    const jsonPath = path.join(OUT_DIR, `link-listings-18-05-2026-${ts}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(linkSummary, null, 2), "utf8");
    console.log(`[report] ${jsonPath}`);
  }
  printLinkSummary(linkSummary);
}

main()
  .catch((err) => {
    console.error("[fatal]", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
