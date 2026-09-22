/**
 * Valor numérico maior do que a coluna comporta (Prisma P2020 / Postgres
 * 22003 "numeric field overflow"). Defesa em profundidade: as rotas de
 * produto já barram os casos conhecidos antes do Prisma
 * (`productNumericLimitError`); se algum caminho novo escapar, a tela recebe
 * uma mensagem legível e um 422 em vez do texto cru do ORM com status 500.
 */
export class NumericOverflowError extends Error {
  readonly code = "NUMERIC_OVERFLOW";

  constructor(
    message = "Um dos valores numéricos do produto está acima do limite permitido. Confira preço, custo, peso e medidas.",
  ) {
    super(message);
    this.name = "NumericOverflowError";
  }
}

export function isNumericOverflowError(
  error: unknown,
): error is NumericOverflowError {
  return error instanceof NumericOverflowError;
}

/**
 * Reconhece o estouro vindo do Prisma, com ou sem o código estruturado:
 * `P2020` (ValueOutOfRange) quando o client o identifica, ou a mensagem do
 * Postgres (22003) quando chega como erro desconhecido.
 */
export function isPrismaNumericOverflow(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown } | null;
  if (!e) return false;
  if (e.code === "P2020") return true;
  const msg = typeof e.message === "string" ? e.message : "";
  // Só pelo TEXTO: o número "22003" sozinho casaria com um SKU ou id qualquer
  // dentro de outra mensagem. O Postgres sempre escreve "numeric field overflow".
  return /numeric field overflow|value out of range for the type/i.test(msg);
}
