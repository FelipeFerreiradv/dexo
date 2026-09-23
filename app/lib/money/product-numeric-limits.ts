import { DECIMAL_10_2_MAX, INT4_MAX, WEIGHT_KG_MAX } from "./markup";

/**
 * Barra, ANTES do Prisma, os valores numéricos que o banco recusaria de
 * qualquer jeito — hoje eles chegam ao Postgres, estouram (22003 / P2020 /
 * "Expected Int") e a tela recebe um 500 com o texto cru do ORM.
 *
 * Regra de não-regressão: só recusa o que o banco JÁ recusa (não finito, acima
 * do limite da coluna, centímetro fracionado). Tudo que grava hoje continua
 * gravando — inclusive custo negativo, que o `numeric` aceita.
 *
 * Campo ausente (`undefined`) ou limpo (`null`) não é validado: a rota decide o
 * que fazer com ele, como antes.
 */
export interface ProductNumericFields {
  price?: unknown;
  costPrice?: unknown;
  weightKg?: unknown;
  heightCm?: unknown;
  widthCm?: unknown;
  lengthCm?: unknown;
}

const BRL_LIMIT = "R$ 99.999.999,99";

function present(v: unknown): boolean {
  return v !== undefined && v !== null && v !== "";
}

function asNumber(v: unknown): number {
  return typeof v === "number" ? v : Number(v);
}

export function productNumericLimitError(
  fields: ProductNumericFields,
): string | null {
  if (present(fields.price)) {
    const n = asNumber(fields.price);
    if (!Number.isFinite(n)) return "Preço inválido";
    if (n > DECIMAL_10_2_MAX)
      return `Preço acima do limite permitido (${BRL_LIMIT})`;
  }

  if (present(fields.costPrice)) {
    const n = asNumber(fields.costPrice);
    if (!Number.isFinite(n)) return "Custo inválido";
    if (Math.abs(n) > DECIMAL_10_2_MAX)
      return `Custo acima do limite permitido (${BRL_LIMIT})`;
  }

  if (present(fields.weightKg)) {
    const n = asNumber(fields.weightKg);
    if (!Number.isFinite(n) || Math.abs(n) > WEIGHT_KG_MAX)
      return "Peso inválido: informe o peso em kg, até 9.999,99 kg";
  }

  const dims: Array<[keyof ProductNumericFields, string]> = [
    ["heightCm", "Altura inválida"],
    ["widthCm", "Largura inválida"],
    ["lengthCm", "Comprimento inválido"],
  ];
  for (const [key, label] of dims) {
    if (!present(fields[key])) continue;
    const n = asNumber(fields[key]);
    if (!Number.isFinite(n) || !Number.isInteger(n) || Math.abs(n) > INT4_MAX)
      return `${label}: informe um número inteiro de centímetros`;
  }

  return null;
}
