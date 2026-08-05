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
 * "Selecionar todos" NÃO tem regra própria: ele marca na ordem visível, e a
 * ordem visível é a que o usuário escolheu no seletor de ordenação da lista
 * (`useProductSort`). Houve uma versão intermediária em que ele inseria de
 * baixo para cima, para compensar a listagem ser fixa em newest-first; com o
 * seletor existindo isso passou a CONTRADIZER o usuário — quem escolhesse "SKU
 * crescente" e marcasse tudo receberia o PDF em SKU decrescente.
 *
 * Kill-switch: NEXT_PUBLIC_LABELS_ORDER_LEGACY=1 restaura exatamente o
 * comportamento anterior. A env é lida DENTRO da função (e
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
