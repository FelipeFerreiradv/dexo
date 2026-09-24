// Aviso do ULTIMO passo do wizard de NF-e ("Finalizar"): qual ambiente vai
// receber esta nota e o que isso significa para quem esta com o dedo no botao.
//
// Modulo puro (testado em node, mesmo padrao de nfe-numeracao-ui.ts) porque o
// defeito que ele corrige era de TEXTO: a tela afirmava "ambiente de
// homologacao" escrito fixo, para todo mundo, inclusive para quem emite em
// PRODUCAO. Quem emitiu R$ 12.000 de verdade lia "homologacao" no segundo
// antes de clicar — mentira em dose dupla (diz que nao vale quando vale, e
// convida a clicar "so para testar").
//
// ── Regra de ouro: PRODUCAO MANDA ──
//   * qualquer sinal CONHECIDO dizendo PRODUCAO  ⇒ aviso de nota real;
//   * so com todos os sinais conhecidos em HOMOLOGACAO o aviso diz "teste";
//   * nenhum sinal conhecido ⇒ aviso NEUTRO, com o peso de producao. Nunca
//     afirmar homologacao por omissao.
// A assimetria e de proposito: errar para "vale de verdade" no maximo assusta;
// errar para "e so teste" autoriza o clique numa nota fiscal real.
//
// ── Por que DOIS sinais de ambiente ──
// Quem decide o ambiente da emissao e a CONFIGURACAO da empresa: o
// NfeEmissionUseCase le `config.ambiente`, reserva o numero nessa sequencia e
// ate REGRAVA o `ambiente` da linha ("the draft row was created with an initial
// ambiente (hardcoded HOMOLOGACAO historically), but the user may have switched
// the fiscal config to PRODUCAO in the meantime"). A coluna `ambiente` do
// rascunho congela o ambiente do dia em que ele nasceu — um rascunho ANTIGO,
// feito antes de o cliente trocar para producao, carrega HOMOLOGACAO para
// sempre. Sozinho, esse sinal repetiria a mesma mentira, so que com cara de
// dado. (Mesmo achado ja registrado em tests/fiscal/devolucao/
// devolucao-ambiente-config.spec.ts.) Por isso a config e a autoridade e o
// rascunho entra so como segundo sinal — e, entre os dois, producao vence.

export type AmbienteResolvido = "PRODUCAO" | "HOMOLOGACAO" | "DESCONHECIDO";

export interface SinaisAmbiente {
  /** `ambiente` da configuracao fiscal — e o que a emissao de fato usa. */
  ambienteConfig?: string | null;
  /** `ambiente` da linha do rascunho — segundo sinal; pode estar velho. */
  ambienteRascunho?: string | null;
  /**
   * false enquanto a leitura da config AINDA nao voltou. Nesse intervalo o
   * rascunho sozinho nao pode afirmar homologacao — ele pode ser o rascunho
   * velho —, entao o aviso fica NEUTRO ate a config chegar; um rascunho em
   * PRODUCAO, esse sim, ja basta (escalar e sempre permitido). Ausente/true =
   * ja resolvido (inclusive "resolvido em nada": leitura falhou).
   */
  configResolvida?: boolean;
}

export interface EntradaAvisoEmissao extends SinaisAmbiente {
  /** Finalidade do rascunho. "DEVOLUCAO" muda o que a nota faz. */
  finalidade?: string | null;
}

export interface AvisoEmissao {
  ambiente: AmbienteResolvido;
  /** true = a tela trata como emissao real (producao ou duvida). */
  valeDeVerdade: boolean;
  /** Estilo do bloco: "atencao" (nota real/duvida) ou "info" (teste). */
  tom: "atencao" | "info";
  titulo: string;
  linhas: string[];
}

/** So PRODUCAO/HOMOLOGACAO contam como sinal; qualquer outra coisa e ruido. */
function normalizar(valor?: string | null): "PRODUCAO" | "HOMOLOGACAO" | null {
  if (typeof valor !== "string") return null;
  const v = valor.trim().toUpperCase();
  return v === "PRODUCAO" || v === "HOMOLOGACAO" ? v : null;
}

