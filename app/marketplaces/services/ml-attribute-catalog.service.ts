import prisma from "@/app/lib/prisma";
import { MLApiService } from "./ml-api.service";

/**
 * Representação normalizada de um atributo ML com o essencial para o preflight.
 * value_type: string | boolean | number | number_unit | list | etc.
 * required: derivado das tags (required, catalog_required, fixed) ou value_type.
 */
export interface NormalizedMLAttribute {
  id: string;
  name: string;
  valueType: string;
  required: boolean;
  variationRequired: boolean;
  allowedValues?: Array<{ id: string; name: string }>;
  valueMaxLength?: number;
}

interface RawMLAttribute {
  id: string;
  name?: string;
  value_type?: string;
  tags?: Record<string, unknown>;
  values?: Array<{ id: string; name: string }>;
  value_max_length?: number;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const memoryCache = new Map<
  string,
  { attrs: NormalizedMLAttribute[]; expiresAt: number }
>();

function normalize(raw: RawMLAttribute): NormalizedMLAttribute {
  const tags = (raw.tags || {}) as Record<string, unknown>;
  const required = Boolean(
    tags.required || tags.catalog_required || tags.fixed,
  );
  const variationRequired = Boolean(tags.allow_variations);
  return {
    id: raw.id,
    name: raw.name || raw.id,
    valueType: raw.value_type || "string",
    required,
    variationRequired,
    allowedValues: Array.isArray(raw.values)
      ? raw.values
          .filter((v) => v && v.id && v.name)
          .map((v) => ({ id: String(v.id), name: String(v.name) }))
      : undefined,
    valueMaxLength:
      typeof raw.value_max_length === "number"
        ? raw.value_max_length
        : undefined,
  };
}

export class MLAttributeCatalogService {
  /**
   * Retorna todos os atributos da categoria (normalizados). Prioridade:
   * 1. cache em memória (TTL 24h)
   * 2. cache em Postgres (TTL 24h)
   * 3. API do ML (`GET /categories/{id}/attributes`)
   * Falhas de API nunca propagam — retornam [] para fail-open.
   */
  static async getAll(categoryId: string): Promise<NormalizedMLAttribute[]> {
    if (!categoryId) return [];
    const now = Date.now();
    const mem = memoryCache.get(categoryId);
    if (mem && mem.expiresAt > now) return mem.attrs;

    try {
      const row = await (prisma as any).mLCategoryAttributeCache.findUnique({
        where: { categoryId },
      });
      if (row && new Date(row.ttlExpiresAt).getTime() > now) {
        const attrs = Array.isArray(row.attributes)
          ? (row.attributes as NormalizedMLAttribute[])
          : [];
        memoryCache.set(categoryId, { attrs, expiresAt: now + CACHE_TTL_MS });
        return attrs;
      }
    } catch (err) {
      console.warn(
        `[MLAttributeCatalog] cache read failed for ${categoryId}:`,
        err instanceof Error ? err.message : String(err),
      );
    }

    try {
      const raw = (await MLApiService.getCategoryAttributes(
        categoryId,
      )) as RawMLAttribute[];
      const normalized = raw.map(normalize);
      const ttlExpiresAt = new Date(now + CACHE_TTL_MS);
      try {
        await (prisma as any).mLCategoryAttributeCache.upsert({
          where: { categoryId },
          update: {
            attributes: normalized as any,
            fetchedAt: new Date(now),
            ttlExpiresAt,
          },
          create: {
            categoryId,
            attributes: normalized as any,
            fetchedAt: new Date(now),
            ttlExpiresAt,
          },
        });
      } catch (err) {
        console.warn(
          `[MLAttributeCatalog] cache write failed for ${categoryId}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
      memoryCache.set(categoryId, {
        attrs: normalized,
        expiresAt: now + CACHE_TTL_MS,
      });
      console.log(
        JSON.stringify({
          event: "ml.attr_catalog.fetched",
          categoryId,
          count: normalized.length,
          required: normalized.filter((a) => a.required).length,
        }),
      );
      return normalized;
    } catch (err) {
      console.warn(
        JSON.stringify({
          event: "ml.attr_catalog.fetch_failed",
          categoryId,
          message: err instanceof Error ? err.message : String(err),
        }),
      );
      return [];
    }
  }

  /**
   * Só os obrigatórios. Conveniente para o preflight.
   */
  static async getRequired(
    categoryId: string,
  ): Promise<NormalizedMLAttribute[]> {
    const all = await this.getAll(categoryId);
    return all.filter((a) => a.required);
  }

  /** Limpa cache em memória (testes). */
  static _clearMemory() {
    memoryCache.clear();
  }
}
