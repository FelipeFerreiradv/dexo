// Decisões de tela do WIZARD quando o rascunho é (ou quer ser) uma devolução,
// em módulo puro para serem testadas em node — mesmo motivo do
// `nfe-numeracao-ui.ts` e do `nfe-erro-calculo-ui.ts` ao lado: o texto que a
// dona do desmanche lê é o produto, e produto se testa.
//
// O que vive aqui (DLS AUTO PEÇAS, 23 e 24/09/2026):
//
//  1. A GUARDA de navegação. Nos passos 1, 3 e 8 da devolução, só o botão
//     "Salvar devolução" grava. "Próximo", "Voltar" e o clique num passo
//     trocavam de passo e jogavam fora, sem aviso, o que ela tinha mexido
//     (quantidade, CFOP, imposto). A guarda pergunta — e NUNCA prende: sempre
//     há "Salvar e seguir", "Descartar e seguir" e "Ficar neste passo".
//     Só existe na devolução e só com edição não salva: a NF-e comum não muda.
//
//  2. O rascunho de devolução FEITO À MÃO (NF-e comum com a finalidade trocada
//     para "Devolução"). Ele nunca emite: não está amarrado à nota que volta. O
//     wizard engolia o 404 e ela preenchia 7 passos para bater no muro no 8.
//     Agora o aviso sai no PASSO 1, com o caminho certo e o descarte.
//
//  3. Para onde ir depois de autorizar: a nota autorizada (lista de Notas
//     Emitidas com ela aberta), e não "Emitir NF-e", que reabria um rascunho
//     qualquer.
//
//  4. O aviso de rascunho REAPROVEITADO: "Devolver" e "Devolução manual"
//     reabrem a devolução que já estava em andamento em vez de criar outra, e a
//     tela passa a dizer isso.
//
// Módulo PURO: sem React, sem fetch, sem DOM.

import { ROTULO_DEVOLVER_PELA_CHAVE } from "./nfe-devolucao-manual-ui";

/** Passos em que o editor da devolução fica montado (e pode ter edição não salva). */
export const PASSOS_COM_EDITOR_DEVOLUCAO: readonly number[] = [1, 3, 8];

// ─────────────────────────────── 1. guarda de navegação ───────────────────────────────

/**
 * A troca de passo precisa perguntar antes? Só na devolução, só com o editor
 * montado no passo atual e só com edição que ainda não foi salva. Em qualquer
 * outro caso — inclusive TODA NF-e comum — a navegação segue como sempre.
 */
export function precisaConfirmarSaida(e: {
  devolucao: boolean;
  editorSujo: boolean;
  passoAtual: number;
  destino: number;
}): boolean {
  return (
    e.devolucao &&
    e.editorSujo &&
    PASSOS_COM_EDITOR_DEVOLUCAO.includes(e.passoAtual) &&
    e.destino !== e.passoAtual
  );
}

export const GUARDA_TITULO = "Você mexeu nesta devolução e ainda não salvou";
export const GUARDA_SALVAR_E_SEGUIR = "Salvar e seguir";
export const GUARDA_DESCARTAR_E_SEGUIR = "Descartar e seguir";
export const GUARDA_FICAR = "Ficar neste passo";
/** Enquanto o "Salvar e seguir" espera o servidor. Nunca prende: descartar continua ali. */
export const GUARDA_SALVANDO =
  "Salvando… assim que a devolução for salva, o assistente segue sozinho. Se o Dexo recusar, o motivo aparece no quadro da devolução, acima: corrija e salve de novo, ou descarte e siga.";
/** O botão "Salvar devolução" está travado: o quadro aponta algo a resolver antes. */
export const GUARDA_NAO_DA_PARA_SALVAR =
  "O quadro da devolução ainda não deixa salvar: falta resolver o que ele aponta, acima. Corrija e salve, ou descarte e siga.";
/** Quando o botão de salvar do quadro não foi achado na tela (não deveria acontecer). */
export const GUARDA_SALVE_NO_QUADRO =
  'Clique em "Salvar devolução" no quadro acima: assim que salvar, o assistente segue sozinho para o passo que você escolheu.';

/** A frase principal da guarda, com o passo para onde ela queria ir. */
export function guardaMensagem(destino: number, tituloDestino: string): string {
  const para = tituloDestino ? `o passo ${destino} (${tituloDestino})` : `o passo ${destino}`;
  return `Se for para ${para} agora, o que você mudou neste passo se perde — quantidade, CFOP ou imposto voltam a ser os da última vez que salvou.`;
}

