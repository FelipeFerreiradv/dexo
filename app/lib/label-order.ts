/**
 * Ordem canônica das etiquetas no PDF — uma regra só para toda a aplicação.
 *
 * REGRA: o PDF respeita a ORDEM EM QUE O USUÁRIO SELECIONOU. Item marcado
 * primeiro = primeira etiqueta do PDF. É o único critério que funciona igual em
 * lista, catálogo, busca filtrada e seleção parcial.
 *
 * O que existia antes: cada tela fazia `colecao.filter(item => selecionados
 * .inclui(item.id))`, o que devolve a ordem da COLEÇÃO (a ordem da tela) e joga
 * fora a ordem de clique. Na listagem de produtos a coleção vem do SQL com
 * `ORDER BY (stock > 0) DESC, "createdAt" DESC` — mais novo primeiro —, então
 * quem cadastrava 1..10 e mandava imprimir recebia 10..1. Não havia `reverse()`
 * nem sort escondido: o PDF só refletia fielmente a ordem da listagem.
 *
 * Kill-switch: NEXT_PUBLIC_LABELS_ORDER_LEGACY=1 restaura exatamente o
 * comportamento anterior nas duas funções. A env é lida DENTRO das funções (e
 * não num const de módulo) para o valor não congelar no import — o Next inlina
 * `process.env.NEXT_PUBLIC_*` no build em qualquer posição, então continua
 * funcionando no bundle do cliente.
 *
 * Sem dependência de React: é lógica pura, testável em unidade.
 */

function isLegacyOrder(): boolean {
  return process.env.NEXT_PUBLIC_LABELS_ORDER_LEGACY === "1";
}

/**
 * Resolve os itens selecionados NA ORDEM DA SELEÇÃO.
 *
 * Complexidade O(n + m) — um passe pela coleção para indexar por id e um passe
 * pela seleção. Nada de `indexOf` dentro de `sort` (que seria O(n·m·log m)) nem
 * de `includes` dentro de `filter` (O(n·m), que era o custo do código anterior
 * em `products-list.tsx`).
 *
 * Tolerante por construção:
 *  - id selecionado que não está mais na coleção (item saiu da página, foi
 *    excluído, filtro mudou) é ignorado sem quebrar;
 *  - id repetido na seleção gera UMA etiqueta só, como antes;
 *  - coleção vazia ou seleção vazia devolvem lista vazia.
 *
 * Quando dois itens da coleção compartilham o mesmo id (não acontece hoje —
 * ids são únicos), vence o primeiro, que é o que o `filter` anterior manteria
 * na frente.
 */
export function orderBySelection<T>(
  items: readonly T[],
  selectedIds: readonly string[],
  getId: (item: T) => string,
): T[] {
  if (isLegacyOrder()) {
    // Caminho antigo, byte-idêntico: ordem da coleção, não da seleção.
    const selected = new Set(selectedIds);
    return items.filter((item) => selected.has(getId(item)));
  }

  const byId = new Map<string, T>();
  for (const item of items) {
    const id = getId(item);
    if (!byId.has(id)) byId.set(id, item);
  }

  const ordered: T[] = [];
  const emitted = new Set<string>();
  for (const id of selectedIds) {
    if (emitted.has(id)) continue;
    const item = byId.get(id);
    if (item === undefined) continue;
    emitted.add(id);
    ordered.push(item);
  }
  return ordered;
}

/**
 * Ids que o "selecionar todos" deve inserir, na ordem em que devem sair no PDF.
 *
 * A listagem de produtos é servida com o mais novo primeiro e NÃO tem controle
 * de ordenação — não há como o usuário pedir crescente. Se "selecionar todos"
 * inserisse na ordem visível, o PDF continuaria saindo 10..1, que é exatamente
 * a queixa. Por isso aqui a inserção é de BAIXO PARA CIMA: com a lista
 * newest-first, isso entrega o mais antigo primeiro, ou seja, a ordem de
 * cadastro — que para peças cadastradas em sequência é a ordem crescente de
 * SKU que o cliente espera na impressão.
 *
 * A regra do `orderBySelection` continua valendo: quem marca item a item manda
 * na ordem, e "selecionar todos" é só um atalho que já entrega a seleção na
 * ordem certa.
 */
export function selectAllIdsInPrintOrder<T>(
  items: readonly T[],
  getId: (item: T) => string,
): string[] {
  const ids = items.map(getId);
  if (isLegacyOrder()) return ids;
  return ids.reverse();
}
