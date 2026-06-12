/**
 * Composição das Informações Complementares (`<infAdic><infCpl>`) da NF-e.
 *
 * Único ponto de verdade para a ordem do texto — observações do usuário
 * primeiro, depois `Pedido: <n>` — compartilhado pelos dois builders de XML
 * (SEFAZ direto e Focus NFe) e pelos geradores de DANFE. Vazio ⇒ string vazia
 * (os builders então NÃO emitem `<infAdic>`, preservando o XML atual).
 */

/** Limite do campo infCpl no leiaute 4.00 da NF-e. */
export const INF_CPL_MAX_LENGTH = 5000;

/**
 * Normaliza texto livre digitado pelo usuário: CRLF → LF e remove caracteres
 * de controle inválidos em XML 1.0 (mantém `\n` e `\t`). O escape de `&<>"`
 * fica a cargo do serializador (xmlbuilder2/JSON) — aqui só garantimos que
 * nenhum byte proibido chegue a ele.
 */
export function sanitizeFreeText(s: string | null | undefined): string {
  if (!s) return "";
  const normalized = s.replace(/\r\n?/g, "\n");
  let out = "";
  for (const ch of normalized) {
    const code = ch.charCodeAt(0);
    const isControl = (code < 32 && ch !== "\n" && ch !== "\t") || code === 127;
    if (!isControl) out += ch;
  }
  return out.trim();
}

export function composeInfCpl(draft: {
  informacoesComplementares?: string | null;
  numeroPedido?: string | null;
}): string {
  const pedido = draft.numeroPedido ? `Pedido: ${draft.numeroPedido}` : "";
  let obs = sanitizeFreeText(draft.informacoesComplementares);

  // O "Pedido: N" tem prioridade no limite de 5000: se a soma estourar, quem
  // cede espaço é a observação — nunca cortamos o número do pedido no meio.
  if (obs && pedido) {
    const maxObs = INF_CPL_MAX_LENGTH - pedido.length - " | ".length;
    if (maxObs <= 0) obs = "";
    else if (obs.length > maxObs) obs = obs.slice(0, maxObs);
  }

  const parts = [obs, pedido].filter(Boolean);
  return parts.join(" | ").slice(0, INF_CPL_MAX_LENGTH);
}
