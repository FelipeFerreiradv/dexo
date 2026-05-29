import { useMemo } from "react";
import { tokenize } from "../lib/search-utils";
import {
  buildTree,
  buildFullPathMap,
  filterTree,
  countNodes,
  type FlatNode,
  type TreeNode,
} from "../lib/location-tree";

export interface UseLocationSearchResult<T> {
  /** Árvore a renderizar: completa quando inativa, podada quando há busca. */
  filtered: Array<TreeNode<T>>;
  /** Mapa id → caminho legível ("GAL-01 / PRAT-02 / SUB-03"). */
  pathMap: Map<string, string>;
  /** Tokens normalizados da query (para highlight). */
  tokens: string[];
  /** Ids com match direto (highlight/contagem). */
  matchedIds: Set<string>;
  /** Ids a forçar expandidos (ancestrais de matches). */
  expandedIds: Set<string>;
  /** Contagem exibida: total de nós quando inativo, matches quando ativo. */
  count: number;
  /** Total de nós (todas as profundidades). */
  total: number;
  /** Há busca ativa? */
  active: boolean;
}

/**
 * Deriva, de forma memoizada, a árvore e o resultado da busca a partir da lista
 * achatada (`GET /locations?tree=full`) e da query.
 *
 * Memoização em camadas:
 * - árvore e pathMap recalculam só quando `flat` muda (refetch — raro);
 * - o filtro recalcula quando muda a query (debounced a montante).
 */
export function useLocationSearch<T extends FlatNode>(
  flat: T[],
  query: string,
): UseLocationSearchResult<T> {
  const tree = useMemo(() => buildTree(flat), [flat]);
  const pathMap = useMemo(() => buildFullPathMap(flat), [flat]);
  const total = useMemo(() => countNodes(tree), [tree]);
  const tokens = useMemo(() => tokenize(query), [query]);
  const active = tokens.length > 0;

  return useMemo(() => {
    if (!active) {
      return {
        filtered: tree,
        pathMap,
        tokens,
        matchedIds: new Set<string>(),
        expandedIds: new Set<string>(),
        count: total,
        total,
        active,
      };
    }
    const { filtered, matchedIds, expandedIds, count } = filterTree(
      tree,
      tokens,
    );
    return {
      filtered,
      pathMap,
      tokens,
      matchedIds,
      expandedIds,
      count,
      total,
      active,
    };
  }, [active, tree, pathMap, tokens, total]);
}
