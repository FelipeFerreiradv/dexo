// O campo de ICMS do passo "Impostos" da devolução: ele passa a CONHECER o
// regime da empresa e a recusar o código errado na hora, com o motivo escrito —
// módulo puro, testado em node (mesmo padrão de `nfe-aviso-emissao.ts` e
// `nfe-devolucao-pendencias-ui.ts` ao lado).
//
// ── O caso real (DLS AUTO PEÇAS, 24/09/2026) ──
// Ela é do Simples Nacional e estava devolvendo uma COMPRA. No passo de
// impostos digitou `00` no campo de ICMS. `00` é CST, de regime NORMAL; no
// Simples o código é o CSOSN, de 3 dígitos. O campo decidia pelo TAMANHO do que
// se digitava:
//
//     v.length === 3 ? { csosn: v, cst: null } : { cst: v, csosn: null }
//
// Sem rótulo dizendo isso, sem conferência, e o valor SALVAVA. O bloqueio só
// aparecia depois, na validação do servidor, como "CST para emitente do Simples
// (Rejeição 591) — ajuste a tributação". Ela repetiu o ciclo e acumulou SEIS
// rascunhos de devolução abertos. Dois dígitos custaram o dia dela.
//
// ── Por que SELETOR e não campo livre com aviso ──
// O construtor da devolução emite EXATAMENTE 7 grupos (`TagIcmsDevolucao`):
// ICMSSN102/500/900 no Simples e ICMS00/40/60/90 no regime normal — 12 códigos
// no total, porque 103/300/400 caem no grupo do 102 e 41/50 no do 40, e o
// construtor escreve o código LITERAL dentro do grupo. O seletor oferece os 12,
// um rótulo por código: mostrar um por grupo obrigaria a operadora do Simples a
// declarar 102 (tributada) numa peça NÃO tributada, que é o 400. Fora deles o
// servidor não emite nada — `validacao.ts` levanta `TRIBUTACAO_NAO_SUPORTADA`.
// Ou seja: não existe caso legítimo fora da lista, e por isso o campo livre não
// tem o que defender. Quem não consegue digitar o código errado não erra: o
// seletor elimina a classe inteira do defeito, enquanto o aviso imediato apenas
// avisaria mais cedo — e ela já ignorou seis avisos tardios.
//
// A recusa com motivo continua existindo, e é o coração deste arquivo: o valor
// que JÁ ESTÁ no item vem do XML do FORNECEDOR (na DLS, CST 00 e CST 10 de uma
// distribuidora de regime normal), então o campo nasce carregando um código do
// regime errado. É ESSE valor que o seletor recusa na hora, nomeando o regime
// dela, dizendo o que o campo espera e por que o código que está lá não serve.
//
// ── O que este módulo NÃO faz ──
// Não escolhe imposto no lugar dela. Diante de um código incompatível ele
// mostra o problema e deixa o seletor VAZIO: escolher a tributação por conta
// própria é pior que travar, porque a nota sairia errada sem ninguém saber.
//
// ── De onde vem a lista ──
// De `DevolucaoDetalhe.emitente` (`regimeEmitenteDevolucao`, no backend), que é
// derivado das MESMAS tabelas do construtor. Nada de literal aqui: no dia em que
// alguém somar um grupo ao construtor, a tela acompanha sozinha. O veredito de
// cada código é delegado a `checarCodigoIcmsDevolucao` — a tela não fica nem
// mais rígida (recusaria o que a SEFAZ aceita) nem mais frouxa (deixaria passar
// a rejeição 590/591).
//
// Módulo PURO: sem React, sem fetch, sem DOM.

import {
  checarCodigoIcmsDevolucao,
  regimeEmitenteDevolucao,
} from "@/app/fiscal/devolucao/tributacao";
import type {
  CausaRecusaIcms,
  CrtEmitente,
  OpcaoIcmsDevolucao,
  RegimeEmitenteDevolucao,
  TagIcmsDevolucao,
  TipoCodigoIcms,
  TributacaoOverride,
} from "@/app/fiscal/devolucao/tipos";

// ─────────────────────────────── textos ───────────────────────────────

export const PLACEHOLDER_ICMS = "Escolha o código do ICMS";

export const TITULO_CODIGO_NAO_SERVE =
  "O código de ICMS deste item não serve para a sua empresa";

export const TITULO_SEM_CODIGO = "Este item veio sem código de ICMS";

export const MOTIVO_SEM_CODIGO = "A nota original não trouxe CST nem CSOSN neste item.";

/**
 * Quem decide a tributação é ela com o contador. A tela mostra o problema e
 * para por aí — o Dexo não elege um código "parecido".
 */
