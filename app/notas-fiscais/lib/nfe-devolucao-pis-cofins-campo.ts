// Os campos de PIS e de COFINS do passo "Impostos" da devolução: SELETOR com o
// significado de cada código, no lugar da caixa de texto livre "CST" — módulo
// puro, testado em node (irmão de `nfe-devolucao-icms-campo.ts`).
//
// ── O caso real (DLS AUTO PEÇAS, 24/09/2026) ──
// Ela é do Simples Nacional e devolvia uma COMPRA da DISAUTO (regime normal). O
// PIS e a COFINS eram duas caixas vazias com o texto de exemplo "CST": sem lista,
// sem dizer o que cada número quer dizer e sem mostrar o código que já estava no
// item. Ela ficou 70 minutos chutando (01, 49, 01, 49) e chegou a gravar COFINS a
// 1,64%. Pior: digitar o CST depois da alíquota APAGAVA a alíquota (`{cst: v}`
// trocava o grupo inteiro) e a caixa de alíquota era `defaultValue` — a tela
// mostrava 1,65% e o banco guardava 0%.
//
// ── As regras deste arquivo ──
//  1. A lista vem do servidor (`DevolucaoDetalhe.emitente.pisCofinsOpcoes`,
//     montada pelas MESMAS tabelas de `tributacao.ts`); sem ela, da mesma função
//     (`opcoesPisCofinsDevolucao`). Nada de literal aqui.
//  2. O veredito é o do servidor (`checarCstPisCofinsDevolucao`): 01/02 numa
//     empresa do Simples é RECUSADO (decisão do dono: é o que o Dexo já faz nas
//     notas comuns do Simples); CST de entrada numa nota de saída é só AVISO.
//  3. O seletor nasce VAZIO quando o código gravado não serve — o Dexo não
//     escolhe imposto no lugar dela.
//  4. Código e alíquota viajam SEMPRE juntos no corpo, com o número que a caixa
//     mostra (`overrideComPisCofins`): o servidor completa o que falta, e
//     completar em silêncio é o que fazia a tela e o banco divergirem.
//
// Módulo PURO: sem React, sem fetch, sem DOM.

import {
  checarCstPisCofinsDevolucao,
  opcoesPisCofinsDevolucao,
} from "@/app/fiscal/devolucao/tributacao";
import type {
  CausaRecusaPisCofins,
  CrtEmitente,
  OpcaoPisCofinsDevolucao,
  SentidoCstPisCofins,
  TipoDevolucao,
  TributacaoOverride,
} from "@/app/fiscal/devolucao/tipos";
import { ORIGEM_NOTA_ORIGINAL, regimeDoDetalhe, type EmitenteBruto } from "./nfe-devolucao-icms-campo";

export type TributoPisCofins = "pis" | "cofins";

/** "do PIS" / "da COFINS" — a preposição certa em cada frase. */
const NOME: Readonly<Record<TributoPisCofins, { nome: string; de: string }>> = {
  pis: { nome: "PIS", de: "do PIS" },
  cofins: { nome: "COFINS", de: "da COFINS" },
};

// ─────────────────────────────── textos ───────────────────────────────

export function rotuloCampoPisCofins(tributo: TributoPisCofins): string {
  return `Código ${NOME[tributo].de} (CST)`;
}

export function placeholderPisCofins(tributo: TributoPisCofins): string {
  return `Escolha o código ${NOME[tributo].de}`;
}

export function rotuloAliquotaPisCofins(tributo: TributoPisCofins): string {
  return `Alíquota ${NOME[tributo].de} (%)`;
}

export function semAliquotaPisCofins(tributo: TributoPisCofins): string {
  return `Este código não leva alíquota: ${tributo === "pis" ? "o PIS sai" : "a COFINS sai"} sem valor na nota.`;
}

export function escolhaAntesDaAliquotaPisCofins(tributo: TributoPisCofins): string {
  return `Escolha o código ${NOME[tributo].de} para poder informar a alíquota.`;
}