/**
 * O subtítulo da página "Emitir NF-e" (`app/notas-fiscais/nfe/page.tsx`). Dizia
 * "O rascunho é salvo automaticamente." — falso nos passos 1, 3 e 8 da
 * devolução, onde só o botão "Salvar devolução" grava (G4 #1). A página é do
 * servidor e não sabe se o rascunho é devolução, então a frase vale para os dois.
 */
export const SUBTITULO_EMITIR_NFE =
  'Preencha as etapas abaixo para gerar uma Nota Fiscal Eletrônica. O rascunho é salvo quando você passa de uma etapa para outra — numa devolução, as etapas Informações, Produtos e Impostos só gravam quando você clica em "Salvar devolução".';

/**
 * Aviso fixo nos passos da devolução com o editor. A página dizia "o rascunho é
 * salvo automaticamente", o que valia para a NF-e comum e NÃO para estes passos.
 */
export const AVISO_SALVAR_DEVOLUCAO =
  'Nesta devolução, o que você muda nos passos Informações, Produtos e Impostos só fica gravado quando você clica em "Salvar devolução". Se tentar sair do passo sem salvar, o Dexo pergunta antes.';

/**
 * Passos 6 (Duplicatas) e 7 (Pagamentos) numa devolução. Dizia "Devolução sem
 * cobrança, com pagamento 90 — sem pagamento." — o "90" é o código do grupo de
 * pagamento no XML, que não diz nada a quem está no galpão (N-fluxo-11).
 */
export const TEXTO_DEVOLUCAO_SEM_COBRANCA =
  'Devolução não tem cobrança nem forma de pagamento: a nota sai como "sem pagamento", e o Dexo já preenche isso. Não há nada a fazer nesta etapa — clique em "Próximo".';

/** Selo ao lado do "Salvo HH:MM" enquanto há edição não salva no editor da devolução. */
export const ALTERACOES_NAO_SALVAS = "Alterações da devolução ainda não salvas";

/** O mais recente dos dois registros de "salvo" (rascunho comum e devolução). */
export function ultimoSalvo(a: Date | null | undefined, b: Date | null | undefined): Date | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

// ─────────────────────────────── 2. rascunho feito à mão ───────────────────────────────

/**
 * O que o GET /fiscal/nfe/draft/:id/devolucao disse sobre ESTE rascunho.
 *
 * - GERENCIADA: é uma devolução do Dexo (o editor aparece).
 * - NAO_GERENCIADA: a devolução está ligada para a empresa DESTE rascunho, mas ele
 *   não foi criado pelo Dexo (feito à mão) — nunca vai emitir.
 * - EXIGE_NUMERACAO_V2: a devolução está ligada, mas a numeração nova não — também
 *   não emite por aqui.
 * - DESLIGADA: 404 sem `code` = a devolução não existe para esta empresa. Tudo
 *   segue mudo, exatamente como antes (empresas fora da devolução nova).
 * - DESCONHECIDO: rede caída, 500 — não afirma nada.
 *
 * É ESTE GET, e não a disponibilidade geral, que decide: ele usa a empresa do
 * rascunho (multi-CNPJ), a disponibilidade usa a empresa padrão.
 */
export type EstadoDevolucaoDoRascunho =
  | "GERENCIADA"
  | "NAO_GERENCIADA"
  | "EXIGE_NUMERACAO_V2"
  | "DESLIGADA"
  | "DESCONHECIDO";

export function lerEstadoDevolucaoDoRascunho(status: number, corpo: unknown): EstadoDevolucaoDoRascunho {
  if (status >= 200 && status < 300) return "GERENCIADA";
  const code =
    corpo && typeof corpo === "object" && typeof (corpo as { code?: unknown }).code === "string"
      ? (corpo as { code: string }).code
      : null;
  if (status === 404 && code === "DEVOLUCAO_NAO_GERENCIADA") return "NAO_GERENCIADA";
  if (code === "EXIGE_NUMERACAO_V2") return "EXIGE_NUMERACAO_V2";
  if (status === 404 && code === null) return "DESLIGADA";
  return "DESCONHECIDO";
}

export interface QuadroDevolucaoAMao {
  titulo: string;
  mensagem: string;
  /** Caminho certo, um por tipo de devolução. */
  caminhos: readonly string[];
  /** Linha sobre aproveitar o rascunho como nota comum. */
  aproveitar: string;
  /** Rótulo do botão de descarte; vazio = não oferecer (rascunho ainda não é devolução). */
  descartar: string;
}

const CAMINHO_COMPRA =
  'Peça que você COMPROU e está devolvendo ao fornecedor: em "Notas Emitidas", abra "Devolução manual" e importe o XML da nota que o fornecedor mandou.';
