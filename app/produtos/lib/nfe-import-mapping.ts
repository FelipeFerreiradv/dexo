/**
 * Mapeamento PURO (front) de um item de NF-e → valores iniciais do modal de produto.
 *
 * A NF-e traz o CUSTO (vUnCom), não o preço de venda. Aqui sugerimos o preço de
 * venda aplicando um markup padrão sobre o custo. O markup é uma preferência de
 * front (sem coluna no banco): lido de `NEXT_PUBLIC_NFE_DEFAULT_MARKUP`, com
 * fallback 100%. O valor é apenas uma SUGESTÃO — o usuário edita no modal, e a
 * margem é recalculada lá automaticamente a partir de price/costPrice.
 *
 * Importa apenas o TIPO do parser (import type), então o parser de XML e o
 * `fast-xml-parser` NUNCA entram no bundle do client.
 */

import type { NfeParsedItem } from "../../fiscal/nfe-import/nfe-import.types";

/** Markup padrão (%) para sugerir o preço de venda a partir do custo. */
export const DEFAULT_NFE_MARKUP: number = (() => {
  const raw = process.env.NEXT_PUBLIC_NFE_DEFAULT_MARKUP;
  const n = raw != null && raw !== "" ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : 100;
})();

/** Preço sugerido = custo × (1 + markup/100), arredondado a 2 casas. */
export function computeSuggestedPrice(
  costPrice: number,
  markupPercent: number,
): number {
  if (!Number.isFinite(costPrice) || costPrice < 0) return 0;
  const m = Number.isFinite(markupPercent) && markupPercent >= 0 ? markupPercent : 0;
  const price = costPrice * (1 + m / 100);
  return Math.round((price + Number.EPSILON) * 100) / 100;
}

/**
 * Subconjunto de campos do form preenchidos a partir da NF-e. É estruturalmente
 * compatível com `Partial<ProductFormData>` do modal. Repare que NÃO há
 * `imageUrl` (imagem é manual e obrigatória) nem `sku` (continua automático via
 * /products/next-sku) — a importação não pode burlar nenhum dos dois.
 */
export interface NfeInitialValues {
  name: string;
  costPrice: number;
  stock: number;
  price: number;
  quality: "NOVO";
}

/** Converte um item já parseado da NF-e nos valores iniciais do modal. */
export function nfeItemToInitialValues(
  item: NfeParsedItem,
  markupPercent: number = DEFAULT_NFE_MARKUP,
): NfeInitialValues {
  return {
    name: item.name,
    costPrice: item.costPrice,
    stock: item.quantity,
    price: computeSuggestedPrice(item.costPrice, markupPercent),
    quality: "NOVO",
  };
}

/**
 * Campos do formulário que a importação de NF-e tem PERMISSÃO de preencher.
 * Tudo fora desta lista — `imageUrl` (imagem é manual e obrigatória), `sku`
 * (continua automático via /products/next-sku), `brand`/`model`/`year`/
 * `category` (vêm do auto-fill por nome) — NUNCA é tocado pela NF-e.
 */
export const NFE_FILLABLE_FIELDS = [
  "name",
  "costPrice",
  "stock",
  "price",
  "quality",
] as const;

export type NfeFillableField = (typeof NFE_FILLABLE_FIELDS)[number];

/**
 * Entradas `[campo, valor]` que a NF-e deve aplicar no form, restritas à lista
 * permitida e a valores não-nulos. Sem `initialValues` (fluxo manual) retorna
 * `[]` — o caminho manual do modal não recebe NADA da NF-e. Mesmo que o
 * `initialValues` traga campos proibidos (imageUrl, sku…), eles são descartados.
 */
export function nfeFieldEntries(
  initialValues?: Record<string, unknown> | null,
): Array<[NfeFillableField, unknown]> {
  if (!initialValues) return [];
  const entries: Array<[NfeFillableField, unknown]> = [];
  for (const field of NFE_FILLABLE_FIELDS) {
    const value = initialValues[field];
    if (value != null) entries.push([field, value]);
  }
  return entries;
}