export const COMO_RESOLVER_PIS_COFINS =
  "Escolha na lista um dos códigos que servem para a sua empresa. O Dexo não escolhe por você: a tributação é sua e da sua contadora.";

export const BLOQUEIO_CONFIRMAR_PIS_COFINS =
  "Só dá para marcar como revisado depois de escolher um código de PIS e um de COFINS que sirvam para a sua empresa.";

function tituloNaoServe(tributo: TributoPisCofins, causa: CausaRecusaPisCofins): string {
  if (causa === "REGIME") return `O código ${NOME[tributo].de} deste item não serve para a sua empresa`;
  return `O código ${NOME[tributo].de} deste item não serve na devolução`;
}

function tituloSemCodigo(tributo: TributoPisCofins): string {
  return `Este item veio sem código ${NOME[tributo].de}`;
}

// ─────────────────────────────── opções ───────────────────────────────

const SENTIDOS: ReadonlySet<string> = new Set(["SAIDA", "ENTRADA", "AMBOS"]);

function opcaoValida(o: unknown): o is OpcaoPisCofinsDevolucao {
  const x = o as Partial<OpcaoPisCofinsDevolucao> | null;
  return (
    !!x &&
    typeof x.codigo === "string" &&
    /^\d{2}$/.test(x.codigo) &&
    typeof x.rotulo === "string" &&
    x.rotulo !== "" &&
    typeof x.sentido === "string" &&
    SENTIDOS.has(x.sentido) &&
    typeof x.exigeAliquota === "boolean" &&
    typeof x.doSentidoDaNota === "boolean" &&
    typeof x.usual === "boolean"
  );
}

/** `DevolucaoDetalhe.emitente` com o bloco de PIS/COFINS (opcional: servidor antigo não manda). */
export interface EmitentePisCofinsBruto extends EmitenteBruto {
  pisCofinsOpcoes?: unknown;
  pisCofinsAjuda?: unknown;
  tipoDevolucao?: unknown;
}

function tipoValido(v: unknown): TipoDevolucao | null {
  return v === "VENDA_ENTRADA" || v === "COMPRA_SAIDA" ? v : null;
}

/**
 * As opções do seletor: as do servidor quando vêm inteiras; senão, a MESMA
 * função que as monta lá, com o regime que a tela recebeu. Assim a tela nunca
 * oferece o que o servidor recusa, nem esconde o que ele aceita.
 */
export function opcoesPisCofinsDoDetalhe(
  emitente: EmitentePisCofinsBruto | null | undefined,
  tipo: TipoDevolucao | null | undefined,
): OpcaoPisCofinsDevolucao[] {
  const lista = Array.isArray(emitente?.pisCofinsOpcoes) ? emitente.pisCofinsOpcoes.filter(opcaoValida) : [];
  if (lista.length > 0) return lista.map((o) => ({ ...o }));
  const crt = regimeDoDetalhe(emitente).crt;
  return opcoesPisCofinsDevolucao({ crt, tipo: tipoValido(tipo) ?? tipoValido(emitente?.tipoDevolucao) });
}

/** Frase do topo do passo (uma vez): a do servidor, ou nada. */
export function ajudaPisCofinsDoDetalhe(emitente: EmitentePisCofinsBruto | null | undefined): string {
  return typeof emitente?.pisCofinsAjuda === "string" ? emitente.pisCofinsAjuda : "";
}

export interface GrupoOpcoesPisCofins {
  rotulo: string;
  opcoes: OpcaoPisCofinsDevolucao[];
}

/**
 * Os mais usados no regime dela primeiro; depois os outros do sentido da nota;
 * por último os do sentido oposto (não recusados — só avisados).
 */
