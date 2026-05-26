import { promises as fs } from "fs";
import { join } from "path";
import prisma from "@/app/lib/prisma";

/**
 * Catálogo persistente de atributos de categoria Shopee.
 *
 * Substitui o cache disco-only anterior (.cache/shopee-category-attrs.json).
 * Motivação: a API /api/v2/product/get_attributes retorna 403 em algumas
 * categorias mesmo com o app autorizado. O catálogo em DB sobrevive deploys,
 * é compartilhado entre instâncias, e permite harvest cross-account.
 *
 * Estratégia 3-tier:
 *   1. Memória (TTL 24h, process-local)
 *   2. DB ShopeeCategoryAttribute (TTL 24h fresh, 30d stale-fallback)
 *   3. Live API via callback fetchLive (caller injeta a credencial certa)
 *   4. Harvest via callback (caller decide se busca em listing existente)
 *
 * Fail-closed: retorna null quando todos os caminhos falham. Caller deve
 * abortar a criação com erro terminal — NÃO emitir payload com
 * attribute_id=0, que a Shopee rejeita por contrato.
 */

const FRESH_TTL_MS = 24 * 60 * 60 * 1000;
const STALE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface MemoryEntry {
  attribute_list: any[];
  cachedAt: number;
}

const memoryCache = new Map<string, MemoryEntry>();
let diskSeedingAttempted = false;

function memKey(region: string, categoryId: number, locale: string): string {
  return `${region}:${categoryId}:${locale}`;
}

function legacyDiskCachePath(): string {
  return join(process.cwd(), ".cache", "shopee-category-attrs.json");
}

/**
 * One-shot: lê o arquivo .cache/shopee-category-attrs.json (formato legado
 * com chave `${shopId}:${categoryId}:${locale}`) e popula a tabela
 * ShopeeCategoryAttribute, descartando o shopId (a chave nova é por região).
 * Idempotente via upsert. Não deleta o arquivo. Roda no máximo uma vez por
 * processo — chamado lazy no primeiro lookup.
 */
