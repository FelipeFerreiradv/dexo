/**
 * Marcar-como-lida da aba de Mensagens, isolado do componente.
 *
 * Existe separado porque o defeito que ele corrige é de DECISÃO, e decisão
 * precisa de teste. O efeito do ChatPane fazia o POST sem checar `res.ok` e
 * chamava `onAfterRead` sempre: 401/404/5xx caíam no caminho de sucesso, o
 * badge zerava na tela e voltava no poll de 30 s — o "some e volta" relatado.
 *
 * Por que um módulo e não um teste de componente: a suíte roda em
 * `environment: "node"` e o `jsdom` deste repo vem apenas como dependência
 * OPCIONAL do `fabric` (e está quebrado neste ambiente — falha idêntica no HEAD
 * limpo). Mesmo padrão já adotado em `app/produtos/lib/location-scan-decision.ts`.
 */

export type ResultadoLeitura =
  | { confirmada: true; atualizadas: number }
  | {
      confirmada: false;
      motivo: "abortada" | "http" | "rede";
      detalhe?: string;
    };

export interface ParametrosLeitura {
  apiBase: string;
  accountId: string;
  itemId: string;
  headers: HeadersInit;
  signal?: AbortSignal;
  /** Injeção para teste; em produção usa o `fetch` global (com o Bearer da ponte). */
  fetchImpl?: typeof fetch;
}

/**
 * POST /messages/conversations/:itemId/read.
 *
 * Só devolve `confirmada: true` num 2xx — é o único caso em que o chamador pode
 * zerar o badge. Qualquer outro desfecho preserva o número que o servidor
 * mostra, em vez de mentir e deixar o próximo poll desfazer.
 */
export async function marcarConversaLida(
  params: ParametrosLeitura,
): Promise<ResultadoLeitura> {
  const { apiBase, accountId, itemId, headers, signal, fetchImpl } = params;
  const executar = fetchImpl ?? fetch;
  // URL montada exatamente como antes (accountId cru) — nada de mudar o
  // contrato da chamada junto com a correção do tratamento de erro.
  const url = `${apiBase}/messages/conversations/${encodeURIComponent(itemId)}/read?accountId=${accountId}`;

  try {
    const res = await executar(url, { method: "POST", headers, signal });
    if (!res.ok) {
      return { confirmada: false, motivo: "http", detalhe: `HTTP ${res.status}` };
    }
    // A rota devolve { updated }. Corpo ilegível NÃO invalida o 2xx: o servidor
    // já gravou; perdemos só a contagem, não a certeza.
    const corpo = (await res.json().catch(() => null)) as {
      updated?: number;
    } | null;
    return { confirmada: true, atualizadas: Number(corpo?.updated ?? 0) };
  } catch (err) {
    if ((err as { name?: string })?.name === "AbortError") {
      return { confirmada: false, motivo: "abortada" };
    }
    return {
      confirmada: false,
      motivo: "rede",
      detalhe: err instanceof Error ? err.message : String(err),
    };
  }
}
