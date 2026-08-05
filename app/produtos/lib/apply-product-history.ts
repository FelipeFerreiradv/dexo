/**
 * Aplicação de um cadastro anterior sobre o formulário aberto.
 *
 * Espelha `apply-internal-suggestion.ts`: função PURA que devolve
 * `{ next, applied, conflicts }` e deixa o `setValue` do react-hook-form com o
 * chamador. Reusa os primitivos de `suggestion-merge.ts` — a política é a mesma
 * que o usuário já conhece da "Sugestão da base interna": **preenche só o que
 * está vazio**, merge não destrutivo de `attributes`, união de
 * `compatibilities`. Nada que o usuário já digitou é sobrescrito.
 */

import {
  compatKey,
  mergeAttributes,
  tryFillNumber,
  tryFillString,
  type AttrMap,
  type CompatLike,
  type MergeCtx,
  type SuggestionConflict,
} from "./suggestion-merge";
import {
  HISTORY_BLOCKED_FIELDS,
  type ProductFormSnapshot,
} from "./product-form-snapshot";

/**
 * Campos de texto copiáveis do cadastro anterior.
 *
 * `name` e `partNumber` entraram em 05/08/2026. Os dois identificam a peça
 * específica — "Farol Esquerdo" e "Farol Direito" têm nome e part number
 * diferentes — então valem só como PONTO DE PARTIDA para editar. O que torna
 * isso seguro é a política de `tryFillString`: preenche apenas quando o campo
 * está vazio e, se já houver valor, registra conflito em vez de sobrescrever.
 */
const STRING_FIELDS = [
  "name",
  "partNumber",
  "description",
  "brand",
  "model",
  "year",
  "version",
  "category",
  "quality",
  "sourceVehicle",
  "location",
  "locationId",
  "mlCategory",
  "shopeeCategory",
  "magaluCategory",
  "mlListingType",
  "mlWarrantyUnit",
  "mlItemCondition",
  "mlShippingMode",
] as const;

/**
 * Campos numéricos copiáveis (medidas + configuração de anúncio).
 *
 * `price` e `stock` entraram em 05/08/2026. Para o merge, `isEmptyNumber`
 * trata `0` como vazio — e `0` é justamente o default do formulário para os
 * dois —, então eles são preenchidos num cadastro novo e preservados assim que
 * o usuário digita qualquer coisa. `costPrice` e `markup` continuam de fora:
 * o custo é da peça específica e o markup é derivado dele.
 */
const NUMBER_FIELDS = [
  "price",
  "stock",
  "heightCm",
  "widthCm",
  "lengthCm",
  "weightKg",
  "mlWarrantyDuration",
  "mlManufacturingTime",
] as const;

/** Booleanos e listas de contas: só preenchem quando o campo está "vazio". */
const BOOLEAN_FIELDS = [
  "isSecurityItem",
  "isTraceable",
  "createMLListing",
  "createShopeeListing",
  "createMagaluListing",
  "mlHasWarranty",
  "mlFreeShipping",
  "mlLocalPickup",
] as const;

const ACCOUNT_FIELDS = [
  "mlAccountIds",
  "shopeeAccountIds",
  "magaluAccountIds",
] as const;

export interface HistoryApplyResult {
  next: Record<string, unknown>;
  applied: string[];
  conflicts: SuggestionConflict[];
  /** Compatibilidades resultantes (união), ou `null` se nada mudou. */
  compatibilities: CompatLike[] | null;
  /**
   * Posição do cadastro anterior, ou `null` quando não há o que copiar.
   *
   * Não é união como as compatibilidades: posição é UMA por produto, e juntar
   * a do cadastro anterior com a atual montaria uma combinação que ninguém
   * escolheu — inclusive combinações impossíveis ("Esquerda" + "Direita").
   * Segue a política do resto do arquivo: só preenche quando está vazia.
   */
  compatibilityPositions: string[] | null;
}

const isBlocked = (field: string) =>
  (HISTORY_BLOCKED_FIELDS as readonly string[]).includes(field);

/**
 * @param current  valores atuais do formulário (`getValues()` + compatibilidades)
 * @param snapshot cadastro anterior escolhido pelo usuário
 */
