/**
 * Núcleo PURO de agregação do job scripts/build-catalog-stats.ts.
 *
 * Sem DB, sem I/O: recebe os valores brutos de uma "família" de produtos
 * (já agrupados por colunas de lookup) e devolve a linha agregada do CatalogStat,
 * ou null quando a amostra é insuficiente (< MIN_SAMPLE). Toda a estatística
 * (mediana, corte IQR, moda, união) e o filtro de lixo vivem aqui para serem
 * testáveis isoladamente.
 *
 * Decisões fechadas:
 *  - "valor médio" = mediana de `price` (NUNCA costPrice/markup).
 *  - Unidades: SÓ descartar valores absurdos, nunca converter (decisão do Felipe).
 *  - Gate de privacidade: persistir só famílias com >= 5 membros.
 */

import { buildMatchKey, normalizeText } from "./title-parse";
import type { AttrMap, CompatLike } from "@/app/produtos/lib/suggestion-merge";

export const MIN_SAMPLE = 5;
export const MIN_MODE_FREQ = 2;
export const MAX_COMPAT = 20;

// Faixas plausíveis para autopeças. Fora delas = descartar o valor do campo
// (o produto ainda contribui com os demais campos válidos).
export const SANITY = {
  priceMin: 0.01,
  priceMax: 1_000_000,
  weightKgMin: 0.01,
  weightKgMax: 200,
  dimMinCm: 1,
  dimMaxCm: 400,
  yearMin: 1900,
  yearMax: 2100,
};

export const isValidPrice = (n: unknown): n is number =>
  typeof n === "number" &&
  Number.isFinite(n) &&
  n >= SANITY.priceMin &&
  n <= SANITY.priceMax;
export const isValidWeight = (n: unknown): n is number =>
  typeof n === "number" &&
  Number.isFinite(n) &&
  n >= SANITY.weightKgMin &&
  n <= SANITY.weightKgMax;
export const isValidDim = (n: unknown): n is number =>
  typeof n === "number" &&
  Number.isFinite(n) &&
  n >= SANITY.dimMinCm &&
  n <= SANITY.dimMaxCm;
export const isValidYear = (n: unknown): n is number =>
  typeof n === "number" &&
  Number.isFinite(n) &&
  n >= SANITY.yearMin &&
  n <= SANITY.yearMax;

/** Mediana (par → média dos dois centrais). Retorna null para lista vazia. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

/** Quantil por interpolação linear (tipo-7, igual ao numpy/Excel). */
export function quantile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return NaN;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const pos = (sortedAsc.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedAsc[lo];
  const frac = pos - lo;
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * frac;
}

/** Sobreviventes ao corte IQR [Q1-1.5·IQR, Q3+1.5·IQR]. */
export function iqrSurvivors(values: number[]): number[] {
  if (values.length < 4) return [...values];
  const s = [...values].sort((a, b) => a - b);
  const q1 = quantile(s, 0.25);
  const q3 = quantile(s, 0.75);
  const iqr = q3 - q1;
  const lo = q1 - 1.5 * iqr;
  const hi = q3 + 1.5 * iqr;
  return s.filter((v) => v >= lo && v <= hi);
}

/**
 * Moda + frequência. Conta por `keyFn`, devolve o PRIMEIRO item original com a
 * chave vencedora (preserva display). Empate: maior contagem, depois menor chave
 * (determinístico).
 */
export function modeOf<T>(
  items: T[],
  keyFn: (t: T) => string,
): { value: T; count: number } | null {
  if (items.length === 0) return null;
  const map = new Map<string, { count: number; first: T }>();
  for (const it of items) {
    const k = keyFn(it);
    if (k.length === 0) continue;
    const e = map.get(k);
    if (e) e.count++;
    else map.set(k, { count: 1, first: it });
  }
  if (map.size === 0) return null;
  let bestKey: string | null = null;
  let best: { count: number; first: T } | null = null;
  for (const [k, e] of map) {
    if (
      best === null ||
      e.count > best.count ||
      (e.count === best.count && k < (bestKey as string))
    ) {
      best = e;
      bestKey = k;
    }
  }
  return best ? { value: best.first, count: best.count } : null;
}

