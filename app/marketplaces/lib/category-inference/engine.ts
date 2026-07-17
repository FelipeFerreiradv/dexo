/**
 * Orquestra a coleta de votos dos sinais de inferência (A: mapa curado, B:
 * base interna) para um título. Este é o ÚNICO arquivo do módulo que conhece o
 * prisma — os sinais continuam puros com deps injetáveis.
 *
 * Contratos de segurança:
 *  - FAIL-OPEN: qualquer erro (DB fora, dado corrompido) → lista vazia de
 *    votos; o chamador segue com o comportamento atual;
 *  - EGRESS-LEAN: selects mínimos (5 colunas do CatalogStat, 1 coluna de
 *    MarketplaceCategory), tudo atrás de caches Map+TTL por processo;
 *  - as consultas ao CatalogStat usam as MESMAS colunas kebab do
 *    /internal/suggest (buildLookupColumns), version-agnósticas ("*").
 */

import prisma from "../../../lib/prisma";
import {
  buildLookupColumns,
  normalizeText,
  parseTitleToParts,
} from "../title-parse";
import { AMBIGUOUS_LABELS } from "./map-generation";
import { basePartTypeKey } from "./part-type-category-map";
import {
  catalogStatVote,
  partTypeMapVote,
  type CatalogStatDeps,
  type CatalogStatModes,
} from "./signals";
import type { CategoryVote } from "./types";

export interface CategoryInferenceResult {
  votes: CategoryVote[];
  /** Label-base do tipo de peça ("amortecedor") — alimenta o pieceType da sugestão. */
  pieceType: string | null;
}

const EMPTY_RESULT: CategoryInferenceResult = { votes: [], pieceType: null };

/**
 * Palavras de COMPONENTE que o PART_TYPES não conhece: quando presentes, o
 * tipo extraído é o da peça-MÃE, não do que está à venda ("REATOR farol",
 * "DOBRADIÇA capô", "PARAFUSOS do cabeçote", "CINTA airbag" — casos reais da
 * validação com 800 produtos). Título composto → conservador: sem voto.
 */
const COMPONENT_BLOCKERS = [
  "dobradica",
  "parafuso",
  "reator",
  "cinta",
  "moldura",
  "engrenagem",
  "interruptor",
  "reparo",
  "carcaca",
];

/**
 * true quando o título é COMPOSTO demais para a inferência votar com
 * segurança: contém palavra de componente desconhecida do vocabulário, ou um
 * label ambíguo ("tampa", "caixa") fora do próprio tipo extraído ("Lanterna
 * TAMPA Voyage" = lanterna DA tampa, folha diferente de Faróis Traseiros).
 */
function isCompoundTitle(title: string, partTypeFolded: string): boolean {
  const tokens = normalizeText(title).split(/[^a-z0-9]+/);
  for (const token of tokens) {
    if (token.length < 4) continue;
    for (const blocker of COMPONENT_BLOCKERS) {
      if (token.startsWith(blocker)) return true;
    }
    for (const ambiguous of AMBIGUOUS_LABELS) {
      if (
        token.startsWith(ambiguous) &&
        token.length - ambiguous.length <= 2 &&
        !partTypeFolded.includes(ambiguous)
      )
        return true;
    }
  }
  return false;
}

const MODES_SELECT = {
  mlCategoryIdMode: true,
  mlCategoryIdModeCount: true,
  shopeeCategoryIdMode: true,
  shopeeCategoryIdModeCount: true,
  sampleSize: true,
} as const;

const MODES_CACHE_TTL_MS = 5 * 60 * 1000;
const CUID_CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_MAX_ENTRIES = 2000;

type CacheEntry<T> = { data: T; exp: number };

function cacheGet<T>(map: Map<string, CacheEntry<T>>, key: string): T | undefined {
  const hit = map.get(key);
  if (!hit) return undefined;
  if (hit.exp <= Date.now()) {
    map.delete(key);
    return undefined;
  }
  return hit.data;
}

