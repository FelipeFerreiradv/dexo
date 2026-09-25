// Decisões de tela do erro do passo "Impostos" do wizard (POST
// /fiscal/nfe/draft/:id/calculate), em módulo puro para serem testadas em node
// — mesmo motivo do `nfe-numeracao-ui.ts` e do `nfe-ajuste-numeracao-ui.ts` ao
// lado: o texto que o dono do desmanche lê é o produto, e produto se testa.
//
// O caso real (DLS AUTO PEÇAS, 24/09/2026): rascunho com
// `finalidade = DEVOLUCAO` aberto À MÃO, antes de existir devolução gerenciada.
// O rascunho não tem linha em `NfeDevolucao`, então o `/calculate` cai no ramo
// de devolução e o `contextoEmissao` responde 404 DEVOLUCAO_NAO_GERENCIADA. Vai
// responder 404 PARA SEMPRE: nada nesta tela cria aquela linha — quem cria é o
// "Devolver total"/"Devolver parcial" em cima da NOTA DE VENDA original. Mesmo
// assim a tela oferecia "Tentar novamente", que só repetia o mesmo 404.
//
// Regra: perde o "Tentar novamente" APENAS o que é comprovadamente PERMANENTE.
// Tudo o mais — rede caída, 500, e códigos como RASCUNHO_ALTERADO, cuja própria
// mensagem do servidor manda tentar de novo — segue exatamente como antes.
//
// Módulo PURO: sem React, sem fetch, sem DOM.

import {
  viewPendenciasDaResposta,
  type PendenciasDevolucaoView,
} from "./nfe-devolucao-pendencias-ui";

/** Corpo de erro do POST /fiscal/nfe/draft/:id/calculate (ou nada, quando a rede caiu). */
export interface RespostaErroCalculo {
  error?: unknown;
  code?: unknown;
  /**
   * Lista de pendências do 422 DEVOLUCAO_INVALIDA. Ela SEMPRE veio no corpo
   * (`fiscal.routes.ts` serializa `issues` do `DevolucaoError`) — o que faltava
   * era alguém lê-la. Ver `nfe-devolucao-pendencias-ui`.
   */
  issues?: unknown;
}

export type AcaoErroCalculo = "TENTAR_NOVAMENTE" | "IR_PARA_NOTAS_EMITIDAS";

export interface ErroCalculoView {
  /** Código do servidor quando veio um; `null` para erro sem código (rede, 500 cru). */
  codigo: string | null;
  /** `true` só quando repetir a MESMA chamada não tem como mudar de resultado. */
  permanente: boolean;
  /** Título curto do quadro; `null` mantém o quadro de antes (só a mensagem). */
  titulo: string | null;
  mensagem: string;
  /** Passo a passo do caminho certo. Vazio quando não há caminho a indicar. */
  passos: readonly string[];
  acao: AcaoErroCalculo;
  /**
   * Quando o erro é o bloqueio da devolução (DEVOLUCAO_INVALIDA), o que falta
   * item a item. Ausente em todo o resto — a tela segue como antes.
   */
  pendencias?: PendenciasDevolucaoView;
}

/** Fallback histórico desta tela quando o servidor não manda `error`. */
export const MENSAGEM_CALCULO_GENERICA = "Erro ao calcular impostos";

/** Lista de notas emitidas — é lá que ficam "Devolver total" e "Devolver parcial". */
export const LINK_NOTAS_EMITIDAS = "/notas-fiscais/emitidas";
export const ROTULO_IR_PARA_NOTAS_EMITIDAS = "Ir para Notas Emitidas";
// O passo a passo abaixo e o da devolucao de VENDA. Dizer so "esta devolução"
// deixava a lista parecer o unico caminho, e ela NAO serve para quem devolve uma
// COMPRA (nao existe "nota de venda original" para procurar) — que era
// justamente o caso da DLS. O caminho da compra vai na mensagem, acima da lista.
export const TITULO_PASSO_A_PASSO =
  "Como emitir a devolução de uma peça que você VENDEU:";

/**
 * Passo a passo do caminho que REALMENTE monta a devolução, em linguagem de
 * galpão. Os rótulos entre aspas são os exatos da tela (`devolucao-actions.tsx`,
 * `devolucao-editor.tsx`, `app-sidebar.tsx`, rodapé do wizard) — se algum deles
 * mudar, este texto passa a mentir.
 */
