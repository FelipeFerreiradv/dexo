// O que trava a emissão da NF-e de devolução, dito em português de galpão e
// com o número do ITEM em que cada coisa está — módulo puro, testado em node
// (mesmo padrão de `nfe-numeracao-ui.ts`, `nfe-aviso-emissao.ts` e
// `nfe-erro-calculo-ui.ts` ao lado).
//
// ── O caso real (DLS AUTO PEÇAS, 24/09/2026) ──
// Ela passou o dia inteiro travada numa devolução de COMPRA (comprou da
// DISAUTO, devolveu 2 de 6 itens). O rascunho tinha os 6 itens com
// `tributacao.requerRevisao = true` e `confirmada = false` — o XML veio do
// FORNECEDOR, o CFOP de lá é o de VENDA dele, então o Dexo não assume a
// tributação e exige confirmação item a item. A tela dizia só:
//
//     "A devolução tem pendências que impedem a emissão."
//
// ...e mais nada. Qual pendência, em qual item, o que fazer: nada.
//
// ── O achado ──
// A informação JÁ EXISTIA e era jogada fora PELA TELA. O use case lança
// `new DevolucaoError("DEVOLUCAO_INVALIDA", detalhe.issues)`
// (`nfe-devolucao.usecase.ts`, `contextoEmissao` e `validarReserva`) e a rota
// serializa `issues` no corpo do erro
// (`fiscal.routes.ts`: `.send({error,code,issues})`, inclusive no
// POST /fiscal/nfe/:id/issue). Ou seja: as pendências CHEGAM ao navegador —
// quem as descartava era o `desfechoEmissao`, que só aproveita `d.error` para
// o toast. Este módulo é o tradutor que faltava; nada mudou no backend.
//
// ── As três decisões deste arquivo ──
//  1. AGRUPA por código. Seis itens com a mesma pendência viram UMA linha
//     ("Falta confirmar a tributação dos itens 1 a 6"), não seis frases quase
//     iguais que ela teria de ler uma a uma para descobrir que são a mesma.
//  2. Separa ERRO de AVISO. `detalhe.issues` traz as duas severidades; só
//     ERRO bloqueia (`temBloqueio`/`issuesBloqueantes` em `validacao.ts`).
//     Misturar faria o aviso de PIS/COFINS parecer um impedimento.
//  3. Diz O QUE FAZER com os rótulos EXATOS da tela — a caixinha "Revisei a
//     tributação deste item" e o botão "Salvar devolução" do
//     `devolucao-editor.tsx`, e os passos do wizard pelo número e pelo título
//     que o `STEPS` de fato mostra (o passo 1 aparece como "Informacoes", sem
//     acento; mandá-la procurar "Informações" seria mandá-la procurar o que
//     não está escrito).
//
// Lista de pendências VAZIA não faz o bloqueio sumir: o 422 continua sendo um
// 422. Sem detalhe, o quadro mostra a frase do servidor e diz onde procurar.
//
// Módulo PURO: sem React, sem fetch, sem DOM.

import type { DevolucaoIssueCode, SeveridadeIssue } from "@/app/fiscal/devolucao/tipos";

/** Issue como ela chega do servidor: nada aqui pode confiar no formato. */
export interface IssueBruta {
  code?: unknown;
  severidade?: unknown;
  ordem?: unknown;
  mensagem?: unknown;
}

/** Corpo do erro 422 de POST /fiscal/nfe/:id/issue (e de /calculate). */
export interface RespostaErroDevolucao {
  error?: unknown;
  code?: unknown;
  issues?: unknown;
}

export interface PendenciaDevolucao {
  /** Código da issue quando veio um reconhecível; `null` caso contrário. */
  codigo: string | null;
  severidade: SeveridadeIssue;
  /** Itens (ordem) atingidos, crescente e sem repetição. Vazio = a nota toda. */
  ordens: readonly number[];
  /** O que falta, já com os itens dentro. */
  titulo: string;
  /** O caminho para resolver, com os rótulos exatos da tela. "" quando não há. */
  comoResolver: string;
  /** Mensagens do servidor que caíram neste grupo, sem o "Item N:" repetido. */
  detalhes: readonly string[];
}

