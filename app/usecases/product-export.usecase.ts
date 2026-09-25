/**
 * GET /products/export — base COMPLETA de produtos do cliente, por página.
 *
 * Rota própria (em vez de reaproveitar GET /products) por dois motivos:
 *
 * 1. Completude. A listagem ordena por `(stock > 0) DESC, createdAt DESC` e
 *    pagina por OFFSET. Produtos criados na mesma importação têm o MESMO
 *    `createdAt`, e sem desempate o Postgres pode devolver o grupo em ordem
 *    diferente a cada página: a exportação repetia uns e PERDIA outros.
 *    Medido em 25/09/2026: 8.858 produtos em 91 grupos empatados (6 clientes),
 *    o maior com 393 — quase 4 páginas de 100. Aqui a paginação é por cursor
 *    de `id` (índice único `(id, userId)`: 0,5 ms por página no maior cliente).
 * 2. Conteúdo. A planilha precisa de dados que a listagem não carrega
 *    (compatibilidades, nome da conta de cada anúncio, quem cadastrou, sucata)
 *    e a listagem não deve ficar mais pesada por causa da exportação.
 *
 * Seleção é allowlist explícita. Da conta de marketplace saem SÓ `platform` e
 * `accountName` — nunca token.
 */
import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import {
  createLegacyLocationPathResolver,
  createLocationPathResolver,
  type LocationPathNode,
} from "../lib/location-path";
import { maskCorruptVehicleCategoriesInProducts } from "../marketplaces/services/category-resolution.service";
import type {
  ExportExtraEntry,
  ExportFichaEntry,
  ExportListing,
  ExportPage,
  ExportProduct,
} from "../produtos/lib/product-export.logic";

export const EXPORT_PAGE_DEFAULT = 500;
export const EXPORT_PAGE_MAX = 1000;

const EXPORT_SELECT = {
  id: true,
  sku: true,
  name: true,
  description: true,
  price: true,
  costPrice: true,
  markup: true,
  stock: true,
  reservedStock: true,
  brand: true,
  model: true,
  year: true,
  version: true,
  category: true,
  partNumber: true,
  quality: true,
  heightCm: true,
  widthCm: true,
  lengthCm: true,
  weightKg: true,
  imageUrl: true,
  imageUrls: true,
  isSecurityItem: true,
  isTraceable: true,
  sourceVehicle: true,
  location: true,
  locationId: true,
  productLocation: { select: { code: true, description: true } },
  mlCategory: { select: { externalId: true, fullPath: true } },
  shopeeCategoryId: true,
  magaluCategoryId: true,
  olxCategoryId: true,
  fbCategoryId: true,
  attributes: true,
  compatibilityPositions: true,
  compatibilities: {
    select: {
      brand: true,
      model: true,
      version: true,
      yearFrom: true,
      yearTo: true,
    },
    orderBy: [
      { brand: "asc" },
      { model: "asc" },
      { yearFrom: "asc" },
    ],
  },
  listings: {
    select: {
      externalListingId: true,
      status: true,
      permalink: true,
      marketplaceAccount: {
        select: { platform: true, accountName: true },
      },
    },
  },
  scrap: {
    select: { nickname: true, brand: true, model: true, year: true },
  },
  createdBy: { select: { name: true } },
  originPlatform: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ProductSelect;

/** Linha como o Prisma devolve com `EXPORT_SELECT` (tipagem frouxa de propósito). */
export interface ExportSourceRow {
  id: string;
  sku: string;
  name: string;
  description?: string | null;
  price?: unknown;
  costPrice?: unknown;
  markup?: unknown;
  stock?: number | null;
  reservedStock?: number | null;
  brand?: string | null;
  model?: string | null;
  year?: string | null;
  version?: string | null;
  category?: string | null;
  partNumber?: string | null;
  quality?: string | null;
  heightCm?: number | null;
  widthCm?: number | null;
  lengthCm?: number | null;
  weightKg?: unknown;
  imageUrl?: string | null;
  imageUrls?: string[] | null;
  isSecurityItem?: boolean | null;
  isTraceable?: boolean | null;
  sourceVehicle?: string | null;
  location?: string | null;
  locationId?: string | null;
  productLocation?: { code: string; description?: string | null } | null;
  mlCategory?: { externalId: string; fullPath: string } | null;
  shopeeCategoryId?: string | null;
  magaluCategoryId?: string | null;
  olxCategoryId?: string | null;
  fbCategoryId?: string | null;
  attributes?: unknown;
  compatibilityPositions?: unknown;
  compatibilities?: Array<{
    brand: string;
    model: string;
    version?: string | null;
    yearFrom?: number | null;
    yearTo?: number | null;
  }> | null;
  listings?: Array<{
    externalListingId?: string | null;
    status?: string | null;
    permalink?: string | null;
    marketplaceAccount?: { platform: string; accountName?: string | null } | null;
  }> | null;
  scrap?: {
    nickname?: string | null;
    brand?: string | null;
    model?: string | null;
    year?: string | null;
  } | null;
  createdBy?: { name?: string | null } | null;
  originPlatform?: string | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
}

// ── Parâmetros ──────────────────────────────────────────────────────────────

const CURSOR_RE = /^[A-Za-z0-9_-]{1,64}$/;

export class ExportParamError extends Error {}

export function parseExportCursor(value: string | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (!CURSOR_RE.test(value)) throw new ExportParamError("Cursor inválido");
  return value;
}

export function parseExportLimit(value: string | undefined): number {
  if (value === undefined || value === "") return EXPORT_PAGE_DEFAULT;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new ExportParamError("Limite inválido");
  return Math.min(n, EXPORT_PAGE_MAX);
}

// ── Conversão pura (testável sem banco) ─────────────────────────────────────

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(
    typeof value === "object" && value !== null && "toString" in value
      ? String(value)
      : value,
  );
  return Number.isFinite(n) ? n : null;
}

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function clean(value: string | null | undefined): string | null {
  const s = (value ?? "").trim();
  return s ? s : null;
}

