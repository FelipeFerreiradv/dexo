import axios from "axios";
import { ML_CONSTANTS } from "../mercado-livre/ml-constants";
import {
  MLItemsSearchResponse,
  MLItemDetails,
  MLMultigetResponse,
  MLItemUpdatePayload,
  MLItemCreatePayload,
  MLCatalogDomainResponse,
  MLCatalogDomainAttribute,
  MLCatalogCompatibilityChunkResponse,
  MLCatalogCompatibilityProduct,
  MLCatalogProductAttribute,
  MLCompatibilityBrandOption,
  MLCompatibilityModelOption,
  MLCompatibilityVehicleOption,
} from "../types/ml-api.types";
import {
  MLOrderDetails,
  MLOrdersSearchResponse,
  MLOrdersSearchParams,
  MLOrderStatus,
} from "../types/ml-order.types";

export const ML_COMPAT_DOMAIN_ID = "MLB-CARS_AND_VANS";

const ML_ATTR = {
  BRAND: "BRAND",
  MODEL: "MODEL",
  VEHICLE_YEAR: "VEHICLE_YEAR",
  SHORT_VERSION: "SHORT_VERSION",
  ENGINE: "ENGINE",
  TRIM: "TRIM",
} as const;

/**
 * Compõe a versão canônica do veículo seguindo a regra do ML:
 *   1) se TRIM estiver presente, usa-o integralmente;
 *   2) caso contrário, concatena SHORT_VERSION + ENGINE evitando duplicidade
 *      (se o motor já aparece no short_version, não repete).
 * Pura, exportada para testes.
 */
export function composeCanonicalVersion(input: {
  trim?: string | null;
  shortVersion?: string | null;
  engine?: string | null;
}): string {
  const trim = (input.trim ?? "").trim();
  if (trim) return trim;

  const sv = (input.shortVersion ?? "").trim();
  const eng = (input.engine ?? "").trim();

  if (sv && eng) {
    const svNorm = sv.toLowerCase().replace(/\s+/g, " ");
    const engNorm = eng.toLowerCase().replace(/\s+/g, " ");
    if (svNorm.includes(engNorm)) return sv;
    return `${sv} ${eng}`.replace(/\s+/g, " ").trim();
  }
  return sv || eng || "";
}

/** Extrai o primeiro atributo pelo id, tolerando ausência. */
function findProductAttribute(
  product: MLCatalogCompatibilityProduct,
  id: string,
): MLCatalogProductAttribute | undefined {
  const attrs = product.attributes;
  if (!attrs || attrs.length === 0) return undefined;
  return attrs.find((a) => a?.id === id);
}

function firstAttrValue(
  attr: MLCatalogProductAttribute | undefined,
): { id: string | null; name: string | null } {
  if (!attr) return { id: null, name: null };
  if (attr.value_id || attr.value_name) {
    return { id: attr.value_id ?? null, name: attr.value_name ?? null };
  }
  const first = attr.values?.[0];
  if (first) {
    return { id: first.id ?? null, name: first.name ?? null };
  }
  return { id: null, name: null };
}

