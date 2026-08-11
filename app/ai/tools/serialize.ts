// Normalização do que sai de uma tool para o contexto do modelo.
//
// Três problemas concretos que este arquivo resolve, todos descobertos lendo o
// que o Prisma realmente devolve:
//
//  1. `Decimal` tem `toJSON` que produz STRING. `{"total":"84320.00"}` leva o
//     modelo a tratar dinheiro como texto e a errar comparação e soma.
//  2. `BigInt` (todo COUNT(*) de `$queryRaw`) faz `JSON.stringify` LANÇAR.
//  3. `Date` vira ISO em UTC. A loja opera em São Paulo, e "01/08 21:00 UTC" é
//     31/07 para o lojista — a resposta cairia no mês errado.
//
// Nada aqui lança: entrada inesperada vira `null`, nunca uma exceção no meio de
// uma consulta que já custou uma ida ao banco.

/** Fuso da operação. Toda data que o usuário lê passa por aqui. */
export const TIMEZONE_LOJA = "America/Sao_Paulo";

/**
 * Decimal | number | string | null -> number | null.
 *
 * Use em TODO campo de dinheiro, peso e medida antes de devolver.
 */
export function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return Number(value);
  // Decimal do Prisma (decimal.js): tem toNumber().
  if (typeof (value as any)?.toNumber === "function") {
    const n = (value as any).toNumber();
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Dinheiro: número com 2 casas. Evita `84320.000000001` no contexto. */
export function money(value: unknown): number | null {
  const n = num(value);
  return n === null ? null : Math.round(n * 100) / 100;
}

const dataFormatter = new Intl.DateTimeFormat("pt-BR", {
  timeZone: TIMEZONE_LOJA,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

const dataHoraFormatter = new Intl.DateTimeFormat("pt-BR", {
  timeZone: TIMEZONE_LOJA,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/**
 * Data civil no fuso da loja, no formato que o lojista lê (dd/mm/aaaa).
 *
 * ISO em UTC seria mais "correto" tecnicamente e mais errado na prática: o
 * modelo repete o que recebe, e o usuário veria a data de ontem em toda venda
 * feita depois das 21h.
 */
export function data(value: unknown): string | null {
  const d = toDate(value);
  return d ? dataFormatter.format(d) : null;
}

/** Data e hora no fuso da loja. */
export function dataHora(value: unknown): string | null {
  const d = toDate(value);
  return d ? dataHoraFormatter.format(d) : null;
}

function toDate(value: unknown): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value as string);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Corta texto longo. Descrição de produto pode ter milhares de caracteres. */
export function texto(value: unknown, max = 240): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).replace(/\s+/g, " ").trim();
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
