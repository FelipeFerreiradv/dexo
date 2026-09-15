/**
 * Paginação incremental da gaveta "Produtos em <caixa>".
 *
 * Módulo puro pelo mesmo motivo de `move-products-decisions.ts`: sem
 * `@testing-library/react` e sem jsdom, a decisão só é testável fora do React.
 *
 * O QUE ISTO PROTEGE (chamado MK2, 09/2026): a gaveta pedia `limit=50` e NUNCA
 * mandava `page`. O cabeçalho mostrava o total verdadeiro e a lista mostrava 50.
 * Medido em produção em 15/09/2026: a MK2 tem 160 caixas com mais de 50 peças e
 * **11.518 peças inalcançáveis pela tela** (39,3% das 29.336 endereçadas). Numa
 * caixa de 168, mover algumas peças não muda nada visível — as que saem são
 * repostas por outras vindas da posição 51 — e o operador repete a operação
 * achando que não funcionou.
 *
 * ⚠️ E o "Selecionar todos" marcava só as 50 carregadas, sob esse rótulo. Quem
 * lê "168 produto(s) vinculado(s)", marca tudo e manda mover, move 50 achando
 * que moveu 168. Corrigir a paginação sem corrigir o rótulo trocaria um bug
 * visível por um destrutivo.
 */

export const TAMANHO_PAGINA_GAVETA = 50;

/**
 * Concatena a próxima página descartando repetidos.
 *
 * Não é preciosismo: `getProductsByLocationId` ordena por `name asc` e, até esta
 * correção, sem desempate — peças de nome igual e SKU diferente (o normal num
 * desmonte) podiam aparecer em duas páginas. O desempate por `id` foi adicionado
 * no repositório; esta função é a rede de segurança do lado do cliente.
 *
 * Preserva a ordem de chegada e nunca reordena o que já está na tela.
 */
export function appendUniqueById<T extends { id: string }>(
  atual: T[],
  novos: T[],
): T[] {
  const vistos = new Set(atual.map((p) => p.id));
  const saida = atual.slice();
  for (const item of novos) {
    if (vistos.has(item.id)) continue;
    vistos.add(item.id);
    saida.push(item);
  }
  return saida;
}

export function hasMoreProducts(carregados: number, total: number): boolean {
  return carregados > 0 && carregados < total;
}

/** "Mostrando 50 de 168" — some quando não há o que esconder. */
export function describeSheetCount(
  carregados: number,
  total: number,
): string | null {
  if (total <= 0) return null;
  if (carregados >= total) return null;
  return `Mostrando ${carregados} de ${total}`;
}

/**
 * O rótulo do "selecionar todos" tem de dizer o que a ação REALMENTE faz.
 * Com tudo carregado ele volta a ser "Selecionar todos" — quem tem 12 peças na
 * caixa não precisa ser alertado de nada.
 */
export function describeSelectAll(
  carregados: number,
  total: number,
): { label: string; hint: string | null } {
  if (total <= 0 || carregados >= total) {
    return { label: "Selecionar todos", hint: null };
  }
  return {
    label: `Selecionar os ${carregados} carregados`,
    hint: `de ${total}`,
  };
}

/** "Carregar mais (118 restantes)" — `null` quando já está tudo na tela. */
export function describeLoadMore(
  carregados: number,
  total: number,
): string | null {
  if (!hasMoreProducts(carregados, total)) return null;
  return `Carregar mais (${total - carregados} restantes)`;
}

/**
 * Acima disto, clicar "Carregar mais" repetidas vezes é pior que usar a busca:
 * a `P1-ACABAMENTODIVERSOS` da MK2 tem 4.067 peças, o que daria 81 cliques e
 * 4.067 linhas com imagem no DOM.
 */
export const LIMIAR_SUGERIR_BUSCA = 300;

export function shouldSuggestSearch(carregados: number, total: number): boolean {
  return hasMoreProducts(carregados, total) && total > LIMIAR_SUGERIR_BUSCA;
}

/**
 * Próxima página a pedir, a partir da ÚLTIMA página realmente carregada.
 *
 * ⚠️ De propósito NÃO deriva de `produtosCarregados.length`: o
 * `appendUniqueById` descarta repetidos, então o length deixa de ser múltiplo
 * do tamanho de página e `floor(length / 50) + 1` devolveria uma página que já
 * foi buscada — uma requisição inteira que acrescenta zero item, com o botão
 * travado repetindo a mesma página para sempre. Quem chama guarda a página.
 */
export function nextPage(ultimaPaginaCarregada: number): number {
  return Math.max(1, Math.floor(ultimaPaginaCarregada)) + 1;
}