async function seedFromDiskOnce(region: string): Promise<void> {
  if (diskSeedingAttempted) return;
  diskSeedingAttempted = true;
  let raw: string;
  try {
    raw = await fs.readFile(legacyDiskCachePath(), "utf-8");
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      console.warn(
        `[ShopeeAttrCatalog] failed to read legacy disk cache:`,
        err?.message || err,
      );
    }
    return;
  }
  let parsed: Record<string, { attribute_list: unknown; cachedAt: unknown }>;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(
      `[ShopeeAttrCatalog] failed to parse legacy disk cache:`,
      err instanceof Error ? err.message : String(err),
    );
    return;
  }
  let seeded = 0;
  for (const [k, v] of Object.entries(parsed)) {
    if (
      !v ||
      typeof v !== "object" ||
      !Array.isArray(v.attribute_list) ||
      typeof v.cachedAt !== "number"
    ) {
      continue;
    }
    const parts = k.split(":");
    if (parts.length !== 3) continue;
    const categoryId = Number(parts[1]);
    const locale = parts[2];
    if (!Number.isFinite(categoryId) || categoryId <= 0 || !locale) continue;
    if (!validateAttributeList(v.attribute_list)) continue;
    try {
      await (prisma as any).shopeeCategoryAttribute.upsert({
        where: {
          region_categoryId_locale: { region, categoryId, locale },
        },
        update: {},
        create: {
          region,
          categoryId,
          locale,
          attributes: v.attribute_list as any,
          source: "seeded_from_disk",
          fetchedAt: new Date(v.cachedAt),
          ttlExpiresAt: new Date(v.cachedAt + FRESH_TTL_MS),
        },
      });
      seeded += 1;
    } catch (err) {
      console.warn(
        `[ShopeeAttrCatalog] failed to seed entry ${k}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  if (seeded > 0) {
    console.log(
      JSON.stringify({
        event: "shopee.attr_catalog.disk_seeded",
        count: seeded,
        region,
      }),
    );
  }
}

function validateAttributeList(list: unknown): list is any[] {
  if (!Array.isArray(list)) return false;
  for (const a of list) {
    if (!a || typeof a !== "object") return false;
    if (typeof (a as any).attribute_id !== "number") return false;
    if (typeof (a as any).attribute_name !== "string") return false;
  }
  return true;
}

export type ShopeeAttrSource =
  | "memory"
  | "db_fresh"
  | "db_stale"
  | "live"
  | "harvested";

export interface ShopeeAttrResolution {
  attribute_list: any[];
  source: ShopeeAttrSource;
}

export interface ShopeeAttrFetchOptions {
  /** Faz a chamada live à Shopee usando a credencial certa do account chamador. */
  fetchLive: () => Promise<{ attribute_list: any[] } | null | undefined>;
  /**
   * Tenta extrair attribute_list de algum listing ativo na mesma categoria,
   * em qualquer conta da plataforma. Retorna null se nenhuma fonte disponível.
   */
  harvest?: () => Promise<any[] | null | undefined>;
}

export class ShopeeAttributeCatalogService {
  /**
   * Resolve attribute_list da categoria. Tenta na ordem:
   *   memória → DB fresh → live (fetchLive) → harvest → DB stale.
   * Retorna null se TUDO falhar. Não lança erro — caller decide o erro
   * terminal user-facing.
   */
  static async getCategoryAttributes(
    region: string,
    categoryId: number,
    locale: string,
    opts: ShopeeAttrFetchOptions,
  ): Promise<ShopeeAttrResolution | null> {
    if (!region || !categoryId || !locale) return null;
    const now = Date.now();
    const k = memKey(region, categoryId, locale);

    // 1. Memória (process-local, TTL 24h)
    const mem = memoryCache.get(k);
    if (mem && now - mem.cachedAt < FRESH_TTL_MS && mem.attribute_list.length) {
      return { attribute_list: mem.attribute_list, source: "memory" };
    }

    // Seed lazy do disco para o primeiro lookup do processo
    await seedFromDiskOnce(region);

    // 2. DB fresh
    interface DbRow {
      attributes: unknown;
      ttlExpiresAt: Date;
      fetchedAt: Date;
    }
    let dbRow: DbRow | null = null;
    try {
      dbRow = (await (prisma as any).shopeeCategoryAttribute.findUnique({
        where: {
          region_categoryId_locale: { region, categoryId, locale },
        },
        select: {
          attributes: true,
          ttlExpiresAt: true,
          fetchedAt: true,
        },
      })) as DbRow | null;
    } catch (err) {
      console.warn(
        JSON.stringify({
          event: "shopee.attr_catalog.db_read_failed",
          region,
          categoryId,
          locale,
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    }
    if (dbRow && Array.isArray(dbRow.attributes)) {
      const isFresh = dbRow.ttlExpiresAt.getTime() > now;
      const isStaleButUsable =
        !isFresh &&
        now - dbRow.fetchedAt.getTime() < STALE_TTL_MS;
      if (isFresh && (dbRow.attributes as any[]).length > 0) {
        const list = dbRow.attributes as any[];
        memoryCache.set(k, { attribute_list: list, cachedAt: now });
        return { attribute_list: list, source: "db_fresh" };
      }
      // Guarda referência stale para fallback abaixo se live+harvest falharem
      if (isStaleButUsable && (dbRow.attributes as any[]).length > 0) {
        // continua para tentar live primeiro
      }
    }

    // 3. Live API
    let liveError: unknown = null;
    try {
      const live = await opts.fetchLive();
      if (live && Array.isArray(live.attribute_list)) {
        const list = live.attribute_list;
        // Live respondeu com sucesso — guarda no catálogo (mesmo vazio:
        // categoria sem atributos é um caso real e legítimo).
        if (validateAttributeList(list) && list.length > 0) {
          await this.putCategoryAttributes(
            region,
            categoryId,
            locale,
            list,
            "live",
          );
        }
        // Lista vazia legítima → retorna com source=live, caller decide.
        // Lista populada → idem. Lista malformada → cai abaixo.
        if (
          list.length === 0 ||
          (validateAttributeList(list) && list.length > 0)
        ) {
          memoryCache.set(k, { attribute_list: list, cachedAt: now });
          return { attribute_list: list, source: "live" };
        }
      }
    } catch (err) {
      liveError = err;
    }

    // 4. Harvest (cross-account) — apenas se live falhou
    if (opts.harvest) {
      try {
        const harvested = await opts.harvest();
        if (
          harvested &&
          validateAttributeList(harvested) &&
          harvested.length > 0
        ) {
          await this.putCategoryAttributes(
            region,
            categoryId,
            locale,
            harvested,
            "harvested",
          );
          return { attribute_list: harvested, source: "harvested" };
        }
      } catch (err) {
        console.warn(
          JSON.stringify({
            event: "shopee.attr_catalog.harvest_failed",
            region,
            categoryId,
            locale,
            message: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }

    // 5. DB stale (último recurso — melhor schema antigo do que nada)
    if (dbRow && Array.isArray(dbRow.attributes)) {
      const ageMs = now - dbRow.fetchedAt.getTime();
      if (
        ageMs < STALE_TTL_MS &&
        (dbRow.attributes as any[]).length > 0
      ) {
        console.warn(
          JSON.stringify({
            event: "shopee.attr_catalog.using_stale",
            region,
            categoryId,
            locale,
            ageMs,
            reason: liveError ? "live_failed" : "live_empty",
          }),
        );
        const list = dbRow.attributes as any[];
        memoryCache.set(k, { attribute_list: list, cachedAt: now });
        return { attribute_list: list, source: "db_stale" };
      }
    }

    return null;
  }

  /**
   * Upsert direto no catálogo. Usado pelo fluxo interno e pelo script de sync.
   * Valida o shape antes de gravar — entries malformadas viram log warning
   * e são descartadas em vez de poluir o catálogo.
   */
  static async putCategoryAttributes(
    region: string,
    categoryId: number,
    locale: string,
    attribute_list: any[],
    source: "live" | "harvested" | "seeded_from_disk",
  ): Promise<void> {
    if (!validateAttributeList(attribute_list) || attribute_list.length === 0) {
      console.warn(
        JSON.stringify({
          event: "shopee.attr_catalog.put_rejected",
          region,
          categoryId,
          locale,
          reason: "invalid_or_empty_attribute_list",
        }),
      );
      return;
    }
    const now = Date.now();
    const fetchedAt = new Date(now);
    const ttlExpiresAt = new Date(now + FRESH_TTL_MS);
    try {
      await (prisma as any).shopeeCategoryAttribute.upsert({
        where: {
          region_categoryId_locale: { region, categoryId, locale },
        },
        update: {
          attributes: attribute_list as any,
          source,
          fetchedAt,
          ttlExpiresAt,
        },
        create: {
          region,
          categoryId,
          locale,
          attributes: attribute_list as any,
          source,
          fetchedAt,
          ttlExpiresAt,
        },
      });
    } catch (err) {
      console.warn(
        JSON.stringify({
          event: "shopee.attr_catalog.db_write_failed",
          region,
          categoryId,
          locale,
          source,
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    }
    memoryCache.set(memKey(region, categoryId, locale), {
      attribute_list,
      cachedAt: now,
    });
  }

  /** Reseta cache de memória + flag de seed (apenas para testes). */
  static _resetForTests(): void {
    memoryCache.clear();
    diskSeedingAttempted = true; // bypassa leitura de disco em testes
  }
}
