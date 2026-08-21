/**
 * Decisões de estado da lista de conversas, isoladas do componente.
 *
 * Elas existem separadas porque cada uma corrige um defeito de LÓGICA, e lógica
 * precisa de teste — mas a suíte roda em `environment: "node"` e o `jsdom` deste
 * repo está quebrado (vem só como dependência opcional do `fabric`). Mesmo
 * caminho de `app/produtos/lib/location-scan-decision.ts`.
 */

/** Só o que estas funções precisam — não acopla a lib ao DTO inteiro. */
export interface ItemConversa {
  externalItemId: string;
  unreadCount: number;
}

/** Por quanto tempo uma leitura confirmada veta a ressurreição do contador. */
export const READ_ACK_TTL_MS = 5 * 60_000;

/** Descarta confirmações de leitura velhas demais para importar. */
export function podarLeiturasAntigas(
  leituras: Map<string, number>,
  agora: number = Date.now(),
): void {
  const limite = agora - READ_ACK_TTL_MS;
  for (const [itemId, quando] of leituras) {
    if (quando < limite) leituras.delete(itemId);
  }
}

/**
 * Impede que uma resposta ATRASADA ressuscite o contador (H4 do diagnóstico).
 *
 * A lista tinha três disparadores de refetch e dois rodavam sem
 * AbortController. Uma requisição iniciada ANTES da leitura ser confirmada
 * podia voltar DEPOIS e sobrescrever o zero com o valor velho — o número
 * "voltava" em segundos.
 *
 * Regra: se a leitura daquele item foi confirmada DEPOIS que esta requisição
 * começou, o dado que ela traz é anterior à leitura e não vale para o contador.
 * Se a requisição começou depois da confirmação, o servidor já respondeu
 * considerando a leitura — e aí o valor dele é a verdade, inclusive um número
 * novo legítimo (outra pessoa perguntou no mesmo anúncio).
 */
export function aplicarLeiturasConfirmadas<T extends ItemConversa>(
  itens: T[],
  leituras: Map<string, number>,
  iniciadoEm: number,
): T[] {
  return itens.map((item) => {
    const confirmadaEm = leituras.get(item.externalItemId);
    return confirmadaEm !== undefined && confirmadaEm > iniciadoEm
      ? { ...item, unreadCount: 0 }
      : item;
  });
}

/**
 * Aplica a página 0 recém-buscada sobre a lista acumulada, preservando as
 * páginas profundas que o usuário já abriu com "Carregar mais".
 *
 * O que saiu da página 0 (empurrado por mensagem nova) desce na lista em vez de
 * sumir da tela.
 */
export function mesclarPagina0<T extends ItemConversa>(
  anteriores: T[],
  pagina0: T[],
): T[] {
  const naPagina0 = new Set(pagina0.map((c) => c.externalItemId));
  const resto = anteriores.filter((c) => !naPagina0.has(c.externalItemId));
  return [...pagina0, ...resto];
}
