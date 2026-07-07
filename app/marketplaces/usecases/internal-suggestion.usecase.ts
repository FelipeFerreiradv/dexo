/**
 * Sugestão da BASE INTERNA: casa um título contra a tabela materializada
 * CatalogStat (recalculada pelo job noturno) e devolve agregados para preencher
 * o form de produto. Núcleo determinístico — sem LLM.
 *
 * Cascata (primeiro hit vence; confiança deriva do nível), ano por INTERSEÇÃO de
 * faixa (nunca igualdade):
 *   1. version-específica + ano na faixa  → alta   (só quando o título traz versão)
 *   2. version-agnóstica (*) + ano na faixa → alta
 *   3. version-agnóstica (*) ignorando ano  → baixa (se havia ano) / media (sem ano)
 *
 * Privacidade: lê SÓ CatalogStat (agregados); nunca toca Product/costPrice/markup.
 */

import { Prisma } from "@prisma/client";
import prisma from "../../lib/prisma";
import {
  buildLookupColumns,
  normalizeText,
  parseTitleToParts,
} from "../lib/title-parse";
import type {
  InternalSuggestion,
  InternalSuggestionFields,
} from "../../produtos/lib/apply-internal-suggestion";
import type { AttrMap, CompatLike } from "../../produtos/lib/suggestion-merge";
import { CategoryResolutionService } from "../services/category-resolution.service";
import {
  mlModeToLeafCuid,
  shopeeModeToLeafId,
} from "../lib/category-leaf-resolver";

export type InternalSuggestResult =
  | { suggestion: InternalSuggestion }
  | { suggestion: null; reason: "insufficient_sample" };

const INSUFFICIENT: InternalSuggestResult = {
  suggestion: null,
  reason: "insufficient_sample",
};

// Cache curto por título normalizado (mesmo espírito dos caches dos outros
// endpoints de marketplace).
const CACHE_TTL_MS = 120 * 1000;
const cache = new Map<string, { data: InternalSuggestResult; exp: number }>();

const toNum = (v: unknown): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// Egress: trazemos só as colunas que buildSuggestion usa (segue o padrão
// perf(egress) do projeto — nada de *ModeCount/priceSampleSize/id/computedAt).
const SUGGEST_SELECT = {
  matchKey: true,
  sampleSize: true,
  versionMode: true,
  qualityMode: true,
  sourceVehicleMode: true,
  partNumberMode: true,
  priceMedian: true,
  weightKgMedian: true,
  heightCmMedian: true,
  widthCmMedian: true,
  lengthCmMedian: true,
  mlCategoryIdMode: true,
  shopeeCategoryIdMode: true,
  attributes: true,
  compatibilities: true,
} satisfies Prisma.CatalogStatSelect;

type CatalogStatRecord = Prisma.CatalogStatGetPayload<{
  select: typeof SUGGEST_SELECT;
}>;

