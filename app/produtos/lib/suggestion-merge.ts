/**
 * Helpers puros de merge "preencher só vazios" compartilhados pelas duas fontes
 * de sugestão de produto:
 *   - applyMlCatalogSuggestion (catálogo Mercado Livre) — comportamento INALTERADO.
 *   - applyInternalSuggestion (base interna agregada / CatalogStat).
 *
 * Extraído de apply-ml-catalog-suggestion.ts SEM mudar o comportamento do ML:
 * compatKey mantém 4 segmentos por padrão (version é opt-in), e os loops de
 * attributes/compatibilities replicam exatamente a lógica anterior. O guarda de
 * regressão é tests/apply-ml-catalog-suggestion.spec.ts.
 */

export type AttrMap = Record<
  string,
  { value_id?: string; value_name?: string }
>;

export interface CompatLike {
  brand: string;
  model: string;
  yearFrom?: number | null;
  yearTo?: number | null;
  version?: string | null;
}

export interface SuggestionConflict {
  field: string;
  currentValue: unknown;
  catalogValue: unknown;
}

/** Contexto mutável passado aos try-fill (current = leitura, next = escrita). */
export interface MergeCtx {
  current: Record<string, unknown>;
  next: Record<string, unknown>;
  applied: string[];
  conflicts: SuggestionConflict[];
}

export function isEmptyString(v: unknown): boolean {
  return typeof v !== "string" || v.trim().length === 0;
}

export function isEmptyScalar(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === "string") return v.trim().length === 0;
  return false;
}

/**
 * "Vazio" para campos numéricos do form. Tanto `undefined/null` quanto `0`
 * contam como vazio neste domínio (preço/peso/medida = 0 significa "não
 * informado"; ninguém vende a R$ 0 nem pesa 0 kg). Strings numéricas vazias
 * ou "0" também contam como vazias.
 */
export function isEmptyNumber(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === "number") return !Number.isFinite(v) || v === 0;
  if (typeof v === "string") {
    const t = v.trim();
    return t.length === 0 || Number(t) === 0;
  }
  return false;
}

/**
 * Chave de dedup de compatibilidade. Por padrão 4 segmentos
 * (brand|model|yearFrom|yearTo) — idêntico ao comportamento histórico do ML.
 * `includeVersion: true` acrescenta a versão (usado pela base interna).
 */
export function compatKey(
  c: CompatLike,
  opts: { includeVersion?: boolean } = {},
): string {
  const base = [
    c.brand.trim().toLowerCase(),
    c.model.trim().toLowerCase(),
    c.yearFrom ?? "",
    c.yearTo ?? "",
  ];
  if (opts.includeVersion) base.push((c.version ?? "").trim().toLowerCase());
  return base.join("|");
}

/** Preenche um campo string se vazio; senão registra conflito (sem sobrescrever). */
export function tryFillString(
  ctx: MergeCtx,
  field: string,
  value: string | null | undefined,
): void {
  if (!value || value.trim().length === 0) return;
  const cur = ctx.current[field];
  if (isEmptyString(cur)) {
    ctx.next[field] = value;
    ctx.applied.push(field);
  } else if (cur !== value) {
    ctx.conflicts.push({ field, currentValue: cur, catalogValue: value });
  }
}

/** Preenche um campo numérico se vazio; senão registra conflito. */
export function tryFillNumber(
  ctx: MergeCtx,
  field: string,
  value: number | null | undefined,
): void {
  if (value == null || !Number.isFinite(value)) return;
  const cur = ctx.current[field];
  if (isEmptyNumber(cur)) {
    ctx.next[field] = value;
    ctx.applied.push(field);
  } else if (cur !== value) {
    ctx.conflicts.push({ field, currentValue: cur, catalogValue: value });
  }
}

/**
 * Merge não destrutivo de ficha técnica: chaves já preenchidas no form ficam,
 * novas chaves entram; divergências viram conflito. Replica exatamente o loop
 * histórico de applyMlCatalogSuggestion.
 */
export function mergeAttributes(
  current: AttrMap | undefined,
  incoming: AttrMap | undefined,
): { merged: AttrMap; changed: boolean; conflicts: SuggestionConflict[] } {
  const cur = current ?? {};
  const inc = incoming ?? {};
  const merged: AttrMap = { ...cur };
  const conflicts: SuggestionConflict[] = [];
  let changed = false;
  for (const [attrId, val] of Object.entries(inc)) {
    if (merged[attrId]) {
      const a = merged[attrId];
      const hasValue =
        (typeof a.value_id === "string" && a.value_id.length > 0) ||
        (typeof a.value_name === "string" && a.value_name.length > 0);
      if (hasValue) {
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
    merged[attrId] = val;
    changed = true;
  }
  return { merged, changed, conflicts };
}

/**
 * União idempotente de compatibilidades por compatKey. Entradas manuais
 * (current) são preservadas; só as novas (incoming) que não colidem entram.
 */
export function mergeCompatibilities<T extends CompatLike>(
  current: T[] | undefined,
  incoming: T[] | undefined,
  opts: { includeVersion?: boolean } = {},
): { next: T[]; added: boolean } {
  const existing = Array.isArray(current) ? current : [];
  const hints = Array.isArray(incoming) ? incoming : [];
  if (hints.length === 0) return { next: existing, added: false };
  const seen = new Set(existing.map((c) => compatKey(c, opts)));
  const toAdd = hints.filter((h) => !seen.has(compatKey(h, opts)));
  if (toAdd.length === 0) return { next: existing, added: false };
  return { next: [...existing, ...toAdd], added: true };
}
