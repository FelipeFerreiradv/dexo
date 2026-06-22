/**
 * Aplica uma sugestão da BASE INTERNA (CatalogStat, agregada) aos valores atuais
 * do form de produto. Espelha applyMlCatalogSuggestion: preenche só campos
 * **vazios**, faz merge não destrutivo de `attributes` e união de
 * `compatibilities`; reaproveita os helpers puros de suggestion-merge.
 *
 * Cobre os campos do MVP da feature (decisão do Felipe): price, quality, marca,
 * modelo, ano, versão, medidas, peso, veículo de origem, compatibilidades, part
 * number e ficha técnica — além das categorias ML/Shopee.
 *
 * Quirks de nome de campo do form (create-product-dialog):
 *   - o ID de categoria ML mora no campo `mlCategory` (não `mlCategoryId`);
 *   - o de Shopee mora em `shopeeCategory` (não `shopeeCategoryId`);
 *   - `compatibilities` é estado React no caller; aqui só calculamos `next`.
 *
 * Função pura: sem react-hook-form, toasts ou i18n.
 */

import {
  isEmptyString,
  mergeAttributes,
  mergeCompatibilities,
  tryFillNumber,
  tryFillString,
  type AttrMap,
  type CompatLike,
  type MergeCtx,
  type SuggestionConflict,
} from "./suggestion-merge";

/** Bloco `fields` do contrato do endpoint /marketplace/internal/suggest. */
export interface InternalSuggestionFields {
  brand?: string | null;
  model?: string | null;
  year?: string | null;
  version?: string | null;
  quality?: string | null;
  sourceVehicle?: string | null;
  partNumber?: string | null;
  /** mediana de `price` (referência de venda) — preenche o campo `price`. */
  priceMedian?: number | null;
  weightKg?: number | null;
  heightCm?: number | null;
  widthCm?: number | null;
  lengthCm?: number | null;
  mlCategoryId?: string | null;
  shopeeCategoryId?: string | null;
}

/** Sugestão completa retornada pelo endpoint (campo `suggestion`). */
export interface InternalSuggestion {
  matchKey?: string;
  sampleSize?: number;
  confidence?: "alta" | "media" | "baixa";
  fields: InternalSuggestionFields;
  compatibilities?: CompatLike[];
  attributes?: AttrMap;
  source?: string;
}

/** Subset do form que este merge entende/toca (extras são preservados). */
export interface InternalApplyFormValues {
  brand?: string;
  model?: string;
  year?: string;
  version?: string;
  price?: number | null;
  quality?: string | null;
  partNumber?: string | null;
  sourceVehicle?: string | null;
  weightKg?: number | null;
  heightCm?: number | null;
  widthCm?: number | null;
  lengthCm?: number | null;
  // quirks: guardam o ID da categoria
  mlCategory?: string;
  shopeeCategory?: string;
  attributes?: AttrMap;
  compatibilities?: CompatLike[];
}

export interface InternalApplyResult {
  next: InternalApplyFormValues;
  applied: string[];
  conflicts: SuggestionConflict[];
}

export function applyInternalSuggestion(
  current: InternalApplyFormValues,
  suggestion: InternalSuggestion,
): InternalApplyResult {
  const next: InternalApplyFormValues = { ...current };
  const applied: string[] = [];
  const conflicts: SuggestionConflict[] = [];

  const ctx: MergeCtx = {
    current: current as Record<string, unknown>,
    next: next as Record<string, unknown>,
    applied,
    conflicts,
  };

  const f = suggestion.fields ?? {};

  // Strings (preenche só vazio)
  tryFillString(ctx, "brand", f.brand);
  tryFillString(ctx, "model", f.model);
  tryFillString(ctx, "year", f.year);
  tryFillString(ctx, "version", f.version);
  tryFillString(ctx, "quality", f.quality);
  tryFillString(ctx, "sourceVehicle", f.sourceVehicle);
  tryFillString(ctx, "partNumber", f.partNumber);

  // Números (preenche só vazio; preço = mediana, fica editável e rotulado na UI)
  tryFillNumber(ctx, "price", f.priceMedian);
  tryFillNumber(ctx, "weightKg", f.weightKg);
  tryFillNumber(ctx, "heightCm", f.heightCm);
  tryFillNumber(ctx, "widthCm", f.widthCm);
  tryFillNumber(ctx, "lengthCm", f.lengthCm);

  // Categorias (quirk: o ID mora em mlCategory / shopeeCategory).
  if (f.mlCategoryId && isEmptyString(current.mlCategory)) {
    next.mlCategory = f.mlCategoryId;
    applied.push("mlCategory");
  }
  if (f.shopeeCategoryId && isEmptyString(current.shopeeCategory)) {
    next.shopeeCategory = f.shopeeCategoryId;
    applied.push("shopeeCategory");
  }

  // Ficha técnica: merge não destrutivo.
  const attrMerge = mergeAttributes(current.attributes, suggestion.attributes);
  if (attrMerge.conflicts.length > 0) conflicts.push(...attrMerge.conflicts);
  if (attrMerge.changed) {
    next.attributes = attrMerge.merged;
    applied.push("attributes");
  }

  // Compatibilidades: união por (brand,model,yearFrom,yearTo,version).
  const compatMerge = mergeCompatibilities(
    current.compatibilities,
    suggestion.compatibilities,
    { includeVersion: true },
  );
  if (compatMerge.added) {
    next.compatibilities = compatMerge.next;
    applied.push("compatibilities");
  }

  return { next, applied, conflicts };
}
