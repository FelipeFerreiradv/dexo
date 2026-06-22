import type { CatalogProductDetail } from "../../marketplaces/usecases/ml-catalog-suggestion.usecase";
import {
  isEmptyScalar,
  isEmptyString,
  mergeAttributes,
  mergeCompatibilities,
  tryFillString,
  type MergeCtx,
} from "./suggestion-merge";

/**
 * Forma mínima dos valores do form que este merge entende/toca.
 * Propositalmente permissiva: campos extras do form são preservados
 * (o caller só sobrescreve este subset e mantém o resto com `...prev`).
 */
export interface CatalogApplyFormValues {
  name?: string;
  brand?: string;
  model?: string;
  year?: string;
  category?: string;
  partNumber?: string | null;
  mlCategory?: string;
  mlCategoryId?: string | null;
  mlCategorySource?: string | null;
  mlCatalogProductId?: string | null;
  attributes?: Record<string, { value_id?: string; value_name?: string }>;
  compatibilities?: Array<{
    brand: string;
    model: string;
    yearFrom?: number | null;
    yearTo?: number | null;
    version?: string | null;
  }>;
  heightCm?: number | null;
  widthCm?: number | null;
  lengthCm?: number | null;
  weightKg?: number | null;
}

export interface CatalogApplyConflict {
  field: keyof CatalogApplyFormValues | string;
  currentValue: unknown;
  catalogValue: unknown;
}

export interface CatalogApplyResult {
  next: CatalogApplyFormValues;
  applied: Array<keyof CatalogApplyFormValues | string>;
  conflicts: CatalogApplyConflict[];
}

/**
 * Aplica uma sugestão de catálogo ML aos valores atuais do form.
 *
 * Regras (confirmadas com o usuário em 2026-04-24):
 *   - Preencher só campos **vazios**. Campos já preenchidos geram um conflict
 *     e NÃO são sobrescritos (o chamador decide se pergunta ao usuário).
 *   - `attributes`: mescla por chave; chaves existentes no form não são
 *     substituídas; novas chaves do catálogo entram.
 *   - `compatibilities`: merge por `(brand, model, yearFrom, yearTo)` —
 *     upsert idempotente. Entradas manuais são preservadas.
 *   - Sempre grava `mlCatalogProductId` e define `mlCategorySource = "auto"`
 *     quando a sugestão preencheu `mlCategoryId`.
 *
 * Função pura: não depende de react-hook-form, i18n, toasts etc.
 */
export function applyMlCatalogSuggestion(
  current: CatalogApplyFormValues,
  detail: CatalogProductDetail,
): CatalogApplyResult {
  const next: CatalogApplyFormValues = { ...current };
  const applied: Array<keyof CatalogApplyFormValues | string> = [];
  const conflicts: CatalogApplyConflict[] = [];

  const ctx: MergeCtx = {
    current: current as Record<string, unknown>,
    next: next as Record<string, unknown>,
    applied: applied as string[],
    conflicts,
  };

  tryFillString(ctx, "name", detail.name || null);
  tryFillString(ctx, "brand", detail.brand);
  tryFillString(ctx, "model", detail.model);
  tryFillString(ctx, "year", detail.year);
  tryFillString(ctx, "partNumber", detail.partNumber);

  // Categoria: o valor "canônico" é o categoryId do ML. Gravamos em mlCategoryId
  // e em mlCategory (display) quando vazios. O campo `category` (local, texto
  // livre) também recebe o mesmo nome quando vazio.
  if (detail.categoryId) {
    if (isEmptyScalar(current.mlCategoryId)) {
      next.mlCategoryId = detail.categoryId;
      applied.push("mlCategoryId");
      // Source = auto apenas quando nós preenchemos — respeita escolha prévia do usuário.
      if (isEmptyScalar(current.mlCategorySource)) {
        next.mlCategorySource = "auto";
        applied.push("mlCategorySource");
      }
    } else if (current.mlCategoryId !== detail.categoryId) {
      conflicts.push({
        field: "mlCategoryId",
        currentValue: current.mlCategoryId,
        catalogValue: detail.categoryId,
      });
    }
  }

  if (detail.categoryId && isEmptyString(current.mlCategory)) {
    // Usar o id como fallback quando o detail não traz display path;
    // a UI resolve depois via /marketplace/ml/categories.
    next.mlCategory = detail.categoryId;
    applied.push("mlCategory");
  }

  // Ficha técnica: merge não destrutivo — chaves existentes ficam, novas entram.
  const attrMerge = mergeAttributes(current.attributes, detail.attributes);
  if (attrMerge.conflicts.length > 0) conflicts.push(...attrMerge.conflicts);
  if (attrMerge.changed) {
    next.attributes = attrMerge.merged;
    applied.push("attributes");
  }

  // Compatibilidades: merge por chave (brand, model, yearFrom, yearTo).
  const compatMerge = mergeCompatibilities(
    current.compatibilities,
    detail.compatibilities,
  );
  if (compatMerge.added) {
    next.compatibilities = compatMerge.next;
    applied.push("compatibilities");
  }

  // Sempre grava o vínculo.
  next.mlCatalogProductId = detail.catalogProductId;
  applied.push("mlCatalogProductId");

  return { next, applied, conflicts };
}
