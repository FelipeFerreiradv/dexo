/**
 * Mapa "tipo de peça → categoria por marketplace" + lookup.
 *
 * Chaves = labels canônicos do PART_TYPES (title-parse.ts), opcionalmente com a
 * POSIÇÃO dobrada ("parachoque-dianteiro"). O lookup tenta a chave dobrada
 * exata primeiro (taxonomias que distinguem posição) e cai para a chave-base
 * ("parachoque") — que é o caso comum.
 *
 * Fontes das entradas:
 *  - "prod-mode":        moda das categorias escolhidas manualmente na base,
 *                        aprovada nos gates do gerador (a mais confiável);
 *  - "domain-discovery": preenchida via API do ML para gaps, revisada à mão;
 *  - "manual":           curadoria direta (overrides ou seed).
 */

import { GENERATED_PART_TYPE_CATEGORY_MAP } from "./part-type-category-map.data";
import { PART_TYPE_CATEGORY_OVERRIDES } from "./part-type-category-map.overrides";

export interface PartTypeCategoryEntry {
  /** externalId MLB da FOLHA (ex.: "MLB417737" — Faróis). */
  ml?: string;
  /** id Shopee SEM prefixo (mesmo padrão de Product.shopeeCategoryId). */
  shopee?: string;
  /** uuid da categoria Magalu (complementa MAGALU_CATEGORY_MAP). */
  magaluId?: string;
  /** Termo canônico para a busca ao vivo da Magalu (fallback sem magaluId). */
  magaluTerm?: string;
  source: "prod-mode" | "domain-discovery" | "manual";
  /** Nº de produtos que sustentaram a moda na geração (auditoria). */
  sampleSize?: number;
}

export type PartTypeCategoryMap = Record<string, PartTypeCategoryEntry>;

/**
 * Override POR CAMPO de uma entrada gerada: campo com string substitui, campo
 * com null REMOVE (ex.: moda Shopee poluída numa chave cujo lado ML é bom),
 * campo ausente mantém o gerado. A chave inteira mapeada para null descarta a
 * entrada gerada.
 */
export interface PartTypeCategoryOverride {
  ml?: string | null;
  shopee?: string | null;
  magaluId?: string | null;
  magaluTerm?: string | null;
  source?: PartTypeCategoryEntry["source"];
}

function applyOverride(
  base: PartTypeCategoryEntry | undefined,
  override: PartTypeCategoryOverride,
): PartTypeCategoryEntry | null {
  const merged: PartTypeCategoryEntry = {
    ...(base ?? { source: "manual" as const }),
  };
  for (const field of ["ml", "shopee", "magaluId", "magaluTerm"] as const) {
    const value = override[field];
    if (value === null) delete merged[field];
    else if (value !== undefined) merged[field] = value;
  }
  if (override.source) merged.source = override.source;
  // Entrada sem nenhum destino de marketplace não vota em nada — descarta.
  if (!merged.ml && !merged.shopee && !merged.magaluId && !merged.magaluTerm)
    return null;
  return merged;
}

/** Mapa efetivo: gerado + overrides por campo (null remove chave/campo). */
export const PART_TYPE_CATEGORY_MAP: PartTypeCategoryMap = (() => {
  const merged: PartTypeCategoryMap = { ...GENERATED_PART_TYPE_CATEGORY_MAP };
  for (const [key, override] of Object.entries(PART_TYPE_CATEGORY_OVERRIDES)) {
    if (override === null) {
      delete merged[key];
      continue;
    }
    const entry = applyOverride(merged[key], override);
    if (entry) merged[key] = entry;
    else delete merged[key];
  }
  return merged;
})();

export interface PartTypeCategoryHit {
  entry: PartTypeCategoryEntry;
  /** Chave que casou ("parachoque-dianteiro" ou "parachoque"). */
  key: string;
  /**
   * true quando a chave casou COMO EXTRAÍDA do título (com ou sem posição) —
   * nenhuma informação foi descartada. false quando caiu para a chave-base
   * descartando a posição (a taxonomia pode distinguir posição e o mapa não
   * cobre a dobrada — leve incerteza a mais).
   */
  exact: boolean;
}

/**
 * Deriva a chave-base removendo o sufixo de posição dobrado por
 * `extractPartType` ("cubo-de-roda-dianteiro" + "dianteiro" → "cubo-de-roda").
 */
export function basePartTypeKey(
  partTypeFolded: string,
  position: string | null,
): string {
  if (!position) return partTypeFolded;
  const suffix = `-${position}`;
  return partTypeFolded.endsWith(suffix)
    ? partTypeFolded.slice(0, -suffix.length)
    : partTypeFolded;
}

/**
 * Lookup: chave dobrada exata primeiro, depois a chave-base. `partTypeFolded` e
 * `position` vêm de `parseTitleToParts` (title-parse.ts). null quando o tipo é
 * desconhecido ou não mapeado.
 */
export function lookupPartTypeCategory(
  partTypeFolded: string | null,
  position: string | null,
  map: PartTypeCategoryMap = PART_TYPE_CATEGORY_MAP,
): PartTypeCategoryHit | null {
  if (!partTypeFolded) return null;

  const exact = map[partTypeFolded];
  if (exact) return { entry: exact, key: partTypeFolded, exact: true };

  const baseKey = basePartTypeKey(partTypeFolded, position);
  if (baseKey !== partTypeFolded) {
    const base = map[baseKey];
    if (base) return { entry: base, key: baseKey, exact: false };
  }
  return null;
}