export const COMO_RESOLVER_ICMS =
  "Escolha na lista um dos códigos do seu regime. O Dexo não escolhe por você: a tributação é sua e do seu contador.";

export const ORIGEM_NOTA_ORIGINAL =
  "Este código veio da nota original — quem a emitiu pode ser de outro regime tributário.";

export const BLOQUEIO_CONFIRMAR =
  "Só dá para marcar como revisado depois de escolher um código de ICMS que sirva para o seu regime.";

export const SEM_ALIQUOTA = "Este grupo não leva alíquota de ICMS.";

export const ESCOLHA_ANTES_DA_ALIQUOTA =
  "Escolha o código do ICMS para poder informar a alíquota.";

// ───────────────────────── regime que a tela recebeu ─────────────────────────

/** `DevolucaoDetalhe.emitente` como ele chega: nada aqui pode confiar no formato. */
export interface EmitenteBruto {
  regimeTributario?: unknown;
  crt?: unknown;
  tipoCodigoIcms?: unknown;
  icmsOpcoes?: unknown;
  ajuda?: unknown;
}

function opcaoValida(o: unknown): o is OpcaoIcmsDevolucao {
  const x = o as Partial<OpcaoIcmsDevolucao> | null;
  return (
    !!x &&
    typeof x.codigo === "string" &&
    x.codigo !== "" &&
    typeof x.tag === "string" &&
    typeof x.rotulo === "string" &&
    (x.tipo === "CSOSN" || x.tipo === "CST")
  );
}

/**
 * O bloco do emitente, com rede de segurança: servidor antigo (sem o campo) ou
 * resposta truncada cai em `regimeEmitenteDevolucao`, que sem regime devolve os
 * DOIS conjuntos. A tela nunca recusa o que o servidor aceitaria — sem regime,
 * o servidor também aceita os dois.
 */
export function regimeDoDetalhe(emitente: EmitenteBruto | null | undefined): RegimeEmitenteDevolucao {
  const e = emitente ?? null;
  const opcoes = Array.isArray(e?.icmsOpcoes) ? e.icmsOpcoes.filter(opcaoValida) : [];
  if (e && opcoes.length > 0 && typeof e.ajuda === "string" && e.ajuda !== "") {
    return {
      regimeTributario: typeof e.regimeTributario === "string" ? e.regimeTributario : null,
      crt: normalizarCrt(e.crt),
      tipoCodigoIcms: e.tipoCodigoIcms === "CSOSN" || e.tipoCodigoIcms === "CST" ? e.tipoCodigoIcms : null,
      icmsOpcoes: opcoes,
      ajuda: e.ajuda,
    };
  }
  return regimeEmitenteDevolucao(typeof e?.regimeTributario === "string" ? e.regimeTributario : null);
}

function normalizarCrt(v: unknown): CrtEmitente | null {
  const s = v === null || v === undefined ? "" : String(v).trim();
  return s === "1" || s === "2" || s === "3" || s === "4" ? s : null;
}

// ───────────────────────── código gravado no item ─────────────────────────

/** ICMS do item como ele vem em `TributacaoDevolucaoItem` (parcial de propósito). */
export interface IcmsDoItem {
  cst?: string | null;
  csosn?: string | null;
}

/**
 * O código que está no item HOJE. CSOSN primeiro, igual à linha que a tela já
 * mostrava ("ICMS: {csosn ?? cst}") — nada de inventar precedência nova.
 */
export function codigoIcmsDoItem(icms: IcmsDoItem | null | undefined): string | null {
  const csosn = typeof icms?.csosn === "string" ? icms.csosn.trim() : "";
  if (csosn !== "") return csosn;
  const cst = typeof icms?.cst === "string" ? icms.cst.trim() : "";
  return cst === "" ? null : cst;
}

// ─────────────────────────────── a view ───────────────────────────────

export interface EntradaCampoIcms {
  /** `DevolucaoDetalhe.emitente`. */
  emitente: EmitenteBruto | null | undefined;
  /** `item.tributacao.icms` do detalhe — o que veio do XML da nota original. */
  icmsDoItem: IcmsDoItem | null | undefined;
  /**
   * O código escolhido NESTA sessão da tela. `null`/`undefined` = ela ainda não
   * mexeu no seletor, então o campo julga o valor que veio do servidor. `""` =
   * ela voltou o seletor para o vazio de propósito.
   */
  escolhido?: string | null;
}