export function gruposPisCofins(
  opcoes: readonly OpcaoPisCofinsDevolucao[],
  tipo: TipoDevolucao | null | undefined,
): GrupoOpcoesPisCofins[] {
  const usuais = opcoes.filter((o) => o.usual);
  const doSentido = opcoes.filter((o) => !o.usual && o.doSentidoDaNota);
  const oposto = opcoes.filter((o) => !o.usual && !o.doSentidoDaNota);
  const nomeOposto =
    tipo === "COMPRA_SAIDA"
      ? "Códigos de entrada (esta devolução é uma nota de saída)"
      : tipo === "VENDA_ENTRADA"
        ? "Códigos de saída (esta devolução é uma nota de entrada)"
        : "Outros códigos";
  return [
    { rotulo: "Mais usados", opcoes: usuais },
    { rotulo: "Outros códigos", opcoes: doSentido },
    { rotulo: nomeOposto, opcoes: oposto },
  ].filter((g) => g.opcoes.length > 0);
}

// ───────────────────────────── a view do campo ─────────────────────────────

export interface EntradaCampoPisCofins {
  emitente: EmitentePisCofinsBruto | null | undefined;
  /** `DevolucaoDetalhe.tipo`: é ele que diz se a nota é de entrada ou de saída. */
  tipo: TipoDevolucao | null | undefined;
  tributo: TributoPisCofins;
  /** `item.tributacao.pis|cofins` — o que está GRAVADO no item. */
  gravado: { cst?: string | null } | null | undefined;
  /**
   * O código escolhido NESTA sessão. `null`/`undefined` = não mexeu (o campo
   * julga o gravado); `""` = voltou o seletor para o vazio de propósito.
   */
  escolhido?: string | null;
  /**
   * O CST que veio na nota ORIGINAL (`referenciaOriginal.pis.cst`), quando o
   * gravado é nulo: diz por que o item "veio sem código" (03/05, por exemplo).
   */
  codigoDaNota?: string | null;
}

export interface CampoPisCofinsView {
  tributo: TributoPisCofins;
  rotulo: string;
  placeholder: string;
  opcoes: OpcaoPisCofinsDevolucao[];
  grupos: GrupoOpcoesPisCofins[];
  /** Valor do seletor. `""` enquanto não há código que sirva — nunca um palpite. */
  valor: string;
  /** O código gravado no item (null quando não há). */
  codigoAtual: string | null;
  crt: CrtEmitente | null;
  /** true ⇒ falta escolher: nem confirmar revisão nem informar alíquota. */
  precisaEscolher: boolean;
  causa: CausaRecusaPisCofins | null;
  titulo: string;
  motivo: string;
  comoResolver: string;
  origem: string;
  /** O código escolhido leva alíquota (PISAliq/PISOutr)? */
  exigeAliquota: boolean;
  sentido: SentidoCstPisCofins | null;
  /** Aviso de sentido (não impede): "" quando não há. */
  avisoTexto: string;
}

/**
 * Rede de segurança: código que SERVE mas não veio na lista do servidor
 * (servidor mais antigo, lista truncada) entra como opção própria — senão o
 * `<select>` ficaria em branco com um valor que o campo diz que serve.
 */
function comOCodigoAtual(
  opcoes: OpcaoPisCofinsDevolucao[],
  codigo: string,
  sentido: SentidoCstPisCofins,
  exigeAliquota: boolean,
): OpcaoPisCofinsDevolucao[] {
  if (opcoes.some((o) => o.codigo === codigo)) return opcoes;
  return [
    {
      codigo,
      rotulo: `${codigo} — como está gravado neste item`,
      sentido,
      exigeAliquota,
      doSentidoDaNota: true,
      usual: true,
    },
    ...opcoes,
  ];
}

function codigoGravado(g: { cst?: string | null } | null | undefined): string | null {
  const c = typeof g?.cst === "string" ? g.cst.trim() : "";
  return c === "" ? null : c;
}

