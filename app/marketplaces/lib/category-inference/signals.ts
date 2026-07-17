/**
 * Sinais de inferência de categoria — funções puras (A) ou com deps injetáveis
 * (B), no padrão de category-leaf-resolver.ts: testáveis sem prisma, fail-safe
 * (sem dado → sem voto; nunca lança para o chamador).
 *
 * Todo voto sai no namespace da ÁRVORE LOCAL ("MLB…" / "SHP_<id>"). A conversão
 * de namespace (cuid do ML, id puro da Shopee) acontece AQUI, antes do voto.
 */

import type { TitleParts } from "../title-parse";
import {
  lookupPartTypeCategory,
  type PartTypeCategoryMap,
} from "./part-type-category-map";
import type { CategoryVote } from "./types";

const SHOPEE_PREFIX = "SHP_";

// ── Sinal A — mapa curado tipo-de-peça → categoria ─────────────────────────

/** Força quando a chave casa como extraída do título (nada foi descartado). */
const MAP_STRENGTH_EXACT = 0.9;
/** Força quando caiu para a chave-base descartando a posição do título. */
const MAP_STRENGTH_BASE = 0.85;
/** Desconto para entradas vindas do domain_discovery (não validadas na base). */
const DOMAIN_DISCOVERY_FACTOR = 0.85;

/**
 * Sinal A: tipo de peça extraído do título → categoria do mapa curado.
 * Síncrono e puro. null quando não há partType ou o mapa não cobre o
 * marketplace pedido.
 */
export function partTypeMapVote(
  siteId: string,
  parts: Pick<TitleParts, "partType" | "position">,
  map?: PartTypeCategoryMap,
): CategoryVote | null {
  const hit = lookupPartTypeCategory(parts.partType, parts.position, map);
  if (!hit) return null;

  let externalId: string | null = null;
  if (siteId === "MLB") externalId = hit.entry.ml ?? null;
  else if (siteId === "SHP")
    externalId = hit.entry.shopee ? `${SHOPEE_PREFIX}${hit.entry.shopee}` : null;
  if (!externalId) return null;

  let strength = hit.exact ? MAP_STRENGTH_EXACT : MAP_STRENGTH_BASE;
  if (hit.entry.source === "domain-discovery") strength *= DOMAIN_DISCOVERY_FACTOR;

  return {
    externalId,
    strength,
    signal: "part-type-map",
    reason: `tipo de peça "${hit.key}" → mapa curado (${hit.entry.source})`,
  };
}

// ── Sinal B — base interna agregada (CatalogStat) ───────────────────────────

/** Select mínimo da linha do CatalogStat que interessa ao sinal (egress-lean). */
export interface CatalogStatModes {
  mlCategoryIdMode: string | null;
  mlCategoryIdModeCount: number | null;
  shopeeCategoryIdMode: string | null;
  shopeeCategoryIdModeCount: number | null;
  sampleSize: number;
}

export interface CatalogStatDeps {
  /** Família exata (partType|brand|model, version-agnóstica). */
  findFamilyModes(where: {
    partType: string;
    brand: string;
    model: string;
  }): Promise<CatalogStatModes | null>;
  /** Família partType-only (partType|*|*) — existe a partir do job ampliado. */
  findPartTypeOnlyModes(partType: string): Promise<CatalogStatModes | null>;
  /** Moda ML é cuid (FK) — converte para externalId da árvore. */
  mlCuidToExternalId(cuid: string): Promise<string | null>;
}

/**
 * Gate: a moda precisa cobrir ≥ 50% da amostra para votar. Validação com 800
 * produtos reais mostrou que moda difusa (ex.: 6% numa família heterogênea de
 * "tampa"/"vidro") vira voto forte errado sem este piso — mesma filosofia do
 * gate modeShare do gerador do mapa.
 */
const MIN_MODE_SHARE = 0.5;
/** Desconto da família partType-only sobre a fórmula da família exata. */
const PART_TYPE_ONLY_FACTOR = 0.75;
/** Teto da força na família partType-only. */
const PART_TYPE_ONLY_CAP = 0.65;

/**
 * Força da família exata: cresce com o tamanho da amostra (log) e com a fração
 * da amostra coberta pela moda. Ex.: 10 produtos, moda 80% → 0.82; 100
 * produtos, moda 100% → 0.85 (cap).
 */
function familyStrength(sampleSize: number, modeShare: number): number {
  return Math.min(
    0.85,
    0.55 + 0.15 * Math.log10(Math.max(1, sampleSize)) + 0.15 * modeShare,
  );
}

/**
 * Sinal B: moda de categoria da base interna. Tenta a família exata
 * (partType+brand+model) e cai para a família partType-only. Fail-safe: sem
 * linha, sem moda, cuid órfão ou erro → sem voto.
 */
export async function catalogStatVote(
  siteId: string,
  parts: Pick<TitleParts, "partType" | "brand" | "model">,
  deps: CatalogStatDeps,
): Promise<CategoryVote | null> {
  if (!parts.partType) return null;

  try {
    if (parts.brand && parts.model) {
      const family = await deps.findFamilyModes({
        partType: parts.partType,
        brand: parts.brand,
        model: parts.model,
      });
      const vote = await voteFromModes(siteId, family, deps, {
        factor: 1,
        cap: 0.85,
        minModeShare: MIN_MODE_SHARE,
        reason: (n) =>
          `base interna: moda de ${n} produtos da família ${parts.partType}|${parts.brand}|${parts.model}`,
      });
      if (vote) return vote;
    }

    const partTypeOnly = await deps.findPartTypeOnlyModes(parts.partType);
    return await voteFromModes(siteId, partTypeOnly, deps, {
      factor: PART_TYPE_ONLY_FACTOR,
      cap: PART_TYPE_ONLY_CAP,
      minModeShare: MIN_MODE_SHARE,
      reason: (n) =>
        `base interna: moda de ${n} produtos do tipo ${parts.partType}`,
    });
  } catch {
    return null;
  }
}

async function voteFromModes(
  siteId: string,
  modes: CatalogStatModes | null,
  deps: Pick<CatalogStatDeps, "mlCuidToExternalId">,
  opts: {
    factor: number;
    cap: number;
    minModeShare: number;
    reason: (sampleSize: number) => string;
  },
): Promise<CategoryVote | null> {
  if (!modes || modes.sampleSize <= 0) return null;

  let mode: string | null = null;
  let modeCount = 0;
  if (siteId === "MLB") {
    mode = modes.mlCategoryIdMode;
    modeCount = modes.mlCategoryIdModeCount ?? 0;
  } else if (siteId === "SHP") {
    mode = modes.shopeeCategoryIdMode;
    modeCount = modes.shopeeCategoryIdModeCount ?? 0;
  }
  if (!mode || modeCount <= 0) return null;

  const modeShare = Math.min(1, modeCount / modes.sampleSize);
  if (modeShare < opts.minModeShare) return null;

  const externalId =
    siteId === "MLB"
      ? await deps.mlCuidToExternalId(mode)
      : `${SHOPEE_PREFIX}${mode}`;
  if (!externalId) return null;

  const strength = Math.min(
    opts.cap,
    familyStrength(modes.sampleSize, modeShare) * opts.factor,
  );

  return {
    externalId,
    strength,
    signal: "catalog-stat",
    reason: opts.reason(modes.sampleSize),
  };
}
