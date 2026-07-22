import { chunk } from "./chunk";

/**
 * Executa uma consulta `IN (...)` em lotes, contornando o teto de 32767 bind
 * variables do PostgreSQL.
 *
 * O Prisma monta um bind por elemento do `in:`, então uma conta grande
 * (>32k anúncios) derruba a query inteira com
 * `too many bind variables in prepared statement`. Em vez de espalhar
 * `chunk()` e números mágicos por cada chamada, o padrão fica aqui.
 *
 * Decisões que importam:
 *  - **Dedupe antes de fatiar**: ids repetidos viram binds e linhas repetidas
 *    à toa. `Set` também deixa o nº de lotes previsível.
 *  - **Lista vazia não toca o banco**: preserva os guards `length > 0` dos
 *    chamadores (uma query a menos, egress idêntico ao de hoje).
 *  - **Lotes sequenciais, não `Promise.all`**: numa conta de centenas de
 *    milhares de itens, paralelizar abriria dezenas de conexões do pool ao
 *    mesmo tempo e seguraria todos os resultados em memória de uma vez.
 *    Sequencial mantém pool e memória sob controle e ainda é rápido — são
 *    poucos lotes (32k ids = 4 queries).
 *  - **`size` com folga**: 10.000 é o mesmo valor já usado em
 *    `marketplace.repository.ts`, bem abaixo do teto mesmo quando o `where`
 *    tem outros campos (cada um também consome bind).
 *
 * @param ids   valores do `in:` (pode ter repetidos; pode ser vazio)
 * @param query recebe UM lote e devolve as linhas dele
 * @param size  ids por lote (default 10.000)
 */
export async function findManyInChunks<TId, TRow>(
  ids: readonly TId[],
  query: (idsChunk: TId[]) => Promise<TRow[]>,
  size = 10_000,
): Promise<TRow[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  // Caminho rápido: cabe num lote só → sem overhead de concat.
  if (unique.length <= size) return query(unique);

  const rows: TRow[] = [];
  for (const part of chunk(unique, size)) {
    rows.push(...(await query(part)));
  }
  return rows;
}
