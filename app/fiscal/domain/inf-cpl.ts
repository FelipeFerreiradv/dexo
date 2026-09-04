/**
 * Composição das Informações Complementares (`<infAdic><infCpl>`) da NF-e.
 *
 * Único ponto de verdade para a ordem do texto — observações do usuário
 * primeiro, depois `Pedido: <n>` — compartilhado pelos dois builders de XML
 * (SEFAZ direto e Focus NFe) e pelos geradores de DANFE. Vazio ⇒ string vazia
 * (os builders então NÃO emitem `<infAdic>`, preservando o XML atual).
 */

import {
  formatDimensoesParaInfCpl,
  isNfeFreteMedidasEnabled,
} from "./frete";

/** Limite do campo infCpl no leiaute 4.00 da NF-e. */
export const INF_CPL_MAX_LENGTH = 5000;

/** Separador entre os trechos do infCpl. */
const SEP = " | ";

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
  /** `volumesJson` da nota — fonte das dimensões (o leiaute não tem campo). */
  volumesJson?: unknown;
}): string {
  const pedido = draft.numeroPedido ? `Pedido: ${draft.numeroPedido}` : "";
  // Dimensões dos volumes: a NF-e 4.00 não tem campo para elas, então o único
  // caminho até o destinatário é este texto livre. Atrás da flag para que o
  // desligamento devolva o infCpl byte-idêntico ao de antes.
  // O orcamento das medidas ja desconta o "Pedido: N" e o separador, entao o
  // pedido nunca pode ser empurrado para fora do limite de 5000 (nem cortado
  // ao meio) por uma nota com muitos volumes.
  const reservaPedido = pedido ? pedido.length + SEP.length : 0;
  const dimensoes = isNfeFreteMedidasEnabled()
    ? formatDimensoesParaInfCpl(
        draft.volumesJson,
        INF_CPL_MAX_LENGTH - reservaPedido,
      )
    : "";
  let obs = sanitizeFreeText(draft.informacoesComplementares);

  // "Pedido: N" e as dimensões têm prioridade no limite de 5000: se a soma
  // estourar, quem cede espaço é a observação — nunca cortamos o número do
  // pedido nem uma medida no meio.
  const fixos = [dimensoes, pedido].filter(Boolean);
  if (obs && fixos.length > 0) {
    const ocupado = fixos.reduce((acc, p) => acc + p.length + SEP.length, 0);
    const maxObs = INF_CPL_MAX_LENGTH - ocupado;
    if (maxObs <= 0) obs = "";
    else if (obs.length > maxObs) obs = obs.slice(0, maxObs);
  }

  const parts = [obs, dimensoes, pedido].filter(Boolean);
  return parts.join(SEP).slice(0, INF_CPL_MAX_LENGTH);
}
