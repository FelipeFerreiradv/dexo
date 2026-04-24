import {
  MLProductSearchHit,
  MLProductDetails,
  MLProductAttribute,
  MLProductPicture,
} from "../types/ml-api.types";
import { MLCatalogSearchService } from "../services/ml-catalog-search.service";
import { MLApiService } from "../services/ml-api.service";

/**
 * Orquestra o consumo do catálogo público do ML e normaliza para shapes
 * amigáveis ao frontend.
 *
 * Esta camada existe para:
 *   - Isolar o frontend da forma bruta da API do ML
 *   - Facilitar testes (mockamos apenas o service HTTP)
 *   - Concentrar regras de normalização (atributos conhecidos, thumbnails, etc)
 */

export interface CatalogSuggestion {
  catalogProductId: string;
  name: string;
  status: string | null;
  domainId: string | null;
  categoryId: string | null;
  permalink: string | null;
  thumbnailUrl: string | null;
  brand: string | null;
  model: string | null;
}

export interface CatalogCompatibilityHint {
  brand: string;
  model: string;
  yearFrom: number | null;
  yearTo: number | null;
  version: string | null;
}

export interface CatalogProductDetail {
  catalogProductId: string;
  siteId: string | null;
  domainId: string | null;
  categoryId: string | null;
  name: string;
  familyName: string | null;
  permalink: string | null;
  pictures: Array<{ id: string | null; url: string }>;
  /** Ficha técnica no formato consumido pelo form: { [attrId]: { value_id?, value_name? } } */
  attributes: Record<string, { value_id?: string; value_name?: string }>;
  /** Marca/modelo/ano extraídos dos atributos quando disponíveis. */
  brand: string | null;
  model: string | null;
  year: string | null;
  /** Part number (PART_NUMBER | MPN | OEM) quando presente nos atributos. */
  partNumber: string | null;
  /** Sugestão de compatibilidades quando domínio for autopeças veiculares. */
  compatibilities: CatalogCompatibilityHint[];
  /** Snapshot bruto do catalog product para auditoria (opcional). */
  raw: MLProductDetails;
}

function pickThumbnail(pictures?: MLProductPicture[] | null): string | null {
  if (!Array.isArray(pictures)) return null;
  for (const pic of pictures) {
    const url = pic?.secure_url || pic?.url;
    if (typeof url === "string" && url.length > 0) return url;
  }
  return null;
}

function findAttributeValue(
  attrs: MLProductAttribute[] | null | undefined,
  id: string,
): string | null {
  if (!Array.isArray(attrs)) return null;
  for (const a of attrs) {
    if (a?.id !== id) continue;
    const name = a.value_name ?? a.values?.[0]?.name ?? null;
    if (typeof name === "string" && name.trim().length > 0) return name.trim();
  }
  return null;
}

function parseYearToNumber(raw: string | null): number | null {
  if (!raw) return null;
  const match = raw.match(/\b(19|20)\d{2}\b/);
  if (!match) return null;
  const n = parseInt(match[0], 10);
  return Number.isFinite(n) ? n : null;
}

function parseYearRange(raw: string | null): {
  from: number | null;
  to: number | null;
} {
  if (!raw) return { from: null, to: null };
  const matches = Array.from(raw.matchAll(/\b(19|20)\d{2}\b/g))
    .map((m) => parseInt(m[0], 10))
    .filter((n) => Number.isFinite(n));
  if (matches.length === 0) return { from: null, to: null };
  return { from: Math.min(...matches), to: Math.max(...matches) };
}

function normalizeAttributesMap(
  attrs: MLProductAttribute[] | null | undefined,
): Record<string, { value_id?: string; value_name?: string }> {
  const out: Record<string, { value_id?: string; value_name?: string }> = {};
  if (!Array.isArray(attrs)) return out;
  for (const a of attrs) {
    if (!a || typeof a.id !== "string" || a.id.length === 0) continue;
    const valueId = a.value_id ?? a.values?.[0]?.id ?? undefined;
    const valueName = a.value_name ?? a.values?.[0]?.name ?? undefined;
    if (!valueId && !valueName) continue;
    out[a.id] = {
      ...(valueId ? { value_id: valueId } : {}),
      ...(valueName ? { value_name: valueName } : {}),
    };
  }
  return out;
}

/**
 * Extrai sugestão de compatibilidades quando o domínio indicar autopeças
 * veiculares (MLB-*_AUTO_PARTS ou presença de BRAND/MODEL/VEHICLE_YEAR).
 * Retorna no máximo 1 entrada por (brand, model) — os anos viram range.
 */
function extractCompatibilities(
  details: MLProductDetails,
): CatalogCompatibilityHint[] {
  const brand = findAttributeValue(details.attributes, "BRAND");
  const model = findAttributeValue(details.attributes, "MODEL");
  if (!brand || !model) return [];

  const yearRaw = findAttributeValue(details.attributes, "VEHICLE_YEAR");
  const { from, to } = parseYearRange(yearRaw);
  const version =
    findAttributeValue(details.attributes, "TRIM") ||
    findAttributeValue(details.attributes, "SHORT_VERSION") ||
    null;

  return [
    {
      brand,
      model,
      yearFrom: from,
      yearTo: to,
      version,
    },
  ];
}