export function campoPisCofins(entrada: EntradaCampoPisCofins): CampoPisCofinsView {
  const crt = regimeDoDetalhe(entrada.emitente).crt;
  const tipo = tipoValido(entrada.tipo) ?? tipoValido(entrada.emitente?.tipoDevolucao);
  const tributo = entrada.tributo;
  const codigoAtual = codigoGravado(entrada.gravado);
  const listaServidor = opcoesPisCofinsDoDetalhe(entrada.emitente, tipo);
  const base = {
    tributo,
    rotulo: rotuloCampoPisCofins(tributo),
    placeholder: placeholderPisCofins(tributo),
    codigoAtual,
    crt,
  };

  const mexeu = typeof entrada.escolhido === "string";
  const alvo = mexeu ? (entrada.escolhido as string).trim() : (codigoAtual ?? "");
  const veredito = alvo === "" ? null : checarCstPisCofinsDevolucao({ crt, tipo, codigo: alvo });

  if (veredito && veredito.ok) {
    const opcoes = comOCodigoAtual(listaServidor, veredito.codigo, veredito.sentido, veredito.exigeAliquota);
    return {
      ...base,
      opcoes,
      grupos: gruposPisCofins(opcoes, tipo),
      valor: veredito.codigo,
      precisaEscolher: false,
      causa: null,
      titulo: "",
      motivo: "",
      comoResolver: "",
      origem: "",
      exigeAliquota: veredito.exigeAliquota,
      sentido: veredito.sentido,
      avisoTexto: veredito.avisoTexto,
    };
  }

  const opcoes = listaServidor;
  const grupos = gruposPisCofins(opcoes, tipo);
  if (veredito === null) {
    // Nada escolhido e nada gravado: há código FALTANDO (o servidor também
    // barra a emissão — PIS_COFINS_NAO_SUPORTADO). Se a nota original trouxe um
    // código que o Dexo não emite (03, 05), a frase diz qual.
    const semCodigo = !mexeu && codigoAtual === null;
    const daNota = typeof entrada.codigoDaNota === "string" ? entrada.codigoDaNota.trim() : "";
    const porQue =
      semCodigo && daNota !== ""
        ? (() => {
            const r = checarCstPisCofinsDevolucao({ crt, tipo, codigo: daNota });
            return r.ok ? "" : `A nota original trouxe o CST ${r.codigo || daNota}. ${r.motivo}`;
          })()
        : "";
    return {
      ...base,
      opcoes,
      grupos,
      valor: "",
      precisaEscolher: true,
      causa: "VAZIO",
      titulo: semCodigo ? tituloSemCodigo(tributo) : "",
      motivo: porQue,
      comoResolver: COMO_RESOLVER_PIS_COFINS,
      origem: "",
      exigeAliquota: false,
      sentido: null,
      avisoTexto: "",
    };
  }
  return {
    ...base,
    opcoes,
    grupos,
    valor: "",
    precisaEscolher: true,
    causa: veredito.causa,
    titulo: tituloNaoServe(tributo, veredito.causa),
    motivo: veredito.motivo,
    comoResolver: COMO_RESOLVER_PIS_COFINS,
    origem: !mexeu && codigoAtual !== null ? ORIGEM_NOTA_ORIGINAL : "",
    exigeAliquota: false,
    sentido: null,
    avisoTexto: "",
  };
}

export interface RecusaPisCofins {
  titulo: string;
  motivo: string;
  origem: string;
  comoResolver: string;
}

/**
 * Os quadros de recusa do PIS e da COFINS de um item. Quando os dois recusam o
 * MESMO código pelo MESMO motivo (o 01 da DISAUTO nos dois, na DLS), vira UM
 * quadro só — dois quadros iguais lado a lado ela lê como dois problemas.
 */
export function recusasPisCofins(pis: CampoPisCofinsView, cofins: CampoPisCofinsView): RecusaPisCofins[] {
  const de = (c: CampoPisCofinsView): RecusaPisCofins => ({
    titulo: c.titulo,
    motivo: c.motivo,
    origem: c.origem,
    comoResolver: c.comoResolver,
  });
  if (!pis.precisaEscolher && !cofins.precisaEscolher) return [];
  if (!pis.precisaEscolher) return [de(cofins)];
  if (!cofins.precisaEscolher) return [de(pis)];
  const iguais = pis.causa === cofins.causa && pis.codigoAtual === cofins.codigoAtual && pis.motivo === cofins.motivo;
  if (!iguais) return [de(pis), de(cofins)];
  const titulo =
    pis.titulo === ""
      ? ""
      : pis.causa === "VAZIO"
        ? "Este item veio sem código do PIS e da COFINS"
        : pis.causa === "REGIME"
          ? "O código do PIS e da COFINS deste item não serve para a sua empresa"
          : "O código do PIS e da COFINS deste item não serve na devolução";
  return [{ titulo, motivo: pis.motivo, origem: pis.origem, comoResolver: pis.comoResolver }];
}