export interface PendenciasDevolucaoView {
  titulo: string;
  /** `true` quando a emissão está de fato impedida (422, ou `podeEmitir` false). */
  bloqueado: boolean;
  /** Estilo do quadro, como no `nfe-aviso-emissao`: a tela não decide texto. */
  tom: "bloqueio" | "aviso";
  /** Severidade ERRO: é isto que impede a emissão. */
  bloqueios: readonly PendenciaDevolucao[];
  /** Severidade AVISO: informa, não impede. */
  avisos: readonly PendenciaDevolucao[];
  /** Bloqueado E sem lista utilizável: o quadro fica, o detalhe é que falta. */
  semDetalhe: boolean;
  /** Frase do servidor (ou o texto do contrato), sempre presente. */
  mensagem: string;
}

/** Frase do contrato (`DEVOLUCAO_ERRO_MENSAGEM.DEVOLUCAO_INVALIDA`). */
export const MENSAGEM_DEVOLUCAO_INVALIDA =
  "A devolução tem pendências que impedem a emissão.";

export const CODIGO_DEVOLUCAO_INVALIDA = "DEVOLUCAO_INVALIDA";

export const TITULO_PENDENCIAS = "Falta resolver isto para emitir a devolução:";
export const TITULO_AVISOS = "Avisos (não impedem a emissão):";

/**
 * O que dizer quando o bloqueio veio sem lista. Não some com o bloqueio: manda
 * procurar onde a prévia das pendências aparece (o editor da devolução as
 * mostra a cada "Salvar devolução", vindas do mesmo `validarDevolucao`).
 */
export const COMO_RESOLVER_SEM_DETALHE =
  'Volte pelos passos da devolução e clique em "Salvar devolução" em cada um: o Dexo lista ali embaixo o que ainda falta.';

// ───────────────────────────── itens em texto ─────────────────────────────

/**
 * "4" → "4"; "1,2,3,4,5,6" → "1 a 6"; "1,3,5" → "1, 3 e 5"; "1,2,3,7" →
 * "1 a 3 e 7". Corrida de 3 ou mais vira faixa; de 2, os dois números (uma
 * faixa "1 a 2" custa mais para ler do que "1 e 2").
 */
export function listarOrdens(ordens: readonly number[]): string {
  if (ordens.length === 0) return "";
  const partes: string[] = [];
  let inicio = ordens[0];
  let fim = ordens[0];
  const fechar = () => {
    if (fim - inicio >= 2) partes.push(`${inicio} a ${fim}`);
    else for (let n = inicio; n <= fim; n++) partes.push(String(n));
  };
  for (let i = 1; i < ordens.length; i++) {
    if (ordens[i] === fim + 1) {
      fim = ordens[i];
      continue;
    }
    fechar();
    inicio = ordens[i];
    fim = ordens[i];
  }
  fechar();
  if (partes.length === 1) return partes[0];
  return `${partes.slice(0, -1).join(", ")} e ${partes[partes.length - 1]}`;
}

/** "Item 4: " / "Itens 1 a 6: " / "" — o mesmo formato do servidor. */
function prefixoItens(ordens: readonly number[]): string {
  if (ordens.length === 0) return "";
  return `${ordens.length === 1 ? "Item" : "Itens"} ${listarOrdens(ordens)}: `;
}

/**
 * Os três jeitos de citar os itens dentro de uma frase. Cada entrada do
 * catálogo escolhe o seu, para a preposição sair certa em português:
 * "Falta confirmar a tributação {DOS_ITENS}" ⇒ "…dos itens 1 a 6";
 * "A quantidade passou do saldo {NOS_ITENS}" ⇒ "…no item 4".
 */