/** Chave de atributo no formato do Mercado Livre (COLOR, PART_NUMBER…). */
const ML_ATTRIBUTE_KEY = /^[A-Z][A-Z0-9_]*$/;

function scalarText(value: unknown): string | null {
  if (typeof value === "string") return clean(value);
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value === "boolean") return value ? "Sim" : "Não";
  return null;
}

/** Valor legível de um atributo do ML ({value_name}, {value_id}, values[]…). */
export function attributeDisplayValue(raw: unknown): string | null {
  const scalar = scalarText(raw);
  if (scalar !== null || raw === null || typeof raw !== "object") return scalar;
  if (Array.isArray(raw)) {
    const parts = raw.map(attributeDisplayValue).filter(Boolean) as string[];
    return parts.length ? parts.join(", ") : null;
  }
  const obj = raw as Record<string, unknown>;
  const named = scalarText(obj.value_name) ?? scalarText(obj.name);
  if (named) return named;
  if (Array.isArray(obj.values)) {
    const parts = obj.values
      .map((v) =>
        v && typeof v === "object"
          ? scalarText((v as Record<string, unknown>).name) ??
            scalarText((v as Record<string, unknown>).id)
          : scalarText(v),
      )
      .filter(Boolean) as string[];
    if (parts.length) return parts.join(", ");
  }
  return scalarText(obj.value) ?? scalarText(obj.value_id);
}

/**
 * Separa `Product.attributes` em ficha técnica do ML (chaves MAIÚSCULAS) e
 * dados que vieram de outro sistema na migração (etiqueta antiga, código da
 * peça, NCM…). Destes, só valores simples; objetos internos ficam de fora.
 */
export function splitAttributes(
  attributes: unknown,
  names: ReadonlyMap<string, string>,
): { ficha: ExportFichaEntry[]; extraData: ExportExtraEntry[] } {
  const ficha: ExportFichaEntry[] = [];
  const extraData: ExportExtraEntry[] = [];
  if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) {
    return { ficha, extraData };
  }
  for (const [key, raw] of Object.entries(attributes as Record<string, unknown>)) {
    if (ML_ATTRIBUTE_KEY.test(key)) {
      const value = attributeDisplayValue(raw);
      if (value) ficha.push({ id: key, name: names.get(key) ?? null, value });
    } else {
      const value = scalarText(raw);
      if (value) extraData.push({ key, value });
    }
  }
  return { ficha, extraData };
}

/** Compara ignorando espaços e maiúsculas ("1P2 CX4" ≡ "1P2CX4"). */
function sameLocationText(a: string, b: string): boolean {
  const key = (s: string) => s.replace(/\s+/g, "").toUpperCase();
  return key(a) === key(b);
}

function positionsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter(Boolean);
}

function scrapLabel(scrap: ExportSourceRow["scrap"]): string | null {
  if (!scrap) return null;
  const vehicle = [scrap.brand, scrap.model, scrap.year]
    .map((s) => (s ?? "").trim())
    .filter(Boolean)
    .join(" ");
  const nickname = clean(scrap.nickname);
  if (nickname && vehicle) return `${nickname} (${vehicle})`;
  return nickname ?? (vehicle || null);
}