export interface CampoIcmsView {
  /** Rótulo do campo, com o nome do código NO REGIME DELA. */
  rotulo: string;
  /** Frase do servidor ("Sua empresa é do Simples Nacional…"). */
  ajuda: string;
  placeholder: string;
  /** Só o que ESTE emitente pode usar (mais o código atual, quando ele serve). */
  opcoes: OpcaoIcmsDevolucao[];
  /** Valor do seletor. `""` enquanto não há código que sirva — nunca um palpite. */
  valor: string;
  crt: CrtEmitente | null;
  tipoCodigoIcms: TipoCodigoIcms | null;
  /** O código gravado no item (null quando a original não trouxe nenhum). */
  codigoAtual: string | null;
  /** O gravado serve para este emitente? */
  atualServe: boolean;
  /** true ⇒ falta escolher: nem confirmar revisão nem informar alíquota. */
  precisaEscolher: boolean;
  causa: CausaRecusaIcms | null;
  /** "" quando não há nada a recusar. */
  titulo: string;
  /** O motivo escrito, vindo de `checarCodigoIcmsDevolucao`. */
  motivo: string;
  /** "" quando não há recusa. */
  comoResolver: string;
  /** "" a menos que a recusa seja do código que veio da nota original. */
  origem: string;
  /** O grupo escolhido leva base e alíquota? */
  exigeAliquota: boolean;
  tag: TagIcmsDevolucao | null;
}

const VAZIO = {
  titulo: "",
  motivo: "",
  comoResolver: "",
  origem: "",
} as const;

/**
 * Tudo que o campo precisa para desenhar e para recusar, numa passada só.
 *
 * A ordem importa: o que ELA escolheu manda sobre o que veio do servidor. Sem
 * escolha, o campo julga o valor gravado — que é justamente o do fornecedor.
 */
export function campoIcms(entrada: EntradaCampoIcms): CampoIcmsView {
  const regime = regimeDoDetalhe(entrada.emitente);
  const codigoAtual = codigoIcmsDoItem(entrada.icmsDoItem);
  /** Do valor GRAVADO, sempre — independe do que ela escolheu depois. */
  const atualServe =
    codigoAtual !== null && checarCodigoIcmsDevolucao({ crt: regime.crt, codigo: codigoAtual }).ok;
  const base = {
    ajuda: regime.ajuda,
    placeholder: PLACEHOLDER_ICMS,
    crt: regime.crt,
    tipoCodigoIcms: regime.tipoCodigoIcms,
    codigoAtual,
    rotulo: rotuloDoCampo(regime.tipoCodigoIcms),
  };

  const mexeu = typeof entrada.escolhido === "string";
  const alvo = mexeu ? (entrada.escolhido as string).trim() : (codigoAtual ?? "");
  const veredito =
    alvo === ""
      ? null
      : checarCodigoIcmsDevolucao({ crt: regime.crt, codigo: alvo });

  // Serve: o seletor mostra o código e nada é recusado.
  if (veredito && veredito.ok) {
    const opcoes = comOCodigoAtual(regime.icmsOpcoes, veredito.codigo, veredito.tag, veredito.tipo);
    const opcao = opcoes.find((o) => o.codigo === veredito.codigo) ?? null;
    return {
      ...base,
      ...VAZIO,
      opcoes,
      valor: veredito.codigo,
      atualServe,
      precisaEscolher: false,
      causa: null,
      exigeAliquota: opcao?.exigeValores === true,
      tag: veredito.tag,
    };
  }

  // Não serve (ou está vazio): seletor VAZIO e o motivo na tela.
  const opcoes = regime.icmsOpcoes.map((o) => ({ ...o }));
  const daNotaOriginal = !mexeu && codigoAtual !== null;
  if (veredito === null) {
    // Nada escolhido e nada gravado: não há código para recusar, há código
    // FALTANDO — e o servidor também bloqueia (TRIBUTACAO_NAO_SUPORTADA).
    const semCodigoNoItem = codigoAtual === null;
    return {
      ...base,
      opcoes,
      valor: "",
      atualServe,
      precisaEscolher: true,
      causa: "VAZIO",
      titulo: semCodigoNoItem ? TITULO_SEM_CODIGO : "",
      motivo: semCodigoNoItem ? MOTIVO_SEM_CODIGO : "",
      comoResolver: COMO_RESOLVER_ICMS,
      origem: "",
      exigeAliquota: false,
      tag: null,
    };
  }
  return {
    ...base,
    opcoes,
    valor: "",
    atualServe,
    precisaEscolher: true,
    causa: veredito.causa,
    titulo: TITULO_CODIGO_NAO_SERVE,
    motivo: veredito.motivo,
    comoResolver: COMO_RESOLVER_ICMS,
    origem: daNotaOriginal ? ORIGEM_NOTA_ORIGINAL : "",
    exigeAliquota: false,
    tag: null,
  };
}

function rotuloDoCampo(tipo: TipoCodigoIcms | null): string {
  if (tipo === "CSOSN") return "Código do ICMS (CSOSN — Simples Nacional)";
  if (tipo === "CST") return "Código do ICMS (CST — regime normal)";
  return "Código do ICMS (CST ou CSOSN)";
}

