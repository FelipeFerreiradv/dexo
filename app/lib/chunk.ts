/**
 * Quebra um array em sub-arrays de tamanho fixo. Útil para evitar o limite
 * de bind variables do PostgreSQL (32767) em queries `IN (...)` grandes:
 * com muitos IDs, o Prisma estoura com `too many bind variables in prepared
 * statement`. A solução é rodar várias queries menores, idealmente dentro
 * de uma transação para preservar atomicidade.
 *
 * @throws Error se `size <= 0`
 */
export function chunk<T>(arr: ReadonlyArray<T>, size: number): T[][] {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error(`chunk size deve ser um inteiro positivo (recebido: ${size})`);
  }
  if (arr.length === 0) return [];
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}
