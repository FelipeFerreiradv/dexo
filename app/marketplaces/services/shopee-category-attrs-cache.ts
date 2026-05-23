import { promises as fs } from "fs";
import { join } from "path";

/**
 * Cache de atributos de categoria Shopee — em memória + persistido em disco.
 *
 * Motivação:
 * - `ShopeeApiService.getCategoryAttributes` retorna 403 permission_denied
 *   esporadicamente E persistentemente em algumas categorias (102340/102370/
 *   102371/102416 — peças de reposição). Sem os atributos, o payload do
 *   `createItem` vai com `attribute_list: []` e a API rejeita por
 *   "Attribute 'Auto-Part Number' is mandatory required".
 * - Mesmo quando uma categoria responde OK numa hora, ela pode 403 logo depois.
 *   Como o esquema de atributos da Shopee muda raramente, faz sentido cachear.
 *
 * Estratégia:
 * - In-memory Map (process-level) com TTL fresh de 24h.
 * - Persiste em disco como JSON (sobrevive restart do PM2).
 * - Em caso de 403, retorna entrada STALE (até 30 dias) se existir — melhor
 *   atributos antigos do que nenhum.
 *
 * Chave: `${shopId}:${categoryId}:${locale}` — atributos podem variar por
 * locale ("pt-BR" vs "en"). shopId entra na chave porque algumas categorias
 * têm sub-attrs específicos por shop (raro mas possível).
 */

const CACHE_TTL_FRESH_MS = 24 * 60 * 60 * 1000; // 24h
const CACHE_TTL_STALE_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias

interface CachedEntry {
  attribute_list: any[];
  cachedAt: number;
}

const memoryCache = new Map<string, CachedEntry>();
let diskLoaded = false;

const cacheKey = (shopId: number, categoryId: number, locale: string) =>
  `${shopId}:${categoryId}:${locale}`;

const cacheFilePath = () =>
  join(process.cwd(), ".cache", "shopee-category-attrs.json");

async function loadFromDisk(): Promise<void> {
  if (diskLoaded) return;
  diskLoaded = true;
  try {
    const raw = await fs.readFile(cacheFilePath(), "utf-8");
    const parsed = JSON.parse(raw) as Record<string, CachedEntry>;
    for (const [k, v] of Object.entries(parsed)) {
      if (
        v &&
        typeof v === "object" &&
        Array.isArray((v as any).attribute_list) &&
        typeof (v as any).cachedAt === "number"
      ) {
        memoryCache.set(k, v);
      }
    }
    console.log(
      `[ShopeeAttrsCache] loaded ${memoryCache.size} entries from disk`,
    );
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      console.warn(
        "[ShopeeAttrsCache] failed to load disk cache:",
        err?.message || err,
      );
    }
    // ENOENT é normal na primeira execução
  }
}

async function persistToDisk(): Promise<void> {
  try {
    const obj: Record<string, CachedEntry> = {};
    for (const [k, v] of memoryCache.entries()) obj[k] = v;
    const dir = join(process.cwd(), ".cache");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(cacheFilePath(), JSON.stringify(obj, null, 2), "utf-8");
  } catch (err: any) {
    console.warn(
      "[ShopeeAttrsCache] failed to persist cache to disk:",
      err?.message || err,
    );
  }
}

export type ShopeeAttrsCacheStatus = "fresh" | "stale" | "miss";

export interface ShopeeAttrsLookup {
  status: ShopeeAttrsCacheStatus;
  attribute_list: any[] | null;
  ageMs: number;
}

/**
 * Procura no cache atributos de uma categoria Shopee.
 * Retorna `fresh` se cache hit < 24h, `stale` se entre 24h e 30 dias, `miss`
 * se nada (ou > 30 dias).
 */
export async function lookupShopeeCategoryAttrs(
  shopId: number,
  categoryId: number,
  locale: string,
): Promise<ShopeeAttrsLookup> {
  await loadFromDisk();
  const entry = memoryCache.get(cacheKey(shopId, categoryId, locale));
  if (!entry) return { status: "miss", attribute_list: null, ageMs: 0 };

  const ageMs = Date.now() - entry.cachedAt;
  if (ageMs < CACHE_TTL_FRESH_MS) {
    return { status: "fresh", attribute_list: entry.attribute_list, ageMs };
  }
  if (ageMs < CACHE_TTL_STALE_MS) {
    return { status: "stale", attribute_list: entry.attribute_list, ageMs };
  }
  // Muito velho — descarta e devolve miss
  memoryCache.delete(cacheKey(shopId, categoryId, locale));
  return { status: "miss", attribute_list: null, ageMs };
}

/**
 * Armazena atributos de uma categoria Shopee no cache. Chamado depois de
 * cada `getCategoryAttributes` bem-sucedido. Persistência em disco é
 * fire-and-forget para não bloquear o fluxo de criação.
 */
export function storeShopeeCategoryAttrs(
  shopId: number,
  categoryId: number,
  locale: string,
  attribute_list: any[],
): void {
  if (!Array.isArray(attribute_list)) return;
  memoryCache.set(cacheKey(shopId, categoryId, locale), {
    attribute_list,
    cachedAt: Date.now(),
  });
  // Persist async — não esperamos
  void persistToDisk();
}

/** Estatísticas — útil pra debug/observabilidade. */
export function shopeeCategoryAttrsCacheStats(): {
  size: number;
  freshMs: number;
  staleMs: number;
} {
  return {
    size: memoryCache.size,
    freshMs: CACHE_TTL_FRESH_MS,
    staleMs: CACHE_TTL_STALE_MS,
  };
}

/**
 * Limpa o cache em memória + apaga o arquivo de disco (se existir) + bypassa
 * load-from-disk no próximo lookup. Usado apenas em testes para isolar runs.
 * NÃO chamar em produção.
 */
export async function __resetShopeeCategoryAttrsCacheForTests(): Promise<void> {
  memoryCache.clear();
  // Marca "loaded" pra que o próximo lookup não recarregue do disco
  // (que pode ter entries de outros tests/runs).
  diskLoaded = true;
  try {
    await fs.unlink(cacheFilePath());
  } catch {
    // arquivo pode não existir — ok
  }
}
