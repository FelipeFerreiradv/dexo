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
  MLCompatibilityReadResult,
  MLCompatReadUnavailableReason,
} from "../types/ml-api.types";
import {
  MLOrderDetails,
  MLOrdersSearchResponse,
  MLOrdersSearchParams,
  MLOrderStatus,
} from "../types/ml-order.types";

export const ML_COMPAT_DOMAIN_ID = "MLB-CARS_AND_VANS";

/**
 * Teto do multiget de DETALHES (`/items?ids=...`). Generoso de propósito: o
 * irmão `getItemsStatuses` usa 10s, mas pede `attributes=id,status` (~100
 * bytes/item) — aqui vem o body completo de 20 itens, com 4 workers em
 * paralelo. Um teto apertado transformaria cauda de latência em importação
 * descartada, que é pior do que o problema.
 */
const MULTIGET_TIMEOUT_MS = 30_000;
/** Repetições do MESMO chunk antes de propagar (ver getItemsDetails). */
const MULTIGET_TIMEOUT_RETRIES = 2;

/** Só timeout/conexão abortada — erro de HTTP (4xx/5xx) NÃO é repetido. */
function isTimeoutError(error: unknown): boolean {
  if (!axios.isAxiosError(error)) return false;
  if (error.response) return false; // servidor respondeu: não é timeout
  return (
    error.code === "ECONNABORTED" ||
    error.code === "ETIMEDOUT" ||
    error.code === "ERR_CANCELED"
  );
}

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