function parseYearFromAttr(name: string | null): number | null {
  if (!name) return null;
  const match = name.match(/\b(19|20)\d{2}\b/);
  if (!match) return null;
  const n = parseInt(match[0], 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Converte um catalog product em uma opção normalizada de veículo.
 * Ausências são toleradas — retorna null quando faltam brand/model.
 */
export function mapCatalogProductToVehicle(
  product: MLCatalogCompatibilityProduct,
): MLCompatibilityVehicleOption | null {
  const brandAttr = findProductAttribute(product, ML_ATTR.BRAND);
  const modelAttr = findProductAttribute(product, ML_ATTR.MODEL);
  const yearAttr = findProductAttribute(product, ML_ATTR.VEHICLE_YEAR);
  const shortVersionAttr = findProductAttribute(product, ML_ATTR.SHORT_VERSION);
  const engineAttr = findProductAttribute(product, ML_ATTR.ENGINE);
  const trimAttr = findProductAttribute(product, ML_ATTR.TRIM);

  const brand = firstAttrValue(brandAttr);
  const model = firstAttrValue(modelAttr);
  if (!brand.name || !model.name) return null;

  const year = parseYearFromAttr(firstAttrValue(yearAttr).name);
  const version = composeCanonicalVersion({
    trim: firstAttrValue(trimAttr).name,
    shortVersion: firstAttrValue(shortVersionAttr).name,
    engine: firstAttrValue(engineAttr).name,
  });

  const key =
    product.id ||
    `${brand.id ?? brand.name}|${model.id ?? model.name}|${year ?? ""}|${version}`;

  const labelParts: string[] = [];
  if (year) labelParts.push(String(year));
  if (version) labelParts.push(version);

  return {
    key,
    brand: brand.name,
    brandValueId: brand.id ?? "",
    model: model.name,
    modelValueId: model.id ?? "",
    year,
    version,
    label: labelParts.join(" ") || model.name,
  };
}

/** Cache global leve (TTL) para dados públicos do catálogo do ML. */
type CompatCacheEntry<T> = { data: T; exp: number };
const COMPAT_CACHE_TTL_MS = 10 * 60 * 1000;
const compatCache = new Map<string, CompatCacheEntry<unknown>>();

function compatCacheGet<T>(key: string): T | null {
  const entry = compatCache.get(key);
  if (!entry) return null;
  if (entry.exp <= Date.now()) {
    compatCache.delete(key);
    return null;
  }
  return entry.data as T;
}

function compatCacheSet<T>(key: string, data: T): void {
  compatCache.set(key, { data, exp: Date.now() + COMPAT_CACHE_TTL_MS });
}

/**
 * Cliente para API do Mercado Livre
 * ResponsÃ¡vel por:
 * 1. Listar items do vendedor
 * 2. Obter detalhes de items
 * 3. Atualizar estoque e preÃ§o
 */
export class MLApiService {
  // cache simples para app access token obtido via client_credentials
  private static appToken: { token: string; exp: number } | null = null;

  private static formatAxiosError(prefix: string, error: unknown): string {
    if (!axios.isAxiosError(error)) {
      return `${prefix}: ${error instanceof Error ? error.message : String(error)}`;
    }

    const responseData = error.response?.data as
      | {
          message?: string;
          cause?: Array<{ code?: string; message?: string }>;
        }
      | undefined;
    const baseMessage = responseData?.message || error.message;
    const causeMessage = Array.isArray(responseData?.cause)
      ? responseData.cause
          .map((cause) => {
            const code = cause?.code?.trim();
            const message = cause?.message?.trim();
            if (code && message) return `${code}: ${message}`;
            return code || message || "";
          })
          .filter(Boolean)
          .join(" | ")
      : "";

    return causeMessage
      ? `${prefix}: ${baseMessage} (${causeMessage})`
      : `${prefix}: ${baseMessage}`;
  }

  private static async getAppAccessToken(): Promise<string | null> {
    const now = Date.now();
    if (this.appToken && this.appToken.exp > now + 10_000) {
      return this.appToken.token;
    }

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
      const expiresIn = Number(resp.data?.expires_in || 1800) * 1000;
      if (token) {
        this.appToken = { token, exp: now + expiresIn };
        return token;
      }
    } catch (err) {
      console.warn("[ML API] Não foi possível obter app access token:", err);
    }

    return null;
  }
  /**
   * Lista todos os IDs de items de um vendedor
   * @param accessToken Token de acesso OAuth
   * @param sellerId ID do vendedor no ML
   * @param status Filtro por status (ignorado na query para evitar cap de offset do ML)
   * @param maxItems Limite mÃ¡ximo de IDs a buscar (opcional, sem limite por padrÃ£o)
   */
  static async getSellerItemIds(
    accessToken: string,
    sellerId: string,
    _status: "active" | "paused" | "closed" = "active", // Status filtrado depois nos detalhes
    maxItems?: number, // Sem limite por padrão
  ): Promise<string[]> {
    const allItemIds: string[] = [];
    const limit = 50; // ML aceita no mÃ¡ximo 50 por página
    let scrollId: string | undefined;

    try {
      while (true) {
        const url = new URL(
          `/users/${sellerId}/items/search`,
          ML_CONSTANTS.API_URL,
        );
        url.searchParams.set("limit", limit.toString());
        url.searchParams.set("search_type", "scan"); // scan/scroll para percorrer >1000 resultados
        if (scrollId) {
          url.searchParams.set("scroll_id", scrollId);
        }

        const response = await axios.get<MLItemsSearchResponse>(
          url.toString(),
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
            },
            timeout: 10000, // 10 segundos de timeout por requisiÃ§Ã£o
          },
        );

        const batchIds = response.data.results || [];
        if (batchIds.length === 0) {
          break;
        }

        for (const id of batchIds) {
          allItemIds.push(id);
          if (maxItems && allItemIds.length >= maxItems) {
            break;
          }
        }

        if (maxItems && allItemIds.length >= maxItems) {
          break;
        }

        scrollId = response.data.scroll_id || scrollId;

        // Se o ML não retornar scroll_id, evitamos loop infinito
        if (!scrollId) {
          break;
        }

        // Pequena pausa para evitar rate limiting
        await new Promise((resolve) => setTimeout(resolve, 120));
      }

      console.log(
        `[ML API] Fetched ${allItemIds.length} item IDs via scan (status filtrado depois)`,
      );
      return allItemIds;
    } catch (error) {
      console.error(
        `[ML API] Error fetching IDs (scroll_id=${scrollId ?? "start"}):`,
        error,
      );
      if (axios.isAxiosError(error)) {
        throw new Error(
          `Erro ao buscar items do vendedor: ${error.response?.data?.message || error.message}`,
        );
      }
      throw error;
    }
  }

  /**
   * ObtÃ©m detalhes de mÃºltiplos items (mÃ¡ximo 20 por chamada)
   * @param accessToken Token de acesso OAuth
   * @param itemIds Array de IDs de items
   * @param maxItems Limite opcional de itens a processar
   */
  static async getItemsDetails(
    accessToken: string,
    itemIds: string[],
    maxItems?: number,
  ): Promise<MLItemDetails[]> {
    if (itemIds.length === 0) return [];

    // Limitar nÃºmero de itens se especificado
    const idsToProcess = maxItems ? itemIds.slice(0, maxItems) : itemIds;
    console.log(`[ML API] Processing ${idsToProcess.length} items`);

    // API permite mÃ¡ximo 20 items por chamada
    const chunks: string[][] = [];
    for (let i = 0; i < idsToProcess.length; i += 20) {
      chunks.push(idsToProcess.slice(i, i + 20));
    }

    console.log(
      `[ML API] Will make ${chunks.length} requests for item details`,
    );

    const allItems: MLItemDetails[] = [];

    // Limitar concorrência para acelerar sem estourar rate limits
    const maxConcurrent = Math.min(4, chunks.length);
    let nextIndex = 0;

    const worker = async () => {
      while (true) {
        const current = nextIndex++;
        if (current >= chunks.length) break;

        const chunk = chunks[current];
        const url = `${ML_CONSTANTS.API_URL}/items?ids=${chunk.join(",")}`;

        try {
          const response = await axios.get<MLMultigetResponse[]>(url, {
            headers: {
              Authorization: `Bearer ${accessToken}`,
            },
          });

          for (const item of response.data) {
            if (item.code === 200) {
              allItems.push(item.body);
            }
          }
        } catch (error) {
          console.error(`[ML API] Error fetching item details chunk ${current}:`, error);
          if (axios.isAxiosError(error)) {
            throw new Error(
              `Erro ao obter detalhes dos items: ${error.response?.data?.message || error.message}`,
            );
          }
          throw error;
        }

        // Pausa leve entre requisições do mesmo worker para suavizar burst
        if (current + maxConcurrent < chunks.length) {
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
      }
    };

    try {
      await Promise.all(Array.from({ length: maxConcurrent }, worker));
      console.log(`[ML API] Fetched ${allItems.length} item details`);
      return allItems;
    } catch (error) {
      throw error;
    }
  }

  /**
   * ObtÃ©m detalhes de um Ãºnico item
   * @param accessToken Token de acesso OAuth
   * @param itemId ID do item
   */
  static async getItemDetails(
    accessToken: string,
    itemId: string,
  ): Promise<MLItemDetails> {
    try {
      const response = await axios.get<MLItemDetails>(
        `${ML_CONSTANTS.API_URL}/items/${itemId}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        },
      );

      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        throw new Error(
          `Erro ao obter detalhes do item: ${error.response?.data?.message || error.message}`,
        );
      }
      throw error;
    }
  }

  /**
   * Lista categorias de um site (ex: 'MLB') - endpoint pÃºblico
   */
  static async getSiteCategories(
    siteId: string,
    accessToken?: string,
  ): Promise<{ id: string; name: string }[]> {
    try {
      const headers = accessToken
        ? { Authorization: `Bearer ${accessToken}` }
        : undefined;

      const response = await axios.get(
        `${ML_CONSTANTS.API_URL}/sites/${siteId}/categories`,
        {
          headers,
          timeout: 10000,
        },
      );
      return response.data as { id: string; name: string }[];
    } catch (error) {
      // Se o token for inválido, tentar novamente com app token ou sem Authorization
      if (
        axios.isAxiosError(error) &&
        (error.response?.status === 401 || error.response?.status === 403)
      ) {
        console.warn(
          `[ML API] Token inválido para listar categorias; tentando com app token / sem Authorization...`,
        );

        // 1) app token via client_credentials (se disponível)
        const appToken = await this.getAppAccessToken();
        if (appToken) {
          try {
            const withApp = await axios.get(
              `${ML_CONSTANTS.API_URL}/sites/${siteId}/categories`,
              {
                headers: { Authorization: `Bearer ${appToken}` },
                timeout: 10000,
              },
            );
            return withApp.data as { id: string; name: string }[];
          } catch (appErr) {
            console.warn(
              "[ML API] App token também falhou, tentando sem Authorization...",
              appErr instanceof Error ? appErr.message : appErr,
            );
          }
        }

        // 2) último fallback: sem Authorization
        const retry = await axios.get(
          `${ML_CONSTANTS.API_URL}/sites/${siteId}/categories`,
          { timeout: 10000 },
        );
        return retry.data as { id: string; name: string }[];
      }

      console.error(
        `[ML API] Error fetching site categories for ${siteId}:`,
        error,
      );
      if (axios.isAxiosError(error)) {
        throw new Error(
          `Erro ao obter categorias do site: ${error.response?.data?.message || error.message}`,
        );
      }
      throw error;
    }
  }

  /**
   * ObtÃ©m detalhes de uma categoria (inclui path_from_root)
   */
  static async getCategory(categoryId: string): Promise<any> {
    try {
      const response = await axios.get(
        `${ML_CONSTANTS.API_URL}/categories/${categoryId}`,
        { timeout: 1000 },
      );
      return response.data;
    } catch (error) {
      // Tentar com app token se 401/403
      if (
        axios.isAxiosError(error) &&
        (error.response?.status === 401 || error.response?.status === 403)
      ) {
        try {
          const appToken = await this.getAppAccessToken();
          if (appToken) {
            const retry = await axios.get(
              `${ML_CONSTANTS.API_URL}/categories/${categoryId}`,
              {
                headers: { Authorization: `Bearer ${appToken}` },
                timeout: 1000,
              },
            );
            return retry.data;
          }
        } catch (appErr) {
          console.warn(
            `[ML API] getCategory fallback with app token failed for ${categoryId}:`,
            appErr instanceof Error ? appErr.message : appErr,
          );
        }
      }

      console.error(`[ML API] Error fetching category ${categoryId}:`, error);
      if (axios.isAxiosError(error)) {
        throw new Error(
          `Erro ao obter dados da categoria: ${error.response?.data?.message || error.message}`,
        );
      }
      throw error;
    }
  }

  /**
   * Busca atributos de uma categoria ML. Usado para descobrir campos obrigatórios
   * antes de montar payload de criação (PART_NUMBER, MPN, family_name, etc).
   */
  static async getCategoryAttributes(categoryId: string): Promise<any[]> {
    const url = `${ML_CONSTANTS.API_URL}/categories/${categoryId}/attributes`;
    try {
      const res = await axios.get(url, { timeout: 5000 });
      return Array.isArray(res.data) ? res.data : [];
    } catch (error) {
      if (
        axios.isAxiosError(error) &&
        (error.response?.status === 401 || error.response?.status === 403)
      ) {
        try {
          const appToken = await this.getAppAccessToken();
          if (appToken) {
            const retry = await axios.get(url, {
              headers: { Authorization: `Bearer ${appToken}` },
              timeout: 5000,
            });
            return Array.isArray(retry.data) ? retry.data : [];
          }
        } catch (appErr) {
          console.warn(
            `[ML API] getCategoryAttributes fallback with app token failed for ${categoryId}:`,
            appErr instanceof Error ? appErr.message : appErr,
          );
        }
      }
      if (axios.isAxiosError(error)) {
        throw new Error(
          `Erro ao obter atributos da categoria ${categoryId}: ${error.response?.data?.message || error.message}`,
        );
      }
      throw error;
    }
  }

  /**
   * ObtÃ©m visitas totais de uma lista de itens
   * Endpoint: /visits/items?ids={ids}
   */
  static async getItemsVisits(
    accessToken: string,
    itemIds: string[],
  ): Promise<Record<string, number>> {
    if (!itemIds.length) return {};
    const result: Record<string, number> = {};

    for (const id of itemIds) {
      const url = `${ML_CONSTANTS.API_URL}/visits/items?ids=${id}`;
      try {
        const res = await axios.get(url, {
          headers: { Authorization: `Bearer ${accessToken}` },
          timeout: 5000,
        });
        const data = res.data as any[];
        const entry = Array.isArray(data) ? data[0] : data;
        const total = entry?.total_visits ?? entry?.total ?? entry?.visits ?? 0;
        result[id] = Number(total) || 0;
      } catch (error) {
        console.error(`[ML API] Error fetching visits for ${id}:`, error);
        // segue para o prÃ³ximo ID
      }
      // Pausa leve para evitar rate limiting
      await new Promise((resolve) => setTimeout(resolve, 120));
    }

    return result;
  }

  /**
   * ObtÃ©m resumo de reviews de um item
   * Endpoint: /reviews/item/{itemId}
   */
  static async getItemReviewSummary(
    accessToken: string,
    itemId: string,
  ): Promise<{ ratingAverage?: number; totalReviews?: number }> {
    const url = `${ML_CONSTANTS.API_URL}/reviews/item/${itemId}`;
    try {
      const res = await axios.get(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const data = res.data as any;
      const ratingAverage = data.rating_average ?? data.rating ?? undefined;
      const totalReviews =
        data.paging?.total ??
        data.reviews_count ??
        (Array.isArray(data.reviews) ? data.reviews.length : undefined);
      return { ratingAverage, totalReviews };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        // Se o item nÃ£o tem reviews, a API pode retornar 404; tratamos como ausÃªncia de dado
        if (error.response?.status === 404) return {};
        throw new Error(
          error.response?.data?.message ||
            error.message ||
            "Erro ao buscar reviews",
        );
      }
      throw error;
    }
  }

  /**
   * Usa o endpoint de domain discovery do ML para sugerir uma categoria
   * com base em um texto (tÃ­tulo + palavras-chave).
   * Retorna o category_id ou null se nÃ£o encontrar.
   */
  static async suggestCategoryId(
    siteId: string,
    query: string,
  ): Promise<string | null> {
    if (!query || !query.trim()) return null;
    try {
      const url = new URL(
        `/sites/${siteId}/domain_discovery/search`,
        ML_CONSTANTS.API_URL,
      );
      url.searchParams.set("limit", "1");
      url.searchParams.set("q", query);

      const resp = await axios.get(url.toString(), {
        timeout: 5000,
      });

      const first = Array.isArray(resp.data) ? resp.data[0] : null;
      if (first?.category_id && typeof first.category_id === "string") {
        return first.category_id;
      }
      return null;
    } catch (err) {
      console.warn(
        "[ML API] domain_discovery failed, will fall back to defaults:",
        err instanceof Error ? err.message : String(err),
      );
      return null;
    }
  }

  /**
   * Busca item por SKU (seller_custom_field ou atributo SELLER_SKU)
   * @param accessToken Token de acesso OAuth
   * @param sellerId ID do vendedor
   * @param sku SKU do produto
   */
  static async findItemBySku(
    accessToken: string,
    sellerId: string,
    sku: string,
  ): Promise<MLItemDetails | null> {
    try {
      // Tentar buscar por seller_custom_field
      const url = new URL(
        `/users/${sellerId}/items/search`,
        ML_CONSTANTS.API_URL,
      );
      url.searchParams.set("sku", sku);

      const response = await axios.get<MLItemsSearchResponse>(url.toString(), {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      if (response.data.results.length === 0) {
        return null;
      }

      // Obter detalhes do primeiro item encontrado
      const itemDetails = await this.getItemDetails(
        accessToken,
        response.data.results[0],
      );

      return itemDetails;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        throw new Error(
          `Erro ao buscar item por SKU: ${error.response?.data?.message || error.message}`,
        );
      }
      throw error;
    }
  }

  /**
   * Atualiza um item no Mercado Livre
   * @param accessToken Token de acesso OAuth
   * @param itemId ID do item
   * @param data Dados para atualizar
   */
  static async updateItem(
    accessToken: string,
    itemId: string,
    data: MLItemUpdatePayload,
  ): Promise<MLItemDetails> {
    try {
      const response = await axios.put<MLItemDetails>(
        `${ML_CONSTANTS.API_URL}/items/${itemId}`,
        data,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
        },
      );

      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        throw new Error(this.formatAxiosError("Erro ao atualizar item", error));
      }
      throw error;
    }
  }

  /**
   * Atualiza apenas o estoque de um item
   * @param accessToken Token de acesso OAuth
   * @param itemId ID do item
   * @param quantity Nova quantidade
   */
  static async updateItemStock(
    accessToken: string,
    itemId: string,
    quantity: number,
  ): Promise<MLItemDetails> {
    return this.updateItem(accessToken, itemId, {
      available_quantity: quantity,
    });
  }

  /**
   * Atualiza apenas o preÃ§o de um item
   * @param accessToken Token de acesso OAuth
   * @param itemId ID do item
   * @param price Novo preÃ§o
   */
  static async updateItemPrice(
    accessToken: string,
    itemId: string,
    price: number,
  ): Promise<MLItemDetails> {
    return this.updateItem(accessToken, itemId, { price });
  }

  /**
   * Cria ou atualiza a descriÃ§Ã£o de um item (endpoint dedicado do ML).
   * Usa POST para criar/replace a descriÃ§Ã£o plain_text.
   */
  static async upsertDescription(
    accessToken: string,
    itemId: string,
    plainText: string,
  ): Promise<void> {
    if (!plainText || !plainText.trim()) return;

    const url = `${ML_CONSTANTS.API_URL}/items/${itemId}/description`;
    const body = { plain_text: plainText };
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    };

    // POST cria; PUT substitui. Alguns domínios retornam validation_error no POST se já houver descrição,
    // então aplicamos fallback para PUT para garantir que a descrição seja gravada.
    try {
      await axios.post(url, body, { headers });
      return;
    } catch (postErr) {
      const isAxios = axios.isAxiosError(postErr);
      const postData = isAxios ? postErr.response?.data : null;
      const status = isAxios ? postErr.response?.status : undefined;

      // Fallback HTML no POST: se plain_text não é permitido, tenta formato HTML
      const postPlainTextNotAllowed =
        postData?.error === "DESCRIPTION_PLAIN_TEXT_NOT_ALLOWED" ||
        postData?.cause === "item.description.type.invalid";
      if (postPlainTextNotAllowed) {
        try {
          await axios.post(url, { text: plainText }, { headers });
          return;
        } catch {
          // Se POST com HTML falhar, cai pro PUT abaixo
        }
      }

      const shouldTryPut =
        isAxios &&
        (status === 400 || status === 403 || status === 404 || status === 409);

      if (!shouldTryPut) {
        throw new Error(
          `Erro ao atualizar descrição (POST): ${
            isAxios && postData
              ? JSON.stringify(postData)
              : postErr instanceof Error
                ? postErr.message
                : String(postErr)
          }`,
        );
      }

      try {
        await axios.put(url, body, { headers });
      } catch (putErr) {
        const putAxios = axios.isAxiosError(putErr);
        const putData = putAxios ? putErr.response?.data : null;
        const isPlainTextNotAllowed =
          putData?.error === "DESCRIPTION_PLAIN_TEXT_NOT_ALLOWED" ||
          putData?.cause === "item.description.type.invalid";

        // Fallback: algumas categorias exigem formato HTML em vez de plain_text
        if (isPlainTextNotAllowed) {
          try {
            const htmlBody = { text: plainText };
            await axios.put(url, htmlBody, { headers });
            return;
          } catch (htmlErr) {
            const htmlAxios = axios.isAxiosError(htmlErr);
            throw new Error(
              `Erro ao atualizar descrição (HTML fallback): ${
                htmlAxios && htmlErr.response?.data
                  ? JSON.stringify(htmlErr.response.data)
                  : htmlErr instanceof Error
                    ? htmlErr.message
                    : String(htmlErr)
              }`,
            );
          }
        }

        throw new Error(
          `Erro ao atualizar descrição (PUT): ${
            putAxios && putErr.response?.data
              ? JSON.stringify(putErr.response.data)
              : putErr instanceof Error
                ? putErr.message
                : String(putErr)
          }`,
        );
      }
    }
  }

  // ====================================================================
  // MÃ‰TODOS DE ORDERS (PEDIDOS)
  // ====================================================================

  /**
   * Busca pedidos de um vendedor com filtros
   * @param accessToken Token de acesso OAuth
   * @param params ParÃ¢metros de busca
   */
  static async getSellerOrders(
    accessToken: string,
    params: MLOrdersSearchParams,
  ): Promise<MLOrdersSearchResponse> {
    try {
      const url = new URL("/orders/search", ML_CONSTANTS.API_URL);

      // ParÃ¢metro obrigatÃ³rio: seller
      url.searchParams.set("seller", params.seller);

      // ParÃ¢metros opcionais
      if (params.status) {
        url.searchParams.set("order.status", params.status);
      }
      if (params.dateCreatedFrom) {
        url.searchParams.set("order.date_created.from", params.dateCreatedFrom);
      }
      if (params.dateCreatedTo) {
        url.searchParams.set("order.date_created.to", params.dateCreatedTo);
      }
      if (params.sort) {
        url.searchParams.set("sort", params.sort);
      }
      if (params.offset !== undefined) {
        url.searchParams.set("offset", params.offset.toString());
      }
      if (params.limit !== undefined) {
        url.searchParams.set("limit", params.limit.toString());
      }
      if (params.tags) {
        url.searchParams.set("tags", params.tags);
      }

      console.log(`[ML API] Fetching orders: ${url.toString()}`);

      const response = await axios.get<MLOrdersSearchResponse>(url.toString(), {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        timeout: 15000,
      });

      console.log(
        `[ML API] Found ${response.data.results.length} orders (total: ${response.data.paging.total})`,
      );

      return response.data;
    } catch (error) {
      console.error("[ML API] Error fetching orders:", error);
      if (axios.isAxiosError(error)) {
        throw new Error(
          `Erro ao buscar pedidos: ${error.response?.data?.message || error.message}`,
        );
      }
      throw error;
    }
  }

  /**
   * Busca todos os pedidos paginados (com limite de seguranÃ§a)
   * @param accessToken Token de acesso OAuth
   * @param sellerId ID do vendedor
   * @param status Status dos pedidos (opcional)
   * @param maxOrders Limite mÃ¡ximo de pedidos a buscar (padrÃ£o: 100)
   */
  static async getAllSellerOrders(
    accessToken: string,
    sellerId: string,
    status?: MLOrderStatus,
    maxOrders: number = 100,
  ): Promise<MLOrderDetails[]> {
    const allOrders: MLOrderDetails[] = [];
    let offset = 0;
    const limit = 50; // ML aceita no mÃ¡ximo 50 por pÃ¡gina

    try {
      while (allOrders.length < maxOrders) {
        const response = await this.getSellerOrders(accessToken, {
          seller: sellerId,
          status,
          offset,
          limit,
          sort: "date_desc", // Mais recentes primeiro
        });

        allOrders.push(...response.results);

        // Verificar se hÃ¡ mais pÃ¡ginas
        if (
          response.results.length < limit ||
          allOrders.length >= response.paging.total
        ) {
          break;
        }

        offset += limit;

        // Pequena pausa para evitar rate limiting
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      // Limitar ao mÃ¡ximo especificado
      return allOrders.slice(0, maxOrders);
    } catch (error) {
      console.error("[ML API] Error fetching all orders:", error);
      throw error;
    }
  }

  /**
   * ObtÃ©m detalhes de um pedido especÃ­fico
   * @param accessToken Token de acesso OAuth
   * @param orderId ID do pedido no ML
   */
  static async getOrderDetails(
    accessToken: string,
    orderId: string,
  ): Promise<MLOrderDetails> {
    try {
      const response = await axios.get<MLOrderDetails>(
        `${ML_CONSTANTS.API_URL}/orders/${orderId}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
          timeout: 10000,
        },
      );

      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        throw new Error(
          `Erro ao obter detalhes do pedido: ${error.response?.data?.message || error.message}`,
        );
      }
      throw error;
    }
  }

  /**
   * Busca pedidos recentes (Ãºltimos N dias)
   * @param accessToken Token de acesso OAuth
   * @param sellerId ID do vendedor
   * @param days NÃºmero de dias para trÃ¡s (padrÃ£o: 7)
   * @param status Status dos pedidos (opcional, padrÃ£o: "paid")
   */
  static async getRecentOrders(
    accessToken: string,
    sellerId: string,
    days: number = 7,
    status: MLOrderStatus = "paid",
  ): Promise<MLOrderDetails[]> {
    const dateFrom = new Date();
    dateFrom.setDate(dateFrom.getDate() - days);

    const allOrders: MLOrderDetails[] = [];
    let offset = 0;
    const limit = 50;
    const maxOrders = 500; // safety cap

    while (allOrders.length < maxOrders) {
      const response = await this.getSellerOrders(accessToken, {
        seller: sellerId,
        status,
        dateCreatedFrom: dateFrom.toISOString(),
        sort: "date_desc",
        limit,
        offset,
      });

      allOrders.push(...response.results);

      if (
        response.results.length < limit ||
        allOrders.length >= response.paging.total
      ) {
        break;
      }

      offset += limit;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return allOrders.slice(0, maxOrders);
  }

  /**
   * Cria um novo item no Mercado Livre
   * @param accessToken Token de acesso OAuth
   * @param payload Dados do item a ser criado
   */
  static async createItem(
    accessToken: string,
    payload: MLItemCreatePayload,
  ): Promise<MLItemDetails> {
    try {
      const response = await axios.post<MLItemDetails>(
        `${ML_CONSTANTS.API_URL}/items`,
        payload,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
        },
      );

      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const errorData = error.response?.data;
        const errorMessage = errorData
          ? JSON.stringify(errorData)
          : error.message;
        const err = new Error(`Erro ao criar item: ${errorMessage}`);
        // attach parsed ML payload for callers to inspect
        (err as any).mlError = errorData || null;
        throw err;
      }
      throw error;
    }
  }

  /**
   * POST /items/{itemId}/compatibilities
   * Anexa uma lista de catalog products (IDs já resolvidos) como compatibilidades
   * do item — preenche a aba "Ficha técnica → Compatibilidades" no ML.
   *
   * O endpoint exige `products: [{id: MLB...}]`; não aceita known_attributes.
   * Faz uma chamada única com o batch inteiro; se falhar, cai para chamadas
   * individuais para maximizar sucesso parcial (um ID ruim não derruba os outros).
   *
   * Nunca lança — erros são reportados via `errors`; o caller decide se é fatal.
   */
  static async setItemCompatibilities(
    accessToken: string,
    itemId: string,
    catalogProductIds: string[],
  ): Promise<{ success: boolean; createdCount: number; errors: string[] }> {
    const errors: string[] = [];
    let createdCount = 0;

    const unique = Array.from(
      new Set(
        (catalogProductIds || []).filter(
          (id): id is string => typeof id === "string" && id.length > 0,
        ),
      ),
    );
    if (unique.length === 0) {
      return { success: false, createdCount: 0, errors: [] };
    }

    const postProducts = async (
      ids: string[],
    ): Promise<{ ok: boolean; error?: string }> => {
      try {
        await axios.post(
          `${ML_CONSTANTS.API_URL}/items/${itemId}/compatibilities`,
          { products: ids.map((id) => ({ id })) },
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
            timeout: 15000,
          },
        );
        return { ok: true };
      } catch (error) {
        const msg = axios.isAxiosError(error)
          ? `${error.response?.status ?? ""} ${JSON.stringify(error.response?.data ?? error.message)}`
          : error instanceof Error
            ? error.message
            : String(error);
        return { ok: false, error: msg };
      }
    };

    // Tentativa 1: batch único.
    const batch = await postProducts(unique);
    if (batch.ok) {
      return { success: true, createdCount: unique.length, errors: [] };
    }

    // Fallback: chamadas individuais — isola qual ID o ML rejeita sem perder
    // os demais.
    for (const id of unique) {
      const single = await postProducts([id]);
      if (single.ok) {
        createdCount += 1;
      } else if (single.error) {
        errors.push(`${id}: ${single.error}`);
      }
    }

    return {
      success: errors.length === 0 && createdCount > 0,
      createdCount,
      errors,
    };
  }

  /**
   * Dado nomes textuais de marca/modelo e (opcionalmente) um range de anos,
   * resolve para catalog product IDs do domínio MLB-CARS_AND_VANS. Reutiliza
   * os caches TTL de brands/models/chunks; o overhead marginal é mínimo em
   * runs consecutivos do mesmo usuário.
   *
   * Retorna uma lista de IDs pronta para `setItemCompatibilities`, mais
   * diagnósticos (marcas/modelos/anos não resolvidos) para logging.
   */
  static async resolveCompatibilityCatalogProducts(
    accessToken: string,
    vehicles: Array<{
      brand: string;
      model: string;
      yearFrom?: number | null;
      yearTo?: number | null;
    }>,
  ): Promise<{
    catalogProductIds: string[];
    unresolved: Array<{
      brand: string;
      model: string;
      year?: number | null;
      reason: string;
    }>;
  }> {
    const catalogProductIds = new Set<string>();
    const unresolved: Array<{
      brand: string;
      model: string;
      year?: number | null;
      reason: string;
    }> = [];

    // Cache leve por chamada para evitar refetch repetido do mesmo par marca/modelo.
    const modelListCache = new Map<string, MLCompatibilityModelOption[]>();
    let brandsCache: MLCompatibilityBrandOption[] | null = null;

    const normalize = (s: string): string =>
      (s || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .trim()
        .toLowerCase();

    const findBrand = async (
      name: string,
    ): Promise<MLCompatibilityBrandOption | null> => {
      if (!brandsCache) {
        brandsCache = await this.listCompatibilityBrands(accessToken);
      }
      const n = normalize(name);
      if (!n) return null;
      return (
        brandsCache.find((b) => normalize(b.name) === n) ??
        brandsCache.find((b) => normalize(b.name).includes(n)) ??
        null
      );
    };

    const findModel = async (
      brand: MLCompatibilityBrandOption,
      name: string,
    ): Promise<MLCompatibilityModelOption | null> => {
      let models = modelListCache.get(brand.valueId);
      if (!models) {
        models = await this.listCompatibilityModels(accessToken, {
          valueId: brand.valueId,
          name: brand.name,
        });
        modelListCache.set(brand.valueId, models);
      }
      const n = normalize(name);
      if (!n) return null;
      return (
        models.find((m) => normalize(m.name) === n) ??
        models.find((m) => normalize(m.name).includes(n)) ??
        null
      );
    };

    for (const compat of vehicles) {
      const brandName = (compat.brand || "").trim();
      const modelName = (compat.model || "").trim();
      if (!brandName || !modelName) {
        unresolved.push({
          brand: brandName,
          model: modelName,
          reason: "missing brand or model",
        });
        continue;
      }

      // Fast path: resolve BRAND/MODEL para value_id via cache do domínio.
      // Fallback: quando a marca não está no catalog_domains (p.ex. BMW, que
      // é truncada nesse endpoint), delegamos o matching por nome ao ML via
      // `open_attributes` — mais resiliente a dialetos/acentos e não depende
      // do endpoint de domínio retornar a marca.
      const brand = await findBrand(brandName);
      const model = brand ? await findModel(brand, modelName) : null;

      // Expande range de anos. Se nenhum ano for informado, busca todos os
      // catalog products para o par marca+modelo (sem filtro de ano).
      const yFrom =
        typeof compat.yearFrom === "number" && compat.yearFrom > 0
          ? compat.yearFrom
          : null;
      const yTo =
        typeof compat.yearTo === "number" && compat.yearTo > 0
          ? compat.yearTo
          : null;
      const years: Array<number | null> = [];
      if (yFrom && yTo) {
        const lo = Math.min(yFrom, yTo);
        const hi = Math.max(yFrom, yTo);
        for (let y = lo; y <= hi; y++) years.push(y);
      } else if (yFrom) {
        years.push(yFrom);
      } else if (yTo) {
        years.push(yTo);
      } else {
        years.push(null);
      }

      for (const year of years) {
        const searchParams: {
          knownAttributes?: Array<{ id: string; value_id: string }>;
          openAttributes?: Array<{ id: string; value_name: string }>;
          limit?: number;
          offset?: number;
        } = {};
        if (brand && model) {
          searchParams.knownAttributes = [
            { id: ML_ATTR.BRAND, value_id: brand.valueId },
            { id: ML_ATTR.MODEL, value_id: model.valueId },
          ];
        } else if (brand) {
          searchParams.knownAttributes = [
            { id: ML_ATTR.BRAND, value_id: brand.valueId },
          ];
          searchParams.openAttributes = [
            { id: ML_ATTR.MODEL, value_name: modelName },
          ];
        } else {
          searchParams.openAttributes = [
            { id: ML_ATTR.BRAND, value_name: brandName },
            { id: ML_ATTR.MODEL, value_name: modelName },
          ];
        }

        try {
          // Paginamos até esgotar para pegar todas as versões do modelo
          // (um par marca/modelo pode ter várias linhas de versão/motorização).
          const pageSize = 50;
          const maxPages = 10;
          let found = 0;
          const normalizedBrand = normalize(brandName);
          const normalizedModel = normalize(modelName);
          for (let page = 0; page < maxPages; page++) {
            const chunk = await this.searchCatalogCompatibilityChunks(
              accessToken,
              {
                ...searchParams,
                limit: pageSize,
                offset: page * pageSize,
              },
            );
            const results = chunk.results ?? [];
            if (results.length === 0) break;
            for (const prod of results) {
              if (!prod?.id) continue;
              // Quando usamos open_attributes, o matching é por nome e o ML
              // pode devolver resultados "próximos". Validamos localmente
              // que marca/modelo batem para evitar falsos positivos.
              if (!brand || !model) {
                const brandAttr = prod.attributes?.find(
                  (a) => a?.id === ML_ATTR.BRAND,
                );
                const modelAttr = prod.attributes?.find(
                  (a) => a?.id === ML_ATTR.MODEL,
                );
                const prodBrand = normalize(
                  brandAttr?.value_name ??
                    brandAttr?.values?.[0]?.name ??
                    "",
                );
                const prodModel = normalize(
                  modelAttr?.value_name ??
                    modelAttr?.values?.[0]?.name ??
                    "",
                );
                if (!brand && prodBrand && prodBrand !== normalizedBrand) {
                  continue;
                }
                if (!model && prodModel && prodModel !== normalizedModel) {
                  continue;
                }
              }
              if (year != null) {
                const yearAttr = prod.attributes?.find(
                  (a) => a?.id === ML_ATTR.VEHICLE_YEAR,
                );
                const y = parseYearFromAttr(
                  yearAttr?.value_name ?? yearAttr?.values?.[0]?.name ?? null,
                );
                if (y !== year) continue;
              }
              catalogProductIds.add(prod.id);
              found += 1;
            }
            const total = chunk.paging?.total;
            if (typeof total === "number" && (page + 1) * pageSize >= total) {
              break;
            }
            if (results.length < pageSize) break;
          }
          if (found === 0) {
            unresolved.push({
              brand: brandName,
              model: modelName,
              year,
              reason: year
                ? `no catalog products for ${year}`
                : "no catalog products for brand+model",
            });
          }
        } catch (err) {
          unresolved.push({
            brand: brandName,
            model: modelName,
            year,
            reason:
              err instanceof Error
                ? `lookup failed: ${err.message}`
                : "lookup failed",
          });
        }
      }
    }

    return {
      catalogProductIds: Array.from(catalogProductIds),
      unresolved,
    };
  }

  /**
   * Detecta o content type real de uma imagem a partir dos magic bytes do buffer.
   * Fallback para extensão do arquivo se os bytes não forem reconhecidos.
   */
  private static detectImageContentType(
    buffer: Buffer,
    fileName: string,
  ): string {
    if (
      buffer.length >= 3 &&
      buffer[0] === 0xff &&
      buffer[1] === 0xd8 &&
      buffer[2] === 0xff
    )
      return "image/jpeg";
    if (
      buffer.length >= 4 &&
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47
    )
      return "image/png";
    if (
      buffer.length >= 3 &&
      buffer[0] === 0x47 &&
      buffer[1] === 0x49 &&
      buffer[2] === 0x46
    )
      return "image/gif";
    if (
      buffer.length >= 12 &&
      buffer[0] === 0x52 &&
      buffer[1] === 0x49 &&
      buffer[2] === 0x46 &&
      buffer[3] === 0x46 &&
      buffer[8] === 0x57 &&
      buffer[9] === 0x45 &&
      buffer[10] === 0x42 &&
      buffer[11] === 0x50
    )
      return "image/webp";

    const ext = fileName.split(".").pop()?.toLowerCase() || "jpg";
    const mimeMap: Record<string, string> = {
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      webp: "image/webp",
      gif: "image/gif",
      bmp: "image/bmp",
    };
    return mimeMap[ext] || "image/jpeg";
  }

  /**
   * Faz upload de uma imagem diretamente para o ML e retorna o picture ID.
   * Usa form.getBuffer() para evitar problemas de serialização do axios 1.x
   * com o pacote form-data (stream vs buffer).
   */
  static async uploadPicture(
    accessToken: string,
    imageBuffer: Buffer,
    fileName: string,
  ): Promise<{ id: string }> {
    const FormData = (await import("form-data")).default;
    const form = new FormData();

    const contentType = this.detectImageContentType(imageBuffer, fileName);

    form.append("file", imageBuffer, {
      filename: fileName,
      contentType,
    });

    // Usar getBuffer() + getHeaders() para enviar bytes raw e evitar que o
    // axios 1.x tente re-serializar o stream do form-data (causa 400 no ML).
    const formBuffer = form.getBuffer();
    const formHeaders = form.getHeaders();

    try {
      const response = await axios.post(
        `${ML_CONSTANTS.API_URL}/pictures/items/upload`,
        formBuffer,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            ...formHeaders,
            "Content-Length": String(formBuffer.length),
          },
          maxContentLength: 10 * 1024 * 1024,
          maxBodyLength: 10 * 1024 * 1024,
        },
      );

      return { id: response.data.id };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const detail = error.response?.data
          ? JSON.stringify(error.response.data)
          : error.message;
        console.error(
          `[ML API] uploadPicture failed (${error.response?.status}): ${detail}`,
        );
        throw new Error(`Erro ao enviar imagem ao ML: ${detail}`);
      }
      throw error;
    }
  }

  /**
   * Faz upload de uma imagem ao ML via source URL (ML baixa a imagem).
   * Retorna o picture ID de forma síncrona (diferente do source no payload do item,
   * que é assíncrono e pode causar image_download_pending).
   */
  // =========================================================================
  // Compatibilidade nativa do Mercado Livre (autopeças)
  // Todos os métodos usam o domínio MLB-CARS_AND_VANS e o endpoint
  // /catalog_compatibilities/products_search/chunks para navegar o catálogo.
  // =========================================================================

  /**
   * GET /catalog_domains/MLB-CARS_AND_VANS
   * Fonte primária da lista de marcas (allowed values do atributo BRAND).
   */
  static async getCarsAndVansDomain(
    accessToken: string,
  ): Promise<MLCatalogDomainResponse> {
    try {
      const response = await axios.get<MLCatalogDomainResponse>(
        `${ML_CONSTANTS.API_URL}/catalog_domains/${ML_COMPAT_DOMAIN_ID}`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          timeout: 15000,
        },
      );
      return response.data;
    } catch (error) {
      throw new Error(
        this.formatAxiosError(
          "[ML Compat] Falha ao consultar catalog_domains",
          error,
        ),
      );
    }
  }

  /**
   * POST /catalog_compatibilities/products_search/chunks
   * Retorna uma página de catalog products filtrada por known_attributes
   * (match por value_id, via cache de brands/models) e/ou open_attributes
   * (match por value_name, delegando o matching ao próprio ML — necessário
   * para marcas que o endpoint /catalog_domains retorna truncado, ex.: BMW).
   */
  static async searchCatalogCompatibilityChunks(
    accessToken: string,
    params: {
      knownAttributes?: Array<{ id: string; value_id: string }>;
      openAttributes?: Array<{ id: string; value_name: string }>;
      limit?: number;
      offset?: number;
    },
  ): Promise<MLCatalogCompatibilityChunkResponse> {
    const body: Record<string, unknown> = {
      domain_id: ML_COMPAT_DOMAIN_ID,
      limit: params.limit ?? 50,
      offset: params.offset ?? 0,
    };
    if (params.knownAttributes && params.knownAttributes.length > 0) {
      body.known_attributes = params.knownAttributes;
    }
    if (params.openAttributes && params.openAttributes.length > 0) {
      body.open_attributes = params.openAttributes;
    }
    try {
      const response = await axios.post<MLCatalogCompatibilityChunkResponse>(
        `${ML_CONSTANTS.API_URL}/catalog_compatibilities/products_search/chunks`,
        body,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          timeout: 20000,
        },
      );
      return response.data ?? {};
    } catch (error) {
      throw new Error(
        this.formatAxiosError(
          "[ML Compat] Falha ao consultar products_search/chunks",
          error,
        ),
      );
    }
  }

  /**
   * Lista marcas do domínio MLB-CARS_AND_VANS na nomenclatura oficial do ML.
   * Cache global TTL — os dados não variam por usuário.
   */
  static async listCompatibilityBrands(
    accessToken: string,
  ): Promise<MLCompatibilityBrandOption[]> {
    const cacheKey = `compat:brands:${ML_COMPAT_DOMAIN_ID}`;
    const cached = compatCacheGet<MLCompatibilityBrandOption[]>(cacheKey);
    if (cached) return cached;

    const domain = await this.getCarsAndVansDomain(accessToken);
    const brandAttr = (domain.attributes ?? []).find(
      (a: MLCatalogDomainAttribute) => a?.id === ML_ATTR.BRAND,
    );
    const values = brandAttr?.values ?? [];

    const seen = new Map<string, MLCompatibilityBrandOption>();
    for (const v of values) {
      if (!v?.id || !v?.name) continue;
      if (!seen.has(v.id)) {
        seen.set(v.id, { valueId: v.id, name: v.name });
      }
    }
    const brands = Array.from(seen.values()).sort((a, b) =>
      a.name.localeCompare(b.name, "pt-BR"),
    );

    compatCacheSet(cacheKey, brands);
    return brands;
  }

  /**
   * Lista modelos para uma marca iterando pages do chunks até esgotar.
   * Dedup por MODEL.value_id. Cache por marca.
   */
  static async listCompatibilityModels(
    accessToken: string,
    brand: { valueId: string; name?: string },
  ): Promise<MLCompatibilityModelOption[]> {
    const cacheKey = `compat:models:${brand.valueId}`;
    const cached = compatCacheGet<MLCompatibilityModelOption[]>(cacheKey);
    if (cached) return cached;

    const pageSize = 50;
    const maxPages = 40; // teto de segurança (2000 produtos)
    const seen = new Map<string, MLCompatibilityModelOption>();
    let brandName = brand.name ?? "";

    for (let page = 0; page < maxPages; page++) {
      const chunk = await this.searchCatalogCompatibilityChunks(accessToken, {
        knownAttributes: [{ id: ML_ATTR.BRAND, value_id: brand.valueId }],
        limit: pageSize,
        offset: page * pageSize,
      });
      const results = chunk.results ?? [];
      if (results.length === 0) break;

      for (const product of results) {
        const brandAttr = findProductAttribute(product, ML_ATTR.BRAND);
        const modelAttr = findProductAttribute(product, ML_ATTR.MODEL);
        const brandVal = firstAttrValue(brandAttr);
        const modelVal = firstAttrValue(modelAttr);
        if (!modelVal.name) continue;
        if (!brandName && brandVal.name) brandName = brandVal.name;

        const id = modelVal.id ?? modelVal.name;
        if (!seen.has(id)) {
          seen.set(id, {
            valueId: modelVal.id ?? "",
            name: modelVal.name,
            brandValueId: brand.valueId,
            brandName: brandVal.name || brandName || "",
          });
        }
      }

      const total = chunk.paging?.total;
      if (typeof total === "number" && (page + 1) * pageSize >= total) break;
      if (results.length < pageSize) break;
    }

    const models = Array.from(seen.values()).sort((a, b) =>
      a.name.localeCompare(b.name, "pt-BR"),
    );
    compatCacheSet(cacheKey, models);
    return models;
  }

  /**
   * Lista veículos (linhas ano+versão) para marca+modelo.
   * Dedup por key (catalog product id quando disponível).
   * Ordena por ano desc depois por label.
   */
  static async listCompatibilityVehicles(
    accessToken: string,
    brand: { valueId: string },
    model: { valueId: string },
  ): Promise<MLCompatibilityVehicleOption[]> {
    const cacheKey = `compat:vehicles:${brand.valueId}:${model.valueId}`;
    const cached = compatCacheGet<MLCompatibilityVehicleOption[]>(cacheKey);
    if (cached) return cached;

    const pageSize = 50;
    const maxPages = 20;
    const seen = new Map<string, MLCompatibilityVehicleOption>();

    for (let page = 0; page < maxPages; page++) {
      const chunk = await this.searchCatalogCompatibilityChunks(accessToken, {
        knownAttributes: [
          { id: ML_ATTR.BRAND, value_id: brand.valueId },
          { id: ML_ATTR.MODEL, value_id: model.valueId },
        ],
        limit: pageSize,
        offset: page * pageSize,
      });
      const results = chunk.results ?? [];
      if (results.length === 0) break;

      for (const product of results) {
        const vehicle = mapCatalogProductToVehicle(product);
        if (!vehicle) continue;
        if (!seen.has(vehicle.key)) seen.set(vehicle.key, vehicle);
      }

      const total = chunk.paging?.total;
      if (typeof total === "number" && (page + 1) * pageSize >= total) break;
      if (results.length < pageSize) break;
    }

    const vehicles = Array.from(seen.values()).sort((a, b) => {
      const ya = a.year ?? 0;
      const yb = b.year ?? 0;
      if (ya !== yb) return yb - ya;
      return a.label.localeCompare(b.label, "pt-BR");
    });
    compatCacheSet(cacheKey, vehicles);
    return vehicles;
  }

  /**
   * Faz upload de uma imagem ao ML via source URL (ML baixa a imagem).
   * Retorna o picture ID de forma síncrona (diferente do source no payload do item,
   * que é assíncrono e pode causar image_download_pending).
   */
  static async uploadPictureFromUrl(
    accessToken: string,
    sourceUrl: string,
  ): Promise<{ id: string }> {
    try {
      const response = await axios.post(
        `${ML_CONSTANTS.API_URL}/pictures`,
        { source: sourceUrl },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          timeout: 15000,
        },
      );

      return { id: response.data.id };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const detail = error.response?.data
          ? JSON.stringify(error.response.data)
          : error.message;
        console.error(
          `[ML API] uploadPictureFromUrl failed (${error.response?.status}): ${detail}`,
        );
        throw new Error(`Erro ao enviar imagem (URL) ao ML: ${detail}`);
      }
      throw error;
    }
  }
}