function expandirTokens(frase: string, ordens: readonly number[]): string {
  const lista = listarOrdens(ordens);
  const um = ordens.length === 1;
  const subs: Record<string, string> = lista
    ? {
        "{DOS_ITENS}": `${um ? "do item" : "dos itens"} ${lista}`,
        "{NOS_ITENS}": `${um ? "no item" : "nos itens"} ${lista}`,
        "{OS_ITENS}": `${um ? "o item" : "os itens"} ${lista}`,
      }
    : { "{DOS_ITENS}": "", "{NOS_ITENS}": "", "{OS_ITENS}": "" };
  const texto = frase.replace(/\{(?:DOS_ITENS|NOS_ITENS|OS_ITENS)\}/g, (t) => subs[t] ?? "");
  // Sem itens a frase fica com buraco no meio: fecha o espaço duplo e o espaço
  // antes da pontuação em vez de mostrar "Falta confirmar a tributação ." .
  const limpo = texto.replace(/[ \t]{2,}/g, " ").replace(/\s+([.,;:])/g, "$1").trim();
  // A frase que COMEÇA pelos itens ("{OS_ITENS} tem IBS/CBS…") sai em
  // minúscula, e sem eles perde a primeira palavra inteira: maiúscula no fim,
  // uma vez só, para o catálogo não ter de escrever duas versões de cada texto.
  return limpo.charAt(0).toUpperCase() + limpo.slice(1);
}

// ───────────────────────────── catálogo de textos ─────────────────────────────

interface TextoPendencia {
  /** O que falta. Pode citar os itens por um dos três tokens. */
  falta: string;
  /** O caminho de saída, com os rótulos exatos da tela. */
  comoResolver: string;
}

/**
 * Um texto por código de `DevolucaoIssueCode` — Record FECHADO de propósito:
 * uma regra nova em `validacao.ts` sem texto aqui quebra o `tsc`, em vez de
 * chegar muda na tela da cliente.
 *
 * Os rótulos entre aspas são os que a tela mostra HOJE:
 *   * "Revisei a tributação deste item" e "Salvar devolução" —
 *     `devolucao-editor.tsx`;
 *   * "A mercadoria foi entregue e está sendo devolvida" — idem, passo 1;
 *   * "Notas Emitidas", "Devolver total", "Devolver parcial" —
 *     `app-sidebar.tsx` e `devolucao-actions.tsx`;
 *   * os títulos dos passos ("Informacoes", "Produtos", "Impostos") — `STEPS`
 *     do `nfe-wizard.tsx`, copiados com a grafia que aparece na tela.
 * Se algum deles mudar, este texto passa a mentir.
 */
