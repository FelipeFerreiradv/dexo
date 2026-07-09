import "dotenv/config";
import path from "path";
import fs from "fs";
import { Prisma } from "@prisma/client";
import prisma from "../app/lib/prisma";
import { normalizeSku } from "../app/lib/sku";

/**
 * Migração de cliente do sistema "WebDesmonte" (família IBR) → Dexo, a partir do
 * export estruturado em CSV (issue IBR-xxxx): products.csv, purchase_waste.csv,
 * locations.csv, product_images_joined.csv.
 *
 *   Fase locations → `Location` (árvore via ParentId + InitialsPath) ; map WD→Dexo
 *   Fase scraps    → `Scrap` (purchase_waste)                        ; map WD→Dexo
 *   Fase products  → `Product` (linka locationId + scrapId + imagens do export)
 *   Fase images    → (standalone) preenche imagens por attributes.wdId
 *
 * SEM anúncio ML no export → NÃO há fase de listings (se vier um export de
 * anúncios depois, usar migracao-magoo.ts). SEM NF-e no pacote.
 * Idempotente; sem `--apply` não escreve.
 *
 * Uso (tsx DIRETO — `npm run -- <flags>` engole flags no PowerShell):
 *   npx tsx scripts/migracao-webdesmonte.ts --user-id=<ID> --tenant=K2 --data-dir=scripts/data/migracao-k2 --dry-run
 *   npx tsx scripts/migracao-webdesmonte.ts --user-id=<ID> --tenant=K2 --data-dir=scripts/data/migracao-k2 --apply --only=locations,scraps,products
 */

type Row = Record<string, string | null>;
type Phase = "locations" | "scraps" | "products" | "images";

const DEFAULT_USER_ID = "";
const DEFAULT_DATA_DIR = path.resolve(__dirname, "data", "migracao-webdesmonte");
const OUT_DIR = path.resolve(__dirname, "out");
const MAX_IMAGES = 12;
const ALL_PHASES: Phase[] = ["locations", "scraps", "products", "images"];
let TENANT = "WEBDESMONTE";

interface Flags {
  userId: string;
  dryRun: boolean;
  apply: boolean;
  only: Set<Phase>;
  limit: number | null;
  offset: number;
  dataDir: string;
  tenant: string;
  onlyActive: boolean; // default false = cria tudo (ativos + inativos)
}

function parseFlags(argv: string[]): Flags {
  const get = (n: string): string | undefined => {
    const f = `--${n}=`;
    const a = argv.find((x) => x.startsWith(f));
    return a ? a.slice(f.length) : undefined;
  };
  const has = (n: string): boolean => argv.includes(`--${n}`);
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
  return {
    userId: get("user-id") ?? process.env.MIGRACAO_USER_ID ?? DEFAULT_USER_ID,
    apply,
    dryRun: has("dry-run") || !apply,
    only,
    limit: limitRaw && /^\d+$/.test(limitRaw) ? parseInt(limitRaw, 10) : null,
    offset: offsetRaw && /^\d+$/.test(offsetRaw) ? parseInt(offsetRaw, 10) : 0,
    dataDir: get("data-dir") ?? DEFAULT_DATA_DIR,
    tenant: get("tenant") ?? "WEBDESMONTE",
    onlyActive: has("only-active"),
  };
}

/* ------------------------------ CSV parser ----------------------------- */

/** Parser CSV robusto (aspas, vírgulas e quebras dentro de aspas, "" escapado).
 *  Mantém TUDO como string (preserva SKUs/códigos com zero à esquerda). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      row.push(cur);
      cur = "";
    } else if (c === "\n") {
      row.push(cur);
      rows.push(row);
      row = [];
      cur = "";
    } else if (c !== "\r") cur += c;
  }
  if (cur !== "" || row.length > 0) {
    row.push(cur);
    rows.push(row);
  }
  return rows;
}

function readCsv(dir: string, name: string): Row[] {
  const p = path.resolve(dir, name);
  if (!fs.existsSync(p)) throw new Error(`CSV não encontrado: ${p}`);
  const text = fs.readFileSync(p, "utf8");
  const matrix = parseCsv(text);
  if (matrix.length === 0) return [];
  const header = matrix[0].map((h) => h.replace(/^﻿/, "").trim());
  const out: Row[] = [];
  for (let r = 1; r < matrix.length; r++) {
    const cells = matrix[r];
    if (cells.length === 1 && cells[0] === "") continue; // linha vazia
    const obj: Row = {};
    for (let c = 0; c < header.length; c++) {
      const v = cells[c];
      obj[header[c]] = v === undefined || v === "" ? null : v;
    }
    out.push(obj);
  }
  console.log(`[csv] ${name}: ${out.length} linhas`);
  return out;
}

/* ------------------------------- Helpers ------------------------------- */

