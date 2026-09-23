/**
 * Markup do produto — regra ÚNICA, calculada no servidor.
 *
 * Semântica (a mesma que a tela sempre usou, `create-product-dialog.tsx`):
 * percentual sobre o custo, `((preço − custo) / custo) × 100`, arredondado a
 * 2 casas. Ex.: preço 89,90 e custo 35,00 ⇒ 156,86 (%). Não é multiplicador.
 *
 * Por que existe (22/09/2026): o markup só era calculado no navegador e ia
 * cru para `Product.markup`, que é `Decimal(10,2)` — teto 99.999.999,99. Com o
 * custo padrão R$ 0,01 de alguns usuários, um preço de R$ 26.000 dá
 * 259.999.900% e o Postgres recusa (22003 / Prisma P2020): o produto inteiro
 * deixava de ser criado por causa de um campo DERIVADO. Medido em produção: 20
 * salvamentos perdidos, 2 usuários; 48 usuários com custo padrão < R$ 1.
 *
 * Decisão (Felipe): quando o markup não cabe na coluna, grava `null` e a tela
 * calcula na hora a partir de preço e custo (`resolveDisplayMarkup`). Nada
 * inventado: o valor exato continua derivável dos dois campos persistidos.
 *
 * A conta é feita em CENTAVOS INTEIROS: numerador ≤ 1e14 (< 2^53), então a
 * divisão em ponto flutuante seguida de `Math.round` acerta o arredondamento
 * nos casos exatos de meio (x,5) — a versão em float do navegador podia errar
 * por 0,01 nesses casos. `Math.round` mantém o critério da tela (meio vai para
 * +∞).
 */

/** Maior valor de uma coluna `Decimal(10,2)` (price, costPrice, markup). */
export const DECIMAL_10_2_MAX = 99_999_999.99;

/** Teto de `Product.weightKg` (`Decimal(6,2)`). */
export const WEIGHT_KG_MAX = 9_999.99;

/** Teto de uma coluna `Int` do Postgres (heightCm/widthCm/lengthCm). */
export const INT4_MAX = 2_147_483_647;

export type MarkupNotComputableReason =
  /** Sem custo, custo 0 ou negativo: não há base para o percentual. */
  | "NO_COST"
  /** Sem preço ou preço 0 — a tela também não calculava nesse caso. */
  | "NO_PRICE"
  /** Preço ou custo não é número finito. */
  | "INVALID_INPUT"
  /** O percentual é válido mas não cabe em `Decimal(10,2)`. */
  | "OUT_OF_RANGE";

export interface MarkupResult {
  /** Percentual com 2 casas, ou `null` quando não calculável/representável. */
  value: number | null;
  reason: MarkupNotComputableReason | null;
}

type MoneyInput = number | string | null | undefined | { toString(): string };

function isGiven(value: MoneyInput): boolean {
  return (
    value !== null &&
    value !== undefined &&
    !(typeof value === "string" && value.trim() === "")
  );
}

const PLAIN_DECIMAL = /^(-)?(\d+)(?:\.(\d*))?$/;

/**
 * Converte um valor monetário em centavos inteiros, com o MESMO arredondamento
 * que o Postgres aplica ao gravar em `numeric(10,2)` (meio para longe do zero).
 * `null` para ausente ou não finito. Aceita `Prisma.Decimal` (via `toString`) e
 * string com ponto decimal.
 *
 * Trabalha sobre a representação decimal do número, não sobre `n * 100`: em
 * binário, `10.005 * 100` é `1000.4999…` e daria 10,00 onde o banco grava 10,01.
 */