// Venda sem o XML guardado no Dexo (histórico importado) não tem "Devolver
// total"/"Devolver parcial": o botão dela é "Devolver pela chave". A frase cita
// os dois — citar só os primeiros mandava procurar um botão que não está lá.
const CAMINHO_VENDA =
  `Peça que você VENDEU e o cliente devolveu: em "Notas Emitidas", ache a sua nota de venda e clique em "Devolver total" ou "Devolver parcial" (se a venda não tiver o XML no Dexo, o botão é "${ROTULO_DEVOLVER_PELA_CHAVE}").`;

/**
 * O quadro do passo 1. Texto NEUTRO NO TEMPO (o do passo 8 diz "começado antes
 * de o Dexo montar devolução", o que é falso para um rascunho trocado hoje).
 *
 * `momento`:
 *  - "ABERTO": o rascunho já veio do servidor com finalidade Devolução — oferece
 *    descartar;
 *  - "ESCOLHENDO": ela acabou de escolher "Devolução" no passo 1 de uma NF-e
 *    comum — ainda dá para voltar a finalidade, então não oferece descarte.
 */
export function quadroDevolucaoAMao(momento: "ABERTO" | "ESCOLHENDO"): QuadroDevolucaoAMao {
  if (momento === "ESCOLHENDO") {
    return {
      titulo: "A devolução não se faz por aqui",
      mensagem:
        "Uma NF-e comum trocada para \"Devolução\" não fica amarrada à nota que está voltando, e sem essa amarração o Dexo não calcula o imposto nem emite: você preencheria todos os passos para ser recusada no fim. Comece pelo caminho certo:",
      caminhos: [CAMINHO_COMPRA, CAMINHO_VENDA],
      aproveitar:
        'Se escolheu "Devolução" sem querer, volte a Finalidade para "Normal" e siga com a nota comum.',
      descartar: "",
    };
  }
  return {
    titulo: "Este rascunho de devolução não vai emitir",
    mensagem:
      "Ele foi feito à mão (uma NF-e comum com a finalidade trocada para \"Devolução\"), então não está amarrado à nota que está voltando. Sem essa amarração o Dexo não sabe o que volta nem calcula o imposto: não adianta preencher os próximos passos. Comece pelo caminho certo:",
    caminhos: [CAMINHO_COMPRA, CAMINHO_VENDA],
    aproveitar:
      'Se este rascunho era para uma nota comum, troque a Finalidade para "Normal" aqui no passo 1 e siga com ela.',
    descartar: "Descartar este rascunho",
  };
}

/** O 422 EXIGE_NUMERACAO_V2 também era engolido pelo wizard. */
export const QUADRO_EXIGE_NUMERACAO_V2 = {
  titulo: "Esta empresa ainda não emite devolução pelo Dexo",
  mensagem:
    "A devolução precisa da numeração nova de notas, que ainda não está ligada para este CNPJ. Fale com o suporte do Dexo antes de preencher os próximos passos.",
} as const;

// ─────────────────────────────── 3. depois de autorizar ───────────────────────────────

/** Lista de Notas Emitidas com a nota autorizada já aberta (`?nfe=`). */
export function destinoAposAutorizar(nfeId: string | null | undefined): string {
  return nfeId
    ? `/notas-fiscais/emitidas?nfe=${encodeURIComponent(nfeId)}`
    : "/notas-fiscais/emitidas";
}

/** A nota que a lista deve abrir ao carregar (`?nfe=<id>`), ou null. */
export function notaParaAbrir(search: string): string | null {
  const id = new URLSearchParams(search).get("nfe");
  return id && id.trim() !== "" ? id : null;
}

// ─────────────────────────────── 4. rascunho reaproveitado ───────────────────────────────

export const PARAM_REAPROVEITADA = "reaproveitada";

/** URL do assistente para um rascunho de devolução — com o aviso, quando foi reaproveitado. */
export function urlRascunhoDevolucao(draftId: string, reaproveitado: boolean): string {
  return `/notas-fiscais/nfe?draft=${encodeURIComponent(draftId)}${reaproveitado ? `&${PARAM_REAPROVEITADA}=1` : ""}`;
}

export function veioReaproveitada(search: string): boolean {
  return new URLSearchParams(search).get(PARAM_REAPROVEITADA) === "1";
}

export const AVISO_REAPROVEITADA =
  "Você já tinha uma devolução desta nota em andamento — o Dexo abriu ela em vez de criar outra. Confira as peças e as quantidades no passo Produtos antes de emitir.";