function asString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}
function asNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (s === "") return null;
  const cleaned = s.includes(",") && !s.includes(".") ? s.replace(",", ".") : s;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}
/** Estoque: inteiro >= 0 (negativos/inválidos → 0). */
function asStock(v: unknown): number {
  const n = asNumber(v);
  if (n === null) return 0;
  return Math.max(0, Math.floor(n));
}
function asDimCm(v: unknown): number | null {
  const n = asNumber(v);
  if (n === null || n <= 0) return null;
  return Math.floor(n);
}
function toDecimalOrNull(v: unknown): Prisma.Decimal | null {
  const n = asNumber(v);
  if (n === null) return null;
  try {
    const d = new Prisma.Decimal(n);
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}
function toPriceDecimal(v: unknown): Prisma.Decimal {
  const d = toDecimalOrNull(v);
  if (d === null || d.isNegative()) return new Prisma.Decimal(0);
  return d;
}
/** Peso: origem em GRAMAS (PackageWeightG) → kg; fora de [0.01, 9999.99] → null. */
function weightKgFromGrams(v: unknown): Prisma.Decimal | null {
  const g = asNumber(v);
  if (g === null || g <= 0) return null;
  const kg = g / 1000;
  if (kg < 0.01 || kg >= 10000) return null;
  try {
    return new Prisma.Decimal(kg.toFixed(2));
  } catch {
    return null;
  }
}
function isBoolT(v: unknown): boolean {
  const s = (asString(v) ?? "").toLowerCase();
  return s === "t" || s === "true" || s === "1";
}
function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}
function chunk<T>(a: T[], n: number): T[][] {
  const o: T[][] = [];
  for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n));
  return o;
}
function pushCap<T>(a: T[], x: T, cap = 500): void {
  if (a.length < cap) a.push(x);
}
function sliceRows<T>(rows: T[], flags: Flags): T[] {
  const end = flags.limit !== null ? flags.offset + flags.limit : undefined;
  return rows.slice(flags.offset, end);
}
/** Caminho de localização normalizado (colapsa espaços, " > " uniforme). */
function normPath(raw: unknown): string | null {
  const s = asString(raw);
  if (!s) return null;
  const parts = s
    .split(">")
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 0);
  return parts.length ? parts.join(" > ").toUpperCase() : null;
}
function cleanChassis(raw: unknown): string | null {
  const s = asString(raw);
  if (!s) return null;
  const up = s.toUpperCase().replace(/\s+/g, "");
  if (up.length < 11 || !/^[A-Z0-9]+$/.test(up) || /^(.)\1*$/.test(up)) return null;
  return up;
}
function cleanPlate(raw: unknown): string | null {
  const s = asString(raw);
  if (!s) return null;
  const up = s.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return up.length >= 6 && up.length <= 8 ? up : null;
}

/* ------------------------------ Relatório ------------------------------ */

const reportRef: Record<string, unknown> = { locations: null, scraps: null, products: null, images: null };

async function counts(userId: string): Promise<Record<string, number>> {
  const [products, scraps, locations] = await Promise.all([
    prisma.product.count({ where: { userId } }),
    prisma.scrap.count({ where: { userId } }),
    prisma.location.count({ where: { userId } }),
  ]);
  return { products, scraps, locations };
}

async function assertUser(userId: string): Promise<void> {
  if (!userId) throw new Error("Informe --user-id=<cuid do cliente>. Abortando.");
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, role: true, parentUserId: true },
  });
  if (!u) throw new Error(`Usuário ${userId} não encontrado. Abortando.`);
  console.log(`[preflight] user=${u.email} role=${u.role} parentUserId=${u.parentUserId ?? "(null)"}`);
}

/* ----------------------------- Localizações ---------------------------- */