export function applyProductHistory(
  current: Record<string, unknown>,
  currentCompatibilities: CompatLike[],
  snapshot: ProductFormSnapshot,
  /** Posição já escolhida no formulário aberto. Vazia = pode receber a anterior. */
  currentPositions: readonly string[] = [],
): HistoryApplyResult {
  const next: Record<string, unknown> = { ...current };
  const applied: string[] = [];
  const conflicts: SuggestionConflict[] = [];
  const ctx: MergeCtx = { current, next, applied, conflicts };
  const src = snapshot.values;

  for (const field of STRING_FIELDS) {
    if (isBlocked(field)) continue;
    const v = src[field];
    if (typeof v === "string") tryFillString(ctx, field, v);
  }

  for (const field of NUMBER_FIELDS) {
    if (isBlocked(field)) continue;
    const v = src[field];
    if (typeof v === "number") tryFillNumber(ctx, field, v);
  }

  // Booleano "vazio" é `false`/ausente: ligar uma opção que o usuário já
  // desligou de propósito seria sobrescrever escolha dele.
  for (const field of BOOLEAN_FIELDS) {
    if (isBlocked(field)) continue;
    if (src[field] === true && !current[field]) {
      next[field] = true;
      applied.push(field);
    }
  }

  // Contas selecionadas: só preenche quando a seleção atual está vazia.
  for (const field of ACCOUNT_FIELDS) {
    const incoming = src[field];
    const cur = current[field];
    if (!Array.isArray(incoming) || incoming.length === 0) continue;
    if (Array.isArray(cur) && cur.length > 0) continue;
    next[field] = [...incoming];
    applied.push(field);
  }

  // Ficha técnica: merge não destrutivo, chave a chave.
  const incomingAttrs = src.attributes as AttrMap | undefined;
  if (incomingAttrs && Object.keys(incomingAttrs).length > 0) {
    const {
      merged,
      changed,
      conflicts: attrConflicts,
    } = mergeAttributes(
      (current.attributes as AttrMap | undefined) ?? {},
      incomingAttrs,
    );
    conflicts.push(...attrConflicts);
    if (changed) {
      next.attributes = merged;
      applied.push("attributes");
    }
  }

  // Compatibilidades: união idempotente, sem remover as que o usuário digitou.
  let compatibilities: CompatLike[] | null = null;
  if (snapshot.compatibilities.length > 0) {
    const seen = new Set(
      currentCompatibilities.map((c) => compatKey(c, { includeVersion: true })),
    );
    const added: CompatLike[] = [];
    for (const c of snapshot.compatibilities) {
      const key = compatKey(c, { includeVersion: true });
      if (seen.has(key)) continue;
      seen.add(key);
      added.push(c);
    }
    if (added.length > 0) {
      compatibilities = [...currentCompatibilities, ...added];
      applied.push("compatibilities");
    }
  }

  // Posição: só preenche quando o formulário aberto ainda não tem nenhuma.
  let compatibilityPositions: string[] | null = null;
  const posicoesAnteriores = snapshot.compatibilityPositions ?? [];
  if (posicoesAnteriores.length > 0 && currentPositions.length === 0) {
    compatibilityPositions = [...posicoesAnteriores];
    applied.push("compatibilityPositions");
  }

  return {
    next,
    applied,
    conflicts,
    compatibilities,
    compatibilityPositions,
  };
}

/**
 * Rótulo do item no seletor de histórico. Mostra algo que o usuário reconheça:
 * nome, SKU e quando foi criado.
 */
export function describeSnapshot(
  snapshot: ProductFormSnapshot,
  now: number,
): string {
  const nome = snapshot.label.name || "Cadastro sem nome";
  const sku = snapshot.label.sku ? ` · ${snapshot.label.sku}` : "";
  const minutos = Math.max(0, Math.floor((now - snapshot.savedAt) / 60000));
  let quando: string;
  if (minutos < 1) quando = "agora há pouco";
  else if (minutos < 60) quando = `há ${minutos} min`;
  else if (minutos < 60 * 24) quando = `há ${Math.floor(minutos / 60)} h`;
  else quando = `há ${Math.floor(minutos / (60 * 24))} d`;
  return `${nome}${sku} · ${quando}`;
}
