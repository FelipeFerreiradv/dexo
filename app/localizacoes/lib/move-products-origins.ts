/**
 * Resumo da ORIGEM de uma movimentação de peças, a partir de um `groupBy` feito
 * ANTES da escrita.
 *
 * POR QUE EXISTE
 * --------------
 * `LocationRepositoryPrisma.moveProducts` faz um `updateMany` que sobrescreve
 * `locationId` e o texto `location`. Depois do update a origem não existe mais,
 * em lugar nenhum — não há tabela de histórico. Quem quiser auditar de onde a
 * peça saiu precisa ler ANTES.
 *
 * E a mesma leitura resolve um segundo defeito: o `where` do `updateMany` é
 * `{ id: { in: productIds }, userId }`, **sem predicado de origem**. Peça que já
 * estava no destino é reescrita e entra no `result.count`. Ou seja, o `count`
 * responde "quantas linhas casaram", não "quantas mudaram de lugar" — e era com
 * ele que a tela montava um toast verde de sucesso.
 *
 * Uma leitura, dois defeitos. Função pura: recebe as linhas do `groupBy`, não
 * conhece Prisma.
 */

export interface LinhaOrigem {
  locationId: string | null;
  location: string | null;
  _count: { _all: number };
}

export interface OrigemDaMovimentacao {
  locationId: string | null;
  caminho: string | null;
  quantidade: number;
}

export interface ResumoOrigens {
  origens: OrigemDaMovimentacao[];
  origensTruncadas: boolean;
  /** ids DISTINTOS pedidos (a rota não deduplica; aqui deduplicamos). */
  solicitados: number;
  /** existiam, são do tenant e estavam FORA do destino. */
  movidos: number;
  /** existiam, são do tenant e JÁ estavam no destino. */
  jaNoDestino: number;
  /** não existem ou são de outro dono — o `updateMany` descarta em silêncio. */
  naoEncontrados: number;
}

/** Teto da lista de origens no log, para o registro não virar um blob. */
export const MAX_ORIGENS_REGISTRADAS = 25;

export function summarizeMoveOrigins(
  linhas: LinhaOrigem[],
  targetLocationId: string | null,
  productIds: string[],
  maxOrigens = MAX_ORIGENS_REGISTRADAS,
): ResumoOrigens {
  const solicitados = new Set(productIds).size;

  let encontrados = 0;
  let jaNoDestino = 0;
  const todas: OrigemDaMovimentacao[] = [];

  for (const l of linhas) {
    const n = l._count?._all ?? 0;
    encontrados += n;
    // Desvincular tem destino `null`: peça já sem localização também "já está
    // no destino". Comparar os dois lados normalizados evita tratar null como
    // um caso especial espalhado pelo código.
    if ((l.locationId ?? null) === (targetLocationId ?? null)) {
      jaNoDestino += n;
      continue;
    }
    todas.push({
      locationId: l.locationId ?? null,
      caminho: l.location ?? null,
      quantidade: n,
    });
  }

  todas.sort((a, b) => b.quantidade - a.quantidade);

  return {
    origens: todas.slice(0, maxOrigens),
    origensTruncadas: todas.length > maxOrigens,
    solicitados,
    movidos: encontrados - jaNoDestino,
    jaNoDestino,
    naoEncontrados: Math.max(0, solicitados - encontrados),
  };
}