/** Cria a árvore de Location e devolve o map WD LocationId → Dexo Location id. */
async function phaseLocations(flags: Flags): Promise<Map<string, string>> {
  const rows = readCsv(flags.dataDir, "locations.csv");
  const sum = { total: rows.length, created: 0, skipped_existing: 0, errors: 0 };
  const wdToDexo = new Map<string, string>();

  const existing = await prisma.location.findMany({
    where: { userId: flags.userId },
    select: { id: true, code: true },
  });
  const codeToId = new Map(existing.map((l) => [l.code, l.id]));

  // Processa em ordem de Level (pais antes dos filhos).
  const sorted = [...rows].sort((a, b) => (asNumber(a.Level) ?? 0) - (asNumber(b.Level) ?? 0));
  for (const r of sorted) {
    const wdId = asString(r.Id);
    if (!wdId) continue;
    const code = normPath(r.InitialsPath) ?? normPath(r.Initials);
    if (!code) continue;
    const description = asString(r.Description) ?? asString(r.Initials) ?? code;

    const existingId = codeToId.get(code);
    if (existingId) {
      wdToDexo.set(wdId, existingId);
      sum.skipped_existing++;
      continue;
    }
    const parentWd = asString(r.ParentId);
    const parentId = parentWd ? wdToDexo.get(parentWd) ?? null : null;

    if (flags.dryRun) {
      const fake = `<dry-loc-${wdId}>`;
      wdToDexo.set(wdId, fake);
      codeToId.set(code, fake);
      sum.created++;
      continue;
    }
    try {
      const c = await prisma.location.create({
        data: { userId: flags.userId, code, description, parentId } as Prisma.LocationUncheckedCreateInput,
        select: { id: true },
      });
      wdToDexo.set(wdId, c.id);
      codeToId.set(code, c.id);
      sum.created++;
    } catch (err) {
      if (isUniqueViolation(err)) {
        const ex = await prisma.location.findUnique({
          where: { userId_code: { userId: flags.userId, code } },
          select: { id: true },
        });
        if (ex) {
          wdToDexo.set(wdId, ex.id);
          codeToId.set(code, ex.id);
        }
        sum.skipped_existing++;
      } else {
        sum.errors++;
      }
    }
  }
  reportRef.locations = sum;
  console.log(`[locations] total=${sum.total} criadas=${sum.created} existentes=${sum.skipped_existing} erros=${sum.errors}`);
  return wdToDexo;
}

/** Reconstrói o map WD LocationId → Dexo id a partir do CSV + banco (standalone). */
async function loadLocationMap(flags: Flags): Promise<Map<string, string>> {
  const rows = readCsv(flags.dataDir, "locations.csv");
  const existing = await prisma.location.findMany({
    where: { userId: flags.userId },
    select: { id: true, code: true },
  });
  const codeToId = new Map(existing.map((l) => [l.code, l.id]));
  const map = new Map<string, string>();
  for (const r of rows) {
    const wdId = asString(r.Id);
    const code = normPath(r.InitialsPath) ?? normPath(r.Initials);
    if (wdId && code && codeToId.has(code)) map.set(wdId, codeToId.get(code)!);
  }
  console.log(`[locations] map WD→Dexo reconstruído: ${map.size}`);
  return map;
}

/* -------------------------------- Sucatas ------------------------------ */

