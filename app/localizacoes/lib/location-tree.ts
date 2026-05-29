/**
 * Construção e filtragem da árvore de Localizações no cliente, a partir da
 * lista achatada retornada por `GET /locations?tree=full`. Funções puras (sem
 * React/DOM) para serem testáveis isoladamente.
 */
import { matchesTokens } from "./search-utils";

/** Campos mínimos necessários para montar a árvore e buscar. */
export interface FlatNode {
  id: string;
  code: string;
  description?: string | null;
  parentId?: string | null;
}

/** Nó de árvore: o item original com `children` resolvido (sempre presente). */
export type TreeNode<T> = T & { children: Array<TreeNode<T>> };

export interface FilterResult<T> {
  /** Árvore podada: só ramos com match e seus ancestrais. */
  filtered: Array<TreeNode<T>>;
  /** Ids dos nós que casam diretamente (code/description/caminho). */
  matchedIds: Set<string>;
  /** Ids a forçar expandidos (ancestrais de matches). */
  expandedIds: Set<string>;
  /** Quantidade de nós com match direto. */
  count: number;
}

/**
 * Monta a árvore a partir da lista achatada usando `parentId`. Nós cujo pai
 * não está presente (órfãos) sobem para a raiz, de forma defensiva — nada
 * "desaparece". Preserva a ordem de entrada (a lista já vem ordenada por code).
 */
export function buildTree<T extends FlatNode>(flat: T[]): Array<TreeNode<T>> {
  const nodes = new Map<string, TreeNode<T>>();
  for (const item of flat) {
    nodes.set(item.id, { ...item, children: [] });
  }

  const roots: Array<TreeNode<T>> = [];
  for (const item of flat) {
    const node = nodes.get(item.id)!;
    const parent = item.parentId != null ? nodes.get(item.parentId) : undefined;
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

/**
 * Constrói o mapa `id → caminho legível` (ex.: "GAL-01 / PRAT-02 / SUB-03")
 * subindo por `parentId`. Usa cache e proteção contra ciclos. Separador " / "
 * (distinto do " > " usado por `/locations/select`).
 */
export function buildFullPathMap<T extends FlatNode>(
  flat: T[],
): Map<string, string> {
  const byId = new Map(flat.map((n) => [n.id, n]));
  const cache = new Map<string, string>();

  const pathOf = (node: T, seen: Set<string>): string => {
    const cached = cache.get(node.id);
    if (cached !== undefined) return cached;
    if (seen.has(node.id)) return node.code; // ciclo defensivo
    seen.add(node.id);

    const parent = node.parentId != null ? byId.get(node.parentId) : undefined;
    const path = parent ? `${pathOf(parent, seen)} / ${node.code}` : node.code;
    cache.set(node.id, path);
    return path;
  };

  for (const node of flat) pathOf(node, new Set());
  return cache;
}

/** Conta todos os nós de uma árvore (raízes + descendentes). */
export function countNodes<T>(tree: Array<TreeNode<T>>): number {
  let n = 0;
  const walk = (list: Array<TreeNode<T>>) => {
    for (const node of list) {
      n += 1;
      walk(node.children);
    }
  };
  walk(tree);
  return n;
}

/**
 * Filtra a árvore para uma busca ativa:
 * - Um nó é mantido se casa OU tem descendente que casa.
 * - Nó que casa mantém sua subárvore COMPLETA (container navegável).
 * - Nó que não casa mas tem descendente-match é mantido só com o caminho até
 *   o(s) match(es) (galhos sem match são podados) e entra em `expandedIds`.
 * - `matchedIds`/`count` contam apenas matches diretos.
 *
 * O match considera apenas o `code`+`description` do PRÓPRIO nó (não o
 * caminho/ancestrais): assim `count` e highlight ficam previsíveis e buscar o
 * código de um container já revela toda a sua subárvore sem inflar a contagem.
 * Tokens vazios → árvore inteira, sem matches nem expansão forçada.
 */
export function filterTree<
  T extends { id: string; code: string; description?: string | null },
>(tree: Array<TreeNode<T>>, tokens: string[]): FilterResult<T> {
  const matchedIds = new Set<string>();
  const expandedIds = new Set<string>();

  if (tokens.length === 0) {
    return { filtered: tree, matchedIds, expandedIds, count: 0 };
  }

  const visit = (node: TreeNode<T>): TreeNode<T> | null => {
    const selfMatch = matchesTokens(tokens, {
      code: node.code,
      description: node.description,
    });
    if (selfMatch) matchedIds.add(node.id);

    // Visita todos os filhos (efeitos colaterais nos sets globais).
    const keptChildren: Array<TreeNode<T>> = [];
    for (const child of node.children) {
      const kept = visit(child);
      if (kept) keptChildren.push(kept);
    }

    if (selfMatch) {
      // Container que casa: mostra a subárvore original inteira (navegável).
      if (node.children.length > 0) expandedIds.add(node.id);
      return node;
    }
    if (keptChildren.length > 0) {
      // Ancestral de match: poda galhos sem match e auto-expande o caminho.
      expandedIds.add(node.id);
      return { ...node, children: keptChildren };
    }
    return null;
  };

  const filtered: Array<TreeNode<T>> = [];
  for (const root of tree) {
    const kept = visit(root);
    if (kept) filtered.push(kept);
  }

  return { filtered, matchedIds, expandedIds, count: matchedIds.size };
}