export function resolverAmbienteEmissao(sinais: SinaisAmbiente): AmbienteResolvido {
  const config = normalizar(sinais.ambienteConfig);
  const rascunho = normalizar(sinais.ambienteRascunho);

  // Escalar sempre pode: um unico sinal em PRODUCAO fecha a questao.
  if (config === "PRODUCAO" || rascunho === "PRODUCAO") return "PRODUCAO";

  // Dizer "e so teste" exige mais: ou a config falou, ou ela ja foi consultada
  // (e nao respondeu) e o rascunho e o que temos.
  const aguardandoConfig = config === null && sinais.configResolvida === false;
  if (config === "HOMOLOGACAO" || (rascunho === "HOMOLOGACAO" && !aguardandoConfig)) {
    return "HOMOLOGACAO";
  }

  return "DESCONHECIDO";
}

export function ehDevolucao(finalidade?: string | null): boolean {
  return typeof finalidade === "string" && finalidade.trim().toUpperCase() === "DEVOLUCAO";
}

// A frase de homologacao e, palavra por palavra, a que a tela sempre mostrou —
// la ela estava CERTA, e continua sendo o texto do ambiente de teste.
const ACAO_HOMOLOGACAO =
  'Ao clicar em "Emitir NF-e", a nota será validada, numerada e enviada para autorização na SEFAZ em ambiente de homologação.';
const ACAO_PRODUCAO =
  'Ao clicar em "Emitir NF-e", a nota é validada, numerada e enviada à SEFAZ em PRODUÇÃO: ela vale para o Fisco e acompanha a mercadoria.';
const ACAO_DESCONHECIDO =
  'Ao clicar em "Emitir NF-e", a nota é validada, numerada e enviada à SEFAZ para autorização.';

const NUMERO_DEFINITIVO =
  "O número é definitivo: depois de autorizada, só um cancelamento registrado na SEFAZ desfaz esta nota.";
// ATENCAO: a devolucao e "operacao exclusivamente fiscal. O estoque nao sera
// alterado" — a propria frase do `devolucao-editor.tsx`, dois passos atras.
// Nenhum caminho da devolucao mexe em estoque (ver nfe-devolucao.usecase.ts).
// Prometer aqui que a peca "volta para o estoque" seria uma segunda mentira no
// mesmo bloco: ela emitiria a nota e esperaria a peca reaparecer na prateleira
// do Dexo.
const DEVOLUCAO_REAL =
  "É uma nota de ENTRADA: ela referencia a nota de venda original. É só fiscal — o estoque do Dexo não muda com ela.";
const DEVOLUCAO_TESTE =
  "É uma nota de ENTRADA: ela referencia a nota de venda original.";

/**
 * Texto do bloco final do wizard. Sem estado, sem rede: so os sinais que a
 * tela tem em maos. A cor/estilo sai de `tom` — o componente nao decide texto.
 */
export function avisoEmissao(entrada: EntradaAvisoEmissao): AvisoEmissao {
  const ambiente = resolverAmbienteEmissao(entrada);
  const devolucao = ehDevolucao(entrada.finalidade);

  if (ambiente === "HOMOLOGACAO") {
    return {
      ambiente,
      valeDeVerdade: false,
      tom: "info",
      titulo: "Ambiente de homologação — sem valor fiscal",
      linhas: [
        ACAO_HOMOLOGACAO,
        ...(devolucao ? [DEVOLUCAO_TESTE] : []),
        "É uma emissão de teste: não tem valor fiscal, não vale para o Fisco e não acompanha mercadoria.",
      ],
    };
  }

  if (ambiente === "PRODUCAO") {
    return {
      ambiente,
      valeDeVerdade: true,
      tom: "atencao",
      titulo: devolucao ? "Esta devolução vale de verdade" : "Esta nota vale de verdade",
      linhas: [ACAO_PRODUCAO, ...(devolucao ? [DEVOLUCAO_REAL] : []), NUMERO_DEFINITIVO],
    };
  }

  return {
    ambiente,
    valeDeVerdade: true,
    tom: "atencao",
    titulo: "Confirme o ambiente antes de emitir",
    linhas: [
      ACAO_DESCONHECIDO,
      ...(devolucao ? [DEVOLUCAO_REAL] : []),
      "Não foi possível confirmar aqui em que ambiente o emissor está. Trate como emissão real: o número é definitivo e a nota pode valer para o Fisco.",
    ],
  };
}
