// Lógica pura da "Etiqueta avulsa" (produtos que ainda não existem): validação
// da lista e expansão em páginas (item × quantidade). Sem `window`, sem pdf-lib —
// isolada para ser testável em unidade. O gerador de PDF client-side consome
// estas funções em app/produtos/lib/standalone-labels-pdf.ts.
//
// É o análogo pré-produto do fluxo de "Gerar etiquetas": em vez de produtos com
// `id`, cada linha carrega apenas Nome + SKU + Quantidade. Nada é persistido.

export interface StandaloneLabelItem {
  name: string;
  sku: string;
  /** Cópias desta etiqueta no PDF. Ausente/ inválido => 1. */
  quantity?: number;
}

/** Uma página do PDF já resolvida: nome e sku com `trim()` aplicado. */
export interface StandaloneLabelPage {
  name: string;
  sku: string;
}

// Tetos de segurança para não travar o navegador com PDFs gigantes.
export const MAX_QUANTITY_PER_ITEM = 100;
export const MAX_TOTAL_LABELS = 500;

/**
 * Coage a quantidade de uma linha para um inteiro no intervalo
 * [1, MAX_QUANTITY_PER_ITEM]. Entradas inválidas (vazio, NaN, negativo, zero)
 * caem no padrão 1; decimais são truncados (floor); acima do teto são limitados.
 */
export function normalizeQuantity(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 1;
  const floored = Math.floor(n);
  if (floored < 1) return 1;
  if (floored > MAX_QUANTITY_PER_ITEM) return MAX_QUANTITY_PER_ITEM;
  return floored;
}

export interface StandaloneLabelRowValidation {
  index: number;
  nameOk: boolean;
  skuOk: boolean;
  valid: boolean;
}

export interface StandaloneLabelListValidation {
  rows: StandaloneLabelRowValidation[];
  /** Ao menos uma linha válida. */
  hasValidRows: boolean;
  /** Toda linha é válida (e há ao menos uma). */
  allRowsValid: boolean;
  /** Soma das quantidades normalizadas das linhas válidas. */
  totalLabels: number;
  /** totalLabels acima de MAX_TOTAL_LABELS. */
  overCap: boolean;
  /** Pode gerar: todas as linhas válidas, ao menos uma, e dentro do teto. */
  canGenerate: boolean;
}

const isNonEmpty = (value: unknown): boolean =>
  typeof value === "string" && value.trim().length > 0;

/**
 * Valida a lista de etiquetas avulsas. Nome e SKU são obrigatórios (não-vazios
 * após `trim`) em cada linha. Não gera se qualquer linha for inválida, se não
 * houver nenhuma linha, ou se o total ultrapassar o teto — cabe à UI bloquear.
 */
export function validateStandaloneLabelItems(
  items: StandaloneLabelItem[],
): StandaloneLabelListValidation {
  const rows: StandaloneLabelRowValidation[] = items.map((item, index) => {
    const nameOk = isNonEmpty(item?.name);
    const skuOk = isNonEmpty(item?.sku);
    return { index, nameOk, skuOk, valid: nameOk && skuOk };
  });

  const hasValidRows = rows.some((r) => r.valid);
  const allRowsValid = rows.length > 0 && rows.every((r) => r.valid);

  const totalLabels = items.reduce(
    (sum, item, i) =>
      rows[i].valid ? sum + normalizeQuantity(item.quantity) : sum,
    0,
  );

  const overCap = totalLabels > MAX_TOTAL_LABELS;
  const canGenerate = allRowsValid && hasValidRows && !overCap;

  return { rows, hasValidRows, allRowsValid, totalLabels, overCap, canGenerate };
}

/**
 * Expande a lista em páginas na ordem em que aparecem: item 1 × qtd, item 2 ×
 * qtd, ... Nome e SKU saem com `trim()` (o SKU é o conteúdo do QR e o número
 * grande da etiqueta). Assume itens já validados por
 * `validateStandaloneLabelItems`; o gerador é quem bloqueia listas inválidas.
 */
export function expandItemsToPages(
  items: StandaloneLabelItem[],
): StandaloneLabelPage[] {
  const pages: StandaloneLabelPage[] = [];
  for (const item of items) {
    const name = (item?.name ?? "").trim();
    const sku = (item?.sku ?? "").trim();
    const quantity = normalizeQuantity(item?.quantity);
    for (let i = 0; i < quantity; i++) {
      pages.push({ name, sku });
    }
  }
  return pages;
}