export function toExportProduct(
  row: ExportSourceRow,
  pathOf: (locationId: string) => string,
  attributeNames: ReadonlyMap<string, string>,
  legacyPathOf?: (locationId: string) => string,
): ExportProduct {
  // Mesma precedência da tela (products-list-view / product-card):
  // caminho completo → código da localização → texto livre.
  const typed = clean(row.location);
  const code = clean(row.productLocation?.code);
  const fullPath = row.locationId ? clean(pathOf(row.locationId)) : null;
  const shown = fullPath ?? code ?? typed;
  // Mover/vincular peça grava em `location` o caminho montado do jeito antigo
  // (com trechos repetidos quando o código já é caminho). É o mesmo lugar,
  // não algo que o operador digitou.
  const legacyPath =
    row.locationId && legacyPathOf ? clean(legacyPathOf(row.locationId)) : null;
  const typedDiffers =
    typed !== null &&
    shown !== null &&
    !sameLocationText(typed, shown) &&
    !(code !== null && sameLocationText(typed, code)) &&
    !(legacyPath !== null && sameLocationText(typed, legacyPath));

  const listings: ExportListing[] = (row.listings ?? [])
    .map((l) => {
      const id = clean(l.externalListingId);
      return {
        platform: l.marketplaceAccount?.platform ?? "",
        accountName: clean(l.marketplaceAccount?.accountName),
        // Linha de erro/pendente guarda id provisório (PENDING_…), não anúncio.
        externalListingId: id && !/^PENDING/i.test(id) ? id : null,
        status: clean(l.status),
        permalink: clean(l.permalink),
      };
    })
    .sort(
      (a, b) =>
        a.platform.localeCompare(b.platform) ||
        (a.accountName ?? "").localeCompare(b.accountName ?? ""),
    );

  const { ficha, extraData } = splitAttributes(row.attributes, attributeNames);

  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    description: row.description ?? null,
    price: toNumber(row.price),
    costPrice: toNumber(row.costPrice),
    markup: toNumber(row.markup),
    stock: row.stock ?? 0,
    reservedStock: row.reservedStock ?? 0,
    brand: row.brand ?? null,
    model: row.model ?? null,
    year: row.year ?? null,
    version: row.version ?? null,
    category: row.category ?? null,
    partNumber: row.partNumber ?? null,
    quality: row.quality ?? null,
    heightCm: row.heightCm ?? null,
    widthCm: row.widthCm ?? null,
    lengthCm: row.lengthCm ?? null,
    weightKg: toNumber(row.weightKg),
    imageUrl: row.imageUrl ?? null,
    imageUrls: Array.isArray(row.imageUrls) ? row.imageUrls : [],
    isSecurityItem: Boolean(row.isSecurityItem),
    isTraceable: Boolean(row.isTraceable),
    sourceVehicle: row.sourceVehicle ?? null,
    location: {
      path: shown,
      description: clean(row.productLocation?.description),
      typedText: typedDiffers ? typed : null,
    },
    mlCategory: {
      code: clean(row.mlCategory?.externalId),
      path: clean(row.mlCategory?.fullPath),
    },
    shopeeCategoryId: clean(row.shopeeCategoryId),
    magaluCategoryId: clean(row.magaluCategoryId),
    olxCategoryId: clean(row.olxCategoryId),
    fbCategoryId: clean(row.fbCategoryId),
    compatibilities: (row.compatibilities ?? []).map((c) => ({
      brand: c.brand,
      model: c.model,
      version: clean(c.version),
      yearFrom: c.yearFrom ?? null,
      yearTo: c.yearTo ?? null,
    })),
    compatibilityPositions: positionsOf(row.compatibilityPositions),
    ficha,
    extraData,
    listings,
    scrap: scrapLabel(row.scrap),
    createdByName: clean(row.createdBy?.name),
    originPlatform: row.originPlatform ?? null,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

// ── Nomes dos campos da ficha (cache de atributos do ML) ────────────────────

const NAMES_TTL_MS = 6 * 60 * 60 * 1000;
const NAMES_RETRY_MS = 5 * 60 * 1000;
let namesCache: { map: Map<string, string>; expiresAt: number } | null = null;
let namesInflight: Promise<Map<string, string>> | null = null;

/**
 * `id do atributo → nome` ("COLOR" → "Cor"), a partir do cache de atributos
 * por categoria que o anúncio já mantém (MLCategoryAttributeCache). Quando o
 * mesmo id tem nomes diferentes entre categorias ("Marca", "Marca do
 * produto"…), fica o mais curto. Montado no banco (0,5 s, ~3 mil linhas) e
 * guardado em memória por 6 h. Falha ⇒ mapa vazio: a planilha sai com o id.
 */
export async function getMlAttributeNames(
  now: number = Date.now(),
): Promise<ReadonlyMap<string, string>> {
  if (namesCache && namesCache.expiresAt > now) return namesCache.map;
  if (namesInflight) return namesInflight;
  namesInflight = (async () => {
    try {
      const rows = await prisma.$queryRaw<Array<{ id: string; name: string }>>`
        SELECT DISTINCT ON (a->>'id') a->>'id' AS id, a->>'name' AS name
        FROM "MLCategoryAttributeCache" c,
             LATERAL jsonb_array_elements(
               CASE WHEN jsonb_typeof(c.attributes::jsonb) = 'array'
                    THEN c.attributes::jsonb ELSE '[]'::jsonb END
             ) a
        WHERE coalesce(a->>'id', '') <> '' AND coalesce(a->>'name', '') <> ''
        ORDER BY a->>'id', length(a->>'name'), a->>'name'
      `;
      const map = new Map(rows.map((r) => [r.id, r.name]));
      namesCache = { map, expiresAt: now + NAMES_TTL_MS };
      return map;
    } catch (err) {
      console.warn(
        "[product-export] nomes da ficha indisponíveis:",
        err instanceof Error ? err.message : String(err),
      );
      const map = new Map<string, string>();
      namesCache = { map, expiresAt: now + NAMES_RETRY_MS };
      return map;
    } finally {
      namesInflight = null;
    }
  })();
  return namesInflight;
}

/** Só para testes. */
export function resetMlAttributeNamesCache(): void {
  namesCache = null;
  namesInflight = null;
}

// ── Banco ───────────────────────────────────────────────────────────────────

/**
 * Carrega as localizações dos produtos da página e seus ancestrais (só os
 * necessários — a listagem carrega todas as do cliente a cada página).
 */
async function loadLocationChain(
  userId: string,
  ids: string[],
): Promise<LocationPathNode[]> {
  const nodes = new Map<string, LocationPathNode>();
  let pending = [...new Set(ids)];
  for (let depth = 0; pending.length > 0 && depth < 25; depth++) {
    const rows = await prisma.location.findMany({
      where: { userId, id: { in: pending } },
      select: { id: true, code: true, parentId: true },
    });
    const next = new Set<string>();
    for (const r of rows) {
      nodes.set(r.id, r);
      if (r.parentId && !nodes.has(r.parentId)) next.add(r.parentId);
    }
    pending = [...next].filter((id) => !nodes.has(id));
  }
  return [...nodes.values()];
}

/**
 * A listagem (e portanto a exportação antiga) esconde a categoria de produto
 * com marca+modelo+ano quando ela não é de veículo
 * (`maskCorruptVehicleCategoriesInProducts`, em `listProducts`). A planilha
 * mostra o mesmo que a tela — sem isso a coluna "Categoria" mudaria de valor.
 */
async function maskCategoriesLikeTheList(rows: ExportSourceRow[]): Promise<void> {
  const views = rows.map((r) => ({
    brand: r.brand ?? null,
    model: r.model ?? null,
    year: r.year ?? null,
    category: r.category ?? null,
    // Na listagem `mlCategory` é o externalId (mapPrismaToProduct).
    mlCategory: r.mlCategory?.externalId ?? null,
  }));
  await maskCorruptVehicleCategoriesInProducts(views);
  rows.forEach((r, i) => {
    if (views[i].category == null) r.category = null;
    if (views[i].mlCategory == null) r.mlCategory = null;
  });
}

export async function exportProductsPage(params: {
  userId: string;
  cursor?: string;
  limit: number;
}): Promise<ExportPage> {
  const { userId, cursor, limit } = params;
  const rows = (await prisma.product.findMany({
    where: { userId, ...(cursor ? { id: { gt: cursor } } : {}) },
    orderBy: { id: "asc" },
    take: limit,
    select: EXPORT_SELECT,
  })) as unknown as ExportSourceRow[];

  const total = cursor
    ? undefined
    : await prisma.product.count({ where: { userId } });

  await maskCategoriesLikeTheList(rows);

  const locationIds = rows
    .map((r) => r.locationId)
    .filter((id): id is string => Boolean(id));
  const [chain, names] = await Promise.all([
    locationIds.length ? loadLocationChain(userId, locationIds) : [],
    getMlAttributeNames(),
  ]);
  const pathOf = createLocationPathResolver(chain);
  const legacyPathOf = createLegacyLocationPathResolver(chain);

  return {
    products: rows.map((r) => toExportProduct(r, pathOf, names, legacyPathOf)),
    nextCursor: rows.length === limit ? rows[rows.length - 1].id : null,
    ...(total !== undefined ? { total } : {}),
  };
}