// ───────────────────────────── alíquota ─────────────────────────────

export type AliquotaLida = { ok: true; valor: number } | { ok: false; vazia: boolean; motivo: string };

/**
 * O texto da caixa de alíquota. Vazio NÃO é zero: é "não informada" — era o
 * `Number("") === 0` que mandava 0% sem aviso. Aceita vírgula.
 */
export function lerAliquota(texto: string | null | undefined, de: string): AliquotaLida {
  const t = (texto ?? "").trim().replace(",", ".");
  if (t === "") return { ok: false, vazia: true, motivo: `Informe a alíquota ${de} (de 0 a 100).` };
  if (!/^\d+(\.\d+)?$/.test(t)) return { ok: false, vazia: false, motivo: `A alíquota ${de} é um número de 0 a 100.` };
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    return { ok: false, vazia: false, motivo: `A alíquota ${de} vai de 0 a 100.` };
  }
  return { ok: true, valor: n };
}

/** Número gravado → texto da caixa (o `value` de um input number usa ponto). */
export function textoDaAliquota(n: number | null | undefined): string {
  return typeof n === "number" && Number.isFinite(n) ? String(n) : "";
}

/**
 * A alíquota que a caixa mostra, julgada com o código escolhido: além de 0–100,
 * 01/02 não aceitam zero (alíquota zero é o 06) — o MESMO juiz do servidor.
 */
export function aliquotaPisCofins(entrada: {
  campo: CampoPisCofinsView;
  tipo: TipoDevolucao | null | undefined;
  texto: string | null | undefined;
}): AliquotaLida {
  const { campo } = entrada;
  const lida = lerAliquota(entrada.texto, NOME[campo.tributo].de);
  if (!lida.ok) return lida;
  const r = checarCstPisCofinsDevolucao({ crt: campo.crt, tipo: tipoValido(entrada.tipo), codigo: campo.valor, p: lida.valor });
  if (!r.ok && r.causa === "ALIQUOTA") return { ok: false, vazia: false, motivo: r.motivo };
  return lida;
}

// ─────────────────── o que vai no corpo do PUT …/devolucao/itens ───────────────────

/**
 * Põe (ou tira) o PIS ou a COFINS do override que a tela envia — SEMPRE o par
 * `{cst, p}`, com o número que a caixa mostra. Código que não serve não manda
 * nada (meio ajuste faria o servidor completar com o que está gravado); sem
 * nada sobrando, o override some (`undefined`): "não mexi em imposto" continua
 * sendo não mexer.
 */
export function overrideComPisCofins(
  atual: TributacaoOverride | null | undefined,
  entrada: {
    tributo: TributoPisCofins;
    codigo: string | null | undefined;
    /** Alíquota da caixa. Ignorada (vai 0) quando o código não leva alíquota. */
    p: number | null | undefined;
    crt: CrtEmitente | string | null | undefined;
    tipo?: TipoDevolucao | null;
  },
): TributacaoOverride | undefined {
  const base: TributacaoOverride = { ...(atual ?? {}) };
  const r = checarCstPisCofinsDevolucao({ crt: entrada.crt, tipo: entrada.tipo ?? null, codigo: entrada.codigo });
  if (!r.ok) {
    delete base[entrada.tributo];
  } else {
    const p = r.exigeAliquota ? entrada.p : 0;
    if (r.exigeAliquota && (typeof p !== "number" || !Number.isFinite(p))) delete base[entrada.tributo];
    else base[entrada.tributo] = { cst: r.codigo, p: p as number };
  }
  return Object.keys(base).length > 0 ? base : undefined;
}