function normalizeSuggestion(hit: MLProductSearchHit): CatalogSuggestion {
  return {
    catalogProductId: hit.id,
    name: (hit.name ?? "").toString(),
    status: hit.status ?? null,
    domainId: hit.domain_id ?? null,
    categoryId: hit.category_id ?? null,
    permalink: hit.permalink ?? null,
    thumbnailUrl: pickThumbnail(hit.pictures),
    brand: findAttributeValue(hit.attributes, "BRAND"),
    model: findAttributeValue(hit.attributes, "MODEL"),
  };
}

function normalizeDetail(details: MLProductDetails): CatalogProductDetail {
  const pictures = Array.isArray(details.pictures)
    ? details.pictures
        .map((p) => ({
          id: p?.id ?? null,
          url: (p?.secure_url || p?.url || "").toString(),
        }))
        .filter((p) => p.url.length > 0)
    : [];

  const yearRaw = findAttributeValue(details.attributes, "VEHICLE_YEAR");
  const yearNum = parseYearToNumber(yearRaw);

  const partNumber =
    findAttributeValue(details.attributes, "PART_NUMBER") ||
    findAttributeValue(details.attributes, "MPN") ||
    findAttributeValue(details.attributes, "OEM") ||
    findAttributeValue(details.attributes, "SELLER_SKU") ||
    null;

  return {
    catalogProductId: details.catalog_product_id || details.id,
    siteId: details.site_id ?? null,
    domainId: details.domain_id ?? null,
    categoryId: details.category_id ?? null,
    name: (details.name ?? "").toString(),
    familyName: details.family_name ?? null,
    permalink: details.permalink ?? null,
    pictures,
    attributes: normalizeAttributesMap(details.attributes),
    brand: findAttributeValue(details.attributes, "BRAND"),
    model: findAttributeValue(details.attributes, "MODEL"),
    year: yearNum != null ? String(yearNum) : yearRaw,
    partNumber,
    compatibilities: extractCompatibilities(details),
    raw: details,
  };
}

export interface ListSuggestionsOptions {
  categoryId?: string;
  limit?: number;
  siteId?: string;
}

// Cache para o fallback domain_discovery. Muitos catalog products do ML não
// devolvem `category_id`; consultamos o discovery por nome. Como usuários
// exploram vários catálogos similares na mesma sessão (ex.: 3 variantes de
// reservatório), cachear a resolução economiza round-trips.
const DOMAIN_DISCOVERY_TTL_MS = 15 * 60 * 1000;
const domainDiscoveryCache = new Map<
  string,
  { categoryId: string | null; exp: number }
>();

function domainDiscoveryCacheKey(siteId: string, name: string): string {
  return `${siteId}|${name.trim().toLowerCase().replace(/\s+/g, " ")}`;
}

/** Test-only: limpa o cache do domain_discovery. */
export function __resetDomainDiscoveryCacheForTests(): void {
  domainDiscoveryCache.clear();
}

export class MLCatalogSuggestionUseCase {
  static async listSuggestions(
    q: string,
    opts: ListSuggestionsOptions = {},
  ): Promise<CatalogSuggestion[]> {
    const hits = await MLCatalogSearchService.searchCatalogSuggestions(q, {
      siteId: opts.siteId,
      categoryId: opts.categoryId,
      limit: opts.limit,
      status: "active",
    });
    return hits.map(normalizeSuggestion);
  }

  static async getProductDetail(
    catalogProductId: string,
  ): Promise<CatalogProductDetail | null> {
    const details =
      await MLCatalogSearchService.getCatalogProduct(catalogProductId);
    if (!details) return null;
    const normalized = normalizeDetail(details);

    // Muitos catalog products do ML não devolvem `category_id` em
    // GET /products/{id} — só `domain_id`. Nesses casos, fazemos uma
    // chamada auxiliar a domain_discovery pelo nome do catálogo para
    // ter um category_id aproveitável no form. Falha é silenciosa.
    // Cache em memória (15min) poupa requests quando o usuário explora
    // vários catálogos com nomes similares na mesma sessão.
    if (!normalized.categoryId && normalized.name) {
      const siteId = (normalized.siteId || "MLB").slice(0, 3);
      const cacheKey = domainDiscoveryCacheKey(siteId, normalized.name);
      const cached = domainDiscoveryCache.get(cacheKey);
      const now = Date.now();
      if (cached && cached.exp > now) {
        if (cached.categoryId) normalized.categoryId = cached.categoryId;
      } else {
        try {
          const suggested = await MLApiService.suggestCategoryId(
            siteId,
            normalized.name,
          );
          domainDiscoveryCache.set(cacheKey, {
            categoryId: suggested ?? null,
            exp: now + DOMAIN_DISCOVERY_TTL_MS,
          });
          if (suggested) normalized.categoryId = suggested;
        } catch {
          // fail-open: não cacheamos erro para permitir retry na próxima chamada.
        }
      }
    }

    return normalized;
  }
}

// Exportações auxiliares para testes (normalizadores puros).
export const __testables = {
  normalizeSuggestion,
  normalizeDetail,
  extractCompatibilities,
  parseYearRange,
};