/**
 * Rede de segurança para o código que SERVE mas não está na lista que o servidor
 * mandou. Hoje `opcoesIcmsDevolucao` devolve os 12 códigos da allowlist, então o
 * caso some quando os dois lados estão na mesma versão — mas `regimeDoDetalhe`
 * CONFIA na `icmsOpcoes` que veio no `DevolucaoDetalhe`, e ela pode ser menor:
 * servidor mais antigo (a lista de 7, de um código por grupo), resposta truncada,
 * ou entradas que `opcaoValida` descartou por virem quebradas.
 *
 * Sem isto o `<select>` ficaria com `value` num código sem `<option>`: o DOM
 * renderiza em branco e a tela diria "nada escolhido" enquanto `campoIcms`
 * responde `valor: "400"`, `precisaEscolher: false` — divergência silenciosa, e
 * ainda empurraria a operadora a TROCAR um código que o servidor aceita.
 * Então ele entra como opção própria, dizendo de onde veio e a que grupo pertence.
 */
function comOCodigoAtual(
  opcoes: readonly OpcaoIcmsDevolucao[],
  codigo: string,
  tag: TagIcmsDevolucao,
  tipo: TipoCodigoIcms,
): OpcaoIcmsDevolucao[] {
  const lista = opcoes.map((o) => ({ ...o }));
  if (lista.some((o) => o.codigo === codigo)) return lista;
  const doGrupo = lista.find((o) => o.tag === tag);
  return [
    {
      codigo,
      tipo,
      tag,
      rotulo: doGrupo
        ? `${codigo} — como veio da nota original (mesmo grupo do ${doGrupo.codigo})`
        : `${codigo} — como veio da nota original`,
      exigeValores: doGrupo?.exigeValores === true,
    },
    ...lista,
  ];
}

// ─────────────────── o que vai no corpo do PUT …/devolucao/itens ───────────────────

/**
 * O par `{cst, csosn}` do código, lido pelo MESMO juiz do servidor — é o que
 * aposenta o `v.length === 3` da tela. `null` quando o código não serve: nesse
 * caso nada de ICMS é enviado, porque mandar meio ajuste faria o servidor
 * completar com o código do FORNECEDOR que está gravado.
 */
export function paresDoCodigoIcms(
  codigo: string | null | undefined,
  crt: CrtEmitente | string | null | undefined,
): { cst: string | null; csosn: string | null } | null {
  const r = checarCodigoIcmsDevolucao({ crt, codigo });
  if (!r.ok) return null;
  return r.tipo === "CSOSN" ? { csosn: r.codigo, cst: null } : { cst: r.codigo, csosn: null };
}

/**
 * Põe (ou tira) o ICMS do override que a tela envia.
 *
 * Duas armadilhas do servidor que esta função fecha:
 *  1. O servidor completa o que falta no corpo: primeiro com o ajuste que ela JÁ
 *     gravou (`mesclarAjusteTributacao`, só quando a tributação gravada é dela) e,
 *     sem ele, com a BASE do XML da nota original, recalculada a cada save
 *     (`ov.icms.cst ?? t.icms.cst`, com `t` = `proporcionalizar` do XML) — nunca
 *     com o que a tela mostra. Mandar só a alíquota reenviaria o CST do
 *     fornecedor — por isso o código viaja SEMPRE junto da alíquota, e o editor
 *     manda a alíquota que a caixa MOSTRA (`impostosDaLinha`).
 *  2. Um `icms` vazio ainda é um ajuste. Sem código que sirva, o grupo sai do
 *     corpo inteiro; e se não sobrar mais nada, o override some (`undefined`),
 *     que é o que mantém "não mexi em imposto" significando não mexer —
 *     `temAjuste` falso, nenhum `ALTERADA_PELO_USUARIO` gravado à toa.
 */
export function overrideComIcms(
  atual: TributacaoOverride | null | undefined,
  entrada: {
    codigo?: string | null;
    crt?: CrtEmitente | string | null;
    /** `undefined` mantém a alíquota que já estava no override. */
    pICMS?: number | null;
  },
): TributacaoOverride | undefined {
  const base: TributacaoOverride = { ...(atual ?? {}) };
  const par = paresDoCodigoIcms(entrada.codigo, entrada.crt);
  if (!par) {
    delete base.icms;
  } else {
    const p = entrada.pICMS === undefined ? base.icms?.pICMS ?? null : entrada.pICMS;
    base.icms = { ...par, ...(p === null || p === undefined ? {} : { pICMS: p }) };
  }
  return Object.keys(base).length > 0 ? base : undefined;
}