export function toCents(value: MoneyInput): number | null {
  if (!isGiven(value)) return null;
  const raw =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? value.trim()
        : (value as { toString(): string }).toString().trim();
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return null;

  // `String(n)` devolve a menor representação que volta ao mesmo número — é o
  // que o usuário digitou. Notação exponencial (|n| < 1e-6 ou ≥ 1e21) não tem
  // centavos relevantes a arredondar: cai no cálculo direto.
  const text = typeof raw === "number" ? String(raw) : raw;
  const m = PLAIN_DECIMAL.exec(text);
  if (!m) return Math.round(n * 100);
  const sign = m[1] ? -1 : 1;
  const frac = (m[3] ?? "").padEnd(3, "0");
  let cents = Number(m[2]) * 100 + Number(frac.slice(0, 2));
  if (Number(frac[2]) >= 5) cents += 1;
  return sign * cents === 0 ? 0 : sign * cents;
}

/** Percentual em centésimos inteiros, a partir de centavos já validados. */
function markupHundredths(priceCents: number, costCents: number): number {
  return Math.round(((priceCents - costCents) * 10_000) / costCents);
}

export function computeMarkupPercent(
  price: MoneyInput,
  cost: MoneyInput,
): MarkupResult {
  const priceCents = toCents(price);
  const costCents = toCents(cost);

  if (
    (isGiven(price) && priceCents === null) ||
    (isGiven(cost) && costCents === null)
  ) {
    return { value: null, reason: "INVALID_INPUT" };
  }
  if (costCents === null || costCents <= 0) {
    return { value: null, reason: "NO_COST" };
  }
  if (priceCents === null || priceCents <= 0) {
    return { value: null, reason: "NO_PRICE" };
  }

  const value = markupHundredths(priceCents, costCents) / 100;
  if (!Number.isFinite(value) || Math.abs(value) > DECIMAL_10_2_MAX) {
    return { value: null, reason: "OUT_OF_RANGE" };
  }
  // `-0` vira `0` para não aparecer "-0,00%" na tela.
  return { value: value === 0 ? 0 : value, reason: null };
}

/**
 * Markup a gravar numa EDIÇÃO. Recalcula sempre que o pedido mexe em preço,
 * custo ou markup, combinando o que chegou com o que o produto já tem (a edição
 * rápida de preço manda só `price`; limpar o custo manda `costPrice: null`).
 * Pedido que não toca nenhum dos três ⇒ `touch:false` (não mexe na coluna).
 */
export function deriveMarkupForUpdate(
  change: { price?: MoneyInput; costPrice?: MoneyInput; markup?: unknown },
  current: { price?: MoneyInput; costPrice?: MoneyInput },
): { touch: false } | ({ touch: true } & MarkupResult) {
  if (
    change.price === undefined &&
    change.costPrice === undefined &&
    change.markup === undefined
  ) {
    return { touch: false };
  }
  const finalPrice = change.price !== undefined ? change.price : current.price;
  const finalCost =
    change.costPrice !== undefined ? change.costPrice : current.costPrice;
  return { touch: true, ...computeMarkupPercent(finalPrice, finalCost) };
}

/**
 * Markup a exibir. Usa o gravado quando existe; quando é `null` mas há preço e
 * custo (ex.: fora do limite da coluna), calcula na hora — sem o teto do banco.
 */
export function resolveDisplayMarkup(product: {
  markup?: MoneyInput;
  price?: MoneyInput;
  costPrice?: MoneyInput;
}): number | null {
  if (isGiven(product.markup)) {
    const stored = Number(
      typeof product.markup === "number"
        ? product.markup
        : String(product.markup),
    );
    if (Number.isFinite(stored)) return stored;
  }
  const priceCents = toCents(product.price);
  const costCents = toCents(product.costPrice);
  if (
    priceCents === null ||
    costCents === null ||
    priceCents <= 0 ||
    costCents <= 0
  ) {
    return null;
  }
  const value = markupHundredths(priceCents, costCents) / 100;
  return Number.isFinite(value) ? value : null;
}

/** Valor monetário que cabe em `Decimal(10,2)` (≥ 0). */
export function isStorableMoney(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= DECIMAL_10_2_MAX
  );
}