const TEXTOS: Readonly<Record<DevolucaoIssueCode, TextoPendencia>> = {
  // ── cabeçalho ──
  NAO_GERENCIADA: {
    falta: "Esta devolução não está amarrada a nenhuma nota original",
    comoResolver:
      'Comece a devolução pela nota de venda original: menu "Notas Fiscais" › "Notas Emitidas", e na linha dela clique em "Devolver total" ou "Devolver parcial".',
  },
  ESCOLHA_PENDENTE: {
    falta: "Falta responder se a mercadoria foi entregue e devolvida pelo cliente",
    comoResolver:
      'Volte ao passo 1 ("Informacoes"), marque "A mercadoria foi entregue e está sendo devolvida" e clique em "Salvar devolução".',
  },
  RECUSA_NAO_E_DEVOLUCAO: {
    falta: "A nota está marcada como recusa ou não entrega, e isso não é devolução",
    comoResolver:
      'Mercadoria recusada na porta se resolve com nota de crédito, fora deste caminho. Se a peça chegou ao cliente e voltou depois, volte ao passo 1 ("Informacoes") e marque "A mercadoria foi entregue e está sendo devolvida".',
  },
  FINALIDADE_NAO_DEVOLUCAO: {
    falta: 'A finalidade da nota não está como "Devolução"',
    comoResolver: 'No passo 1 ("Informacoes"), escolha a finalidade "Devolução".',
  },
  MODELO_NAO_PERMITIDO: {
    falta: "A nota não é NF-e modelo 55",
    comoResolver:
      "Devolução só sai em NF-e (modelo 55). Cupom fiscal (NFC-e, modelo 65) não admite devolução.",
  },
  TIPO_OPERACAO_INCOERENTE: {
    falta: "O tipo da operação não combina com o tipo da devolução",
    comoResolver:
      'Devolução de VENDA é nota de ENTRADA; devolução de COMPRA é nota de SAÍDA. Acerte no passo 1 ("Informacoes").',
  },
  NFREF_PROIBIDA: {
    falta: "Há notas referenciadas preenchidas à mão no formulário",
    comoResolver:
      "Apague as notas referenciadas do formulário: quem gera a referência da devolução é o próprio Dexo, e as duas juntas fazem a SEFAZ rejeitar.",
  },
  PAGAMENTO_SERA_90: {
    falta: "A forma de pagamento preenchida não vai nesta nota",
    comoResolver: 'A devolução sai como "Sem pagamento". Não precisa fazer nada.',
  },
  COBRANCA_NAO_ENVIADA: {
    falta: "As duplicatas preenchidas não vão nesta nota",
    comoResolver: "Nota de devolução não leva cobrança. Não precisa fazer nada.",
  },
  SEM_ITENS: {
    falta: "Nenhum item foi escolhido para devolver",
    comoResolver:
      'Vá ao passo 3 ("Produtos"), ponha a quantidade que está voltando em cada peça e clique em "Salvar devolução".',
  },
  ITENS_DESALINHADOS: {
    falta: "Os itens da nota não batem com os itens da devolução",
    comoResolver:
      'Vá ao passo 3 ("Produtos") e clique em "Salvar devolução": é esse botão que grava os dois lados juntos.',
  },
  IDDEST_DIVERGENTE_ORIGINAL: {
    falta: "O destino da operação está diferente do da nota original",
    comoResolver:
      'No passo 1 ("Informacoes"), deixe o destino (dentro do estado, fora do estado ou exterior) igual ao da nota original.',
  },

  // ── referência por item ──
  REFERENCIA_AUSENTE: {
    falta: "Falta a ligação com o item da nota original {NOS_ITENS}",
    comoResolver:
      'Vá ao passo 3 ("Produtos") e clique em "Salvar devolução". Se continuar, recomece a devolução pela nota original, em "Notas Emitidas".',
  },
  CHAVE_INVALIDA: {
    falta: "A chave de acesso da nota original está inválida {NOS_ITENS}",
    comoResolver:
      'Recomece a devolução pela nota original, em "Notas Emitidas": a chave de 44 dígitos é copiada de lá, sem digitação.',
  },
  MODELO_ORIGINAL_NAO_SUPORTADO: {
    falta: "A nota original referenciada não é NF-e nem NFC-e {NOS_ITENS}",
    comoResolver: "Só nota modelo 55 ou 65 pode ser referenciada numa devolução.",
  },
  NITEM_INVALIDO: {
    falta: "O número do item na nota original está fora de 1 a 990 {NOS_ITENS}",
    comoResolver:
      'Recomece a devolução pela nota original, em "Notas Emitidas", para o Dexo numerar os itens.',
  },
  REFERENCIA_DUPLICADA: {
    falta: "O mesmo item da nota original aparece mais de uma vez {NOS_ITENS}",
    comoResolver:
      'No passo 3 ("Produtos"), deixe uma linha só para cada item da nota original, somando as quantidades, e clique em "Salvar devolução".',
  },
  EMITENTES_DIVERSOS: {
    falta: "As notas originais são de fornecedores diferentes",
    comoResolver:
      "Uma devolução só pode referenciar notas de um emitente. Faça uma devolução para cada fornecedor.",
  },
  EMITENTE_ORIGINAL_DIVERGENTE: {
    falta: "A nota original não foi emitida por este CNPJ",
    comoResolver:
      'No passo 1 ("Informacoes"), troque a empresa para o CNPJ que emitiu a nota que está sendo devolvida.',
  },
  DESTINATARIO_NAO_E_EMITENTE_ORIGINAL: {
    falta: "O destinatário não é o fornecedor que emitiu a nota original",
    comoResolver:
      'No passo 2 ("Destinatario"), ponha o CNPJ do fornecedor que emitiu a nota que você está devolvendo.',
  },

  // ── CFOP ──
  CFOP_ESCOLHA_PENDENTE: {
    falta: "Falta escolher o CFOP de devolução {DOS_ITENS}",
    comoResolver:
      'Vá ao passo 3 ("Produtos"), preencha o CFOP (4 dígitos) de cada item e clique em "Salvar devolução".',
  },
  CFOP_NAO_DEVOLUCAO: {
    falta: "O CFOP escolhido não é de devolução {NOS_ITENS}",
    comoResolver:
      'Vá ao passo 3 ("Produtos") e troque o CFOP pelo de devolução que o Dexo sugere; depois clique em "Salvar devolução".',
  },
  CFOP_SENTIDO_INVALIDO: {
    falta: "O CFOP é do sentido contrário ao da nota {NOS_ITENS}",
    comoResolver:
      'Nota de ENTRADA usa CFOP que começa com 1, 2 ou 3; nota de SAÍDA, com 5, 6 ou 7. Acerte no passo 3 ("Produtos").',
  },
  CFOP_IDDEST_DIVERGENTE: {
    falta: "O CFOP não combina com o destino da operação {NOS_ITENS}",
    comoResolver:
      'CFOP de dentro do estado e CFOP de fora do estado são diferentes. Acerte o destino no passo 1 ("Informacoes") ou o CFOP no passo 3 ("Produtos").',
  },
  CFOP_MEI_NAO_PERMITIDO: {
    falta: "O CFOP não é um dos que o MEI pode usar {NOS_ITENS}",
    comoResolver:
      'MEI só devolve com os CFOPs 1202, 1553, 2202, 2553, 5202 e 6202. Escolha um deles no passo 3 ("Produtos").',
  },

  // ── quantidade, saldo e nota original ──
  QUANTIDADE_INVALIDA: {
    falta: "A quantidade devolvida está inválida {NOS_ITENS}",
    comoResolver:
      'No passo 3 ("Produtos"), ponha um número maior que zero, com no máximo 4 casas decimais, e clique em "Salvar devolução".',
  },
  SALDO_EXCEDIDO: {
    falta: "A quantidade é maior do que ainda pode ser devolvido {NOS_ITENS}",
    comoResolver:
      'No passo 3 ("Produtos"), baixe a quantidade até o "Disponível" que aparece no próprio item e clique em "Salvar devolução".',
  },
  SALDO_NAO_VERIFICAVEL: {
    falta: "Sem o XML da nota original o Dexo não consegue conferir o saldo {NOS_ITENS}",
    comoResolver:
      "Refaça a devolução manual marcando a confirmação de devolução sem XML, ou importe o XML autorizado da nota original.",
  },
  ORIGINAL_CANCELADA: {
    falta: "A nota original está cancelada",
    comoResolver: "Nota cancelada não tem o que devolver: ela já foi desfeita na SEFAZ.",
  },
  ORIGINAL_NAO_AUTORIZADA: {
    falta: "A nota original não está autorizada",
    comoResolver: "Só nota autorizada pela SEFAZ pode ser devolvida.",
  },
  AMBIENTE_DIVERGENTE: {
    falta: "A nota original e esta devolução estão em ambientes diferentes",
    comoResolver:
      "Uma está em homologação (teste) e a outra em produção. Acerte o ambiente do emissor na configuração fiscal e refaça a devolução.",
  },

  // ── tributação ──
  TRIBUTACAO_AUSENTE: {
    falta: "Falta a tributação {DOS_ITENS}",
    comoResolver:
      'Vá ao passo 8 ("Impostos") e clique em "Salvar devolução" para o Dexo montar a tributação do item.',
  },
  TRIBUTACAO_REVISAO_PENDENTE: {
    falta: "Falta confirmar a tributação {DOS_ITENS}",
    comoResolver:
      'Vá ao passo 8 ("Impostos"), marque "Revisei a tributação deste item" em cada um deles e clique em "Salvar devolução".',
  },
  TRIBUTACAO_NAO_SUPORTADA: {
    falta: "O ICMS da nota original não é aceito assim na devolução {NOS_ITENS}",
    comoResolver:
      'No passo 8 ("Impostos"), ajuste o CST (2 dígitos) ou o CSOSN (3 dígitos) do ICMS com o seu contador, marque "Revisei a tributação deste item" e clique em "Salvar devolução".',
  },
  TRIBUTACAO_REGIME_INCOMPATIVEL: {
    falta: "O CST/CSOSN não combina com o regime tributário da sua empresa {NOS_ITENS}",
    comoResolver:
      'Simples Nacional usa CSOSN (3 dígitos); fora do Simples, CST (2 dígitos). Acerte no passo 8 ("Impostos") e clique em "Salvar devolução".',
  },
  IPI_DEVOL_INVALIDO: {
    falta: "O percentual de IPI devolvido está inválido {NOS_ITENS}",
    comoResolver:
      'No passo 8 ("Impostos"), o percentual de IPI tem de ficar entre 0 e 100. Corrija e clique em "Salvar devolução".',
  },
  PIS_CST_SAIDA_EM_ENTRADA: {
    falta: "O CST de PIS/COFINS é de saída numa nota de entrada {NOS_ITENS}",
    comoResolver: "Confirme com o seu contador. Isto não impede a emissão.",
  },
  IBS_CBS_NAO_ENVIADO: {
    // Frase que começa pelos itens: "…na devolução no item 2" sairia com dois
    // "no" seguidos. A maiúscula do começo é posta por `expandirTokens`.
    falta: "{OS_ITENS} tem IBS/CBS na nota original, e a devolução não envia esse grupo",
    comoResolver: "Não precisa fazer nada: isto não impede a emissão.",
  },

  // ── montagem do rascunho ──
  TOTALMENTE_DEVOLVIDA: {
    falta: "A nota original já foi devolvida por inteiro",
    comoResolver: "Não sobrou saldo para devolver nesta nota.",
  },
  PARCIALMENTE_DEVOLVIDA: {
    falta: "A nota original já tem uma devolução parcial",
    comoResolver:
      'Use "Devolver parcial" sobre a nota original para devolver só o que ainda sobrou.',
  },
  JA_E_DEVOLUCAO: {
    falta: "A nota escolhida já é uma nota de devolução",
    comoResolver: 'Em "Notas Emitidas", escolha a nota de VENDA original.',
  },
  ORIGINAL_ENTRADA: {
    falta: "A nota escolhida é de entrada",
    comoResolver:
      "Devolução de compra começa pela devolução manual, com o XML que o fornecedor mandou.",
  },
  CHAVE_DIVERGENTE: {
    falta: "A chave informada não é a da nota escolhida",
    comoResolver: 'Recomece a devolução pela nota original, em "Notas Emitidas".',
  },
  XML_SEM_AUTORIZACAO: {
    falta: "O XML da nota original não tem o protocolo de autorização",
    comoResolver:
      "Importe o XML autorizado da nota original — o que traz o protocolo da SEFAZ, não o que você assinou.",
  },
  EMISSAO_EM_ANDAMENTO: {
    falta: "Esta devolução já está sendo emitida",
    comoResolver: 'Espere o desfecho e use "Consultar situação" antes de tentar de novo.',
  },
  DESTINATARIO_AUSENTE: {
    falta: "Falta o destinatário da devolução",
    comoResolver: 'Preencha o destinatário no passo 2 ("Destinatario") e salve o rascunho.',
  },
};

