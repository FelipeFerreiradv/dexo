/**
 * Tributação da NF-e de devolução, proporcional ao `imposto` do XML ORIGINAL
 * (plano §6.4).
 *
 * Princípio: NADA é inventado. Valor que não dá para derivar do XML original
 * (base, alíquota, grupo fora da allowlist, ST, base reduzida, regime que mudou,
 * IPI destacado) marca `requerRevisao` e a emissão fica bloqueada até o usuário
 * confirmar (`confirmada`), eventualmente ajustando por `aplicarOverrideTributacao`
 * — que passa pela MESMA allowlist.
 *
 * Allowlist v1 de tags ICMS (só com contexto de devolução — o montador segue
 * idêntico sem ele):
 *   CSOSN 102/103/300/400 → ICMSSN102 · 500 → ICMSSN500 · 900 → ICMSSN900
 *   CST 00 → ICMS00 · 40/41/50 → ICMS40 · 60 → ICMS60 · 90 → ICMS90
 *
 * Arredondamento: 2 casas, meio-para-cima. Quantidades em 1/10000 (saldo.ts).
 *
 * A mesma allowlist alimenta a TELA: `regimeEmitenteDevolucao` (o que vai no
 * `DevolucaoDetalhe.emitente`) e `checarCodigoIcmsDevolucao` (recusa na hora,
 * com o motivo). A lista de códigos é DERIVADA das tabelas acima — nunca
 * copiada à mão — para o seletor não sair de sincronia com o construtor.
 *
 * Módulo PURO — seguro para backend, testes e client.
 */

import { ESCALA_QUANTIDADE, quantidadeParaUnidades } from "./saldo";
import type {
  AvisoTributacao,
  CofinsOriginal,
  CrtEmitente,
  IcmsOriginal,
  ImpostoOriginal,
  IpiOriginal,
  MotivoRevisaoTributacao,
  OpcaoIcmsDevolucao,
  PisOriginal,
  RegimeEmitenteDevolucao,
  ResultadoCodigoIcms,
  TagIcmsDevolucao,
  TipoCodigoIcms,
  TributacaoDevolucaoItem,
  TributacaoOverride,
  TributoPisCofinsDevolucao,
} from "./tipos";

// ───────────────────────────── utilitários ─────────────────────────────

/** 2 casas, meio-para-cima (toFixed(6) absorve o erro binário: 1.005 → 1.01). */
export function round2(x: number): number {
  if (!Number.isFinite(x)) return 0;
  const sinal = x < 0 ? -1 : 1;
  return (sinal * Math.floor(Number((Math.abs(x) * 100).toFixed(6)) + 0.5)) / 100;
}

type Bruto = Record<string, unknown>;

function objeto(v: unknown): Bruto | null {
  if (Array.isArray(v)) return objeto(v[0]);
  return v !== null && typeof v === "object" ? (v as Bruto) : null;
}

function texto(v: unknown): string | undefined {
  if (Array.isArray(v)) return texto(v[0]);
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : undefined;
  if (typeof v === "string") {
    const t = v.trim();
    return t ? t : undefined;
  }
  const o = objeto(v);
  return o && "#text" in o ? texto(o["#text"]) : undefined;
}

