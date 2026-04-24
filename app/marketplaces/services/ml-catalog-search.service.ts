import axios from "axios";
import { ML_CONSTANTS } from "../mercado-livre/ml-constants";
import {
  MLProductSearchResponse,
  MLProductSearchHit,
  MLProductDetails,
} from "../types/ml-api.types";

/**
 * Cliente para o catálogo público do Mercado Livre.
 * Endpoints cobertos (documentação oficial:
 * https://developers.mercadolivre.com.br/pt_br/guia-para-produtos):
 *   - GET /products/search   (busca por texto)
 *   - GET /products/{id}     (detalhes de um catalog product)
 *
 * Ambos aceitam app access token (client_credentials). Usuário logado não é
 * necessário para descobrir catalog products — apenas para publicar depois.
 */

const DEFAULT_SITE_ID = "MLB";
const DEFAULT_SEARCH_LIMIT = 5;
const MAX_SEARCH_LIMIT = 20;
const SEARCH_TIMEOUT_MS = 6000;
const DETAIL_TIMEOUT_MS = 7000;

type CacheEntry<T> = { data: T; exp: number };
const TTL_MS = 5 * 60 * 1000;
const searchCache = new Map<string, CacheEntry<MLProductSearchHit[]>>();
const detailCache = new Map<string, CacheEntry<MLProductDetails>>();

function now(): number {
  return Date.now();
}

function cacheGet<T>(map: Map<string, CacheEntry<T>>, key: string): T | null {
  const entry = map.get(key);
  if (!entry) return null;
  if (entry.exp <= now()) {
    map.delete(key);
    return null;
  }
  return entry.data;
}

function cacheSet<T>(map: Map<string, CacheEntry<T>>, key: string, data: T): void {
  map.set(key, { data, exp: now() + TTL_MS });
}

/** Test-only: limpa os caches locais. */
export function __resetCatalogSearchCacheForTests(): void {
  searchCache.clear();
  detailCache.clear();
}

function normalizeQuery(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, " ");
}

function buildSearchCacheKey(opts: {
  q: string;
  siteId: string;
  categoryId?: string;
  limit: number;
  status?: string;
}): string {
  return [
    opts.siteId,
    normalizeQuery(opts.q),
    opts.categoryId ?? "",
    opts.status ?? "",
    String(opts.limit),
  ].join("|");
}

async function getAppAccessToken(): Promise<string | null> {
  const clientId = process.env.ML_CLIENT_ID;
  const clientSecret = process.env.ML_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  try {
    const resp = await axios.post(
      `${ML_CONSTANTS.API_URL}/oauth/token`,
      new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
    );
    const token = resp.data?.access_token as string | undefined;
    return token ?? null;
  } catch (err) {
    console.warn(
      "[ML Catalog] Não foi possível obter app access token:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

export interface CatalogSuggestionOptions {
  siteId?: string;
  categoryId?: string;
  limit?: number;
  status?: "active";
}

export class MLCatalogSearchService {
  /**
   * Busca sugestões de catálogo por texto livre (título do produto).
   * Retorna array (possivelmente vazio). Falha de API é tratada como "sem
   * sugestões" — nunca lança, para não interromper o fluxo de criação.
   */
  static async searchCatalogSuggestions(
    q: string,
    opts: CatalogSuggestionOptions = {},
  ): Promise<MLProductSearchHit[]> {
    const query = (q ?? "").trim();
    if (query.length < 3) return [];

    const siteId = opts.siteId || DEFAULT_SITE_ID;
    const limit = Math.min(
      Math.max(1, opts.limit ?? DEFAULT_SEARCH_LIMIT),
      MAX_SEARCH_LIMIT,
    );
    const cacheKey = buildSearchCacheKey({
      q: query,
      siteId,
      categoryId: opts.categoryId,
      limit,
      status: opts.status,
    });
    const cached = cacheGet(searchCache, cacheKey);
    if (cached) return cached;

    const token = await getAppAccessToken();

    try {
      const url = new URL("/products/search", ML_CONSTANTS.API_URL);
      url.searchParams.set("site_id", siteId);
      url.searchParams.set("q", query);
      url.searchParams.set("limit", String(limit));
      if (opts.categoryId) {
        url.searchParams.set("category_id", opts.categoryId);
      }
      if (opts.status) {
        url.searchParams.set("status", opts.status);
      }

      const resp = await axios.get<MLProductSearchResponse>(url.toString(), {
        timeout: SEARCH_TIMEOUT_MS,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });

      const results = Array.isArray(resp.data?.results)
        ? (resp.data.results as MLProductSearchHit[]).filter(
            (hit): hit is MLProductSearchHit =>
              !!hit && typeof hit.id === "string" && hit.id.length > 0,
          )
        : [];

      cacheSet(searchCache, cacheKey, results);
      return results;
    } catch (err) {
      console.warn(
        "[ML Catalog] searchCatalogSuggestions falhou — retornando []:",
        err instanceof Error ? err.message : String(err),
      );
      return [];
    }
  }

  /**
   * Busca detalhes de um catalog product por id.
   * Retorna null quando o id não existe ou quando a API falha.
   */
  static async getCatalogProduct(
    catalogProductId: string,
  ): Promise<MLProductDetails | null> {
    const id = (catalogProductId ?? "").trim();
    if (!id) return null;

    const cached = cacheGet(detailCache, id);
    if (cached) return cached;

    const token = await getAppAccessToken();

    try {
      const url = new URL(
        `/products/${encodeURIComponent(id)}`,
        ML_CONSTANTS.API_URL,
      );
      const resp = await axios.get<MLProductDetails>(url.toString(), {
        timeout: DETAIL_TIMEOUT_MS,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });

      if (!resp.data || typeof resp.data.id !== "string") return null;
      cacheSet(detailCache, id, resp.data);
      return resp.data;
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 404) {
        return null;
      }
      console.warn(
        `[ML Catalog] getCatalogProduct(${id}) falhou:`,
        err instanceof Error ? err.message : String(err),
      );
      return null;
    }
  }
}