function stripAttrFreq(raw: unknown): AttrMap | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: AttrMap = {};
  for (const [attrId, val] of Object.entries(raw as Record<string, any>)) {
    if (!val || typeof val !== "object") continue;
    const entry: { value_id?: string; value_name?: string } = {};
    if (typeof val.value_id === "string") entry.value_id = val.value_id;
    if (typeof val.value_name === "string") entry.value_name = val.value_name;
    if (entry.value_id || entry.value_name) out[attrId] = entry;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function stripCompatFreq(raw: unknown): CompatLike[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: CompatLike[] = [];
  for (const c of raw as any[]) {
    if (!c || !c.brand || !c.model) continue;
    out.push({
      brand: c.brand,
      model: c.model,
      yearFrom: c.yearFrom ?? null,
      yearTo: c.yearTo ?? null,
      version: c.version ?? null,
    });
  }
  return out.length > 0 ? out : undefined;
}

/** Monta o contrato `suggestion` a partir da linha + entidades do título. */
function buildSuggestion(
  row: CatalogStatRecord,
  parts: ReturnType<typeof parseTitleToParts>,
  confidence: "alta" | "media" | "baixa",
): InternalSuggestion {
  const fields: InternalSuggestionFields = {};

  // brand/model/year/version: o que o usuário já digitou (display correto).
  if (parts.brand) fields.brand = parts.brand;
  if (parts.model) fields.model = parts.model;
  if (parts.year != null) fields.year = String(parts.year);
  // versão sugerida = moda da família (o título livre não traz versão no MVP).
  if (row.versionMode) fields.version = row.versionMode;

  // Agregados da base.
  if (row.qualityMode) fields.quality = row.qualityMode;
  if (row.sourceVehicleMode) fields.sourceVehicle = row.sourceVehicleMode;
  if (row.partNumberMode) fields.partNumber = row.partNumberMode;
  const price = toNum(row.priceMedian);
  if (price != null) fields.priceMedian = price;
  const weight = toNum(row.weightKgMedian);
  if (weight != null) fields.weightKg = weight;
  if (row.heightCmMedian != null) fields.heightCm = row.heightCmMedian;
  if (row.widthCmMedian != null) fields.widthCm = row.widthCmMedian;
  if (row.lengthCmMedian != null) fields.lengthCm = row.lengthCmMedian;
  if (row.mlCategoryIdMode) fields.mlCategoryId = row.mlCategoryIdMode;
  if (row.shopeeCategoryIdMode)
    fields.shopeeCategoryId = row.shopeeCategoryIdMode;

  return {
    matchKey: row.matchKey,
    sampleSize: row.sampleSize,
    confidence,
    fields,
    compatibilities: stripCompatFreq(row.compatibilities),
    attributes: stripAttrFreq(row.attributes),
    source: "internal",
  };
}

export class InternalSuggestionUseCase {
  static async suggestFromTitle(title: string): Promise<InternalSuggestResult> {
    const key = normalizeText(title);
    const cached = cache.get(key);
    if (cached && cached.exp > Date.now()) return cached.data;

    const result = await this.compute(title, parseTitleToParts(title));
    cache.set(key, { data: result, exp: Date.now() + CACHE_TTL_MS });
    return result;
  }

  private static async compute(
    title: string,
    parts: ReturnType<typeof parseTitleToParts>,
  ): Promise<InternalSuggestResult> {
    // Todos os níveis exigem partType + brand + model.
    if (!parts.partType || !parts.brand || !parts.model) return INSUFFICIENT;

    const cols = buildLookupColumns({
      partType: parts.partType,
      brand: parts.brand,
      model: parts.model,
      version: parts.version,
    });
    const year = parts.year;
    const baseWhere = {
      partType: cols.partType,
      brand: cols.brand,
      model: cols.model,
    };

    let row: CatalogStatRecord | null = null;
    let confidence: "alta" | "media" | "baixa" = "baixa";

    // Nível 1 — version-específica (só quando o título traz versão).
    if (cols.version !== "*") {
      if (year != null) {
        row = await prisma.catalogStat.findFirst({
          where: {
            ...baseWhere,
            version: cols.version,
            yearFrom: { lte: year },
            yearTo: { gte: year },
          },
          select: SUGGEST_SELECT,
          orderBy: { sampleSize: "desc" },
        });
        if (row) confidence = "alta";
      }
      if (!row) {
        row = await prisma.catalogStat.findFirst({
          where: { ...baseWhere, version: cols.version },
          select: SUGGEST_SELECT,
          orderBy: { sampleSize: "desc" },
        });
        if (row) confidence = year != null ? "baixa" : "media";
      }
    }

    // Nível 2 — version-agnóstica (*) com ano na faixa.
    if (!row && year != null) {
      row = await prisma.catalogStat.findFirst({
        where: {
          ...baseWhere,
          version: "*",
          yearFrom: { lte: year },
          yearTo: { gte: year },
        },
        select: SUGGEST_SELECT,
        orderBy: { sampleSize: "desc" },
      });
      if (row) confidence = "alta";
    }

    // Nível 3 — version-agnóstica (*) ignorando o ano.
    if (!row) {
      row = await prisma.catalogStat.findFirst({
        where: { ...baseWhere, version: "*" },
        select: SUGGEST_SELECT,
        orderBy: { sampleSize: "desc" },
      });
      if (row) confidence = year != null ? "baixa" : "media";
    }

    if (!row) return INSUFFICIENT;
    const suggestion = buildSuggestion(row, parts, confidence);
    await this.ensureCategoryLeaves(suggestion.fields);
    return { suggestion };
  }

  /**
   * Garante que as categorias sugeridas sejam FOLHAS locais: a moda do
   * CatalogStat é a mais comum entre produtos já cadastrados e pode ser um
   * nó-pai (categoria incompleta). Reusa a MESMA descida do publish
   * (ensureLeafLocalOnly), então a sugestão exibida passa a ser a folha que
   * seria de fato publicada. Fail-safe: qualquer miss mantém o valor original.
   */
  private static async ensureCategoryLeaves(
    fields: InternalSuggestionFields,
  ): Promise<void> {
    if (fields.mlCategoryId) {
      fields.mlCategoryId = await mlModeToLeafCuid(fields.mlCategoryId, {
        // Projeções enxutas (egress): buscamos só a coluna necessária de
        // MarketplaceCategory, não a linha inteira (evita puxar JSON pathFromRoot
        // etc.). Segue o padrão perf(egress) do projeto.
        findById: (cuid) =>
          prisma.marketplaceCategory.findUnique({
            where: { id: cuid },
            select: { externalId: true },
          }),
        ensureLeaf: (ext) => CategoryResolutionService.ensureLeafLocalOnly(ext),
        findByExternalId: (ext) =>
          prisma.marketplaceCategory.findUnique({
            where: { externalId: ext },
            select: { id: true },
          }),
      });
    }
    if (fields.shopeeCategoryId) {
      fields.shopeeCategoryId = await shopeeModeToLeafId(fields.shopeeCategoryId, {
        ensureLeaf: (ext) => CategoryResolutionService.ensureLeafLocalOnly(ext),
      });
    }
  }

  /** Apenas para testes — limpa o cache em memória. */
  static __clearCache() {
    cache.clear();
  }
}