function numero(v: unknown): number | undefined {
  const t = texto(v);
  if (t === undefined || !/^-?\d+(\.\d+)?$/.test(t)) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

/** Código numérico com zeros à esquerda (o parser pode ter convertido "00" em 0). */
function codigo(v: unknown, tamanho: number): string | undefined {
  const t = texto(v);
  if (t === undefined || !/^\d+$/.test(t) || t.length > tamanho) return undefined;
  return t.padStart(tamanho, "0");
}

/** 1º filho cujo nome casa com o prefixo (ignora atributos "@_"). */
function primeiroGrupo(pai: Bruto, prefixo: string): [string, Bruto] | null {
  for (const k of Object.keys(pai)) {
    if (k.startsWith("@_") || !k.startsWith(prefixo)) continue;
    const g = objeto(pai[k]);
    if (g) return [k, g];
  }
  return null;
}

function atribuirNumeros<T extends object>(alvo: T, g: Bruto, campos: readonly string[]): void {
  for (const c of campos) {
    const n = numero(g[c]);
    if (n !== undefined) (alvo as Record<string, unknown>)[c] = n;
  }
}

function normalizarCrt(v: unknown): CrtEmitente | null {
  const s = v === null || v === undefined ? "" : String(v).trim();
  return s === "1" || s === "2" || s === "3" || s === "4" ? s : null;
}

/** CSOSN para CRT 1 (Simples) e 4 (MEI); CST para 2 (excesso de sublimite) e 3 (normal). */
function familiaDoCrt(crt: unknown): "SN" | "NORMAL" | null {
  const c = normalizarCrt(crt);
  if (c === null) return null;
  return c === "1" || c === "4" ? "SN" : "NORMAL";
}

/** Regime da CompanyFiscalConfig → CRT (mesma regra de crtFromRegime do montador SEFAZ). */
export function crtDeRegime(regime: string | null | undefined): CrtEmitente | null {
  if (regime === "SIMPLES") return "1";
  if (regime === "LUCRO_PRESUMIDO" || regime === "LUCRO_REAL") return "3";
  return null;
}

// ─────────────────────── normalização do bruto do parser ───────────────────────

function jaNormalizado(r: Bruto): boolean {
  return typeof r.temIbsCbs === "boolean" && "icms" in r && "pis" in r && "cofins" in r;
}

/**
 * `ParsedItem.imposto` (bruto do fast-xml-parser, valores texto) → ImpostoOriginal.
 * Robusto a: valores number (parseTagValue ligado), arrays de 1 elemento,
 * "#text", CST "0" sem zero à esquerda, grupos ausentes, e a um ImpostoOriginal
 * já normalizado (idempotente — vindo de impostoOriginalJson).
 */
export function normalizarImpostoOriginal(raw: unknown): ImpostoOriginal {
  const r = objeto(raw);
  if (!r) return { icms: null, ipi: null, pis: null, cofins: null, temIbsCbs: false };
  if (jaNormalizado(r)) return JSON.parse(JSON.stringify(r)) as ImpostoOriginal;

  let icms: IcmsOriginal | null = null;
  const icmsWrap = objeto(r.ICMS);
  const icmsGrupo = icmsWrap ? primeiroGrupo(icmsWrap, "ICMS") : null;
  if (icmsGrupo) {
    const [grupo, g] = icmsGrupo;
    const orig = numero(g.orig);
    icms = {
      grupo,
      orig: orig !== undefined && Number.isInteger(orig) && orig >= 0 && orig <= 8 ? orig : null,
    };
    const cst = codigo(g.CST, 2);
    if (cst) icms.cst = cst;
    const csosn = codigo(g.CSOSN, 3);
    if (csosn) icms.csosn = csosn;
    const modBC = texto(g.modBC);
    if (modBC !== undefined) icms.modBC = modBC;
    atribuirNumeros(icms, g, ["vBC", "pRedBC", "pICMS", "vICMS", "vBCST", "vICMSST", "pCredSN", "vCredICMSSN"]);
  }

  let ipi: IpiOriginal | null = null;
  const ipiWrap = objeto(r.IPI);
  if (ipiWrap) {
    const trib = objeto(ipiWrap.IPITrib);
    const nt = objeto(ipiWrap.IPINT);
    const g = trib ?? nt;
    if (g) {
      ipi = { grupo: trib ? "IPITrib" : "IPINT", cst: codigo(g.CST, 2) ?? "" };
      const cEnq = texto(ipiWrap.cEnq);
      if (cEnq !== undefined) ipi.cEnq = cEnq;
      atribuirNumeros(ipi, g, ["vBC", "pIPI", "vIPI"]);
    }
  }

  let pis: PisOriginal | null = null;
  const pisWrap = objeto(r.PIS);
  const pisGrupo = pisWrap ? primeiroGrupo(pisWrap, "PIS") : null;
  if (pisGrupo) {
    const [grupo, g] = pisGrupo;
    pis = { grupo, cst: codigo(g.CST, 2) ?? "" };
    atribuirNumeros(pis, g, ["vBC", "pPIS", "vPIS", "qBCProd", "vAliqProd"]);
  }

  let cofins: CofinsOriginal | null = null;
  const cofinsWrap = objeto(r.COFINS);
  const cofinsGrupo = cofinsWrap ? primeiroGrupo(cofinsWrap, "COFINS") : null;
  if (cofinsGrupo) {
    const [grupo, g] = cofinsGrupo;
    cofins = { grupo, cst: codigo(g.CST, 2) ?? "" };
    atribuirNumeros(cofins, g, ["vBC", "pCOFINS", "vCOFINS", "qBCProd", "vAliqProd"]);
  }

  return {
    icms,
    ipi,
    pis,
    cofins,
    temIbsCbs: r.IBSCBS !== undefined && r.IBSCBS !== null,
  };
}

// ───────────────────────────── allowlists ─────────────────────────────

/**
 * A allowlist do SERVIDOR: todo código que a devolução aceita, e o grupo que ele
 * monta no XML. Exportada porque é a FONTE — o seletor da tela e os rótulos
 * (`CODIGOS_ICMS_DEVOLUCAO`) têm de cobrir exatamente estas chaves, nos dois
 * sentidos, e é a suíte que prende isso.
 */
export const TAG_POR_CSOSN: Readonly<Record<string, TagIcmsDevolucao>> = {
  "102": "ICMSSN102",
  "103": "ICMSSN102",
  "300": "ICMSSN102",
  "400": "ICMSSN102",
  "500": "ICMSSN500",
  "900": "ICMSSN900",
};

export const TAG_POR_CST: Readonly<Record<string, TagIcmsDevolucao>> = {
  "00": "ICMS00",
  "40": "ICMS40",
  "41": "ICMS40",
  "50": "ICMS40",
  "60": "ICMS60",
  "90": "ICMS90",
};

const TAGS_COM_VALORES: ReadonlySet<TagIcmsDevolucao> = new Set(["ICMS00", "ICMS90", "ICMSSN900"]);

/** CSTs de PIS/COFINS que os montadores emitem no grupo certo (03 e 05 ficam de fora). */
export const PIS_COFINS_CST_SUPORTADOS: ReadonlySet<string> = new Set([
  "01", "02", "04", "06", "07", "08", "09",
  "49", "50", "51", "52", "53", "54", "55", "56",
  "60", "61", "62", "63", "64", "65", "66", "67",
  "70", "71", "72", "73", "74", "75", "98", "99",
]);

const PIS_COFINS_SEM_VALORES: ReadonlySet<string> = new Set(["04", "06", "07", "08", "09"]);

/**
 * Tag ICMS da devolução pela allowlist; `null` ⇒ não suportado (requerRevisao).
 * Com `crt` informado, a família precisa bater (CSOSN só em CRT 1/4; CST só em 2/3).
 */
export function tagIcmsParaDevolucao(i: {
  crt?: CrtEmitente | string | null;
  cst?: string | null;
  csosn?: string | null;
}): TagIcmsDevolucao | null {
  const familia = familiaDoCrt(i.crt);
  if (i.csosn && familia !== "NORMAL") return TAG_POR_CSOSN[i.csosn] ?? null;
  if (i.cst && familia !== "SN") return TAG_POR_CST[i.cst] ?? null;
  return null;
}

export function familiaDaTag(tag: TagIcmsDevolucao): "SN" | "NORMAL" {
  return tag.startsWith("ICMSSN") ? "SN" : "NORMAL";
}

/** A tag é emitível por um emitente com este CRT? (rejeições 590/591) */
export function tagCompativelComCrt(tag: TagIcmsDevolucao, crt: unknown): boolean {
  const f = familiaDoCrt(crt);
  return f === null || f === familiaDaTag(tag);
}

// ─────────── o que a TELA pode oferecer: regime do emitente → códigos ───────────

/**
 * Rótulo de CADA código aceito, agrupado pela tag que ele monta no XML — quem lê
 * a tela é a dona do desmanche, não a contadora: o número vem primeiro, a
 * explicação depois.
 *
 * ⚠️ 103/300/400 NÃO são apelidos de 102, nem 41/50 de 40: o construtor escreve o
 * código LITERAL dentro do grupo (ver `nfe-xml-builder-sefaz.service.ts`), então
 * `<CSOSN>400</CSOSN>` (não tributada) e `<CSOSN>102</CSOSN>` (tributada sem
 * crédito) são notas diferentes. Mostrar um código por grupo obrigaria a operadora
 * a declarar o que a peça não é. Os textos seguem a tabela oficial de CST/CSOSN.
 *
 * O `Record` por tag é EXAUSTIVO de propósito: somar um grupo a `TagIcmsDevolucao`
 * sem escrever os rótulos dele quebra o `tsc`.
 */
export const CODIGOS_ICMS_DEVOLUCAO: Readonly<
  Record<TagIcmsDevolucao, ReadonlyArray<{ codigo: string; rotulo: string }>>
> = {
  ICMSSN102: [
    { codigo: "102", rotulo: "102 — Tributada pelo Simples: o ICMS já está na guia do Simples, sem crédito para quem compra" },
    { codigo: "103", rotulo: "103 — Isenta do ICMS no Simples Nacional, pela faixa de receita da empresa" },
    { codigo: "300", rotulo: "300 — Imune: a mercadoria não pode ser tributada por ICMS" },
    { codigo: "400", rotulo: "400 — Não tributada pelo Simples Nacional" },
  ],
  ICMSSN500: [
    { codigo: "500", rotulo: "500 — ICMS já cobrado antes por substituição tributária ou antecipação" },
  ],
  ICMSSN900: [
    { codigo: "900", rotulo: "900 — Outros casos do Simples: você informa a alíquota do ICMS" },
  ],
  ICMS00: [
    { codigo: "00", rotulo: "00 — Tributada integralmente: ICMS com base e alíquota na nota" },
  ],
  ICMS40: [
    { codigo: "40", rotulo: "40 — Isenta: a nota sai sem ICMS" },
    { codigo: "41", rotulo: "41 — Não tributada: a operação está fora da cobrança do ICMS" },
    { codigo: "50", rotulo: "50 — Suspensão: o ICMS fica suspenso até um evento futuro" },
  ],
  ICMS60: [
    { codigo: "60", rotulo: "60 — ICMS já cobrado antes por substituição tributária" },
  ],
  ICMS90: [
    { codigo: "90", rotulo: "90 — Outras: você informa a alíquota do ICMS" },
  ],
};

/** Compatibilidade: um rótulo por grupo, o do PRIMEIRO código dele. */
export const ROTULO_ICMS_DEVOLUCAO: Readonly<Record<TagIcmsDevolucao, string>> = Object.fromEntries(
  (Object.keys(CODIGOS_ICMS_DEVOLUCAO) as TagIcmsDevolucao[]).map((tag) => [
    tag,
    CODIGOS_ICMS_DEVOLUCAO[tag][0].rotulo,
  ]),
) as Readonly<Record<TagIcmsDevolucao, string>>;

/**
 * TODOS os códigos aceitos, na ordem em que os grupos estão escritos acima —
 * 12 opções, não 7. Um código por grupo era REGRESSÃO: o construtor escreve o
 * código literal, então esconder o 400 obrigaria a operadora do Simples a
 * declarar 102 (tributada) numa peça NÃO tributada.
 *
 * Código sem lugar na allowlist do servidor some da lista em vez de derrubar o
 * import; é o teste de sincronia que acusa a falta — nos dois sentidos.
 */
const TODAS_AS_OPCOES: readonly OpcaoIcmsDevolucao[] = (
  Object.keys(CODIGOS_ICMS_DEVOLUCAO) as TagIcmsDevolucao[]
).flatMap((tag) => {
  const sn = familiaDaTag(tag) === "SN";
  const tipo: TipoCodigoIcms = sn ? "CSOSN" : "CST";
  const aceitos = sn ? TAG_POR_CSOSN : TAG_POR_CST;
  // Só entra o código que o servidor de fato aceita para esta tag: rótulo escrito
  // para código fora da allowlist não vira opção (o teste acusa a divergência).
  return CODIGOS_ICMS_DEVOLUCAO[tag]
    .filter(({ codigo }) => aceitos[codigo] === tag)
    .map(({ codigo, rotulo }) => ({ codigo, tipo, tag, rotulo, exigeValores: TAGS_COM_VALORES.has(tag) }));
});

const OPCOES_CSOSN: readonly OpcaoIcmsDevolucao[] = TODAS_AS_OPCOES.filter((o) => o.tipo === "CSOSN");
const OPCOES_CST: readonly OpcaoIcmsDevolucao[] = TODAS_AS_OPCOES.filter((o) => o.tipo === "CST");

/**
 * Códigos de ICMS que um emitente com este CRT pode usar na devolução.
 * CRT nulo/desconhecido devolve os dois conjuntos — é EXATAMENTE o que
 * `tagIcmsParaDevolucao` aceita sem CRT, para a tela nunca recusar o que o
 * servidor aceitaria.
 */
export function opcoesIcmsDevolucao(crt: CrtEmitente | string | null | undefined): OpcaoIcmsDevolucao[] {
  const familia = familiaDoCrt(crt);
  if (familia === "SN") return OPCOES_CSOSN.map((o) => ({ ...o }));
  if (familia === "NORMAL") return OPCOES_CST.map((o) => ({ ...o }));
  return TODAS_AS_OPCOES.map((o) => ({ ...o }));
}

function enumerar(codigos: readonly string[]): string {
  if (codigos.length === 0) return "";
  if (codigos.length === 1) return codigos[0];
  return `${codigos.slice(0, -1).join(", ")} ou ${codigos[codigos.length - 1]}`;
}

function tipoDoCrt(crt: CrtEmitente | string | null | undefined): TipoCodigoIcms | null {
  const f = familiaDoCrt(crt);
  return f === "SN" ? "CSOSN" : f === "NORMAL" ? "CST" : null;
}

/**
 * O bloco que o detalhe da devolução entrega à tela para ela recusar o código na
 * hora. O CRT sai de `crtDeRegime` — a MESMA conversão que a validação do
 * servidor usa, para a tela nunca discordar dela.
 */
export function regimeEmitenteDevolucao(regime: string | null | undefined): RegimeEmitenteDevolucao {
  const regimeTributario = typeof regime === "string" && regime.trim() ? regime : null;
  const crt = crtDeRegime(regimeTributario);
  const tipoCodigoIcms = tipoDoCrt(crt);
  const icmsOpcoes = opcoesIcmsDevolucao(crt);
  const codigos = enumerar(icmsOpcoes.map((o) => o.codigo));
  const ajuda =
    tipoCodigoIcms === "CSOSN"
      ? `Sua empresa é do Simples Nacional: aqui o código do ICMS é o CSOSN, de 3 dígitos (${codigos}).`
      : tipoCodigoIcms === "CST"
        ? `Sua empresa é do regime normal: aqui o código do ICMS é o CST, de 2 dígitos (${codigos}).`
        : "O regime tributário desta empresa não está cadastrado no Dexo, então o campo não tem como conferir o código. Confirme a tributação com o contador antes de emitir.";
  return { regimeTributario, crt, tipoCodigoIcms, icmsOpcoes, ajuda };
}

const NOME_DO_REGIME: Readonly<Record<"SN" | "NORMAL", string>> = {
  SN: "do Simples Nacional",
  NORMAL: "do regime normal",
};

/**
 * O código digitado serve para este emitente? Recusa com o motivo escrito, na
 * hora — sem esperar a rejeição 590/591 da SEFAZ.
 *
 * A leitura do que foi digitado é a MESMA do campo de hoje (3 dígitos = CSOSN,
 * 1 ou 2 = CST) e o veredito delega a `tagIcmsParaDevolucao`: a tela não fica
 * nem mais rígida nem mais frouxa que o servidor. Em `ok`, `codigo` volta
 * normalizado com os zeros à esquerda ("0" → "00") — é ele que deve ser salvo.
 *
 * ⚠️ A recusa NÃO enumera os códigos aceitos, de propósito. Enumerava quando
 * eram 3 por regime; com 12 códigos a frase vira parede de número ("…102, 103,
 * 300, 400, 500, 900, 00, 40, 41, 50, 60 ou 90"), e ela se repete em CADA item
 * recusado. O campo hoje é um SELETOR: a lista está logo abaixo da frase, com
 * cada número junto do que ele significa — que é o que dá para agir. A frase
 * fica com o que a lista NÃO diz: qual é o código que ela tem, de que regime ele
 * é, e como o código dela se chama. A enumeração completa continua existindo em
 * `regimeEmitenteDevolucao.ajuda`, que aparece UMA vez no topo e nunca mistura
 * os dois regimes.
 */
export function checarCodigoIcmsDevolucao(entrada: {
  crt: CrtEmitente | string | null | undefined;
  codigo: string | null | undefined;
}): ResultadoCodigoIcms {
  const bruto = (entrada.codigo ?? "").trim();
  if (!bruto) return { ok: false, codigo: "", causa: "VAZIO", motivo: "Informe o código do ICMS." };
  if (!/^\d{1,3}$/.test(bruto)) {
    return {
      ok: false,
      codigo: bruto,
      causa: "FORMATO",
      motivo: "O código do ICMS é só número: 2 dígitos (CST) ou 3 dígitos (CSOSN).",
    };
  }

  const tipo: TipoCodigoIcms = bruto.length === 3 ? "CSOSN" : "CST";
  const codigo = tipo === "CST" ? bruto.padStart(2, "0") : bruto;
  const tag = tagIcmsParaDevolucao({
    crt: entrada.crt,
    cst: tipo === "CST" ? codigo : null,
    csosn: tipo === "CSOSN" ? codigo : null,
  });
  if (tag) return { ok: true, codigo, tipo, tag };

  const conhecida = tipo === "CSOSN" ? TAG_POR_CSOSN[codigo] : TAG_POR_CST[codigo];
  const familiaEmitente = familiaDoCrt(entrada.crt);
  if (conhecida && familiaEmitente && familiaDaTag(conhecida) !== familiaEmitente) {
    const digitosDoSeu = familiaEmitente === "SN" ? "CSOSN, de 3 dígitos" : "CST, de 2 dígitos";
    const deQuem = tipo === "CSOSN" ? NOME_DO_REGIME.SN : NOME_DO_REGIME.NORMAL;
    return {
      ok: false,
      codigo,
      causa: "REGIME",
      motivo:
        `${codigo} é ${tipo}, de empresa ${deQuem}. A sua empresa é ${NOME_DO_REGIME[familiaEmitente]}, ` +
        `onde o código é o ${digitosDoSeu} — escolha um na lista.`,
    };
  }
  return {
    ok: false,
    codigo,
    causa: "NAO_SUPORTADO",
    motivo: `O Dexo não emite devolução com ${tipo} ${codigo}. Escolha na lista um dos códigos que ele emite.`,
  };
}

export const MENSAGEM_MOTIVO_REVISAO: Readonly<Record<MotivoRevisaoTributacao, string>> = {
  SEM_XML: "Nota original sem XML — confirme a tributação com o contador.",
  QUANTIDADE_ORIGINAL_DESCONHECIDA: "Quantidade original desconhecida — os valores não puderam ser proporcionalizados.",
  REGIME_DIVERGENTE: "O regime tributário do emitente difere do da nota original.",
  ICMS_AUSENTE: "A nota original não tem grupo de ICMS neste item.",
  ICMS_ORIGEM_AUSENTE: "A origem da mercadoria não consta no ICMS da nota original.",
  ICMS_GRUPO_NAO_SUPORTADO: "CST/CSOSN de ICMS da nota original não é suportado na devolução.",
  ICMS_ST_NAO_SUPORTADO: "ICMS-ST na nota original não é suportado na devolução.",
  ICMS_BASE_REDUZIDA: "Base de cálculo reduzida na nota original não é suportada na devolução.",
  ICMS_MODBC_NAO_SUPORTADO: "Modalidade de base de cálculo do ICMS diferente de 3 (valor da operação).",
  ICMS_VALORES_AUSENTES: "Base, alíquota ou valor do ICMS ausentes na nota original.",
  IPI_DESTACADO: "A nota original destacou IPI — confirme a devolução do IPI.",
  PIS_AUSENTE: "A nota original não tem grupo de PIS neste item.",
  PIS_NAO_SUPORTADO: "CST de PIS da nota original não é suportado na devolução.",
  PIS_VALORES_AUSENTES: "Base, alíquota ou valor do PIS ausentes na nota original.",
  COFINS_AUSENTE: "A nota original não tem grupo de COFINS neste item.",
  COFINS_NAO_SUPORTADO: "CST de COFINS da nota original não é suportado na devolução.",
  COFINS_VALORES_AUSENTES: "Base, alíquota ou valor da COFINS ausentes na nota original.",
  PIS_CST_SAIDA_EM_ENTRADA: "CST de PIS/COFINS de saída (01 a 09) numa nota de entrada.",
  ALTERADA_PELO_USUARIO: "Tributação alterada manualmente.",
};

// ───────────────────────────── proporcionalização ─────────────────────────────

export interface ProporcionalizarInput {
  impostoOriginal: ImpostoOriginal | null;
  /** qCom da original; null = desconhecida. */
  qOriginal: number | string | null;
  qDevolvida: number | string;
  /** vUnCom da original (base só quando a proporção é desconhecida). */
  vUnCom: number;
  /** CRT do emitente da DEVOLUÇÃO (config atual). */
  crtEmitente?: CrtEmitente | string | null;
  /** CRT do emitente da ORIGINAL (emit/CRT do XML). */
  crtOriginal?: CrtEmitente | string | null;
  /** Default ENTRADA (VENDA_ENTRADA). */
  tipoOperacao?: "ENTRADA" | "SAIDA";
}

function tributacaoVazia(fonte: TributacaoDevolucaoItem["fonte"]): TributacaoDevolucaoItem {
  return {
    versao: 1,
    fonte,
    icms: { tag: null, cst: null, csosn: null, orig: null, modBC: null, vBC: 0, pICMS: 0, vICMS: 0 },
    pis: { cst: null, vBC: 0, p: 0, v: 0 },
    cofins: { cst: null, vBC: 0, p: 0, v: 0 },
    ipiDevol: null,
    requerRevisao: false,
    motivosRevisao: [],
    avisos: [],
    confirmada: false,
  };
}

export function proporcionalizar(input: ProporcionalizarInput): TributacaoDevolucaoItem {
  const imp = input.impostoOriginal;
  if (!imp) {
    const t = tributacaoVazia("SEM_XML");
    t.requerRevisao = true;
    t.motivosRevisao = ["SEM_XML"];
    return t;
  }

  const motivos = new Set<MotivoRevisaoTributacao>();
  const avisos = new Set<AvisoTributacao>();
  const tipoOperacao = input.tipoOperacao ?? "ENTRADA";

  const qOrigU =
    input.qOriginal === null || input.qOriginal === undefined
      ? null
      : quantidadeParaUnidades(input.qOriginal);
  const qDevU = quantidadeParaUnidades(input.qDevolvida) ?? 0;
  const proporcaoConhecida = qOrigU !== null && qOrigU > 0;
  if (!proporcaoConhecida) motivos.add("QUANTIDADE_ORIGINAL_DESCONHECIDA");

  const prop = (v: number | undefined): number => {
    const x = v ?? 0;
    if (!proporcaoConhecida) return 0;
    return qDevU === qOrigU ? round2(x) : round2((x * qDevU) / (qOrigU as number));
  };
  const vUn = Number.isFinite(input.vUnCom) ? input.vUnCom : 0;
  const baseItem = round2((vUn * qDevU) / ESCALA_QUANTIDADE);

  const t = tributacaoVazia("XML_ORIGINAL");

  // ── ICMS ──
  const o = imp.icms;
  if (!o) {
    motivos.add("ICMS_AUSENTE");
  } else {
    const tag = tagIcmsParaDevolucao({ crt: input.crtOriginal ?? null, cst: o.cst, csosn: o.csosn });
    t.icms.tag = tag;
    t.icms.cst = o.cst ?? null;
    t.icms.csosn = o.csosn ?? null;
    t.icms.orig = o.orig;
    if (o.orig === null) motivos.add("ICMS_ORIGEM_AUSENTE");
    if (!tag) motivos.add("ICMS_GRUPO_NAO_SUPORTADO");
    if ((o.vBCST ?? 0) > 0 || (o.vICMSST ?? 0) > 0) motivos.add("ICMS_ST_NAO_SUPORTADO");
    if ((o.pRedBC ?? 0) > 0) motivos.add("ICMS_BASE_REDUZIDA");

    if (tag && TAGS_COM_VALORES.has(tag)) {
      const temAlgum =
        o.modBC !== undefined || o.vBC !== undefined || o.pICMS !== undefined || o.vICMS !== undefined;
      const temTodos =
        o.modBC !== undefined && o.vBC !== undefined && o.pICMS !== undefined && o.vICMS !== undefined;
      // ICMS00 exige os valores; ICMS90/ICMSSN900 podem vir sem nenhum (zeros).
      if (tag === "ICMS00" ? !temTodos : temAlgum && !temTodos) motivos.add("ICMS_VALORES_AUSENTES");
      if (o.modBC !== undefined && o.modBC !== "3") motivos.add("ICMS_MODBC_NAO_SUPORTADO");
      if (temTodos) {
        t.icms.modBC = o.modBC as string;
        t.icms.pICMS = o.pICMS as number;
        if (proporcaoConhecida) {
          t.icms.vBC = prop(o.vBC);
          t.icms.vICMS = prop(o.vICMS);
        } else {
          t.icms.vBC = baseItem;
          t.icms.vICMS = round2((baseItem * (o.pICMS as number)) / 100);
        }
      }
    }

    const famOriginal = tag ? familiaDaTag(tag) : o.csosn ? "SN" : o.cst ? "NORMAL" : null;
    const famEmitente = familiaDoCrt(input.crtEmitente);
    const crtO = normalizarCrt(input.crtOriginal);
    const crtE = normalizarCrt(input.crtEmitente);
    if ((famOriginal && famEmitente && famOriginal !== famEmitente) || (crtO && crtE && crtO !== crtE)) {
      motivos.add("REGIME_DIVERGENTE");
    }
  }

  // ── PIS / COFINS ──
  const derivar = (
    grupo: PisOriginal | CofinsOriginal | null,
    p: number | undefined,
    v: number | undefined,
    m: { ausente: MotivoRevisaoTributacao; naoSuportado: MotivoRevisaoTributacao; valores: MotivoRevisaoTributacao },
  ): TributoPisCofinsDevolucao => {
    if (!grupo) {
      motivos.add(m.ausente);
      return { cst: null, vBC: 0, p: 0, v: 0 };
    }
    const cst = grupo.cst || null;
    if (!cst || !PIS_COFINS_CST_SUPORTADOS.has(cst) || grupo.qBCProd !== undefined || grupo.vAliqProd !== undefined) {
      motivos.add(m.naoSuportado);
      return { cst, vBC: 0, p: 0, v: 0 };
    }
    if (tipoOperacao === "ENTRADA" && /^0[1-9]$/.test(cst)) {
      avisos.add("PIS_CST_SAIDA_EM_ENTRADA");
      motivos.add("PIS_CST_SAIDA_EM_ENTRADA");
    }
    if (PIS_COFINS_SEM_VALORES.has(cst)) return { cst, vBC: 0, p: 0, v: 0 };
    if (grupo.vBC === undefined || p === undefined || v === undefined) {
      motivos.add(m.valores);
      return { cst, vBC: 0, p: 0, v: 0 };
    }
    if (!proporcaoConhecida) return { cst, vBC: baseItem, p, v: round2((baseItem * p) / 100) };
    return { cst, vBC: prop(grupo.vBC), p, v: prop(v) };
  };
  t.pis = derivar(imp.pis, imp.pis?.pPIS, imp.pis?.vPIS, {
    ausente: "PIS_AUSENTE",
    naoSuportado: "PIS_NAO_SUPORTADO",
    valores: "PIS_VALORES_AUSENTES",
  });
  t.cofins = derivar(imp.cofins, imp.cofins?.pCOFINS, imp.cofins?.vCOFINS, {
    ausente: "COFINS_AUSENTE",
    naoSuportado: "COFINS_NAO_SUPORTADO",
    valores: "COFINS_VALORES_AUSENTES",
  });

  // ── IPI destacado ⇒ impostoDevol (só após confirmação) ──
  if (imp.ipi && (imp.ipi.vIPI ?? 0) > 0) {
    motivos.add("IPI_DESTACADO");
    if (proporcaoConhecida) {
      t.ipiDevol = {
        pDevol: round2((qDevU * 100) / (qOrigU as number)),
        vIPIDevol: prop(imp.ipi.vIPI),
      };
    }
  }

  if (imp.temIbsCbs) avisos.add("IBS_CBS_NAO_ENVIADO");

  t.motivosRevisao = Array.from(motivos);
  t.avisos = Array.from(avisos);
  t.requerRevisao = t.motivosRevisao.length > 0;
  return t;
}

// ───────────────────────────── ajuste do usuário ─────────────────────────────

export interface AplicarOverrideInput {
  base: TributacaoDevolucaoItem;
  override?: TributacaoOverride | null;
  /** confirmarTributacao do corpo da requisição. */
  confirmar?: boolean | null;
  /** CRT do emitente da devolução — a tag nova precisa ser da família dele. */
  crtEmitente: CrtEmitente | string | null;
  /** vProd − desconto da linha: base quando o grupo novo exige valores e a atual é 0. */
  baseCalculoItem: number;
  tipoOperacao?: "ENTRADA" | "SAIDA";
}

export type ResultadoOverride =
  | { ok: true; tributacao: TributacaoDevolucaoItem }
  | { ok: false; erros: string[] };

const aliquotaValida = (p: unknown): p is number =>
  typeof p === "number" && Number.isFinite(p) && p >= 0 && p <= 100;

function temAjuste(ov: TributacaoOverride | null | undefined): ov is TributacaoOverride {
  return !!ov && (ov.icms !== undefined || ov.pis !== undefined || ov.cofins !== undefined || ov.ipiDevol === false);
}

/**
 * Aplica o ajuste explícito do usuário e/ou a confirmação.
 * - Sem ajuste: só grava `confirmada = confirmar === true`.
 * - Com ajuste: valida allowlist e alíquota (0..100), recalcula o valor só do
 *   tributo alterado, marca `fonte USUARIO` e mantém `requerRevisao` (ajuste
 *   manual sempre exige a confirmação no mesmo pedido).
 */
export function aplicarOverrideTributacao(input: AplicarOverrideInput): ResultadoOverride {
  const base = input.base;
  const t = JSON.parse(JSON.stringify(base)) as TributacaoDevolucaoItem;
  const ov = input.override;
  const erros: string[] = [];
  const baseItem = round2(Number.isFinite(input.baseCalculoItem) ? input.baseCalculoItem : 0);

  if (temAjuste(ov)) {
    if (ov.icms) {
      const cst = ov.icms.cst ?? (ov.icms.csosn ? null : t.icms.cst);
      const csosn = ov.icms.csosn ?? (ov.icms.cst ? null : t.icms.csosn);
      const tag = tagIcmsParaDevolucao({ crt: input.crtEmitente, cst, csosn });
      if (!tag) {
        erros.push("ICMS: CST/CSOSN fora da lista suportada na devolução para o regime do emitente.");
      } else {
        const sn = familiaDaTag(tag) === "SN";
        t.icms.tag = tag;
        t.icms.cst = sn ? null : cst;
        t.icms.csosn = sn ? csosn : null;
        if (!TAGS_COM_VALORES.has(tag)) {
          t.icms.modBC = null;
          t.icms.vBC = 0;
          t.icms.pICMS = 0;
          t.icms.vICMS = 0;
        } else {
          const modBC = ov.icms.modBC ?? t.icms.modBC ?? "3";
          const p = ov.icms.pICMS ?? t.icms.pICMS;
          if (modBC !== "3") erros.push("ICMS: só a modalidade de base 3 (valor da operação) é suportada.");
          if (!aliquotaValida(p)) {
            erros.push("ICMS: a alíquota deve estar entre 0 e 100.");
          } else if (tag !== base.icms.tag || p !== base.icms.pICMS) {
            t.icms.modBC = "3";
            t.icms.pICMS = p;
            t.icms.vBC = p > 0 ? (t.icms.vBC > 0 ? t.icms.vBC : baseItem) : 0;
            t.icms.vICMS = round2((t.icms.vBC * p) / 100);
          }
        }
      }
    }

    for (const qual of ["pis", "cofins"] as const) {
      const o = ov[qual];
      if (!o) continue;
      const rotulo = qual === "pis" ? "PIS" : "COFINS";
      const cst = o.cst ?? t[qual].cst;
      if (!cst || !PIS_COFINS_CST_SUPORTADOS.has(cst)) {
        erros.push(`${rotulo}: CST fora da lista suportada na devolução.`);
        continue;
      }
      if (PIS_COFINS_SEM_VALORES.has(cst)) {
        t[qual] = { cst, vBC: 0, p: 0, v: 0 };
        continue;
      }
      const p = o.p ?? t[qual].p;
      if (!aliquotaValida(p)) {
        erros.push(`${rotulo}: a alíquota deve estar entre 0 e 100.`);
        continue;
      }
      if (cst === base[qual].cst && p === base[qual].p) continue;
      const vBC = p > 0 ? (t[qual].vBC > 0 ? t[qual].vBC : baseItem) : 0;
      t[qual] = { cst, vBC, p, v: round2((vBC * p) / 100) };
    }

    if (ov.ipiDevol === false) t.ipiDevol = null;

    if (erros.length > 0) return { ok: false, erros };

    t.fonte = "USUARIO";
    if (!t.motivosRevisao.includes("ALTERADA_PELO_USUARIO")) t.motivosRevisao.push("ALTERADA_PELO_USUARIO");
    t.requerRevisao = true;
    if ((input.tipoOperacao ?? "ENTRADA") === "ENTRADA") {
      const saida = [t.pis.cst, t.cofins.cst].some((c) => !!c && /^0[1-9]$/.test(c));
      t.avisos = t.avisos.filter((a) => a !== "PIS_CST_SAIDA_EM_ENTRADA");
      if (saida) t.avisos.push("PIS_CST_SAIDA_EM_ENTRADA");
    }
  }

  t.confirmada = input.confirmar === true;
  return { ok: true, tributacao: t };
}
