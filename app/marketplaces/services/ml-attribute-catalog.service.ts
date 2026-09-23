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
  /**
   * Sinal do PRÓPRIO ML (tags.hidden) de que o atributo não deve aparecer no
   * formulário. Opcional para retrocompatibilidade com o cache de 24h: linhas
   * antigas sem o campo = undefined (falsy) = comportamento atual.
   */
  hidden?: boolean;
  /**
   * Tags CRUAS do ML, separadas. O `required` acima junta tudo
   * (`required || catalog_required || fixed`) e continua assim — é o que o
   * asterisco do formulário e o preflight antigo leem. A regra de bloqueio de
   * obrigatórios (ml-required-attributes.logic) precisa distinguir: só
   * `required` sem `fixed` bloqueia.
   *
   * Gravados SEMPRE como booleano (inclusive false). `undefined` = linha antiga
   * do cache de 24h = tags desconhecidas = a regra nova não bloqueia.
   */
  requiredTag?: boolean;
  catalogRequiredTag?: boolean;
  conditionalRequiredTag?: boolean;
  fixedTag?: boolean;
  /**
   * Metadados que a validação de VALORES (ml-attribute-value-validation.logic)
   * lê. Opcionais: linha antiga do cache de 24h não os tem ⇒ a regra que
   * depende de cada um não roda (comportamento de antes).
   *   - allowedUnits/defaultUnit: `allowed_units`/`default_unit` de atributo
   *     `number_unit` (o ML recusa número sem unidade com 3708);
   *   - multivaluedTag: `tags.multivalued` (395 "too many values");
   *   - readOnlyTag: `tags.read_only` (o ML ignora o valor, aviso 303).
   */
  allowedUnits?: string[];
  defaultUnit?: string;
  multivaluedTag?: boolean;
  readOnlyTag?: boolean;
}

export interface RawMLAttribute {
  id: string;
  name?: string;
  value_type?: string;
  tags?: Record<string, unknown>;
  values?: Array<{ id: string; name: string }>;
  value_max_length?: number;
  allowed_units?: Array<{ id?: string; name?: string }>;
  default_unit?: string;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const memoryCache = new Map<
  string,
  { attrs: NormalizedMLAttribute[]; expiresAt: number; legacyOk?: boolean }
>();

/**
 * Linha gravada ANTES dos metadados de valor (unidades, multivalued,
 * read_only): nenhum atributo tem `readOnlyTag` definido. Tratada como
 * vencida uma vez — sem isso, por até 24-48 h um GTIN read_only inválido era
 * BLOQUEADO em vez de sair do payload (a regra não sabia que era read_only).
 */
function formatoAntigo(attrs: NormalizedMLAttribute[]): boolean {
  return attrs.length > 0 && attrs.every((a) => a.readOnlyTag === undefined);
}

/** Enquanto a API do ML falhar, a linha antiga serve por este tempo. */
const LEGACY_RETRY_MS = 10 * 60 * 1000;

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
    hidden: Boolean(tags.hidden),
    requiredTag: Boolean(tags.required),
    catalogRequiredTag: Boolean(tags.catalog_required),
    conditionalRequiredTag: Boolean(tags.conditional_required),
    fixedTag: Boolean(tags.fixed),
    allowedValues: Array.isArray(raw.values)
      ? raw.values
          .filter((v) => v && v.id && v.name)
          .map((v) => ({ id: String(v.id), name: String(v.name) }))
      : undefined,
    valueMaxLength:
      typeof raw.value_max_length === "number"
        ? raw.value_max_length
        : undefined,
    allowedUnits: Array.isArray(raw.allowed_units)
      ? raw.allowed_units
          .map((u) => String(u?.id ?? u?.name ?? "").trim())
          .filter(Boolean)
      : undefined,
    defaultUnit:
      typeof raw.default_unit === "string" && raw.default_unit.trim()
        ? raw.default_unit.trim()
        : undefined,
    multivaluedTag: Boolean(tags.multivalued),
    readOnlyTag: Boolean(tags.read_only),
  };
}

/**
 * Exposto para o script de prova e para os testes normalizarem o JSON CRU de
 * GET /categories/{id}/attributes (fixtures e snapshot) pelo MESMO caminho do
 * cache — sem passar pelo getAll, que chamaria a API e gravaria no Postgres.
 */
export const normalizeMLCategoryAttribute = normalize;

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
    if (mem && mem.expiresAt > now && (mem.legacyOk || !formatoAntigo(mem.attrs))) {
      return mem.attrs;
    }

    // Linha válida mas de formato antigo: tenta renovar; se o ML falhar,
    // devolve ela mesma (nunca [] — isso desligaria o preflight inteiro).
    let reserva: NormalizedMLAttribute[] | null = null;
    try {
      const row = await (prisma as any).mLCategoryAttributeCache.findUnique({
        where: { categoryId },
      });
      if (row && new Date(row.ttlExpiresAt).getTime() > now) {
        const attrs = Array.isArray(row.attributes)
          ? (row.attributes as NormalizedMLAttribute[])
          : [];
        if (!formatoAntigo(attrs)) {
          memoryCache.set(categoryId, { attrs, expiresAt: now + CACHE_TTL_MS });
          return attrs;
        }
        reserva = attrs;
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
          servedLegacy: !!reserva,
        }),
      );
      if (reserva) {
        memoryCache.set(categoryId, {
          attrs: reserva,
          expiresAt: now + LEGACY_RETRY_MS,
          legacyOk: true,
        });
        return reserva;
      }
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