// ───────────────────────────── leitura defensiva ─────────────────────────────

const temTexto = (v: unknown): v is DevolucaoIssueCode =>
  typeof v === "string" && v.length > 0 &&
  Object.prototype.hasOwnProperty.call(TEXTOS, v);

/**
 * Só "AVISO" escrito assim conta como aviso. Severidade estranha (chave nova,
 * lixo, ausente) cai em ERRO de propósito: esconder do operador uma pendência
 * que o servidor recusou é pior do que mostrar um aviso a mais.
 */
function severidadeDe(v: unknown): SeveridadeIssue {
  return v === "AVISO" ? "AVISO" : "ERRO";
}

function ordemDe(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 990 ? v : null;
}

/** Tira o "Item 3: " que a mensagem do servidor traz — o item já está no título. */
export function semPrefixoDeItem(mensagem: string): string {
  return mensagem.replace(/^Item[ \t]+\d+[ \t]*[:.-][ \t]*/u, "").trim();
}

function mensagemDe(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** Só para comparar título e detalhe: caixa, espaços e pontuação final não contam. */
function comparavel(texto: string): string {
  return texto.toLowerCase().replace(/\s+/g, " ").replace(/[.;:!]+$/, "").trim();
}

// ───────────────────────────── montagem da view ─────────────────────────────

interface Grupo {
  codigo: string | null;
  severidade: SeveridadeIssue;
  texto: TextoPendencia | null;
  ordens: number[];
  detalhes: string[];
}

/**
 * Agrupa por (código + severidade). Issue de código desconhecido não some: vira
 * um grupo próprio com a mensagem do servidor no lugar do título — o servidor
 * já escreve em português, e uma regra nova é melhor mostrada crua do que
 * engolida.
 */
export function pendenciasDeIssues(issues: unknown): PendenciaDevolucao[] {
  if (!Array.isArray(issues)) return [];
  const grupos = new Map<string, Grupo>();
  for (const bruta of issues as IssueBruta[]) {
    if (bruta === null || typeof bruta !== "object") continue;
    const mensagem = mensagemDe(bruta.mensagem);
    const codigoConhecido = temTexto(bruta.code);
    const codigo = typeof bruta.code === "string" && bruta.code.length > 0 ? bruta.code : null;
    // Sem código reconhecível E sem mensagem não há nada para mostrar.
    if (!codigoConhecido && mensagem === "") continue;
    const severidade = severidadeDe(bruta.severidade);
    // Código desconhecido agrupa pela própria mensagem: duas regras novas
    // diferentes não podem virar uma linha só.
    const chave = `${severidade}\u0000${codigoConhecido ? codigo : `?${mensagem}`}`;
    let grupo = grupos.get(chave);
    if (!grupo) {
      grupo = {
        codigo,
        severidade,
        texto: codigoConhecido ? TEXTOS[bruta.code as DevolucaoIssueCode] : null,
        ordens: [],
        detalhes: [],
      };
      grupos.set(chave, grupo);
    }
    const ordem = ordemDe(bruta.ordem);
    if (ordem !== null && !grupo.ordens.includes(ordem)) grupo.ordens.push(ordem);
    const detalhe = semPrefixoDeItem(mensagem);
    if (detalhe !== "" && !grupo.detalhes.includes(detalhe)) grupo.detalhes.push(detalhe);
  }

  return Array.from(grupos.values()).map((g) => {
    const ordens = [...g.ordens].sort((a, b) => a - b);
    const titulo = g.texto
      ? expandirTokens(g.texto.falta, ordens)
      // Código desconhecido: a frase do servidor, com o item na frente no
      // mesmo formato que ele próprio usa ("Item 3: ...").
      : `${prefixoItens(ordens)}${g.detalhes[0] ?? "Pendência informada pelo Dexo"}`;
    return {
      codigo: g.codigo,
      severidade: g.severidade,
      ordens,
      titulo,
      comoResolver: g.texto ? g.texto.comoResolver : "",
      // Código conhecido: o detalhe do servidor entra porque acrescenta (os
      // MOTIVOS da revisão de tributação, o saldo que sobrou, o CFOP recusado)
      // — menos quando repete o título palavra por palavra. Código
      // desconhecido: o detalhe JÁ virou título, não se repete.
      detalhes: g.texto ? g.detalhes.filter((d) => comparavel(d) !== comparavel(titulo)) : [],
    };
  });
}

function montarView(
  issues: unknown,
  bloqueado: boolean,
  mensagem: string,
): PendenciasDevolucaoView {
  const todas = pendenciasDeIssues(issues);
  const bloqueios = todas.filter((p) => p.severidade === "ERRO");
  return {
    titulo: TITULO_PENDENCIAS,
    bloqueado,
    tom: bloqueado ? "bloqueio" : "aviso",
    bloqueios,
    avisos: todas.filter((p) => p.severidade === "AVISO"),
    // Lista vazia NÃO desfaz o bloqueio: o 422 continua sendo um 422. O quadro
    // aparece do mesmo jeito, com a frase do servidor.
    semDetalhe: bloqueado && bloqueios.length === 0,
    mensagem,
  };
}

/**
 * A view do bloqueio inteiro. `mensagemServidor` é usada como está quando não
 * há lista — nunca substituída por um genérico por cima dela.
 */
export function viewPendencias(
  issues: unknown,
  mensagemServidor?: unknown,
): PendenciasDevolucaoView {
  const mensagem =
    typeof mensagemServidor === "string" && mensagemServidor.trim() !== ""
      ? mensagemServidor.trim()
      : MENSAGEM_DEVOLUCAO_INVALIDA;
  return montarView(issues, true, mensagem);
}

/** Prévia no editor quando nada bloqueia — só há aviso a dar. */
export const MENSAGEM_PREVIA_SO_AVISOS =
  "Nada impede a emissão desta devolução. Confira os avisos:";

/**
 * A PRÉVIA que o editor da devolução mostra (`GET …/devolucao` ⇒
 * `DevolucaoDetalhe.issues` + `podeEmitir`, as duas saídas do MESMO
 * `validarDevolucao` que recusa a emissão depois). Aqui `podeEmitir` é a
 * autoridade sobre estar ou não bloqueada: uma lista só de AVISOS não pode
 * pintar a tela de impedimento.
 */
export function viewPendenciasDoDetalhe(detalhe: {
  issues?: unknown;
  podeEmitir?: unknown;
}): PendenciasDevolucaoView {
  const bloqueado = detalhe.podeEmitir !== true;
  return montarView(
    detalhe.issues,
    bloqueado,
    bloqueado ? MENSAGEM_DEVOLUCAO_INVALIDA : MENSAGEM_PREVIA_SO_AVISOS,
  );
}

/**
 * O que o wizard faz com o corpo do POST /fiscal/nfe/:id/issue que falhou.
 * `null` = não é o bloqueio da devolução ⇒ a tela segue EXATAMENTE como antes
 * (toast do `desfechoEmissao` e nada mais).
 */
export function viewPendenciasDaResposta(
  resposta?: RespostaErroDevolucao | null,
): PendenciasDevolucaoView | null {
  if (!resposta || resposta.code !== CODIGO_DEVOLUCAO_INVALIDA) return null;
  return viewPendencias(resposta.issues, resposta.error);
}
