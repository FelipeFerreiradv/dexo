import type { CatalogProductDetail } from "../../marketplaces/usecases/ml-catalog-suggestion.usecase";

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

function isEmptyString(v: unknown): boolean {
  return typeof v !== "string" || v.trim().length === 0;
}

function isEmptyScalar(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === "string") return v.trim().length === 0;
  return false;
}

function compatKey(c: {
  brand: string;
  model: string;
  yearFrom?: number | null;
  yearTo?: number | null;
}): string {
  return [
    c.brand.trim().toLowerCase(),
    c.model.trim().toLowerCase(),
    c.yearFrom ?? "",
    c.yearTo ?? "",
  ].join("|");
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

  const tryFillString = (
    field: keyof CatalogApplyFormValues,
    catalogValue: string | null | undefined,
  ) => {
    if (!catalogValue || catalogValue.trim().length === 0) return;
    const cur = current[field];
    if (isEmptyString(cur)) {
      (next as any)[field] = catalogValue;
      applied.push(field);
    } else if (cur !== catalogValue) {
      conflicts.push({ field, currentValue: cur, catalogValue });
    }
  };

  tryFillString("name", detail.name || null);
  tryFillString("brand", detail.brand);
  tryFillString("model", detail.model);
  tryFillString("year", detail.year);
  tryFillString("partNumber", detail.partNumber);

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
  const curAttrs = current.attributes ?? {};
  const catAttrs = detail.attributes ?? {};
  const mergedAttrs: Record<string, { value_id?: string; value_name?: string }> = {
    ...curAttrs,
  };
  let attrsChanged = false;
  for (const [attrId, val] of Object.entries(catAttrs)) {
    if (mergedAttrs[attrId]) {
      const a = mergedAttrs[attrId];
      const hasValue =
        (typeof a.value_id === "string" && a.value_id.length > 0) ||
        (typeof a.value_name === "string" && a.value_name.length > 0);
      if (hasValue) {
        // Não sobrescreve — reporta conflito se divergir.
        if (
          (val.value_id && val.value_id !== a.value_id) ||
          (val.value_name && val.value_name !== a.value_name)
        ) {
          conflicts.push({
            field: `attributes.${attrId}`,
            currentValue: a,
            catalogValue: val,
          });
        }
        continue;
      }
    }
    mergedAttrs[attrId] = val;
    attrsChanged = true;
  }
  if (attrsChanged) {
    next.attributes = mergedAttrs;
    applied.push("attributes");
  }

  // Compatibilidades: merge por chave (brand, model, yearFrom, yearTo).
  const hints = detail.compatibilities ?? [];
  if (hints.length > 0) {
    const existing = Array.isArray(current.compatibilities)
      ? current.compatibilities
      : [];
    const seen = new Set(existing.map(compatKey));
    const toAdd = hints.filter((h) => !seen.has(compatKey(h)));
    if (toAdd.length > 0) {
      next.compatibilities = [...existing, ...toAdd];
      applied.push("compatibilities");
    }
  }

  // Sempre grava o vínculo.
  next.mlCatalogProductId = detail.catalogProductId;
  applied.push("mlCatalogProductId");

  return { next, applied, conflicts };
}