function cacheSet<T>(
  map: Map<string, CacheEntry<T>>,
  key: string,
  data: T,
  ttl: number,
) {
  if (map.size >= CACHE_MAX_ENTRIES) {
    const first = map.keys().next().value;
    if (first !== undefined) map.delete(first);
  }
  map.set(key, { data, exp: Date.now() + ttl });
}

export class CategoryInferenceEngine {
  private static modesCache = new Map<string, CacheEntry<CatalogStatModes | null>>();
  private static cuidCache = new Map<string, CacheEntry<string | null>>();

  private static deps: CatalogStatDeps = {
    async findFamilyModes(where) {
      const cols = buildLookupColumns({
        partType: where.partType,
        brand: where.brand,
        model: where.model,
        version: null,
      });
      const key = `fam|${cols.partType}|${cols.brand}|${cols.model}`;
      const cached = cacheGet(CategoryInferenceEngine.modesCache, key);
      if (cached !== undefined) return cached;
      const row = await prisma.catalogStat.findFirst({
        where: {
          partType: cols.partType,
          brand: cols.brand,
          model: cols.model,
          version: "*",
        },
        select: MODES_SELECT,
        orderBy: { sampleSize: "desc" },
      });
      cacheSet(CategoryInferenceEngine.modesCache, key, row, MODES_CACHE_TTL_MS);
      return row;
    },

    async findPartTypeOnlyModes(partType) {
      const cols = buildLookupColumns({
        partType,
        brand: null,
        model: null,
        version: null,
      });
      const key = `pt|${cols.partType}`;
      const cached = cacheGet(CategoryInferenceEngine.modesCache, key);
      if (cached !== undefined) return cached;
      // Linhas partType-only (brand="*", model="*") só existem a partir do job
      // ampliado — até lá isto retorna null e o sinal degrada graciosamente.
      const row = await prisma.catalogStat.findFirst({
        where: { partType: cols.partType, brand: "*", model: "*", version: "*" },
        select: MODES_SELECT,
        orderBy: { sampleSize: "desc" },
      });
      cacheSet(CategoryInferenceEngine.modesCache, key, row, MODES_CACHE_TTL_MS);
      return row;
    },

    async mlCuidToExternalId(cuid) {
      const cached = cacheGet(CategoryInferenceEngine.cuidCache, cuid);
      if (cached !== undefined) return cached;
      const cat = await prisma.marketplaceCategory.findUnique({
        where: { id: cuid },
        select: { externalId: true },
      });
      const externalId = cat?.externalId ?? null;
      cacheSet(CategoryInferenceEngine.cuidCache, cuid, externalId, CUID_CACHE_TTL_MS);
      return externalId;
    },
  };

  /**
   * Coleta os votos dos sinais novos para um título. Nunca lança: erro em
   * qualquer sinal → aquele sinal fica de fora (e erro total → sem votos).
   */
  static async collectVotes(
    siteId: string,
    title: string,
  ): Promise<CategoryInferenceResult> {
    try {
      const parts = parseTitleToParts(title);
      if (!parts.partType) return EMPTY_RESULT;

      // Labels ambíguos não determinam categoria (nem via mapa nem via base
      // interna — o CatalogStat agrupa "tampa"/"sensor" heterogêneos).
      const baseLabel = basePartTypeKey(parts.partType, parts.position);
      if (AMBIGUOUS_LABELS.has(baseLabel)) return EMPTY_RESULT;

      // Título composto (componente de outra peça) → sem voto.
      if (isCompoundTitle(title, parts.partType)) return EMPTY_RESULT;

      const votes: CategoryVote[] = [];
      const mapVote = partTypeMapVote(siteId, parts);
      if (mapVote) votes.push(mapVote);

      const statVote = await catalogStatVote(siteId, parts, this.deps);
      if (statVote) votes.push(statVote);

      return {
        votes,
        pieceType: basePartTypeKey(parts.partType, parts.position),
      };
    } catch {
      return EMPTY_RESULT;
    }
  }

  /** Apenas para testes — limpa os caches em memória. */
  static __clearCache() {
    this.modesCache.clear();
    this.cuidCache.clear();
  }
}