/** União deduplicada e ranqueada por frequência das compatibilidades. */
export function rankCompatibilities(
  compats: CompatLike[],
): Array<{
  brand: string;
  model: string;
  yearFrom: number | null;
  yearTo: number | null;
  version: string | null;
  freq: number;
}> {
  const map = new Map<
    string,
    {
      brand: string;
      model: string;
      yearFrom: number | null;
      yearTo: number | null;
      version: string | null;
      freq: number;
    }
  >();
  for (const c of compats) {
    if (!c || !c.brand || !c.model) continue;
    const key = [
      normalizeText(c.brand),
      normalizeText(c.model),
      c.yearFrom ?? "",
      c.yearTo ?? "",
      normalizeText(c.version ?? ""),
    ].join("|");
    const e = map.get(key);
    if (e) {
      e.freq++;
    } else {
      map.set(key, {
        brand: c.brand,
        model: c.model,
        yearFrom: c.yearFrom ?? null,
        yearTo: c.yearTo ?? null,
        version: c.version ?? null,
        freq: 1,
      });
    }
  }
  return Array.from(map.values())
    .sort((a, b) => b.freq - a.freq)
    .slice(0, MAX_COMPAT);
}

/** Por chave de atributo, o valor mais frequente (+freq). Pula freq < MIN_MODE_FREQ. */
export function topAttributes(
  attrsList: AttrMap[],
): Record<string, { value_id?: string; value_name?: string; freq: number }> {
  const perAttr = new Map<
    string,
    Map<string, { value_id?: string; value_name?: string; count: number }>
  >();
  for (const attrs of attrsList) {
    if (!attrs || typeof attrs !== "object") continue;
    for (const [attrId, val] of Object.entries(attrs)) {
      if (!val) continue;
      const valKey = val.value_id ?? normalizeText(val.value_name);
      if (!valKey) continue;
      let inner = perAttr.get(attrId);
      if (!inner) {
        inner = new Map();
        perAttr.set(attrId, inner);
      }
      const e = inner.get(valKey);
      if (e) e.count++;
      else
        inner.set(valKey, {
          value_id: val.value_id,
          value_name: val.value_name,
          count: 1,
        });
    }
  }
  const out: Record<
    string,
    { value_id?: string; value_name?: string; freq: number }
  > = {};
  for (const [attrId, inner] of perAttr) {
    let best: { value_id?: string; value_name?: string; count: number } | null =
      null;
    let bestKey = "";
    for (const [k, e] of inner) {
      if (
        best === null ||
        e.count > best.count ||
        (e.count === best.count && k < bestKey)
      ) {
        best = e;
        bestKey = k;
      }
    }
    if (best && best.count >= MIN_MODE_FREQ) {
      out[attrId] = {
        value_id: best.value_id,
        value_name: best.value_name,
        freq: best.count,
      };
    }
  }
  return out;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

// ──────────────────────────────────────────────────────────────────────────
// Família → linha de CatalogStat
// ──────────────────────────────────────────────────────────────────────────

/** Valores brutos de uma família agrupada (colunas de lookup já normalizadas). */
export interface FamilyInput {
  partType: string;
  brand: string;
  model: string;
  version: string; // "*" para a linha version-agnóstica
  memberCount: number; // nº de produtos no grupo (gate)
  prices: number[];
  weights: number[];
  heights: number[];
  widths: number[];
  lengths: number[];
  years: number[];
  qualities: string[];
  partNumbers: string[];
  versions: string[]; // versões original-cased (para versionMode)
  sourceVehicles: string[];
  mlCategoryIds: string[];
  shopeeCategoryIds: string[];
  attributesList: AttrMap[];
  compatibilities: CompatLike[];
}

export interface CatalogStatRow {
  matchKey: string;
  partType: string;
  brand: string;
  model: string;
  version: string;
  yearFrom: number | null;
  yearTo: number | null;
  sampleSize: number;
  priceSampleSize: number | null;
  priceMedian: number | null;
  weightKgMedian: number | null;
  heightCmMedian: number | null;
  widthCmMedian: number | null;
  lengthCmMedian: number | null;
  qualityMode: string | null;
  qualityModeCount: number | null;
  partNumberMode: string | null;
  partNumberModeCount: number | null;
  versionMode: string | null;
  versionModeCount: number | null;
  sourceVehicleMode: string | null;
  sourceVehicleModeCount: number | null;
  mlCategoryIdMode: string | null;
  mlCategoryIdModeCount: number | null;
  shopeeCategoryIdMode: string | null;
  shopeeCategoryIdModeCount: number | null;
  attributes: Record<
    string,
    { value_id?: string; value_name?: string; freq: number }
  > | null;
  compatibilities: Array<{
    brand: string;
    model: string;
    yearFrom: number | null;
    yearTo: number | null;
    version: string | null;
    freq: number;
  }> | null;
}

const modeField = (
  items: string[],
  keyFn: (s: string) => string,
): { value: string | null; count: number | null } => {
  const m = modeOf(items, keyFn);
  if (!m || m.count < MIN_MODE_FREQ) return { value: null, count: null };
  return { value: m.value, count: m.count };
};

/**
 * Agrega uma família em uma linha de CatalogStat aplicando filtro de lixo,
 * mediana+IQR (preço), medianas (peso/medidas), modas (freq>=2) e união de
 * compatibilidades. Retorna null se memberCount < MIN_SAMPLE (gate/privacidade).
 */
export function finalizeFamily(input: FamilyInput): CatalogStatRow | null {
  if (input.memberCount < MIN_SAMPLE) return null;

  // Filtro de lixo (descarta valores absurdos; nunca converte unidade).
  const prices = input.prices.filter(isValidPrice);
  const weights = input.weights.filter(isValidWeight);
  const heights = input.heights.filter(isValidDim);
  const widths = input.widths.filter(isValidDim);
  const lengths = input.lengths.filter(isValidDim);
  const years = input.years.filter(isValidYear);

  // Preço: corte IQR e mediana dos sobreviventes.
  const priceSurv = iqrSurvivors(prices);
  const priceMedian =
    priceSurv.length > 0 ? round2(median(priceSurv) as number) : null;

  const weightMed =
    weights.length > 0 ? round2(median(weights) as number) : null;
  const heightMed =
    heights.length > 0 ? Math.round(median(heights) as number) : null;
  const widthMed =
    widths.length > 0 ? Math.round(median(widths) as number) : null;
  const lengthMed =
    lengths.length > 0 ? Math.round(median(lengths) as number) : null;

  const yearFrom = years.length > 0 ? Math.min(...years) : null;
  const yearTo = years.length > 0 ? Math.max(...years) : null;

  const quality = modeField(input.qualities, (s) => s.trim().toUpperCase());
  const partNumber = modeField(input.partNumbers, (s) =>
    s.trim().toUpperCase(),
  );
  const versionMode = modeField(input.versions, (s) => normalizeText(s));
  const sourceVehicle = modeField(input.sourceVehicles, (s) =>
    normalizeText(s),
  );
  const mlCat = modeField(input.mlCategoryIds, (s) => s.trim());
  const shopeeCat = modeField(input.shopeeCategoryIds, (s) => s.trim());

  const attrs = topAttributes(input.attributesList);
  const compat = rankCompatibilities(input.compatibilities);

  return {
    matchKey: buildMatchKey({
      partType: input.partType,
      brand: input.brand,
      model: input.model,
      version: input.version,
      yearFrom,
      yearTo,
    }),
    partType: input.partType,
    brand: input.brand,
    model: input.model,
    version: input.version,
    yearFrom,
    yearTo,
    sampleSize: input.memberCount,
    priceSampleSize: prices.length > 0 ? priceSurv.length : null,
    priceMedian,
    weightKgMedian: weightMed,
    heightCmMedian: heightMed,
    widthCmMedian: widthMed,
    lengthCmMedian: lengthMed,
    qualityMode: quality.value,
    qualityModeCount: quality.count,
    partNumberMode: partNumber.value
      ? partNumber.value.trim().toUpperCase()
      : null,
    partNumberModeCount: partNumber.count,
    versionMode: versionMode.value,
    versionModeCount: versionMode.count,
    sourceVehicleMode: sourceVehicle.value,
    sourceVehicleModeCount: sourceVehicle.count,
    mlCategoryIdMode: mlCat.value,
    mlCategoryIdModeCount: mlCat.count,
    shopeeCategoryIdMode: shopeeCat.value,
    shopeeCategoryIdModeCount: shopeeCat.count,
    attributes: Object.keys(attrs).length > 0 ? attrs : null,
    compatibilities: compat.length > 0 ? compat : null,
  };
}