async function phaseScraps(flags: Flags): Promise<Map<string, string>> {
  const rows = readCsv(flags.dataDir, "purchase_waste.csv");
  const sum = { total: rows.length, created: 0, skipped_existing: 0, errors: 0 };
  const wdToDexo = new Map<string, string>();

  // idempotência: sucatas já criadas por este tenant (marcador nas notes).
  const marker = `Legado ${TENANT} · sucata #`;
  const existing = await prisma.scrap.findMany({
    where: { userId: flags.userId, notes: { contains: marker } },
    select: { id: true, notes: true },
  });
  for (const s of existing) {
    const m = s.notes?.match(/#(\d+)/);
    if (m) wdToDexo.set(m[1], s.id);
  }

  for (const r of rows) {
    const wdId = asString(r.Id);
    if (!wdId) continue;
    if (wdToDexo.has(wdId)) {
      sum.skipped_existing++;
      continue;
    }
    const brand = asString(r.Brand) ?? "INDEFINIDO";
    const model = asString(r.Model) ?? "INDEFINIDO";
    const notesParts = [`Legado ${TENANT} · sucata #${wdId}`];
    const lot = asString(r.Lot);
    if (lot) notesParts.push(`lote ${lot}`);
    const infoAdd = asString(r.InfoAdd);
    if (infoAdd) notesParts.push(infoAdd);

    if (flags.dryRun) {
      wdToDexo.set(wdId, `<dry-scrap-${wdId}>`);
      sum.created++;
      continue;
    }
    try {
      const c = await prisma.scrap.create({
        data: {
          userId: flags.userId,
          brand,
          model,
          year: asString(r.Year),
          plate: cleanPlate(r.LicensePlate),
          chassis: cleanChassis(r.Chassis),
          color: asString(r.Color),
          lot,
          deregistrationCert: asString(r.CertidaoBaixaVeiculo),
          cost: toDecimalOrNull(r.PurchaseValue),
          status: "AVAILABLE",
          logisticsStatus: "ON_LIFT",
          notes: notesParts.join(" · "),
        } as Prisma.ScrapUncheckedCreateInput,
        select: { id: true },
      });
      wdToDexo.set(wdId, c.id);
      sum.created++;
    } catch (err) {
      if (isUniqueViolation(err)) sum.skipped_existing++;
      else sum.errors++;
    }
  }
  reportRef.scraps = sum;
  console.log(`[scraps] total=${sum.total} criadas=${sum.created} existentes=${sum.skipped_existing} erros=${sum.errors}`);
  return wdToDexo;
}

async function loadScrapMap(flags: Flags): Promise<Map<string, string>> {
  const marker = `Legado ${TENANT} · sucata #`;
  const existing = await prisma.scrap.findMany({
    where: { userId: flags.userId, notes: { contains: marker } },
    select: { id: true, notes: true },
  });
  const map = new Map<string, string>();
  for (const s of existing) {
    const m = s.notes?.match(/#(\d+)/);
    if (m) map.set(m[1], s.id);
  }
  console.log(`[scraps] map WD→Dexo reconstruído: ${map.size}`);
  return map;
}

/* -------------------------------- Imagens ------------------------------ */

/** wdProductId → [urls] (capa primeiro, depois por Index). */
function loadImageMap(flags: Flags): Map<string, string[]> {
  let rows: Row[] = [];
  try {
    rows = readCsv(flags.dataDir, "product_images_joined.csv");
  } catch {
    console.warn("[images] product_images_joined.csv ausente — sem imagens");
    return new Map();
  }
  const byProd = new Map<string, Array<{ url: string; cover: boolean; idx: number }>>();
  for (const r of rows) {
    const pid = asString(r.ProductId);
    const url = asString(r.Url);
    if (!pid || !url) continue;
    const arr = byProd.get(pid) ?? [];
    arr.push({ url, cover: isBoolT(r.ItsCover), idx: asNumber(r.Index) ?? 0 });
    byProd.set(pid, arr);
  }
  const map = new Map<string, string[]>();
  for (const [pid, arr] of byProd) {
    arr.sort((a, b) => (a.cover === b.cover ? a.idx - b.idx : a.cover ? -1 : 1));
    const urls: string[] = [];
    for (const x of arr) {
      if (!urls.includes(x.url)) urls.push(x.url);
      if (urls.length >= MAX_IMAGES) break;
    }
    map.set(pid, urls);
  }
  console.log(`[images] map: ${map.size} produtos com imagem`);
  return map;
}

/* -------------------------------- Produtos ----------------------------- */

async function phaseProducts(
  flags: Flags,
  locMap: Map<string, string>,
  scrapMap: Map<string, string>,
  imageMap: Map<string, string[]>,
): Promise<void> {
  const rows = sliceRows(readCsv(flags.dataDir, "products.csv"), flags);
  const sum = {
    processed: rows.length,
    created: 0,
    skipped_existing_wd: 0,
    skipped_existing_sku: 0,
    dup_code_disambiguated: 0,
    skipped_inactive: 0,
    zero_price: 0,
    scrap_linked: 0,
    location_linked: 0,
    image_set: 0,
    errors: 0,
    details: [] as unknown[],
  };

  const existing = await prisma.product.findMany({
    where: { userId: flags.userId },
    select: { sku: true, attributes: true },
  });
  const existingSku = new Set(existing.map((p) => p.sku));
  // Idempotência real: produtos deste tenant já migrados (por wdId).
  const existingWd = new Set<string>();
  for (const p of existing) {
    const a = (p.attributes ?? {}) as Record<string, unknown>;
    if (a.migration === TENANT && a.wdId != null) existingWd.add(String(a.wdId));
  }
  const seenSku = new Set<string>();
  const seenWd = new Set<string>();
  console.log(
    `[products] preload: ${existingSku.size} SKUs no banco (${existingWd.size} já ${TENANT}) | loc=${locMap.size} scrap=${scrapMap.size} img=${imageMap.size}`,
  );

  let i = 0;
  for (const r of rows) {
    i++;
    const active = isBoolT(r.Active);
    if (flags.onlyActive && !active) {
      sum.skipped_inactive++;
      continue;
    }
    const wdId = asString(r.Id);
    const code = asString(r.Code);
    if (!code || !wdId) {
      sum.errors++;
      continue;
    }
    // Idempotência: se este wdId já foi migrado por este tenant, pula.
    if (existingWd.has(wdId) || seenWd.has(wdId)) {
      sum.skipped_existing_wd++;
      continue;
    }
    seenWd.add(wdId);
    // SKU: se o código já existe (qualquer origem: import Shopee, run anterior),
    // NÃO cria — evita duplicar (a unique (userId,sku) é o item). Só desambigua
    // código duplicado DENTRO do próprio arquivo (2 peças WD com mesmo Code).
    let sku = code;
    if (existingSku.has(sku)) {
      sum.skipped_existing_sku++;
      continue;
    }
    if (seenSku.has(sku)) {
      const alt = `${code}-${wdId}`;
      if (seenSku.has(alt) || existingSku.has(alt)) {
        sum.skipped_existing_sku++;
        continue;
      }
      sku = alt;
      sum.dup_code_disambiguated++;
    }
    seenSku.add(sku);

    const name = asString(r.Description) ?? "(sem descrição)";
    const price = toPriceDecimal(r.SaleValue);
    if (price.isZero()) sum.zero_price++;
    const locId = locMap.get(asString(r.LocationId) ?? "") ?? null;
    const realLocId = locId && !locId.startsWith("<dry-") ? locId : null;
    if (realLocId) sum.location_linked++;
    const scrapWd = asString(r.PurchaseWasteId);
    const scrapId = scrapWd ? scrapMap.get(scrapWd) ?? null : null;
    const realScrapId = scrapId && !scrapId.startsWith("<dry-") ? scrapId : null;
    if (realScrapId) sum.scrap_linked++;

    const imgs = imageMap.get(wdId) ?? [];
    if (imgs.length) sum.image_set++;

    const attributes = {
      migration: TENANT,
      wdId,
      code,
      active,
      mlCategoryId: asString(r.CategoryId),
      quality: asString(r.PieceWasteQuality),
      chassi: cleanChassis(r.Chassi),
      additionalInfo: asString(r.AdditionalInfo),
      trim: asString(r.Trim),
      ncm: asString(r.Ncm),
      purchaseWasteId: scrapWd,
      locationIdWd: asString(r.LocationId),
    };

    const data: Prisma.ProductUncheckedCreateInput = {
      userId: flags.userId,
      sku,
      skuNormalized: normalizeSku(sku),
      name,
      price,
      costPrice: toDecimalOrNull(r.RealCost) ?? toDecimalOrNull(r.CurrentCost),
      stock: asStock(r.QuantityInBox),
      quality: "SEMINOVO",
      brand: asString(r.Brand),
      model: asString(r.Model),
      year: asString(r.Year),
      partNumber: asString(r.PartNumberDescription),
      weightKg: weightKgFromGrams(r.PackageWeightG),
      heightCm: asDimCm(r.PackageHeightCm),
      widthCm: asDimCm(r.PackageWidthCm),
      lengthCm: asDimCm(r.PackageLengthCm),
      locationId: realLocId,
      scrapId: realScrapId,
      imageUrl: imgs[0] ?? null,
      imageUrls: imgs,
      attributes: attributes as unknown as Prisma.InputJsonValue,
    };

    if (flags.dryRun) {
      sum.created++;
      continue;
    }
    try {
      await prisma.product.create({ data, select: { id: true } });
      existingSku.add(sku);
      sum.created++;
    } catch (err) {
      if (isUniqueViolation(err)) sum.skipped_existing_sku++;
      else {
        sum.errors++;
        pushCap(sum.details, { sku, error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (i % 1000 === 0) {
      console.log(`[products] ${i}/${rows.length} criados=${sum.created} scrapLink=${sum.scrap_linked} locLink=${sum.location_linked} img=${sum.image_set}`);
    }
  }

  reportRef.products = sum;
  console.log(
    `[products] criados=${sum.created} jaMigrado(wd)=${sum.skipped_existing_wd} skuExist=${sum.skipped_existing_sku} dupCode=${sum.dup_code_disambiguated} inativosPulados=${sum.skipped_inactive} scrapLink=${sum.scrap_linked} locLink=${sum.location_linked} img=${sum.image_set} zero_price=${sum.zero_price} erros=${sum.errors}`,
  );
}

/* ---------------------- Imagens (fase standalone) ---------------------- */

async function phaseImages(flags: Flags, imageMap: Map<string, string[]>): Promise<void> {
  const sum = { candidates: 0, preenchidas: 0, sem_imagem: 0, ja_tinha: 0, errors: 0 };
  const products = await prisma.product.findMany({
    where: { userId: flags.userId, attributes: { path: ["migration"], equals: TENANT } },
    select: { id: true, imageUrl: true, imageUrls: true, attributes: true },
  });
  const targets = products.filter(
    (p) => !(p.imageUrl && p.imageUrl.trim()) && !(Array.isArray(p.imageUrls) && p.imageUrls.length > 0),
  );
  sum.ja_tinha = products.length - targets.length;
  sum.candidates = targets.length;

  for (const p of targets) {
    const wdId = String((p.attributes as Record<string, unknown> | null)?.wdId ?? "");
    const imgs = wdId ? imageMap.get(wdId) ?? [] : [];
    if (!imgs.length) {
      sum.sem_imagem++;
      continue;
    }
    if (flags.dryRun) {
      sum.preenchidas++;
      continue;
    }
    try {
      await prisma.product.update({ where: { id: p.id }, data: { imageUrl: imgs[0], imageUrls: imgs } });
      sum.preenchidas++;
    } catch {
      sum.errors++;
    }
  }
  reportRef.images = sum;
  console.log(`[images] candidatos=${sum.candidates} preenchidas=${sum.preenchidas} semImagem=${sum.sem_imagem} jaTinha=${sum.ja_tinha}`);
}

/* -------------------------------- Main --------------------------------- */

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const flags = parseFlags(process.argv.slice(2));
  TENANT = flags.tenant;
  console.log(
    `[migracao-webdesmonte] userId=${flags.userId || "(vazio)"} tenant=${TENANT} modo=${flags.dryRun ? "DRY-RUN" : "APPLY"} only=${[...flags.only].join(",")} dataDir=${flags.dataDir}`,
  );

  await assertUser(flags.userId);
  const baseline = await counts(flags.userId);
  console.log("[baseline]", JSON.stringify(baseline));

  let locMap = new Map<string, string>();
  let scrapMap = new Map<string, string>();

  if (flags.only.has("locations")) locMap = await phaseLocations(flags);
  if (flags.only.has("scraps")) scrapMap = await phaseScraps(flags);

  if (flags.only.has("products")) {
    if (locMap.size === 0) locMap = await loadLocationMap(flags);
    if (scrapMap.size === 0) scrapMap = await loadScrapMap(flags);
    const imageMap = loadImageMap(flags);
    await phaseProducts(flags, locMap, scrapMap, imageMap);
  }
  if (flags.only.has("images") && !flags.only.has("products")) {
    const imageMap = loadImageMap(flags);
    await phaseImages(flags, imageMap);
  }

  const final = await counts(flags.userId);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.writeFileSync(
    path.join(OUT_DIR, `migracao-webdesmonte-${TENANT}-${stamp}.json`),
    JSON.stringify({ userId: flags.userId, tenant: TENANT, mode: flags.dryRun ? "dry-run" : "apply", startedAt, finishedAt: new Date().toISOString(), flags: { only: [...flags.only], onlyActive: flags.onlyActive, limit: flags.limit }, baseline, final, phases: reportRef }, null, 2),
    "utf8",
  );

  console.log(`\n===== RESUMO ${TENANT} =====`);
  console.log(`modo: ${flags.dryRun ? "DRY-RUN (0 escritas)" : "APPLY"}`);
  for (const k of ["locations", "scraps", "products"]) {
    console.log(`  ${k.padEnd(10)} ${String(baseline[k]).padStart(7)} → ${String(final[k]).padStart(7)}  (Δ ${final[k] - baseline[k]})`);
  }
  console.log("=========================\n");

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(`[migracao-webdesmonte][fatal]`, e);
  await prisma.$disconnect();
  process.exit(1);
});