// ML frequentemente devolve VEHICLE_YEAR.value_name como range textual
// ("2008-2013", "2008 a 2013") em vez de ano único. Extraímos todos os anos
// de 4 dígitos e tratamos como intervalo [min, max]. Quando não há ano
// parseável (ex.: "Todos", vazio) retornamos null — quem chama decide como
// tratar (tipicamente aceita como compatível com qualquer ano).
function parseYearRangeFromAttr(
  name: string | null,
): { from: number; to: number } | null {
  if (!name) return null;
  const matches = Array.from(name.matchAll(/\b(19|20)\d{2}\b/g));
  if (matches.length === 0) return null;
  const years = matches
    .map((m) => parseInt(m[0], 10))
    .filter((n) => Number.isFinite(n));
  if (years.length === 0) return null;
  return { from: Math.min(...years), to: Math.max(...years) };
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
/**
 * TTL curto para resultado VAZIO. Uma falha momentânea do
 * GET /catalog_domains devolvendo lista vazia ficava grudada 10 minutos e
 * derrubava a resolução de compat de todo mundo (o cache é por processo e
 * compartilhado entre contas). Errar por 30s é recuperável; por 10 min, não.
 */
const COMPAT_EMPTY_CACHE_TTL_MS = 30 * 1000;
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

function compatCacheSet<T>(key: string, data: T, ttlMs?: number): void {
  const ttl =
    ttlMs ??
    (Array.isArray(data) && data.length === 0
      ? COMPAT_EMPTY_CACHE_TTL_MS
      : COMPAT_CACHE_TTL_MS);
  compatCache.set(key, { data, exp: Date.now() + ttl });
}

/**
 * Serializa para log cortando no limite.
 *
 * As respostas de compatibilidade trazem a lista inteira de catalog products
 * (uma delas passou de 50 entradas num único PUT), e despejar isso a cada
 * chamada afogava o pm2 log — os erros de outras contas sumiam no meio. O
 * começo do corpo já basta para reconhecer o formato e a mensagem de erro.
 */
function logResumo(data: unknown, max = 300): string {
  let texto: string;
  try {
    texto = JSON.stringify(data ?? {});
  } catch {
    return "(nao serializavel)";
  }
  return texto.length <= max
    ? texto
    : `${texto.slice(0, max)}…(+${texto.length - max} chars)`;
}

/**
 * Veredito sobre o corpo de uma ESCRITA de compatibilidade.
 *
 * O ML responde HTTP 200 mesmo quando não amarra o item a veículo nenhum: o
 * corpo volta com `ids: []` dentro de `products_families` ou `products`. Isso é
 * o "vínculo fantasma" — o painel do vendedor mostra Compatibilidades vazio e o
 * sistema declara sucesso. Distinguir os dois casos é o núcleo da correção.
 *
 * - "persisted": achou pelo menos um `ids` com conteúdo.
 * - "empty": achou `ids` e TODOS estão vazios.
 * - "unknown": não achou nenhuma chave `ids` — resposta que não sabemos ler.
 *
 * O bucket "unknown" existe de propósito: sem ele, qualquer resposta em formato
 * novo (ou um mock de teste que devolve `{}`) seria lida como falha e a
 * verificação passaria a reprovar publicações que funcionam. Só reprovamos com
 * evidência positiva de que o ML ignorou o vínculo.
 */
export function inspectCompatWriteResponse(data: unknown): {
  verdict: "persisted" | "empty" | "unknown";
  count: number;
} {
  if (!data || typeof data !== "object") {
    return { verdict: "unknown", count: 0 };
  }
  const root = data as Record<string, unknown>;
  const scope =
    root.create && typeof root.create === "object"
      ? (root.create as Record<string, unknown>)
      : root;

  let sawIds = false;
  let total = 0;

  // `create.products`: envio por catalog product ID. Cada entrada ecoa o `id`
  // que aceitamos enviar, e o `ids` interno vem SEMPRE vazio mesmo quando o
  // vínculo é criado — confirmado em produção (MLB7216055142 saiu de 0 para 57
  // compatibilidades com essa exata resposta). Portanto aqui o sinal de
  // sucesso é o `id` presente, não o `ids`.
  const produtos = scope.products;
  if (Array.isArray(produtos) && produtos.length > 0) {
    const aceitos = produtos.filter(
      (p) =>
        p &&
        typeof p === "object" &&
        typeof (p as Record<string, unknown>).id === "string" &&
        ((p as Record<string, unknown>).id as string).length > 0,
    ).length;
    if (aceitos > 0) return { verdict: "persisted", count: aceitos };
  }

  // `create.products_families`: envio por atributos. Aqui o `ids` É o
  // resultado da resolução — vazio significa que o ML não amarrou a veículo
  // nenhum. É o vínculo fantasma que deixa o painel do vendedor vazio.
  const walk = (list: unknown): void => {
    if (!Array.isArray(list)) return;
    for (const entry of list) {
      if (!entry || typeof entry !== "object") continue;
      const ids = (entry as Record<string, unknown>).ids;
      if (Array.isArray(ids)) {
        sawIds = true;
        total += ids.length;
      }
    }
  };

  walk(scope.products_families);
  walk(produtos);

  if (!sawIds) return { verdict: "unknown", count: 0 };
  return total > 0
    ? { verdict: "persisted", count: total }
    : { verdict: "empty", count: 0 };
}

/**
 * Conta as compatibilidades de um corpo de LEITURA.
 *
 * Tolerante a shape de propósito: o endpoint de leitura não estava mapeado no
 * serviço e a documentação do ML varia entre item legado e User Product.
 * Quando nenhuma forma conhecida aparece, devolve `available: false` — que o
 * chamador trata como "não sei", nunca como "está vazio".
 */
/**
 * Detecta a recusa estrutural do ML: o User Product está num domínio que
 * simplesmente não habilita compatibilidade (ex.:
 * `MLB-LIGHT_VEHICLE_ACCESSORIES`, `MLB-VEHICLE_SEATS`).
 *
 * Confirmado em produção: a mensagem é
 * "The user product domain X does not have active compatibilities."
 *
 * Distinguir isso de uma falha comum importa porque a ação do vendedor é
 * outra — não adianta reenviar nem corrigir o cadastro de veículos; o anúncio
 * precisa estar em outra categoria. Reenviar em loop só queima chamada.
 */
export function extractUnsupportedDomain(mensagem: string): string | null {
  const m = /user product domain\s+([A-Z0-9_-]+)\s+does not have active compatibilities/i.exec(
    mensagem || "",
  );
  return m ? m[1] : null;
}

/**
 * Traduz a falha de uma LEITURA de compatibilidade em causa acionável.
 *
 * Antes, os dois getters tinham `catch { return { available: false, ... } }`:
 * 404, 403, 429, timeout e erro de rede colapsavam no mesmo silêncio, e o
 * relatório de divergências só sabia dizer "inconclusivo". Em produção
 * (25/07/2026) isso escondeu 451 anúncios cujo diagnóstico real era 404 —
 * vínculo quebrado da importação de 18/05, não problema de compatibilidade.
 * Cada causa pede uma ação diferente, e sem ela a única saída era sondar
 * anúncio por anúncio.
 *
 * Pura de propósito: é o pedaço que dá para travar em teste sem tocar a rede.
 */
export function classifyCompatReadFailure(error: unknown): {
  reason: MLCompatReadUnavailableReason;
  httpStatus?: number;
} {
  if (!axios.isAxiosError(error)) return { reason: "erro_rede" };

  const status = error.response?.status;
  if (typeof status === "number") {
    if (status === 404) {
      return { reason: "item_inexistente", httpStatus: status };
    }
    if (status === 403) return { reason: "sem_permissao", httpStatus: status };
    if (status === 429) return { reason: "rate_limit", httpStatus: status };
    return { reason: "erro_http", httpStatus: status };
  }

  // Sem resposta: o axios sinaliza estouro de tempo por `code`, nunca por
  // status — checar `response` aqui daria sempre undefined.
  if (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT") {
    return { reason: "timeout" };
  }
  return { reason: "erro_rede" };
}

export function countCompatibilitiesFromPayload(
  data: unknown,
): MLCompatibilityReadResult {
  const empty: MLCompatibilityReadResult = {
    available: false,
    count: 0,
    productIds: [],
    universal: false,
    // Chegou resposta (o chamador só entra aqui depois de um 2xx), mas o corpo
    // não bate com nenhuma forma conhecida.
    reason: "shape_desconhecido",
  };
  if (!data || typeof data !== "object") return empty;

  const root = data as Record<string, unknown>;
  const universal = root.universal === true;
  const productIds = new Set<string>();
  let sawKnownShape = false;

  const collect = (list: unknown): void => {
    if (!Array.isArray(list)) return;
    sawKnownShape = true;
    for (const entry of list) {
      if (!entry || typeof entry !== "object") continue;
      const rec = entry as Record<string, unknown>;
      if (typeof rec.id === "string" && rec.id.length > 0) {
        productIds.add(rec.id);
      }
      if (typeof rec.product_id === "string" && rec.product_id.length > 0) {
        productIds.add(rec.product_id);
      }
      if (Array.isArray(rec.ids)) {
        for (const id of rec.ids) {
          if (typeof id === "string" && id.length > 0) productIds.add(id);
        }
      }
    }
  };

  collect(root.products);
  collect(root.products_families);
  collect(root.results);
  collect(root.compatibilities);

  if (!sawKnownShape) {
    // Universal declarado sem lista ainda é uma leitura válida: o item vale
    // para qualquer veículo, então não há o que contar.
    if (universal) {
      return { available: true, count: 0, productIds: [], universal: true };
    }
    return empty;
  }

  return {
    available: true,
    count: productIds.size,
    productIds: Array.from(productIds),
    universal,
  };
}

/** Test-only: limpa o cache global de compat (brands/models/vehicles). */
export function __resetCompatCacheForTests(): void {
  compatCache.clear();
}

/**
 * Cliente para API do Mercado Livre
 * ResponsÃ¡vel por:
 * 1. Listar items do vendedor
 * 2. Obter detalhes de items
 * 3. Atualizar estoque e preÃ§o
 */

/** Dados fiscais do comprador (GET /orders/:id/billing_info, x-version 2). */
export interface MLOrderBillingInfo {
  buyer?: {
    billing_info?: {
      name?: string | null;
      last_name?: string | null;
      identification?: { type?: string | null; number?: string | null } | null;
      address?: {
        street_name?: string | null;
        street_number?: string | null;
        city_name?: string | null;
        neighborhood?: string | null;
        state?: { code?: string | null; name?: string | null } | null;
        zip_code?: string | null;
        country_id?: string | null;
      } | null;
    } | null;
  } | null;
}

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
          // Em alguns endpoints (PUT /items) o ML usa `error` em vez de
          // `cause` para descrever o motivo. Ex.: BODY_INVALID_FIELDS +
          // error: "You cannot modify the title if the item has a family_name".
          error?: string;
          cause?:
            | string
            | Array<{ code?: string; message?: string } | string>;
        }
      | undefined;
    const baseMessage = responseData?.message || error.message;
    const errorDetail =
      typeof responseData?.error === "string" && responseData.error.trim()
        ? responseData.error.trim()
        : "";
    const causeMessage = Array.isArray(responseData?.cause)
      ? responseData.cause
          .map((cause) => {
            if (typeof cause === "string") return cause.trim();
            const code = cause?.code?.trim();
            const message = cause?.message?.trim();
            if (code && message) return `${code}: ${message}`;
            return code || message || "";
          })
          .filter(Boolean)
          .join(" | ")
      : typeof responseData?.cause === "string"
        ? responseData.cause
        : "";

    const detail = [errorDetail, causeMessage].filter(Boolean).join(" | ");
    return detail
      ? `${prefix}: ${baseMessage} (${detail})`
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

        // Timeout + retry NO MESMO chunk. Sem timeout, um socket pendurado
        // travava a importação inteira (os 4 workers ficam num Promise.all).
        // O retry não é opcional: este método é tudo-ou-nada — um throw
        // rejeita o Promise.all, descarta a importação da conta e mexe nos
        // contadores. Com a repetição, qualquer chunk que realisticamente
        // completaria continua completando; só o pendurado de verdade cai.
        let attempt = 0;
        for (;;) {
          try {
            const response = await axios.get<MLMultigetResponse[]>(url, {
              headers: {
                Authorization: `Bearer ${accessToken}`,
              },
              timeout: MULTIGET_TIMEOUT_MS,
            });

            for (const item of response.data) {
              if (item.code === 200) {
                allItems.push(item.body);
              }
            }
            break;
          } catch (error) {
            if (isTimeoutError(error) && attempt < MULTIGET_TIMEOUT_RETRIES) {
              attempt++;
              console.warn(
                `[ML API] timeout no chunk ${current} — tentativa ${attempt}/${MULTIGET_TIMEOUT_RETRIES}`,
              );
              await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
              continue;
            }
            console.error(`[ML API] Error fetching item details chunk ${current}:`, error);
            if (axios.isAxiosError(error)) {
              throw new Error(
                `Erro ao obter detalhes dos items: ${error.response?.data?.message || error.message}`,
              );
            }
            throw error;
          }
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
   * EGRESS/PERF-lean: só (id, status) de múltiplos items via multiget com
   * `attributes=id,status` (~100 bytes/item vs o JSON completo). Uso: espelho
   * de status marketplace→Dexo (webhook/refresh/sweep), que não precisa do
   * resto do item. Items deletados/inacessíveis (code≠200) são omitidos.
   */
  static async getItemsStatuses(
    accessToken: string,
    itemIds: string[],
  ): Promise<Array<{ id: string; status: string }>> {
    if (itemIds.length === 0) return [];

    const results: Array<{ id: string; status: string }> = [];
    for (let i = 0; i < itemIds.length; i += 20) {
      const chunk = itemIds.slice(i, i + 20);
      const url = `${ML_CONSTANTS.API_URL}/items?ids=${chunk.join(",")}&attributes=id,status`;
      const response = await axios.get<MLMultigetResponse[]>(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 10000,
      });
      for (const item of response.data) {
        if (item.code === 200 && item.body?.id && item.body?.status) {
          results.push({ id: item.body.id, status: item.body.status });
        }
      }
    }
    return results;
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
        const wrapped = new Error(
          `Erro ao obter detalhes do item: ${error.response?.data?.message || error.message}`,
        );
        (wrapped as any).status = error.response?.status;
        (wrapped as any).responseData = error.response?.data;
        (wrapped as any).code = error.code;
        (wrapped as any).cause = error;
        throw wrapped;
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
        // Log detalhado do payload e response do ML para diagnóstico de
        // BODY_INVALID_FIELDS e outros erros de validação.
        try {
          console.error(
            "[MLApiService.updateItem] payload rejected by ML",
            JSON.stringify(
              {
                itemId,
                payloadKeys: Object.keys(data),
                payload: data,
                status: error.response?.status,
                response: error.response?.data,
              },
              null,
              2,
            ),
          );
        } catch {
          /* ignore log errors */
        }
        const wrapped = new Error(
          this.formatAxiosError("Erro ao atualizar item", error),
        );
        (wrapped as any).status = error.response?.status;
        (wrapped as any).responseData = error.response?.data;
        (wrapped as any).code = error.code;
        (wrapped as any).cause = error;
        throw wrapped;
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
   * Normaliza o `listing_type_id` antes de enviar para a API do ML.
   *
   * Contexto: no MLB (Brasil), o tipo "Premium" atual é `gold_pro`. O alias
   * legado `gold_premium` ainda é aceito por `POST /items`, mas em fluxos UP
   * (categorias com `family_name`, ex.: MLB-CARS_AND_VANS) o ML faz downgrade
   * silencioso para `gold_special` (Clássica) — o item é criado com sucesso
   * mas com o tipo errado. Tentativas posteriores de promover para
   * `gold_premium` via `POST /items/{id}/listing_type` falham com
   * `listing_type_id.invalid`, e o próprio ML responde indicando que o tipo
   * válido para Premium é `gold_pro`.
   *
   * Mapeamos `gold_premium → gold_pro` aqui para garantir que o tipo enviado
   * seja sempre o que o ML reconhece. Frontend continua com `gold_premium`
   * (configurações antigas salvas no banco também).
   */
  static normalizeListingType(type: string | null | undefined): string {
    const v = (type || "").trim();
    if (v === "gold_premium") return "gold_pro";
    return v || "bronze";
  }

  /**
   * Altera o tipo de listagem (listing_type_id) de um item via endpoint
   * dedicado. Não é possível alterar listing_type via PUT /items/{id} —
   * o ML retorna `field_not_updatable: listing_type_id is not modifiable`.
   *
   * Endpoint: POST /items/{itemId}/listing_type
   * Body: { id: "bronze" | "gold_special" | "gold_pro" }
   *
   * IMPORTANTE: o ML costuma permitir apenas upgrades (bronze → gold_special →
   * gold_pro). Tentativas de downgrade podem retornar erro do próprio ML.
   */
  static async changeListingType(
    accessToken: string,
    itemId: string,
    newListingTypeId: string,
  ): Promise<void> {
    try {
      await axios.post(
        `${ML_CONSTANTS.API_URL}/items/${itemId}/listing_type`,
        { id: newListingTypeId },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
        },
      );
    } catch (error) {
      if (axios.isAxiosError(error)) {
        throw new Error(
          this.formatAxiosError("Erro ao alterar tipo de anúncio", error),
        );
      }
      throw error;
    }
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
   * Dados fiscais do comprador (nome, documento, endereço) de um pedido ML,
   * usados para preencher o destinatário da NF-e. Endpoint separado por
   * privacidade (x-version 2). Best-effort: retorna null em qualquer erro —
   * o prefill cai no fallback (nome do pedido). NÃO logar os dados (LGPD).
   */
  static async getOrderBillingInfo(
    accessToken: string,
    orderId: string,
  ): Promise<MLOrderBillingInfo | null> {
    try {
      const response = await axios.get<MLOrderBillingInfo>(
        `${ML_CONSTANTS.API_URL}/orders/${orderId}/billing_info`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "x-version": "2",
          },
          timeout: 10000,
        },
      );
      return response.data;
    } catch {
      return null;
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
    maxOrders: number = 500,
  ): Promise<MLOrderDetails[]> {
    const dateFrom = new Date();
    dateFrom.setDate(dateFrom.getDate() - days);

    const allOrders: MLOrderDetails[] = [];
    let offset = 0;
    const limit = 50;
    // safety cap parametrizado (default 500 mantém comportamento do sync loop;
    // backfill manual pode subir p/ varrer janelas históricas grandes).

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
    // Diagnóstico: loga os campos que costumamos errar (listing_type_id,
    // category, preço, estoque). Útil para confirmar que o valor que
    // chega ao ML é exatamente o que o usuário selecionou no frontend —
    // já tivemos bug de dropdown cacheado enviando `gold_special` em
    // vez de `gold_premium`.
    console.warn(
      `[ML CreateItem] listing_type_id=${payload.listing_type_id} category=${payload.category_id} price=${payload.price} qty=${payload.available_quantity}`,
    );
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
   * Lê as compatibilidades gravadas de um item legado.
   *
   * Nunca lança: falha de rede/404 vira `available: false`, que o chamador
   * interpreta como "não sei", nunca como "está vazio". Essa distinção é o que
   * garante que a verificação não passe a reprovar publicações que funcionam.
   */
  static async getItemCompatibilities(
    accessToken: string,
    itemId: string,
  ): Promise<MLCompatibilityReadResult> {
    try {
      const resp = await axios.get(
        `${ML_CONSTANTS.API_URL}/items/${itemId}/compatibilities`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          timeout: 10000,
        },
      );
      return countCompatibilitiesFromPayload(resp?.data);
    } catch (error) {
      const { reason, httpStatus } = classifyCompatReadFailure(error);
      return {
        available: false,
        count: 0,
        productIds: [],
        universal: false,
        reason,
        httpStatus,
      };
    }
  }

  /** Mesma leitura para itens vinculados a um User Product. */
  static async getUserProductCompatibilities(
    accessToken: string,
    userProductId: string,
  ): Promise<MLCompatibilityReadResult> {
    try {
      const resp = await axios.get(
        `${ML_CONSTANTS.API_URL}/user-products/${userProductId}/compatibilities`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          timeout: 10000,
        },
      );
      return countCompatibilitiesFromPayload(resp?.data);
    } catch (error) {
      const { reason, httpStatus } = classifyCompatReadFailure(error);
      return {
        available: false,
        count: 0,
        productIds: [],
        universal: false,
        reason,
        httpStatus,
      };
    }
  }

  /**
   * Read-back de compatibilidades. É a única forma de saber se o ML realmente
   * amarrou os veículos — o PUT responde 200 mesmo quando ignora tudo.
   *
   * EGRESS: `/items/{id}/compatibilities` PRIMEIRO, de propósito. A escrita
   * roteia para `/user-products` quando o item tem um, mas na LEITURA esse
   * endpoint responde 400 "Missing request parameter" — verificado contra a
   * API em 24/07/2026 (MLBU4432566442) — enquanto `/items` responde 200 tanto
   * para item legado quanto para User Product. Como praticamente todo item de
   * autopeça tem user_product_id, tentar o UP antes queimava uma chamada
   * garantidamente inútil em TODA leitura, e o read-back roda uma vez por
   * degrau da escada.
   *
   * O UP continua como fallback: se um dia `/items` deixar de servir esse
   * item, a capacidade de ler não se perde.
   */
  static async readCompatibilities(
    accessToken: string,
    itemId: string,
    userProductId?: string | null,
  ): Promise<MLCompatibilityReadResult> {
    const viaItem = await this.getItemCompatibilities(accessToken, itemId);
    if (viaItem.available) return viaItem;
    if (userProductId) {
      const viaUp = await this.getUserProductCompatibilities(
        accessToken,
        userProductId,
      );
      if (viaUp.available) return viaUp;
      // Os dois falharam. Devolve o resultado do /items porque o motivo dele é
      // o acionável: o endpoint de UP responde 400 na leitura por contrato
      // (ver o comentário acima), então o `reason` dele seria sempre o mesmo
      // ruído e esconderia o 404/403 que interessa. Os demais campos são
      // idênticos nos dois (false/0/[]/false) — só o diagnóstico muda.
      return viaItem;
    }
    return viaItem;
  }

  /**
   * Anexa uma lista de catalog products (IDs já resolvidos) como compatibilidades
   * do item — preenche a aba "Ficha técnica → Compatibilidades" no ML.
   *
   * Roteamento:
   * - User Product (item com family_name): PUT /user-products/{up_id}/compatibilities
   *   com body { domain_id, category_id, create: { products_families: [{ domain_id, ids }], universal: false } }.
   *   /items/{id}/compatibilities é bloqueado nesses casos ("use user product resources").
   * - Item legado (sem family_name): POST /items/{id}/compatibilities com
   *   { products: [{id}] }.
   *
   * Nunca lança — erros são reportados via `errors`; o caller decide se é fatal.
   *
   * `opts.verify` liga o read-back: depois do PUT/POST, relê as compatibilidades
   * e devolve quantas de fato ficaram (`persisted`). `createdCount` continua
   * sendo o número ENVIADO — é o contrato dos chamadores atuais.
   */
  static async setItemCompatibilities(
    accessToken: string,
    itemId: string,
    catalogProductIds: string[],
    opts?: { verify?: boolean },
  ): Promise<{
    success: boolean;
    createdCount: number;
    errors: string[];
    persisted?: number;
    verified?: boolean;
    userProductId?: string | null;
  }> {
    const errors: string[] = [];
    let createdCount = 0;
    const verifyEnabled =
      opts?.verify === true && process.env.ML_COMPAT_VERIFY_DISABLED !== "1";

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

    // Resolve user_product_id e category_id uma vez (mesma lógica de
    // setItemCompatibilitiesByAttributes). Para itens user-product o PUT
    // precisa de category_id no root do body.
    let userProductId: string | null = null;
    let categoryId: string | null = null;
    try {
      const resp = await axios.get<{
        user_product_id?: string | null;
        category_id?: string | null;
      }>(`${ML_CONSTANTS.API_URL}/items/${itemId}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 15000,
      });
      const upId = resp.data?.user_product_id;
      const catId = resp.data?.category_id;
      userProductId =
        typeof upId === "string" && upId.length > 0 ? upId : null;
      categoryId = typeof catId === "string" && catId.length > 0 ? catId : null;
    } catch {
      /* mantém null — caímos no caminho legacy com items */
    }

    // Shape do PUT /user-products/{up}/compatibilities com catalog product
    // IDs — confirmado em prod 23/04: o ML aceita `create.products: [{id}]`
    // direto, sem products_families wrapper (shape validado com response
    // 200 + product_type:PRODUCT para cada id). Mantemos shapes alternativos
    // como fallback defensivo, mas `create.products` é tentado primeiro.
    const bodyVariants: Array<{
      label: string;
      build: (ids: string[]) => Record<string, unknown>;
    }> = [
      // V1 (vencedor em prod): products no root de create.
      {
        label: "create.products",
        build: (ids) => {
          const body: Record<string, unknown> = {
            domain_id: ML_COMPAT_DOMAIN_ID,
            create: {
              products: ids.map((id) => ({ id })),
              universal: false,
            },
          };
          if (categoryId) body.category_id = categoryId;
          return body;
        },
      },
      // V2: products dentro de products_families (em prod o ML exigiu
      // attributes nesse shape — não funciona com ids puros).
      {
        label: "products_families.products",
        build: (ids) => {
          const body: Record<string, unknown> = {
            domain_id: ML_COMPAT_DOMAIN_ID,
            create: {
              products_families: [
                {
                  domain_id: ML_COMPAT_DOMAIN_ID,
                  products: ids.map((id) => ({ id })),
                },
              ],
              universal: false,
            },
          };
          if (categoryId) body.category_id = categoryId;
          return body;
        },
      },
      // V3: ids dentro de products_families (rejeitado em prod como
      // 'Invalid request body' — mantido só como último recurso).
      {
        label: "products_families.ids",
        build: (ids) => {
          const body: Record<string, unknown> = {
            domain_id: ML_COMPAT_DOMAIN_ID,
            create: {
              products_families: [
                { domain_id: ML_COMPAT_DOMAIN_ID, ids },
              ],
              universal: false,
            },
          };
          if (categoryId) body.category_id = categoryId;
          return body;
        },
      },
    ];
    let workingVariantIndex = -1;

    const putUserProduct = async (
      ids: string[],
    ): Promise<{ ok: boolean; error?: string; ghost?: boolean }> => {
      if (!userProductId) return { ok: false, error: "no user_product_id" };
      const url = `${ML_CONSTANTS.API_URL}/user-products/${userProductId}/compatibilities`;
      const order =
        workingVariantIndex >= 0
          ? [workingVariantIndex]
          : bodyVariants.map((_, i) => i);
      let lastErr: string | undefined;
      for (const idx of order) {
        const variant = bodyVariants[idx];
        const body = variant.build(ids);
        try {
          const response = await axios.put(url, body, {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
            timeout: 15000,
          });
          const inspected = inspectCompatWriteResponse(response?.data);
          console.warn(
            `[ML Compat] PUT ${url} (${variant.label}) ${inspected.verdict} — ids=${ids.length}, response=${logResumo(response.data)}`,
          );
          if (inspected.verdict === "empty") {
            // 200 com ids:[] é vínculo fantasma: o ML aceitou o corpo e não
            // amarrou nada. NÃO promove esta variante a "campeã", senão o
            // processo inteiro fica preso na forma de payload que não grava.
            lastErr = `200 com ids:[] em ${variant.label} (aceito sem persistir)`;
            continue;
          }
          workingVariantIndex = idx;
          return { ok: true };
        } catch (error) {
          const status = axios.isAxiosError(error)
            ? error.response?.status
            : undefined;
          const data = axios.isAxiosError(error)
            ? error.response?.data
            : undefined;
          console.warn(
            `[ML Compat] PUT ${url} (${variant.label}) FAIL — status=${status} ids=${ids.length} body=${logResumo(body)} response=${logResumo(data)}`,
          );
          lastErr = `${status ?? ""} ${JSON.stringify(data ?? (error instanceof Error ? error.message : String(error)))}`;
          // Só tenta próximas variantes se foi 400 (body mal formado).
          // Para 401/403/404/5xx, é problema distinto — para de tentar.
          if (status !== 400) break;
        }
      }
      return { ok: false, error: lastErr };
    };

    const postItem = async (
      ids: string[],
    ): Promise<{ ok: boolean; error?: string; ghost?: boolean }> => {
      const url = `${ML_CONSTANTS.API_URL}/items/${itemId}/compatibilities`;
      try {
        const response = await axios.post(
          url,
          { products: ids.map((id) => ({ id })) },
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
            timeout: 15000,
          },
        );
        const inspected = inspectCompatWriteResponse(response?.data);
        console.warn(
          `[ML Compat] POST ${url} ${inspected.verdict} — ids=${ids.length}`,
        );
        if (inspected.verdict === "empty") {
          return {
            ok: false,
            error: "200 com ids:[] (aceito sem persistir)",
          };
        }
        return { ok: true };
      } catch (error) {
        const status = axios.isAxiosError(error)
          ? error.response?.status
          : undefined;
        const data = axios.isAxiosError(error)
          ? error.response?.data
          : undefined;
        console.warn(
          `[ML Compat] POST ${url} FAIL — status=${status} ids=${ids.length} response=${logResumo(data)}`,
        );
        const msg = `${status ?? ""} ${JSON.stringify(data ?? (error instanceof Error ? error.message : String(error)))}`;
        return { ok: false, error: msg };
      }
    };

    // Para itens user-product, /items/.../compatibilities retorna 400
    // ("has User Product compatibilities, use the corresponding user
    // product resources"). Então preferimos user-products quando
    // disponível; só caímos para /items como fallback.
    const postBatch = async (
      ids: string[],
    ): Promise<{ ok: boolean; error?: string; ghost?: boolean }> => {
      if (userProductId) {
        const viaUp = await putUserProduct(ids);
        if (viaUp.ok) return viaUp;
        const viaItem = await postItem(ids);
        return viaItem.ok ? viaItem : viaUp;
      }
      return postItem(ids);
    };

    /**
     * Confere no ML o que ficou gravado. Leitura indisponível (`available:
     * false`) devolve o veredito legado — nunca reprovamos por não conseguir
     * ler.
     */
    const finish = async (
      sentCount: number,
      legacySuccess: boolean,
    ): Promise<{
      success: boolean;
      createdCount: number;
      errors: string[];
      persisted?: number;
      verified?: boolean;
      userProductId?: string | null;
    }> => {
      if (!verifyEnabled) {
        return {
          success: legacySuccess,
          createdCount: sentCount,
          errors,
          userProductId,
        };
      }
      const read = await this.readCompatibilities(
        accessToken,
        itemId,
        userProductId,
      );
      return {
        success: read.available ? read.count > 0 : legacySuccess,
        createdCount: sentCount,
        errors,
        persisted: read.available ? read.count : undefined,
        verified: read.available,
        userProductId,
      };
    };

    // Tentativa 1: batch único.
    const batch = await postBatch(unique);
    if (batch.ok) {
      return finish(unique.length, true);
    }

    // Fallback: chamadas individuais — isola qual ID o ML rejeita sem perder
    // os demais.
    for (const id of unique) {
      const single = await postBatch([id]);
      if (single.ok) {
        createdCount += 1;
      } else if (single.error) {
        errors.push(`${id}: ${single.error}`);
      }
    }

    return finish(createdCount, errors.length === 0 && createdCount > 0);
  }

  /**
   * Fallback: envia compatibilidades por atributos crus (BRAND/MODEL/YEAR
   * por nome) quando o `/catalog_compatibilities/products_search` não
   * resolve o par marca+modelo em catalog product IDs. Usa o shape oficial
   * documentado do endpoint:
   *
   *   PUT /items/{id}/compatibilities
   *   {
   *     "create": {
   *       "products_families": [
   *         {
   *           "domain_id": "MLB-CARS_AND_VANS",
   *           "attributes": [
   *             { "id": "BRAND", "value_name": "Chevrolet" },
   *             { "id": "MODEL", "value_name": "Camaro" },
   *             { "id": "YEAR",  "value_name": "2010" }
   *           ]
   *         }
   *       ],
   *       "universal": false
   *     }
   *   }
   *
   * Notas:
   * - Método é PUT, não POST (ver docs oficiais).
   * - Atributo é `YEAR` (não `VEHICLE_YEAR`, que é o nome usado em catalog
   *   products e no search).
   * - `products_families` vs `products`: families aceita attributes por
   *   nome; products exige catalog product id.
   *
   * Expande range de anos igual a resolveCompatibilityCatalogProducts.
   * Dedupa tuplos (brand, model, year). Batch-first + fallback individual
   * segue o mesmo padrão de setItemCompatibilities.
   *
   * Nunca lança — erros reportados via `errors`.
   */
  static async setItemCompatibilitiesByAttributes(
    accessToken: string,
    itemId: string,
    vehicles: Array<{
      brand: string;
      model: string;
      yearFrom?: number | null;
      yearTo?: number | null;
    }>,
    opts?: {
      /**
       * Só envia tuplos cujo BRAND, MODEL e YEAR resolveram para value_id.
       * Sem os ids o ML aceita por nome e devolve ids:[] — enviar assim é o
       * que produz o "vínculo fantasma". Usado como degrau intermediário da
       * escada em `applyCompatibilitiesVerified`.
       */
      requireFullValueIds?: boolean;
      verify?: boolean;
      /** Teto de chamadas a top_values nesta publicação. */
      lookupBudget?: number;
    },
  ): Promise<{
    success: boolean;
    createdCount: number;
    errors: string[];
    persisted?: number;
    verified?: boolean;
    skipped?: string;
    budgetExhausted?: boolean;
    userProductId?: string | null;
  }> {
    const errors: string[] = [];
    let createdCount = 0;
    const verifyEnabled =
      opts?.verify === true && process.env.ML_COMPAT_VERIFY_DISABLED !== "1";
    // Resolver value_id veículo a veículo custa uma chamada por marca, por
    // (marca,modelo) e por (marca,modelo,ano). Um produto com dezenas de
    // compatibilidades transformava a publicação em centenas de requests.
    const lookupBudget =
      opts?.lookupBudget ?? Number(process.env.ML_COMPAT_MAX_LOOKUPS ?? 60);
    let lookupsUsed = 0;
    let budgetExhausted = false;
    const canLookup = (): boolean => {
      if (lookupsUsed >= lookupBudget) {
        budgetExhausted = true;
        return false;
      }
      lookupsUsed += 1;
      return true;
    };

    type Tuple = { brand: string; model: string; year: number | null };
    const tuples: Tuple[] = [];
    const seen = new Set<string>();
    for (const v of vehicles || []) {
      const brand = (v?.brand || "").trim();
      const model = (v?.model || "").trim();
      if (!brand || !model) continue;
      const yFrom =
        typeof v.yearFrom === "number" && v.yearFrom > 0 ? v.yearFrom : null;
      const yTo =
        typeof v.yearTo === "number" && v.yearTo > 0 ? v.yearTo : null;
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
        const key = `${brand.toLowerCase()}|${model.toLowerCase()}|${year ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        tuples.push({ brand, model, year });
      }
    }
    if (tuples.length === 0) {
      return { success: false, createdCount: 0, errors: [] };
    }

    // Resolução de value_id. O PUT aceita value_name mas retorna ids: []
    // (vínculo fantasma, aparece no painel do ML como vazio) quando não
    // consegue mapear o nome em um veículo real. Chamadas ao endpoint
    // top_values (antes do PUT) casam brand/model textual → value_id
    // numérico, tornando o vínculo persistente.
    const normalize = (s: string): string =>
      (s || "")
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .trim()
        .toLowerCase();
    const brandValueIdCache = new Map<string, string | null>();
    const modelValueIdCache = new Map<string, string | null>();
    const yearValueIdCache = new Map<string, string | null>();

    const resolveBrandValueId = async (
      brandName: string,
    ): Promise<string | null> => {
      const key = normalize(brandName);
      if (!key) return null;
      if (brandValueIdCache.has(key)) return brandValueIdCache.get(key) ?? null;
      if (!canLookup()) return null;
      const values = await this.getCompatAttributeTopValues(
        accessToken,
        ML_ATTR.BRAND,
      );
      const match =
        values.find((v) => normalize(v.name) === key) ??
        values.find((v) => normalize(v.name).includes(key)) ??
        null;
      const valueId = match ? match.id : null;
      brandValueIdCache.set(key, valueId);
      return valueId;
    };

    const resolveModelValueId = async (
      brandValueId: string,
      modelName: string,
    ): Promise<string | null> => {
      const key = `${brandValueId}|${normalize(modelName)}`;
      if (modelValueIdCache.has(key)) return modelValueIdCache.get(key) ?? null;
      if (!canLookup()) return null;
      const values = await this.getCompatAttributeTopValues(
        accessToken,
        ML_ATTR.MODEL,
        [{ id: ML_ATTR.BRAND, value_id: brandValueId }],
      );
      const modelKey = normalize(modelName);
      const match =
        values.find((v) => normalize(v.name) === modelKey) ??
        values.find((v) => normalize(v.name).includes(modelKey)) ??
        null;
      const valueId = match ? match.id : null;
      modelValueIdCache.set(key, valueId);
      return valueId;
    };

    // O ano no endpoint de compat usa value_id numérico (não o ano literal).
    // Sem esse mapeamento o PUT retorna ids:[] mesmo com BRAND/MODEL
    // resolvidos — o ML não consegue amarrar à família de produto real.
    //
    // ATENÇÃO ao nome do atributo, que difere entre os dois usos:
    //   - CONSULTA (aqui): `VEHICLE_YEAR`. É o atributo que existe no domínio.
    //     Consultar `YEAR` devolve HTTP 400 "Attribute not found" — era o que
    //     acontecia sempre, e por isso o log de produção mostrava
    //     "YEAR value_id resolved: 0/N tuples" em 100% dos casos.
    //   - ESCRITA (toFamily): `YEAR`. Confirmado em produção e travado por
    //     teste; não uniformizar os dois.
    const resolveYearValueId = async (
      brandValueId: string,
      modelValueId: string,
      year: number,
    ): Promise<string | null> => {
      const key = `${brandValueId}|${modelValueId}|${year}`;
      if (yearValueIdCache.has(key)) return yearValueIdCache.get(key) ?? null;
      if (!canLookup()) return null;
      const values = await this.getCompatAttributeTopValues(
        accessToken,
        ML_ATTR.VEHICLE_YEAR,
        [
          { id: ML_ATTR.BRAND, value_id: brandValueId },
          { id: ML_ATTR.MODEL, value_id: modelValueId },
        ],
      );
      const target = String(year);
      const match =
        values.find((v) => v.name === target) ??
        values.find((v) => v.name.includes(target)) ??
        null;
      const valueId = match ? match.id : null;
      yearValueIdCache.set(key, valueId);
      return valueId;
    };

    // Pré-resolve todos os (brand, model) únicos antes do PUT. Uma chamada
    // por brand + uma chamada por (brand, model) — muito mais barato que
    // não persistir e obrigar o vendedor a corrigir manualmente.
    const resolvedIds = new Map<
      string,
      { brandId: string | null; modelId: string | null }
    >();
    const uniquePairs = new Map<string, Tuple>();
    for (const t of tuples) {
      const k = `${normalize(t.brand)}|${normalize(t.model)}`;
      if (!uniquePairs.has(k)) uniquePairs.set(k, t);
    }
    for (const [pairKey, t] of uniquePairs) {
      const brandId = await resolveBrandValueId(t.brand);
      const modelId = brandId
        ? await resolveModelValueId(brandId, t.model)
        : null;
      resolvedIds.set(pairKey, { brandId, modelId });
    }
    const resolvedCount = Array.from(resolvedIds.values()).filter(
      (r) => r.brandId && r.modelId,
    ).length;
    console.warn(
      `[ML Compat] value_id resolved: ${resolvedCount}/${uniquePairs.size} pairs (faltam ficam como value_name)`,
    );

    // Resolve YEAR value_id por tuple. Só tenta se brand+model foram
    // resolvidos (sem eles o top_values de YEAR não tem como filtrar).
    const resolvedYears = new Map<string, string | null>();
    for (const t of tuples) {
      if (t.year == null) continue;
      const pairKey = `${normalize(t.brand)}|${normalize(t.model)}`;
      const pair = resolvedIds.get(pairKey);
      if (!pair?.brandId || !pair?.modelId) continue;
      const tupleKey = `${pairKey}|${t.year}`;
      if (resolvedYears.has(tupleKey)) continue;
      const yearId = await resolveYearValueId(
        pair.brandId,
        pair.modelId,
        t.year,
      );
      resolvedYears.set(tupleKey, yearId);
    }
    const yearResolvedCount = Array.from(resolvedYears.values()).filter(
      (v) => v,
    ).length;
    console.warn(
      `[ML Compat] YEAR value_id resolved: ${yearResolvedCount}/${resolvedYears.size} tuples`,
    );

    // Marca+modelo resolvem mas o ANO não: o catálogo do ML não cobre aquele
    // ano para aquele modelo (ex.: HB20 só existe de 2013 em diante, então
    // "HB20 2012" nunca vai amarrar). Sem esta linha o operador só via
    // "200 com ids:[]", que não diz o que fazer. Aqui ele vê o ano exato que
    // precisa corrigir no cadastro.
    for (const [tupleKey, yearId] of resolvedYears) {
      if (yearId) continue;
      const [brandKey, modelKey, ano] = tupleKey.split("|");
      console.warn(
        `[ML Compat] ano ${ano} indisponivel no catalogo do ML para ${brandKey}/${modelKey} — ` +
          `essa linha de compatibilidade nao tem como persistir; corrija o ano no cadastro`,
      );
    }

    /** Um tuplo só é "completo" quando BRAND, MODEL e (se houver) YEAR têm id. */
    const hasFullValueIds = (t: Tuple): boolean => {
      const pairKey = `${normalize(t.brand)}|${normalize(t.model)}`;
      const pair = resolvedIds.get(pairKey);
      if (!pair?.brandId || !pair?.modelId) return false;
      if (t.year == null) return true;
      return !!resolvedYears.get(`${pairKey}|${t.year}`);
    };

    // Degrau intermediário da escada: manda só o que tem id completo. Se nada
    // qualifica, devolve sem chamar a API — quem orquestra passa ao próximo
    // degrau em vez de gastar um PUT que voltaria ids:[].
    const sendable = opts?.requireFullValueIds
      ? tuples.filter(hasFullValueIds)
      : tuples;
    if (sendable.length === 0) {
      return {
        success: false,
        createdCount: 0,
        errors: [],
        skipped: "no_full_value_ids",
        budgetExhausted,
      };
    }

    const toFamily = (
      t: Tuple,
      domainId: string,
    ): {
      domain_id: string;
      attributes: Array<{
        id: string;
        value_id?: string;
        value_name?: string;
      }>;
    } => {
      const pairKey = `${normalize(t.brand)}|${normalize(t.model)}`;
      const ids = resolvedIds.get(pairKey);
      const attributes: Array<{
        id: string;
        value_id?: string;
        value_name?: string;
      }> = [];
      attributes.push(
        ids?.brandId
          ? { id: ML_ATTR.BRAND, value_id: ids.brandId, value_name: t.brand }
          : { id: ML_ATTR.BRAND, value_name: t.brand },
      );
      attributes.push(
        ids?.modelId
          ? { id: ML_ATTR.MODEL, value_id: ids.modelId, value_name: t.model }
          : { id: ML_ATTR.MODEL, value_name: t.model },
      );
      if (t.year != null) {
        // YEAR precisa de value_id para o ML amarrar à família real de
        // produtos (brand+model+year). Sem ele o PUT retorna ids:[]
        // mesmo com BRAND/MODEL resolvidos. Nome do atributo é `YEAR`
        // (diferente de VEHICLE_YEAR usado em catalog products).
        const tupleKey = `${pairKey}|${t.year}`;
        const yearId = resolvedYears.get(tupleKey) ?? null;
        attributes.push(
          yearId
            ? { id: "YEAR", value_id: yearId, value_name: String(t.year) }
            : { id: "YEAR", value_name: String(t.year) },
        );
      }
      return { domain_id: domainId, attributes };
    };

    // O ML aceita dois domain_ids para compat em sites MLB dependendo da
    // categoria/seller: "MLB-CARS_AND_VANS" (doc canônica) e
    // "MLB-CARS_AND_VANS_FOR_COMPATIBILITIES" (variante que aparece em
    // exemplos da doc para outros sites e em User Products novos). Quando o
    // primeiro retorna "invalid domain id", tentamos o segundo antes de
    // considerar falha.
    const DOMAIN_IDS_TO_TRY = [
      ML_COMPAT_DOMAIN_ID,
      `${ML_COMPAT_DOMAIN_ID}_FOR_COMPATIBILITIES`,
    ];
    const isInvalidDomainHint = (msg: string): boolean =>
      /invalid domain id/i.test(msg) || /domain_id/i.test(msg);

    // Quando o item está vinculado a um User Product (modelo novo do ML
    // para itens com family_name), o endpoint /items/.../compatibilities
    // retorna 400 "This Item ... has User Product compatibilities. Use
    // the corresponding User Product resources.". Precisamos resolver o
    // user_product_id via GET /items/{id} e redirecionar o PUT para
    // /user-products/{id}/compatibilities.
    let resolvedUserProductId: string | null = null;
    let resolvedCategoryId: string | null = null;
    let itemMetaLookupAttempted = false;

    // GET /items/{id} serve dois propósitos: (1) achar user_product_id para
    // rotear o PUT para /user-products, e (2) achar category_id, que o suporte
    // do ML confirmou ser obrigatório no nível raiz do body de compat.
    const loadItemMeta = async (): Promise<void> => {
      if (itemMetaLookupAttempted) return;
      itemMetaLookupAttempted = true;
      try {
        const resp = await axios.get<{
          user_product_id?: string | null;
          category_id?: string | null;
        }>(`${ML_CONSTANTS.API_URL}/items/${itemId}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
          timeout: 15000,
        });
        const upId = resp.data?.user_product_id;
        const catId = resp.data?.category_id;
        resolvedUserProductId =
          typeof upId === "string" && upId.length > 0 ? upId : null;
        resolvedCategoryId =
          typeof catId === "string" && catId.length > 0 ? catId : null;
      } catch {
        /* mantém null */
      }
    };

    const getUserProductId = async (): Promise<string | null> => {
      await loadItemMeta();
      return resolvedUserProductId;
    };
    const getCategoryId = async (): Promise<string | null> => {
      await loadItemMeta();
      return resolvedCategoryId;
    };

    const isUserProductHint = (msg: string): boolean =>
      /User Product compatibilities/i.test(msg) ||
      /use the corresponding user product resources/i.test(msg);

    // Diagnóstico: logar apenas a 1ª tentativa do batch inicial para não
    // poluir o pm2 log quando vierem dezenas de veículos. Um log por call.
    let diagLogged = false;

    const putCompatWithDomain = async (
      url: string,
      batch: Tuple[],
      domainId: string,
    ): Promise<{ ok: boolean; error?: string; ghost?: boolean }> => {
      // Shape confirmado pelo suporte do ML: domain_id e category_id são
      // obrigatórios no nível raiz do body, não apenas dentro de
      // products_families. Sem eles, a API responde 400 com mensagem
      // enganosa "domain_id: invalid domain id".
      const categoryId = await getCategoryId();
      const body: Record<string, unknown> = {
        domain_id: domainId,
        create: {
          products_families: batch.map((t) => toFamily(t, domainId)),
          universal: false,
        },
      };
      if (categoryId) {
        body.category_id = categoryId;
      }
      try {
        const response = await axios.put(url, body, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          timeout: 15000,
        });
        // O ML retorna HTTP 200 mesmo quando não persiste nenhum vínculo: o
        // corpo volta com `ids: []` quando os atributos não batem em nenhum
        // veículo conhecido. É o "vínculo fantasma" — painel vazio para o
        // vendedor e sucesso para o sistema. Aqui é onde os dois casos deixam
        // de ser tratados como um só.
        const inspected = inspectCompatWriteResponse(response?.data);
        if (!diagLogged) {
          console.warn(
            `[ML Compat] PUT ${url} ${inspected.verdict} — domain=${domainId}, category=${categoryId ?? "null"}, families=${batch.length}, response=${logResumo(response.data)}`,
          );
          diagLogged = true;
        }
        if (inspected.verdict === "empty") {
          return {
            ok: false,
            error: "200 com ids:[] (aceito sem persistir)",
            ghost: true,
          };
        }
        return { ok: true };
      } catch (error) {
        const status = axios.isAxiosError(error)
          ? error.response?.status
          : undefined;
        const responseData = axios.isAxiosError(error)
          ? error.response?.data
          : undefined;
        if (!diagLogged) {
          // Mostra o body exato enviado e a resposta crua do ML. Isso tem
          // sido a única forma de decifrar "Invalid arguments..." quando a
          // mensagem do ML é enganosa (ex.: "invalid domain id" quando o
          // problema real é outro campo).
          console.warn(
            `[ML Compat] PUT ${url} FAIL — status=${status} domain=${domainId}` +
              ` body=${logResumo(body)}` +
              ` response=${logResumo(responseData)}`,
          );
          diagLogged = true;
        }
        const msg = axios.isAxiosError(error)
          ? `${status ?? ""} ${JSON.stringify(responseData ?? error.message)}`
          : error instanceof Error
            ? error.message
            : String(error);
        return { ok: false, error: msg };
      }
    };

    const putCompat = async (
      url: string,
      batch: Tuple[],
    ): Promise<{ ok: boolean; error?: string; ghost?: boolean }> => {
      let lastError: string | undefined;
      for (const domainId of DOMAIN_IDS_TO_TRY) {
        const res = await putCompatWithDomain(url, batch, domainId);
        if (res.ok) return res;
        lastError = res.error;
        // Só faz retry com outro domain_id se o erro foi exatamente sobre
        // domain_id. Para outros erros (stock, auth, etc.), parar aqui.
        if (!res.error || !isInvalidDomainHint(res.error)) {
          return res;
        }
      }
      return { ok: false, error: lastError };
    };

    const postProducts = async (
      batch: Tuple[],
    ): Promise<{ ok: boolean; error?: string; ghost?: boolean }> => {
      // Hoje quase todo item novo de auto-peça é publicado como User Product
      // (quando o ML exige family_name). O endpoint /items/{id}/compatibilities
      // rejeita products_families para esses casos — às vezes com mensagem
      // clara ("has User Product compatibilities"), às vezes com mensagens
      // genéricas ("domain_id: invalid domain id"). Em vez de tentar /items
      // primeiro e fazer retry condicional, resolvemos user_product_id upfront
      // e usamos /user-products direto quando ele existe.
      const upId = await getUserProductId();
      if (upId) {
        const viaUp = await putCompat(
          `${ML_CONSTANTS.API_URL}/user-products/${upId}/compatibilities`,
          batch,
        );
        if (viaUp.ok) return viaUp;
        // Se /user-products falhar, ainda tenta /items — útil para o caso
        // raro onde o item tem user_product_id mas aceita compat no endpoint
        // antigo. Se falhar, a mensagem mais específica prevalece.
        const viaItem = await putCompat(
          `${ML_CONSTANTS.API_URL}/items/${itemId}/compatibilities`,
          batch,
        );
        return viaItem.ok ? viaItem : viaUp;
      }

      // Item sem User Product (caso raro, sem family_name): caminho legado.
      const viaItem = await putCompat(
        `${ML_CONSTANTS.API_URL}/items/${itemId}/compatibilities`,
        batch,
      );
      if (viaItem.ok) return viaItem;

      // Fallback tardio: se a mensagem explicitamente sugere User Product,
      // refaz lookup (caso tenha sido criado entre o GET inicial e este PUT).
      if (viaItem.error && isUserProductHint(viaItem.error)) {
        // A flag real é esta. Antes o código atribuía a um identificador que
        // nunca foi declarado, o que em ESM (strict) lança ReferenceError e
        // fazia este fallback explodir em vez de reconsultar o item.
        itemMetaLookupAttempted = false;
        const lateUp = await getUserProductId();
        if (lateUp) {
          return putCompat(
            `${ML_CONSTANTS.API_URL}/user-products/${lateUp}/compatibilities`,
            batch,
          );
        }
      }
      return viaItem;
    };

    /**
     * Confere no ML o que ficou gravado. Leitura indisponível devolve o
     * veredito legado — nunca reprovamos por não conseguir ler.
     */
    const finish = async (
      sentCount: number,
      legacySuccess: boolean,
    ): Promise<{
      success: boolean;
      createdCount: number;
      errors: string[];
      persisted?: number;
      verified?: boolean;
      budgetExhausted?: boolean;
      userProductId?: string | null;
    }> => {
      const upId = await getUserProductId();
      if (!verifyEnabled) {
        return {
          success: legacySuccess,
          createdCount: sentCount,
          errors,
          budgetExhausted,
          userProductId: upId,
        };
      }
      const read = await this.readCompatibilities(accessToken, itemId, upId);
      return {
        success: read.available ? read.count > 0 : legacySuccess,
        createdCount: sentCount,
        errors,
        persisted: read.available ? read.count : undefined,
        verified: read.available,
        budgetExhausted,
        userProductId: upId,
      };
    };

    const batch = await postProducts(sendable);
    if (batch.ok) {
      return finish(sendable.length, true);
    }

    for (const t of sendable) {
      const single = await postProducts([t]);
      if (single.ok) {
        createdCount += 1;
      } else if (single.error) {
        errors.push(
          `${t.brand}/${t.model}${t.year ? `/${t.year}` : ""}: ${single.error}`,
        );
      }
    }

    return finish(createdCount, errors.length === 0 && createdCount > 0);
  }

  /**
   * Aplica compatibilidades ao item VERIFICANDO que elas persistiram.
   *
   * A escada existente parava na primeira resposta HTTP 200 — que é justamente
   * a que não grava (`ids: []`). Aqui cada degrau só é considerado vencedor se
   * o read-back confirmar veículos gravados; caso contrário passa ao próximo:
   *
   *   1. catalog product IDs resolvidos (vínculo forte, é o que o ML prefere);
   *   2. atributos com BRAND+MODEL+YEAR todos com value_id;
   *   3. atributos com value_id parcial (comportamento histórico);
   *   4. falha registrada — nunca "sucesso" silencioso.
   *
   * Degradação segura: quando o read-back não está disponível (rede, endpoint
   * diferente do esperado) e o corpo do PUT não é conclusivo, o degrau conta
   * como sucesso e a escada PARA — exatamente como antes desta função existir.
   * Só descemos a escada com evidência de falha, nunca por falta de evidência.
   */
  static async applyCompatibilitiesVerified(
    accessToken: string,
    itemId: string,
    vehicles: Array<{
      brand: string;
      model: string;
      yearFrom?: number | null;
      yearTo?: number | null;
    }>,
  ): Promise<{
    ok: boolean;
    strategy:
      | "catalog_products"
      | "attributes_full"
      | "attributes_partial"
      | "none";
    requested: number;
    persisted: number;
    verified: boolean;
    unresolved: Array<{
      brand: string;
      model: string;
      year?: number | null;
      reason: string;
    }>;
    errors: string[];
    budgetExhausted: boolean;
    userProductId: string | null;
    /**
     * Preenchido quando o ML recusa por domínio do User Product. Sinaliza que
     * NENHUMA estratégia vai funcionar enquanto o anúncio estiver nessa
     * categoria — a correção é recategorizar, não reenviar.
     */
    unsupportedDomain?: string;
  }> {
    const requested = (vehicles || []).filter((v) => v?.brand && v?.model)
      .length;
    const errors: string[] = [];
    let unresolved: Array<{
      brand: string;
      model: string;
      year?: number | null;
      reason: string;
    }> = [];
    let budgetExhausted = false;
    let userProductId: string | null = null;
    let verified = false;

    if (requested === 0) {
      return {
        ok: false,
        strategy: "none",
        requested: 0,
        persisted: 0,
        verified: false,
        unresolved: [],
        errors: [],
        budgetExhausted: false,
        userProductId: null,
      };
    }

    // Degrau 1 — catalog product IDs.
    let resolvedIds: string[] = [];
    try {
      const resolved = await this.resolveCompatibilityCatalogProducts(
        accessToken,
        vehicles,
      );
      resolvedIds = resolved.catalogProductIds;
      unresolved = resolved.unresolved;
    } catch (err) {
      errors.push(
        `resolve falhou: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (resolvedIds.length > 0) {
      const r = await this.setItemCompatibilities(
        accessToken,
        itemId,
        resolvedIds,
        { verify: true },
      );
      if (r.errors.length > 0) errors.push(...r.errors);
      if (r.userProductId !== undefined) userProductId = r.userProductId ?? null;
      verified = verified || r.verified === true;
      if (r.success) {
        return {
          ok: true,
          strategy: "catalog_products",
          requested,
          persisted: r.persisted ?? r.createdCount,
          verified: r.verified === true,
          unresolved,
          errors,
          budgetExhausted,
          userProductId,
        };
      }
    }

    /** Recusa por domínio: nenhum degrau adiante muda o resultado. */
    const dominioRecusado = (): string | null => {
      for (const e of errors) {
        const d = extractUnsupportedDomain(e);
        if (d) return d;
      }
      return null;
    };

    {
      const dom = dominioRecusado();
      if (dom) {
        console.warn(
          `[ML Compat] dominio ${dom} do user product nao aceita compatibilidade — ` +
            `nenhuma estrategia vai funcionar; o anuncio precisa de outra categoria`,
        );
        return {
          ok: false,
          strategy: "none",
          requested,
          persisted: 0,
          verified,
          unresolved,
          errors,
          budgetExhausted,
          userProductId,
          unsupportedDomain: dom,
        };
      }
    }

    // Degraus 2 e 3 — por atributos. `requireFullValueIds` primeiro porque
    // value_id completo é o que o ML consegue amarrar a uma família real.
    for (const requireFullValueIds of [true, false]) {
      const r = await this.setItemCompatibilitiesByAttributes(
        accessToken,
        itemId,
        vehicles,
        { requireFullValueIds, verify: true },
      );
      if (r.errors.length > 0) errors.push(...r.errors);
      if (r.budgetExhausted) budgetExhausted = true;
      if (r.userProductId !== undefined) userProductId = r.userProductId ?? null;
      verified = verified || r.verified === true;
      if (r.skipped) continue;
      if (r.success) {
        return {
          ok: true,
          strategy: requireFullValueIds
            ? "attributes_full"
            : "attributes_partial",
          requested,
          persisted: r.persisted ?? r.createdCount,
          verified: r.verified === true,
          unresolved,
          errors,
          budgetExhausted,
          userProductId,
        };
      }
      // Recusa por domínio pode aparecer só agora (o degrau 1 nem sempre a
      // provoca). Interrompe em vez de gastar o degrau seguinte à toa.
      const dom = dominioRecusado();
      if (dom) {
        console.warn(
          `[ML Compat] dominio ${dom} do user product nao aceita compatibilidade — ` +
            `nenhuma estrategia vai funcionar; o anuncio precisa de outra categoria`,
        );
        return {
          ok: false,
          strategy: "none",
          requested,
          persisted: 0,
          verified,
          unresolved,
          errors,
          budgetExhausted,
          userProductId,
          unsupportedDomain: dom,
        };
      }
    }

    return {
      ok: false,
      strategy: "none",
      requested,
      persisted: 0,
      verified,
      unresolved,
      errors,
      budgetExhausted,
      userProductId,
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

    // Cache dos resultados do /products_search/chunks por (brand, model).
    // Um mesmo item pode ter dezenas de linhas de compat com o mesmo par
    // marca+modelo (ex.: 74 "Ford Ka" com versões/anos diferentes). Sem esse
    // cache, cada linha disparava uma busca idêntica ao ML — 10 páginas ×
    // 50 produtos = 500 requests repetidos por iteração. O cache dedupe.
    const productsByBrandModel = new Map<
      string,
      {
        products: MLCatalogCompatibilityProduct[];
        fetchErr: unknown;
      }
    >();

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
        // Cópia defensiva: listCompatibilityBrands devolve o array do cache
        // global POR REFERÊNCIA. O push de marcas vindas de top_values (logo
        // abaixo) escrevia nesse array compartilhado entre todas as contas do
        // processo — e servido também pelo endpoint público de marcas.
        brandsCache = [...(await this.listCompatibilityBrands(accessToken))];
        // Só avisa quando a fonte primária vem VAZIA — esse é o sintoma. Carga
        // bem-sucedida não precisa de linha no log a cada publicação.
        if (brandsCache.length === 0) {
          console.warn(
            `[ML Compat] catalog_domains devolveu 0 marcas — resolucao vai depender de top_values`,
          );
        }
      }
      const n = normalize(name);
      if (!n) return null;
      let match: MLCompatibilityBrandOption | null =
        brandsCache.find((b) => normalize(b.name) === n) ??
        brandsCache.find((b) => normalize(b.name).includes(n)) ??
        null;
      if (!match) {
        // Fallback via top_values (endpoint não truncado): o
        // GET /catalog_domains devolve uma lista incompleta em algumas
        // contas (ex.: Ford pode não aparecer); POST /attributes/BRAND/top_values
        // traz os 100+ valores reais. Sem esse fallback, marcas comuns
        // caíam como "unresolved" e o item ia só com compat por atributos
        // (que o ML aceita mas não persiste).
        const topValues = await this.getCompatAttributeTopValues(
          accessToken,
          ML_ATTR.BRAND,
        );
        const tv =
          topValues.find((v) => normalize(v.name) === n) ??
          topValues.find((v) => normalize(v.name).includes(n)) ??
          null;
        if (tv) {
          // `source` registra a procedência do value_id. Hoje é só
          // diagnóstico: a sonda mostrou que catalog_domains, top_values e os
          // catalog products compartilham o mesmo espaço de IDs.
          match = { valueId: tv.id, name: tv.name, source: "top_values" };
          brandsCache.push(match);
        } else {
          console.warn(
            `[ML Compat] brand "${name}" NÃO encontrada nem em top_values (${topValues.length} valores) — cai para open_attributes`,
          );
        }
      }
      return match;
    };

    const findModel = async (
      brand: MLCompatibilityBrandOption,
      name: string,
    ): Promise<MLCompatibilityModelOption | null> => {
      let models = modelListCache.get(brand.valueId);
      if (!models) {
        try {
          // Cópia defensiva pelo mesmo motivo do brandsCache: o push abaixo
          // não pode escrever no array do cache global.
          models = [
            ...(await this.listCompatibilityModels(accessToken, {
              valueId: brand.valueId,
              name: brand.name,
            })),
          ];
        } catch (err) {
          console.warn(
            `[ML Compat] listCompatibilityModels(${brand.valueId}) falhou: ${err instanceof Error ? err.message : String(err)} — caindo em top_values direto`,
          );
          models = [];
        }
        modelListCache.set(brand.valueId, models);
      }
      const n = normalize(name);
      if (!n) return null;
      let match: MLCompatibilityModelOption | null =
        models.find((m) => normalize(m.name) === n) ??
        models.find((m) => normalize(m.name).includes(n)) ??
        null;
      if (!match) {
        // Mesmo fallback de brand: top_values filtrado por BRAND.value_id.
        const topValues = await this.getCompatAttributeTopValues(
          accessToken,
          ML_ATTR.MODEL,
          [{ id: ML_ATTR.BRAND, value_id: brand.valueId }],
        );
        const tv =
          topValues.find((v) => normalize(v.name) === n) ??
          topValues.find((v) => normalize(v.name).includes(n)) ??
          null;
        if (tv) {
          match = {
            valueId: tv.id,
            name: tv.name,
            brandValueId: brand.valueId,
            brandName: brand.name,
            source: "top_values",
          };
          models.push(match);
        }
      }
      return match;
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

      // Sonda contra a API real (24/07/2026) mostrou que catalog_domains,
      // top_values e os catalog products compartilham o MESMO espaço de IDs
      // (Volkswagen = 60249 nos três). Então qualquer value_id resolvido serve
      // tanto para a query quanto para o filtro — `source` fica só como
      // diagnóstico.
      //
      // O que de fato devolve lixo é `open_attributes`: pedindo
      // BRAND=Volkswagen + MODEL=Gol por NOME, o ML respondeu com Fiat Mobi.
      // Ou seja, o "0 of 1500 matched brand+model" acontece quando a marca não
      // resolve em fonte nenhuma (ex.: "CAOA Chery", que o ML cataloga como
      // "Chery"), caímos em open_attributes e o filtro local — corretamente —
      // descarta tudo que voltou. Por isso o caminho a privilegiar é sempre o
      // known_attributes.
      const brandTrusted = !!brand;
      const modelTrusted = !!model;

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

      // A busca ao ML não filtra por ano — todos os anos no range retornam
      // exatamente o mesmo conjunto de produtos para um dado (brand, model).
      // Paginamos uma vez e aplicamos o filtro de ano localmente por
      // iteração, o que transforma N chamadas idênticas em 1 (N = tamanho
      // do range). Preserva a semântica de `unresolved` (1 entry por ano
      // não coberto) e de erro de rede (1 entry por ano quando a busca
      // falha).
      const searchParams: {
        knownAttributes?: Array<{ id: string; value_id: string }>;
        openAttributes?: Array<{ id: string; value_name: string }>;
        limit?: number;
        offset?: number;
      } = {};
      // Só usa known_attributes (busca por id) para o que é confiável; o resto
      // vai por open_attributes, delegando o casamento textual ao próprio ML.
      if (brandTrusted && modelTrusted) {
        searchParams.knownAttributes = [
          { id: ML_ATTR.BRAND, value_id: brand!.valueId },
          { id: ML_ATTR.MODEL, value_id: model!.valueId },
        ];
      } else if (brandTrusted) {
        searchParams.knownAttributes = [
          { id: ML_ATTR.BRAND, value_id: brand!.valueId },
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

      const pageSize = 50;
      // Modelos populares (Civic, Palio, Gol, Polo) tem >1500 catalog products
      // no ML; com maxPages=10 (=500 produtos) anos antigos costumam ficar
      // de fora do batch e o filtro de ano descarta tudo. 30 paginas (=1500)
      // cobrem o cenario observado em prod sem explodir custo de chamada
      // — searchCatalogCompatibilityChunks ainda corta cedo via paging.total
      // ou results.length<pageSize quando o catalogo eh menor.
      const maxPages = 30;
      const normalizedBrand = normalize(brandName);
      const normalizedModel = normalize(modelName);

      // Cache por (brand, model): se já buscamos esse par nesta chamada,
      // reusa os produtos — compat tem muitas linhas do mesmo veículo em
      // versões/anos diferentes, todas renderizavam o mesmo search.
      const bmKey = `${normalizedBrand}|${normalizedModel}`;
      let cachedProducts: MLCatalogCompatibilityProduct[];
      let fetchErr: unknown;
      const cached = productsByBrandModel.get(bmKey);
      let loggedThisIteration = false;
      if (cached) {
        cachedProducts = cached.products;
        fetchErr = cached.fetchErr;
      } else {
        cachedProducts = [];
        fetchErr = null;
        try {
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
            cachedProducts.push(...results);
            const total = chunk.paging?.total;
            if (typeof total === "number" && (page + 1) * pageSize >= total) {
              break;
            }
            if (results.length < pageSize) break;
          }
        } catch (err) {
          fetchErr = err;
        }
        productsByBrandModel.set(bmKey, {
          products: cachedProducts,
          fetchErr,
        });
        loggedThisIteration = true;
      }

      // Diagnóstico: só loga na 1ª vez que esse par brand+model é buscado.
      // Sem essa guarda, 50 veículos do mesmo Ford/Ka em anos diferentes
      // produzem 50 linhas idênticas no pm2, que escondem os logs das outras
      // marcas e estouram o buffer do grep.
      // As cinco amostras de nome/id que este bloco imprimia serviram para
      // descobrir que catalog_domains, top_values e os catalog products usam o
      // mesmo espaço de IDs. Confirmado isso, viraram ruído: eram ~5 arrays por
      // par marca+modelo, em toda publicação. Fica só a contagem e a
      // procedência, que é o que ainda diagnostica ("0 products fetched" ou
      // "fallback" apontam onde a resolução parou).
      if (fetchErr === null && loggedThisIteration) {
        const brandTag = brand
          ? `brand=${brand.valueId}`
          : `brand=fallback(${brandName})`;
        const modelTag = model
          ? `model=${model.valueId}`
          : `model=fallback(${modelName})`;
        // Usa console.warn pois este ambiente filtra console.info do pm2
        // stdout; o objetivo do log é aparecer junto com os "não resolvidas".
        console.warn(
          `[ML Compat] ${brandName}/${modelName}: ${cachedProducts.length} products fetched (${brandTag}, ${modelTag})`,
        );
      }

      for (const year of years) {
        if (fetchErr !== null) {
          unresolved.push({
            brand: brandName,
            model: modelName,
            year,
            reason:
              fetchErr instanceof Error
                ? `lookup failed: ${fetchErr.message}`
                : "lookup failed",
          });
          continue;
        }

        let matchedBrandModel = 0;
        let found = 0;
        for (const prod of cachedProducts) {
          if (!prod?.id) continue;
          const brandAttr = prod.attributes?.find(
            (a) => a?.id === ML_ATTR.BRAND,
          );
          const modelAttr = prod.attributes?.find(
            (a) => a?.id === ML_ATTR.MODEL,
          );
          // Validação SEMPRE — o ML ignora (ou aplica parcialmente) o
          // known_attributes em vários casos, e compatibilidade ERRADA no
          // anúncio é pior do que compatibilidade faltando. O que muda por
          // procedência é COMO comparar: por value_id só quando o id está no
          // mesmo espaço dos catalog products; por nome normalizado quando
          // veio de top_values (ou quando não resolvemos nada).
          if (brandTrusted) {
            const prodBrandValueId =
              brandAttr?.value_id ?? brandAttr?.values?.[0]?.id ?? null;
            if (prodBrandValueId && prodBrandValueId !== brand!.valueId) {
              continue;
            }
          } else {
            const prodBrand = normalize(
              brandAttr?.value_name ??
                brandAttr?.values?.[0]?.name ??
                "",
            );
            // Só chegamos aqui quando a marca não resolveu em fonte nenhuma,
            // então a busca foi por open_attributes — que o ML ignora. Este
            // gate por nome é o que impede o lixo devolvido de virar
            // compatibilidade errada no anúncio.
            if (prodBrand && prodBrand !== normalizedBrand) continue;
          }
          if (modelTrusted) {
            const prodModelValueId =
              modelAttr?.value_id ?? modelAttr?.values?.[0]?.id ?? null;
            if (prodModelValueId && prodModelValueId !== model!.valueId) {
              continue;
            }
          } else {
            const prodModel = normalize(
              modelAttr?.value_name ??
                modelAttr?.values?.[0]?.name ??
                "",
            );
            if (prodModel && prodModel !== normalizedModel) {
              continue;
            }
          }
          matchedBrandModel += 1;

          if (year != null) {
            const yearAttr = prod.attributes?.find(
              (a) => a?.id === ML_ATTR.VEHICLE_YEAR,
            );
            const raw =
              yearAttr?.value_name ?? yearAttr?.values?.[0]?.name ?? null;
            const range = parseYearRangeFromAttr(raw);
            // Quando o produto traz um range parseável, exige containment.
            // Sem atributo ou formato não-parseável ("Todos"): trata como
            // compatível com qualquer ano — alinha com o painel do ML para
            // produtos universais.
            if (range && (year < range.from || year > range.to)) continue;
          }
          catalogProductIds.add(prod.id);
          found += 1;
        }

        if (found === 0) {
          const fetched = cachedProducts.length;
          // 3 cenários:
          // (a) ML devolveu 0 produtos: par (brand, model) não existe.
          // (b) Devolveu N mas 0 bateram brand+model: ML ignorou o filtro
          //     e retornou lixo — o catálogo dele não cobre esse par.
          // (c) Bateram brand+model mas ano específico não foi coberto.
          unresolved.push({
            brand: brandName,
            model: modelName,
            year,
            reason: year
              ? fetched === 0
                ? `no catalog products for ${year} (ML returned 0 for brand+model)`
                : matchedBrandModel === 0
                  ? `no catalog products for ${year} (0 of ${fetched} matched brand+model; ML ignored filter)`
                  : `no catalog products for ${year} (0 of ${matchedBrandModel} matched year; ${fetched} total fetched)`
              : fetched === 0
                ? "no catalog products for brand+model (ML returned 0)"
                : matchedBrandModel === 0
                  ? `no catalog products for brand+model (0 of ${fetched} matched; ML ignored filter)`
                  : `no catalog products for brand+model (${matchedBrandModel} of ${fetched} matched)`,
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
   * POST /catalog_domains/{DOMAIN_ID}/attributes/{ATTRIBUTE_ID}/top_values
   * Retorna lista completa de valores de um atributo no domínio (BRAND retorna
   * Ford value_id=66432, etc.). Difere do GET /catalog_domains que é truncado
   * a ~10 top brands. Aceita `known_attributes` para filtrar — por exemplo,
   * buscar models de uma brand específica: POST .../attributes/MODEL/top_values
   * com body { known_attributes: [{id: "BRAND", value_id: "66432"}] }.
   *
   * Uso crítico: o PUT /user-products/.../compatibilities aceita attributes
   * por value_name mas retorna `ids: []` quando não consegue resolver os
   * nomes em veículos reais. Precisamos enviar value_id para o compat
   * persistir de fato.
   */
  static async getCompatAttributeTopValues(
    accessToken: string,
    attributeId: string,
    knownAttributes?: Array<{ id: string; value_id: string }>,
  ): Promise<Array<{ id: string; name: string }>> {
    const url = `${ML_CONSTANTS.API_URL}/catalog_domains/${ML_COMPAT_DOMAIN_ID}/attributes/${attributeId}/top_values`;
    const body: Record<string, unknown> = {};
    if (knownAttributes && knownAttributes.length > 0) {
      body.known_attributes = knownAttributes;
    }

    // Este endpoint não tinha cache nenhum e é o mais chamado do fluxo de
    // compatibilidade: uma vez por marca, por (marca,modelo) e por
    // (marca,modelo,ano). Um produto com dezenas de veículos repetia as
    // mesmas consultas dentro da mesma publicação e entre publicações.
    // Dados públicos de catálogo, iguais para todas as contas.
    const cacheKey = `compat:topvalues:${attributeId}:${JSON.stringify(
      (knownAttributes ?? [])
        .map((a) => `${a.id}=${a.value_id}`)
        .sort(),
    )}`;
    const cached = compatCacheGet<Array<{ id: string; name: string }>>(cacheKey);
    if (cached) return cached;

    try {
      const response = await axios.post<
        | { values?: Array<{ id?: string; name?: string }> }
        | Array<{ id?: string; name?: string }>
      >(url, body, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        timeout: 15000,
      });
      // Doc mostra response com { values: [...] }, mas algumas rotas do ML
      // retornam o array diretamente. Normaliza os dois formatos.
      const raw = Array.isArray(response.data)
        ? response.data
        : (response.data?.values ?? []);
      const values = raw
        .filter(
          (v): v is { id: string; name: string } =>
            typeof v?.id === "string" && typeof v?.name === "string",
        )
        .map((v) => ({ id: v.id, name: v.name }));
      // Log único por chamada para diagnóstico — mostra quantos vieram e os
      // primeiros nomes (para sabermos se Ford/Audi estão presentes).
      // Só reporta o caso anômalo: lista vazia. O sucesso é o caminho normal e
      // acontece várias vezes por publicação (uma por marca, por modelo e por
      // ano) — logar tudo enterrava os erros de verdade.
      if (values.length === 0) {
        console.warn(
          `[ML Compat] top_values ${attributeId} devolveu 0 valores` +
            (knownAttributes
              ? ` (filtro: ${knownAttributes.map((a) => a.id).join(",")})`
              : ""),
        );
      }
      // Lista vazia entra com TTL curto (compatCacheSet decide pelo tamanho):
      // resposta vazia costuma ser transitória e não pode grudar por 10 min.
      compatCacheSet(cacheKey, values);
      return values;
    } catch (error) {
      const status = axios.isAxiosError(error)
        ? error.response?.status
        : undefined;
      const data = axios.isAxiosError(error)
        ? error.response?.data
        : undefined;
      console.warn(
        `[ML Compat] top_values ${attributeId} FAILED status=${status ?? "?"} response=${logResumo(data ?? (error instanceof Error ? error.message : String(error)))}`,
      );
      return [];
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
      site_id: "MLB",
      domain_id: ML_COMPAT_DOMAIN_ID,
      limit: params.limit ?? 50,
      offset: params.offset ?? 0,
    };
    if (params.knownAttributes && params.knownAttributes.length > 0) {
      // O endpoint chunks espera `value_ids: [string]` (plural, array),
      // diferente do endpoint top_values que usa `value_id: string`
      // (singular). Confirmado em prod 23/04 via detalhe do 400:
      // "known_attributes[0].value_ids: must not be empty".
      body.known_attributes = params.knownAttributes.map((attr) => ({
        id: attr.id,
        value_ids: [attr.value_id],
      }));
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
      // Diagnóstico: body + status + response crua. "Invalid arguments" do ML
      // é um erro genérico que esconde o campo realmente problemático.
      const status = axios.isAxiosError(error)
        ? error.response?.status
        : undefined;
      const data = axios.isAxiosError(error) ? error.response?.data : undefined;
      console.warn(
        `[ML Compat] chunks FAIL — status=${status ?? "?"} body=${logResumo(body)} response=${logResumo(data)}`,
      );
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
    // O ML devolve as marcas em `suggested_values` (formato
    // {value_id, value_name}), não em `values`. Ler só `values` produzia lista
    // SEMPRE vazia — é a origem do `brandsCache loaded: 0 brands` do log de
    // produção, que derrubava a fonte primária e empurrava tudo para o
    // fallback. Confirmado por sonda contra a API real em 24/07/2026.
    // Aceitamos os dois formatos: `values` continua valendo se voltar.
    const values: Array<{ id: string; name: string }> = [
      ...(brandAttr?.values ?? []).map((v) => ({
        id: String(v?.id ?? ""),
        name: String(v?.name ?? ""),
      })),
      ...(
        (brandAttr as unknown as {
          suggested_values?: Array<{ value_id?: string; value_name?: string }>;
        })?.suggested_values ?? []
      ).map((v) => ({
        id: String(v?.value_id ?? ""),
        name: String(v?.value_name ?? ""),
      })),
    ].filter((v) => v.id && v.name);

    const seen = new Map<string, MLCompatibilityBrandOption>();
    for (const v of values) {
      if (!v?.id || !v?.name) continue;
      if (!seen.has(v.id)) {
        seen.set(v.id, {
          valueId: v.id,
          name: v.name,
          source: "catalog_domains",
        });
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
            // Veio de dentro dos próprios catalog products, então o id está no
            // mesmo espaço que o filtro compara.
            source: "catalog_domains",
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