const PASSOS_DEVOLUCAO_PELA_NOTA_ORIGINAL: readonly string[] = [
  'Abra o menu "Notas Fiscais" e clique em "Notas Emitidas".',
  "Ache a nota de VENDA original: a que você emitiu para o cliente e cuja peça está voltando.",
  'Na linha dessa nota, clique em "Devolver total" (voltou tudo) ou "Devolver parcial" (voltou só parte). Se os botões não couberem na linha, abra a nota no olho — eles também ficam lá em cima. Se a nota for antiga e não tiver o XML guardado no Dexo, o botão se chama "Devolver pela chave".',
  "O Dexo abre uma devolução NOVA já amarrada na nota original, com os produtos, os valores e o CFOP já preenchidos.",
  'Confira as quantidades que estão voltando e clique em "Salvar devolução".',
  'Vá avançando os passos e, no último, clique em "Emitir NF-e".',
  // Onde descartar: o quadro "Devoluções em andamento" da lista de Notas
  // Emitidas (`nfe-devolucoes-abertas-ui.ts`) lista este rascunho como "feito à
  // mão", com o botão "Descartar". Antes a frase dizia "pode ser descartado"
  // sem existir botão de descarte em lugar nenhum.
  'Quando a devolução nova for autorizada, descarte este rascunho em "Notas Emitidas" › "Devoluções em andamento", no botão "Descartar" — ele não serve para nada.',
];

/**
 * Erros em que "Tentar novamente" é promessa falsa. Só entra aqui o que não
 * tem como mudar sozinho: repetir a chamada dá o mesmo resultado sempre.
 */
const PERMANENTES: Readonly<Record<string, Omit<ErroCalculoView, "codigo">>> = {
  DEVOLUCAO_NAO_GERENCIADA: {
    permanente: true,
    titulo: "Esta devolução foi começada à mão — não dá para emitir por esta tela",
    mensagem:
      "Este rascunho foi começado à mão, antes de o Dexo passar a montar devolução sozinho, então ele não está amarrado a nenhuma nota de venda. Sem essa amarração o Dexo não sabe o que está voltando: não calcula o imposto nem emite. Não adianta tentar de novo e não dá para aproveitar este rascunho. Se a peça que está voltando foi VENDIDA por você, a devolução certa começa pela nota de venda original — é o passo a passo abaixo. Se ela foi COMPRADA de um fornecedor, o caminho é outro: em \"Notas Emitidas\", use o quadro \"Devolução manual\" com o XML que o fornecedor mandou.",
    passos: PASSOS_DEVOLUCAO_PELA_NOTA_ORIGINAL,
    acao: "IR_PARA_NOTAS_EMITIDAS",
  },
};

/** `true` quando repetir a mesma chamada não tem como mudar de resultado. */
export function isErroCalculoPermanente(code: unknown): boolean {
  return typeof code === "string" && Object.prototype.hasOwnProperty.call(PERMANENTES, code);
}

/**
 * Traduz o corpo do erro no que a tela mostra. Sem código conhecido, devolve o
 * quadro de sempre: mensagem do SERVIDOR (nunca um genérico por cima dela) e
 * "Tentar novamente".
 */
export function viewErroCalculo(
  resposta?: RespostaErroCalculo | null,
  fallback: string = MENSAGEM_CALCULO_GENERICA,
): ErroCalculoView {
  const codigo =
    typeof resposta?.code === "string" && resposta.code.length > 0 ? resposta.code : null;
  const mensagemServidor =
    typeof resposta?.error === "string" && resposta.error.trim().length > 0
      ? resposta.error.trim()
      : null;

  // `isErroCalculoPermanente` (hasOwnProperty) e não `PERMANENTES[codigo]`:
  // um `code` igual a "constructor" ou "toString" acha o protótipo de Object e
  // roubaria o "Tentar novamente" do operador por causa de lixo na resposta.
  const permanente = codigo && isErroCalculoPermanente(codigo) ? PERMANENTES[codigo] : undefined;
  if (permanente) return { codigo, ...permanente };

  // ADITIVO: o bloqueio da devolução continua PASSAGEIRO ("Tentar novamente"
  // resolve depois que ela confirma a tributação) e continua com a mensagem do
  // servidor. O que muda é só ganhar a lista do que falta, que já vinha no
  // corpo e era descartada. `undefined` em todos os outros erros.
  const pendencias = viewPendenciasDaResposta(resposta) ?? undefined;

  return {
    codigo,
    permanente: false,
    titulo: null,
    mensagem: mensagemServidor ?? fallback,
    passos: [],
    acao: "TENTAR_NOVAMENTE",
    ...(pendencias ? { pendencias } : {}),
  };
}
