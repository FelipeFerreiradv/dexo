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
  CausaRecusaPisCofins,
  CofinsOriginal,
  CrtEmitente,
  CstPisCofinsDevolucao,
  IcmsOriginal,
  ImpostoOriginal,
  IpiOriginal,
  MotivoRevisaoTributacao,
  OpcaoIcmsDevolucao,
  OpcaoPisCofinsDevolucao,
  PisOriginal,
  ReferenciaImpostoOriginal,
  RegimeEmitenteDevolucao,
  ResultadoCodigoIcms,
  ResultadoCstPisCofins,
  SentidoCstPisCofins,
  TagIcmsDevolucao,
  TipoCodigoIcms,
  TipoDevolucao,
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

/**
 * Família do regime para o PIS/COFINS — NÃO é a do ICMS: o CRT 2 (Simples acima
 * do sublimite) usa CST no ICMS, mas continua recolhendo PIS/COFINS na guia do
 * Simples (DAS). Só o CRT 3 apura PIS/COFINS com alíquota na nota.
 */
export function familiaPisCofinsDoCrt(crt: unknown): "SN" | "NORMAL" | null {
  const c = normalizarCrt(crt);
  if (c === null) return null;
  return c === "3" ? "NORMAL" : "SN";
}

/** Família do ICMS de quem emitiu a ORIGINAL: pelo CRT, ou — sem ele — pelo tipo de código do grupo. */
export function familiaIcmsDaOriginal(
  crtOriginal: unknown,
  icms: Pick<IcmsOriginal, "cst" | "csosn"> | null | undefined,
): "SN" | "NORMAL" | null {
  const pelo = familiaDoCrt(crtOriginal);
  if (pelo) return pelo;
  if (icms?.csosn) return "SN";
  if (icms?.cst) return "NORMAL";
  return null;
}

/**
 * Regime da CompanyFiscalConfig → CRT.
 *
 * ⚠️ Igual a `crtFromRegime` do montador SEFAZ SÓ nos três regimes que o cadastro
 * aceita. Fora deles este devolve `null` e o montador carimba CRT 3 — com um
 * CSOSN escolhido, isso é a Rejeição 590. Por isso `validarDevolucao` recusa
 * emitir com CRT nulo (`REGIME_NAO_CADASTRADO`) em vez de deixar o montador chutar.
 */
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
    // O resto do ICMS-ST (N-icms-residual-1): sem modBCST/pICMSST o subgrupo ST
    // do ICMSSN900/ICMS90 não se monta, e não se inventa (vICMSST/vBCST ≠ alíquota).
    const modBCST = texto(g.modBCST);
    if (modBCST !== undefined) icms.modBCST = modBCST;
    atribuirNumeros(icms, g, ["pMVAST", "pRedBCST", "pICMSST", "vFCPST", "vBCSTRet", "pST", "vICMSSubstituto", "vICMSSTRet"]);
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
 *
 * `tipo` (opcional, retrocompatível) ordena o PIS/COFINS pelo sentido da nota:
 * na devolução de venda (entrada) os CSTs de entrada vêm primeiro; na de compra
 * (saída), os de saída. Sem `tipo`, a lista sai em ordem numérica.
 */
export function regimeEmitenteDevolucao(
  regime: string | null | undefined,
  tipo?: TipoDevolucao | null,
): RegimeEmitenteDevolucao {
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
  const tipoDevolucao = tipo === "VENDA_ENTRADA" || tipo === "COMPRA_SAIDA" ? tipo : null;
  return {
    regimeTributario,
    crt,
    tipoCodigoIcms,
    icmsOpcoes,
    ajuda,
    tipoDevolucao,
    pisCofinsOpcoes: opcoesPisCofinsDevolucao({ crt, tipo: tipoDevolucao }),
    pisCofinsAjuda: ajudaPisCofins(crt, tipoDevolucao),
  };
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

  // Código que EXISTE na tabela oficial mas o construtor não emite em regime
  // nenhum (CST 10 da DISAUTO, com ST). A causa segue NAO_SUPORTADO — o Dexo não
  // o emite nem no regime dele —, mas a frase diz o que ele é: "não emite CST 10",
  // sozinha, deixava a dona do Simples sem saber que 10 é código do regime normal.
  const fora = tipo === "CSOSN" ? CSOSN_SN_FORA_DA_DEVOLUCAO[codigo] : CST_NORMAL_FORA_DA_DEVOLUCAO[codigo];
  if (fora && familiaEmitente) {
    const familiaDoCodigo: "SN" | "NORMAL" = tipo === "CSOSN" ? "SN" : "NORMAL";
    if (familiaDoCodigo !== familiaEmitente) {
      const digitosDoSeu = familiaEmitente === "SN" ? "CSOSN, de 3 dígitos" : "CST, de 2 dígitos";
      return {
        ok: false,
        codigo,
        causa: "NAO_SUPORTADO",
        motivo:
          `O ${tipo} ${codigo} é de empresa ${NOME_DO_REGIME[familiaDoCodigo]} (${fora.texto}). ` +
          `A sua empresa é ${NOME_DO_REGIME[familiaEmitente]}, onde o código é o ${digitosDoSeu}. ` +
          "Escolha na lista um dos códigos que o Dexo emite.",
      };
    }
    return {
      ok: false,
      codigo,
      causa: "NAO_SUPORTADO",
      motivo:
        `O Dexo não emite devolução com ${tipo} ${codigo} (${fora.texto})` +
        (fora.st ? ": ele ainda não devolve ICMS-ST" : "") +
        ". Escolha na lista um dos códigos que ele emite.",
    };
  }
  return {
    ok: false,
    codigo,
    causa: "NAO_SUPORTADO",
    motivo: `O Dexo não emite devolução com ${tipo} ${codigo}. Escolha na lista um dos códigos que ele emite.`,
  };
}

/**
 * CST/CSOSN da tabela oficial que o construtor NÃO emite na devolução, com o que
 * cada um significa. Servem só para a frase da recusa — a allowlist continua
 * sendo `TAG_POR_CSOSN`/`TAG_POR_CST`.
 */
const CST_NORMAL_FORA_DA_DEVOLUCAO: Readonly<Record<string, { texto: string; st: boolean }>> = {
  "10": { texto: "tributada, com ICMS-ST", st: true },
  "20": { texto: "com redução da base de cálculo", st: false },
  "30": { texto: "isenta ou não tributada, com ICMS-ST", st: true },
  "51": { texto: "com diferimento", st: false },
  "70": { texto: "com redução da base de cálculo e ICMS-ST", st: true },
};

const CSOSN_SN_FORA_DA_DEVOLUCAO: Readonly<Record<string, { texto: string; st: boolean }>> = {
  "101": { texto: "tributada com permissão de crédito", st: false },
  "201": { texto: "com permissão de crédito e ICMS-ST", st: true },
  "202": { texto: "sem permissão de crédito e com ICMS-ST", st: true },
  "203": { texto: "isenta pela faixa de receita, com ICMS-ST", st: true },
};

// ───────────── PIS/COFINS: o que a TELA pode oferecer e o juiz do código ─────────────

/**
 * Rótulo de CADA CST de PIS/COFINS aceito na devolução — para a dona do
 * desmanche, não para a contadora: o número primeiro, o que ele quer dizer depois.
 *
 * O `Record` é EXAUSTIVO sobre `CstPisCofinsDevolucao`: código novo sem rótulo
 * quebra o `tsc`. A sincronia com `PIS_COFINS_CST_SUPORTADOS` (o que o servidor
 * aceita) é presa pela suíte nos DOIS sentidos — rótulo órfão ou código aceito
 * sem rótulo quebra lá.
 */
export const ROTULOS_PIS_COFINS_DEVOLUCAO: Readonly<Record<CstPisCofinsDevolucao, string>> = {
  "01": "01 — Tributada com a alíquota básica (regime normal: 1,65% e 7,6%, ou 0,65% e 3%)",
  "02": "02 — Tributada com alíquota diferenciada (regime normal)",
  "04": "04 — Monofásica: o PIS/COFINS já foi pago antes, na fábrica ou no importador (comum em autopeça); a revenda sai sem valor",
  "06": "06 — Alíquota zero",
  "07": "07 — Isenta do PIS/COFINS",
  "08": "08 — Sem incidência do PIS/COFINS",
  "09": "09 — Com suspensão do PIS/COFINS",
  "49": "49 — Outras operações de saída (no Simples, é o código das vendas, com PIS/COFINS zerado)",
  "50": "50 — Entrada com direito a crédito, ligada só a receita tributada no mercado interno",
  "51": "51 — Entrada com direito a crédito, ligada só a receita não tributada no mercado interno",
  "52": "52 — Entrada com direito a crédito, ligada só a receita de exportação",
  "53": "53 — Entrada com direito a crédito, ligada a receitas tributadas e não tributadas no mercado interno",
  "54": "54 — Entrada com direito a crédito, ligada a receitas tributadas no mercado interno e de exportação",
  "55": "55 — Entrada com direito a crédito, ligada a receitas não tributadas no mercado interno e de exportação",
  "56": "56 — Entrada com direito a crédito, ligada a receitas tributadas, não tributadas e de exportação",
  "60": "60 — Crédito presumido, ligado só a receita tributada no mercado interno",
  "61": "61 — Crédito presumido, ligado só a receita não tributada no mercado interno",
  "62": "62 — Crédito presumido, ligado só a receita de exportação",
  "63": "63 — Crédito presumido, ligado a receitas tributadas e não tributadas no mercado interno",
  "64": "64 — Crédito presumido, ligado a receitas tributadas no mercado interno e de exportação",
  "65": "65 — Crédito presumido, ligado a receitas não tributadas no mercado interno e de exportação",
  "66": "66 — Crédito presumido, ligado a receitas tributadas, não tributadas e de exportação",
  "67": "67 — Crédito presumido em outras operações",
  "70": "70 — Entrada sem direito a crédito",
  "71": "71 — Entrada com isenção",
  "72": "72 — Entrada com suspensão",
  "73": "73 — Entrada com alíquota zero",
  "74": "74 — Entrada sem incidência",
  "75": "75 — Entrada por substituição tributária",
  "98": "98 — Outras entradas",
  "99": "99 — Outras operações (serve para entrada e para saída)",
};

/** CST de PIS/COFINS que só existe com alíquota do regime normal (PISAliq): recusado no Simples. */
const PIS_COFINS_SO_REGIME_NORMAL: ReadonlySet<string> = new Set(["01", "02"]);

/**
 * CSTs de CRÉDITO de PIS/COFINS (tabela oficial): 50–56 "operação com direito a
 * crédito" e 60–67 "crédito presumido". Só quem apura PIS/COFINS no regime
 * normal toma crédito — a empresa do Simples recolhe na guia do Simples e não
 * credita. Recusados no Simples no MESMO molde do 01/02 (decisão 2 do dono):
 * fora das opções e recusados pelo juiz, na tela e no servidor.
 */
export const PIS_COFINS_CREDITO: ReadonlySet<string> = new Set([
  "50", "51", "52", "53", "54", "55", "56",
  "60", "61", "62", "63", "64", "65", "66", "67",
]);

/** CST de PIS/COFINS que uma empresa do Simples (CRT 1/2/4) não pode usar. */
function soDoRegimeNormal(cst: string): boolean {
  return PIS_COFINS_SO_REGIME_NORMAL.has(cst) || PIS_COFINS_CREDITO.has(cst);
}

/** Tabela oficial: 01–49 são de saída, 50–98 de entrada, 99 serve aos dois. null = fora da tabela. */
export function sentidoCstPisCofins(cst: string | null | undefined): SentidoCstPisCofins | null {
  if (typeof cst !== "string" || !/^\d{2}$/.test(cst)) return null;
  const n = Number(cst);
  if (n === 99) return "AMBOS";
  if (n >= 1 && n <= 49) return "SAIDA";
  if (n >= 50 && n <= 98) return "ENTRADA";
  return null;
}

/**
 * Os códigos que o regime usa no dia a dia, por sentido da nota — vão no topo do
 * seletor, NESTA ordem. No Simples o 04 (monofásico, comum em autopeça) fica
 * junto do 49 e do 99, não depois deles.
 */
const USUAIS_PIS_COFINS: Readonly<Record<"SN" | "NORMAL", Readonly<Record<"ENTRADA" | "SAIDA", readonly string[]>>>> = {
  SN: {
    SAIDA: ["49", "04", "99", "06", "07", "08", "09"],
    ENTRADA: ["98", "99", "70", "71", "72", "73", "74", "75"],
  },
  NORMAL: {
    SAIDA: ["01", "02", "04", "06", "07", "08", "09", "49", "99"],
    ENTRADA: [
      "50", "51", "52", "53", "54", "55", "56",
      "60", "61", "62", "63", "64", "65", "66", "67",
      "70", "71", "72", "73", "74", "75", "98", "99",
    ],
  },
};

function sentidoDaNota(tipo: TipoDevolucao | "ENTRADA" | "SAIDA" | null | undefined): "ENTRADA" | "SAIDA" | null {
  if (tipo === "VENDA_ENTRADA" || tipo === "ENTRADA") return "ENTRADA";
  if (tipo === "COMPRA_SAIDA" || tipo === "SAIDA") return "SAIDA";
  return null;
}

/**
 * CSTs de PIS/COFINS que ESTE emitente pode usar na devolução — exatamente os
 * que `checarCstPisCofinsDevolucao` aceita para ele (sem alíquota informada),
 * nunca um a mais nem um a menos.
 *
 * O que TIRA da lista (decisões 2 e 3 do dono):
 *  - no Simples (CRT 1/2/4), o 01/02 e os de crédito (50–56, 60–67);
 *  - numa nota de SAÍDA (devolução de compra), os de entrada (50–98). Nenhuma
 *    nota de fornecedor traz CST de entrada: não há herança a proteger. O 99
 *    serve aos dois sentidos e fica.
 *
 * O que só ORDENA: numa nota de ENTRADA (devolução de venda) os de saída
 * continuam na lista — o 49 que a DLS herda das próprias vendas; escondê-lo
 * deixaria o seletor sem o código gravado em toda devolução de venda do
 * Simples. Vêm por último, marcados `doSentidoDaNota: false`, e o juiz avisa
 * (sem recusar) — a validação do servidor avisa igual (decisão 4).
 */
export function opcoesPisCofinsDevolucao(entrada: {
  crt: CrtEmitente | string | null | undefined;
  tipo?: TipoDevolucao | "ENTRADA" | "SAIDA" | null;
}): OpcaoPisCofinsDevolucao[] {
  const familia = familiaPisCofinsDoCrt(entrada.crt);
  const sentido = sentidoDaNota(entrada.tipo);
  const usuais = familia && sentido ? USUAIS_PIS_COFINS[familia][sentido] : [];
  const aceitos = (Object.keys(ROTULOS_PIS_COFINS_DEVOLUCAO) as CstPisCofinsDevolucao[])
    .filter((c) => PIS_COFINS_CST_SUPORTADOS.has(c))
    .filter((c) => !(familia === "SN" && soDoRegimeNormal(c)))
    .filter((c) => !(sentido === "SAIDA" && sentidoCstPisCofins(c) === "ENTRADA"))
    .sort();
  const opcoes = aceitos.map((codigo): OpcaoPisCofinsDevolucao => {
    const s = sentidoCstPisCofins(codigo) as SentidoCstPisCofins;
    return {
      codigo,
      rotulo: ROTULOS_PIS_COFINS_DEVOLUCAO[codigo],
      sentido: s,
      exigeAliquota: !PIS_COFINS_SEM_VALORES.has(codigo),
      doSentidoDaNota: sentido === null || s === "AMBOS" || s === sentido,
      usual: usuais.includes(codigo),
    };
  });
  const peso = (o: OpcaoPisCofinsDevolucao) =>
    o.usual ? usuais.indexOf(o.codigo) : o.doSentidoDaNota ? 1000 : 2000;
  // sort estável: dentro do mesmo peso, a ordem numérica de `aceitos`.
  return opcoes.sort((a, b) => peso(a) - peso(b));
}

function ajudaPisCofins(crt: CrtEmitente | null, tipo: TipoDevolucao | null): string {
  const familia = familiaPisCofinsDoCrt(crt);
  // Devolução de compra é nota de SAÍDA: os códigos de entrada saem da lista.
  const saida =
    tipo === "COMPRA_SAIDA"
      ? " Esta devolução é uma nota de saída, então os códigos de entrada (50 a 98) não aparecem na lista; o 99 serve para os dois lados."
      : "";
  if (familia === "SN") {
    return (
      "Sua empresa é do Simples Nacional: o PIS/COFINS vai na guia do Simples, então a alíquota na nota fica 0 " +
      "e os códigos 01 e 02 (com alíquota do regime normal) e os de crédito (50 a 56 e 60 a 67) não servem aqui." +
      (tipo === "COMPRA_SAIDA"
        ? " A alíquota de PIS/COFINS da nota do fornecedor não passa para a sua nota."
        : "") +
      saida
    );
  }
  if (familia === "NORMAL") {
    return "Sua empresa é do regime normal: escolha o código do PIS/COFINS com a sua contadora e, nos códigos que levam alíquota, informe a alíquota." + saida;
  }
  return "O regime tributário desta empresa não está cadastrado no Dexo, então o campo não tem como conferir o código. Confirme a tributação com o contador antes de emitir." + saida;
}

/** A frase da recusa da alíquota no Simples — a mesma na tela, no ajuste e na validação. */
export const MOTIVO_ALIQUOTA_SIMPLES =
  "No Simples o PIS/COFINS vai na guia do Simples: a alíquota na nota fica 0.";

const MOTIVO_PIS_COFINS_NAO_SUPORTADO: Readonly<Record<string, string>> = {
  "03": "O CST 03 calcula o PIS/COFINS por quantidade, e o Dexo ainda não emite devolução assim.",
  "05": "O CST 05 é de substituição tributária do PIS/COFINS, e o Dexo ainda não emite devolução assim.",
};

/**
 * O CST de PIS/COFINS serve para este emitente, nesta devolução? O MESMO juiz
 * para a tela (recusa na hora) e para o servidor (`aplicarOverrideTributacao`),
 * como o `checarCodigoIcmsDevolucao` do ICMS.
 *
 * Recusa:
 *  - VAZIO, FORMATO, NAO_SUPORTADO (03, 05, fora da tabela);
 *  - REGIME: numa empresa do Simples (CRT 1/2/4), o 01/02 (é o que o próprio
 *    Dexo já faz nas notas comuns do Simples) e os de crédito 50–56/60–67
 *    (decisão 2 do dono: o Simples não toma crédito de PIS/COFINS);
 *  - SENTIDO: CST de entrada (50–98) numa nota de SAÍDA (devolução de compra) —
 *    decisão 3 do dono: nenhuma nota de fornecedor traz CST de entrada, então
 *    não há herança a proteger. O 99 serve aos dois sentidos;
 *  - ALIQUOTA, quando `p` vem: fora de 0–100; no Simples, maior que 0 (decisão
 *    2: o PIS/COFINS vai na guia do Simples — a SEFAZ autorizaria a nota com o
 *    valor destacado, e isso só se desfaz cancelando); 01/02 a zero (alíquota
 *    zero tem código próprio, o 06).
 *
 * Só AVISA (volta `ok` com `aviso`): CST de saída numa nota de ENTRADA — o 49
 * que o Simples herda das próprias vendas não pode virar bloqueio (decisão 4:
 * continua aviso, e a validação do servidor avisa igual).
 *
 * Em `ok`, `codigo` volta com o zero à esquerda ("1" → "01") — é ele que se salva.
 */
export function checarCstPisCofinsDevolucao(entrada: {
  crt: CrtEmitente | string | null | undefined;
  tipo?: TipoDevolucao | "ENTRADA" | "SAIDA" | null;
  codigo: string | null | undefined;
  /** Alíquota (%) que vai junto. Ausente/null = não conferir a alíquota. */
  p?: number | null;
}): ResultadoCstPisCofins {
  const bruto = (entrada.codigo ?? "").trim();
  if (!bruto) {
    return { ok: false, codigo: "", causa: "VAZIO", motivo: "Escolha o código (CST) do PIS/COFINS." };
  }
  if (!/^\d{1,2}$/.test(bruto)) {
    return { ok: false, codigo: bruto, causa: "FORMATO", motivo: "O código do PIS/COFINS é só número, de 2 dígitos." };
  }
  const codigo = bruto.padStart(2, "0");
  if (!PIS_COFINS_CST_SUPORTADOS.has(codigo)) {
    const porque = MOTIVO_PIS_COFINS_NAO_SUPORTADO[codigo] ?? `O Dexo não emite devolução com o CST ${codigo} de PIS/COFINS.`;
    return {
      ok: false,
      codigo,
      causa: "NAO_SUPORTADO",
      motivo: `${porque} Escolha na lista um dos códigos que ele emite.`,
    };
  }
  const simples = familiaPisCofinsDoCrt(entrada.crt) === "SN";
  if (simples && PIS_COFINS_SO_REGIME_NORMAL.has(codigo)) {
    return {
      ok: false,
      codigo,
      causa: "REGIME",
      motivo:
        `O CST ${codigo} é de empresa do regime normal, que paga PIS/COFINS com alíquota na nota. ` +
        "A sua empresa é do Simples Nacional, que recolhe o PIS/COFINS na guia do Simples — escolha um código da lista.",
    };
  }
  if (simples && PIS_COFINS_CREDITO.has(codigo)) {
    return {
      ok: false,
      codigo,
      causa: "REGIME",
      motivo:
        `O CST ${codigo} é de crédito de PIS/COFINS, que só a empresa do regime normal toma. ` +
        "A sua empresa é do Simples Nacional, que recolhe o PIS/COFINS na guia do Simples e não toma esse crédito — escolha um código da lista.",
    };
  }
  const sentido = sentidoCstPisCofins(codigo) as SentidoCstPisCofins;
  const daNota = sentidoDaNota(entrada.tipo);
  if (daNota === "SAIDA" && sentido === "ENTRADA") {
    return {
      ok: false,
      codigo,
      causa: "SENTIDO",
      motivo:
        `O CST ${codigo} é de entrada, e esta devolução de compra é uma nota de saída — os códigos de 50 a 98 não servem nela. ` +
        "Escolha na lista um código de saída (ou o 99, que serve para os dois lados).",
    };
  }
  const exigeAliquota = !PIS_COFINS_SEM_VALORES.has(codigo);
  const p = entrada.p;
  if (exigeAliquota && p !== undefined && p !== null) {
    if (!aliquotaValida(p)) {
      return { ok: false, codigo, causa: "ALIQUOTA", motivo: "A alíquota do PIS/COFINS vai de 0 a 100." };
    }
    if (simples && p > 0) {
      return { ok: false, codigo, causa: "ALIQUOTA", motivo: MOTIVO_ALIQUOTA_SIMPLES };
    }
    if (PIS_COFINS_SO_REGIME_NORMAL.has(codigo) && p === 0) {
      return {
        ok: false,
        codigo,
        causa: "ALIQUOTA",
        motivo: `Com o CST ${codigo} a alíquota não pode ser zero: para alíquota zero o código é o 06.`,
      };
    }
  }
  if (daNota === "ENTRADA" && sentido === "SAIDA") {
    return {
      ok: true,
      codigo,
      sentido,
      exigeAliquota,
      aviso: "PIS_CST_SAIDA_EM_ENTRADA",
      avisoTexto: `O CST ${codigo} é de saída, e esta devolução é uma nota de entrada. Não impede a emissão — confirme com a sua contadora.`,
    };
  }
  return { ok: true, codigo, sentido, exigeAliquota, aviso: null, avisoTexto: "" };
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
  /**
   * Desconto da linha na proporção devolvida (o mesmo do NfeItem). A base que
   * nasce do item (proporção desconhecida) é vProd − desconto, não o valor cheio.
   * Ausente = 0 (comportamento antigo).
   */
  descontoDevolvido?: number | null;
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
  const desconto =
    typeof input.descontoDevolvido === "number" && Number.isFinite(input.descontoDevolvido) && input.descontoDevolvido > 0
      ? input.descontoDevolvido
      : 0;
  const baseItem = Math.max(0, round2((vUn * qDevU) / ESCALA_QUANTIDADE - desconto));

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
  const famPisEmitente = familiaPisCofinsDoCrt(input.crtEmitente);
  const famPisOriginal = familiaPisCofinsDoCrt(input.crtOriginal);
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
      // Nasce SEM código: o 03/05 (ou o 99 por quantidade) não tem como ir ao
      // XML, e copiá-lo zerado deixava a caixinha "Revisei" liberar uma nota que
      // o montador trocaria em silêncio (ou a SEFAZ recusaria). O código original
      // continua em `impostoOriginal`; a escolha é dela (validarDevolucao bloqueia).
      return { cst: null, vBC: 0, p: 0, v: 0 };
    }
    if (tipoOperacao === "ENTRADA" && /^0[1-9]$/.test(cst)) {
      avisos.add("PIS_CST_SAIDA_EM_ENTRADA");
      motivos.add("PIS_CST_SAIDA_EM_ENTRADA");
    }
    if (PIS_COFINS_SEM_VALORES.has(cst)) return { cst, vBC: 0, p: 0, v: 0 };
    // Emitente do Simples NÃO herda alíquota nem base de PIS/COFINS de uma nota
    // de outra família de regime (nem do 01/02 ou de um código de crédito, que
    // são apuração do regime normal): era assim que 1,65%/7,6% da DISAUTO
    // chegavam à nota da DLS. Nem de uma nota do próprio Simples que veio com
    // alíquota: no Simples a alíquota na nota fica 0 (decisão 2 do dono). O
    // código fica (a tela mostra "este não serve" e validarDevolucao recusa);
    // os valores, não — e sem eles o override também não tem o que herdar.
    if (
      famPisEmitente === "SN" &&
      (famPisOriginal === "NORMAL" || soDoRegimeNormal(cst) || (typeof p === "number" && p > 0))
    ) {
      return { cst, vBC: 0, p: 0, v: 0 };
    }
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
  /**
   * Base do ICMS da nota ORIGINAL, já na proporção devolvida (opcional). Quando
   * o grupo novo leva valores e a base atual é 0 (original fora da lista, p.ex.
   * CST 20 com base reduzida), é ELA a base — não o valor cheio do item, que
   * destacaria mais ICMS do que o fornecedor debitou.
   */
  baseIcmsOriginal?: number | null;
  /**
   * O ajuste JÁ GRAVADO neste item (opcional; decisão 5 do dono) — no mesmo
   * formato do override: é o `saved` que o caso de uso já monta para
   * `mesclarAjusteTributacao` a partir da tributação gravada com fonte USUARIO.
   *
   * Tributo cujo valor enviado é IGUAL ao salvo não é ajuste novo: não é julgado
   * de novo (nem allowlist, nem regime, nem sentido, nem alíquota, nem modBC) e
   * é regravado como está — assim um 01 antigo gravado no PIS de uma empresa do
   * Simples não barra o salvamento da QUANTIDADE (rascunho 4a3698ee da DLS). Quem
   * barra a EMISSÃO por ele continua sendo `validarDevolucao`.
   *
   * Ausente ⇒ comportamento de antes (só "igual à base" deixa de ser julgado).
   */
  salvo?: TributacaoOverride | null;
}

/** Recusa estruturada do ajuste: o tributo, o código de pendência que a descreve e a frase. */
export interface RecusaOverride {
  tributo: "ICMS" | "PIS" | "COFINS";
  code:
    | "TRIBUTACAO_NAO_SUPORTADA"
    | "TRIBUTACAO_REGIME_INCOMPATIVEL"
    | "PIS_COFINS_NAO_SUPORTADO"
    | "PIS_COFINS_REGIME_INCOMPATIVEL"
    | "PIS_COFINS_ALIQUOTA_INVALIDA"
    /** Simples com alíquota de PIS/COFINS maior que 0 (decisão 2). */
    | "PIS_COFINS_ALIQUOTA_SIMPLES"
    /** CST de entrada (50–98) numa nota de saída (decisão 3). */
    | "PIS_CST_ENTRADA_EM_SAIDA";
  motivo: string;
}

export type ResultadoOverride =
  | { ok: true; tributacao: TributacaoDevolucaoItem }
  | {
      ok: false;
      /** "ICMS: …" / "PIS: …" / "COFINS: …" — a frase pronta, uma por recusa. */
      erros: string[];
      /** As mesmas recusas, com o tributo e o código de pendência (para o caso de uso virar issue). */
      recusas: RecusaOverride[];
    };

const CODIGO_RECUSA_PIS_COFINS: Readonly<Record<CausaRecusaPisCofins, RecusaOverride["code"]>> = {
  REGIME: "PIS_COFINS_REGIME_INCOMPATIVEL",
  ALIQUOTA: "PIS_COFINS_ALIQUOTA_INVALIDA",
  VAZIO: "PIS_COFINS_NAO_SUPORTADO",
  FORMATO: "PIS_COFINS_NAO_SUPORTADO",
  NAO_SUPORTADO: "PIS_COFINS_NAO_SUPORTADO",
  SENTIDO: "PIS_CST_ENTRADA_EM_SAIDA",
};

/**
 * O código de pendência de uma recusa do juiz de PIS/COFINS. A alíquota do
 * Simples tem código próprio (o texto da tela é outro: "fica 0", não "01/02 a
 * zero"), mas a CAUSA continua ALIQUOTA — é por ela que a caixa de alíquota da
 * tela mostra a recusa.
 */
function codigoRecusaPisCofins(
  causa: CausaRecusaPisCofins,
  crt: CrtEmitente | string | null,
  p: number | null | undefined,
): RecusaOverride["code"] {
  if (causa === "ALIQUOTA" && familiaPisCofinsDoCrt(crt) === "SN" && aliquotaValida(p) && p > 0) {
    return "PIS_COFINS_ALIQUOTA_SIMPLES";
  }
  return CODIGO_RECUSA_PIS_COFINS[causa];
}

/**
 * PIS/COFINS regravado SEM julgar (igual ao ajuste salvo): o código e a alíquota
 * como estão, com a base recalculada pela MESMA regra do ajuste.
 */
function pisCofinsComoEsta(
  atual: TributoPisCofinsDevolucao,
  cst: string | null,
  p: number,
  baseItem: number,
): TributoPisCofinsDevolucao {
  if (!cst || !PIS_COFINS_CST_SUPORTADOS.has(cst) || PIS_COFINS_SEM_VALORES.has(cst) || !aliquotaValida(p)) {
    return { cst, vBC: 0, p: 0, v: 0 };
  }
  const vBC = p > 0 ? (atual.vBC > 0 ? atual.vBC : baseItem) : 0;
  return { cst, vBC, p, v: round2((vBC * p) / 100) };
}

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
 * - PIS/COFINS passam pelo MESMO juiz da tela (`checarCstPisCofinsDevolucao`):
 *   01/02 e crédito no Simples, alíquota > 0 no Simples, entrada numa saída e
 *   01/02 a zero são recusados aqui também. O par (CST, alíquota) idêntico ao
 *   da base não é ajuste e não é julgado — é o reenvio do valor gravado, e
 *   quem barra a emissão é `validarDevolucao`.
 * - Idem para o valor idêntico ao AJUSTE SALVO (`salvo`, decisão 5): julga-se
 *   só o que ela mudou.
 * - modBC: só o que vem EXPLÍCITO no override (e diferente do salvo) é julgado.
 *   O modBC 0/1/2 herdado do XML original não trava mais a troca de grupo
 *   (N-icms-residual-4): o grupo novo sai com modBC 3.
 */
export function aplicarOverrideTributacao(input: AplicarOverrideInput): ResultadoOverride {
  const base = input.base;
  const t = JSON.parse(JSON.stringify(base)) as TributacaoDevolucaoItem;
  const ov = input.override;
  const erros: string[] = [];
  const recusas: RecusaOverride[] = [];
  const recusar = (tributo: RecusaOverride["tributo"], code: RecusaOverride["code"], motivo: string) => {
    erros.push(`${tributo}: ${motivo}`);
    recusas.push({ tributo, code, motivo });
  };
  const baseItem = round2(Number.isFinite(input.baseCalculoItem) ? input.baseCalculoItem : 0);
  const baseIcms =
    typeof input.baseIcmsOriginal === "number" && Number.isFinite(input.baseIcmsOriginal) && input.baseIcmsOriginal > 0
      ? round2(input.baseIcmsOriginal)
      : baseItem;

  if (temAjuste(ov)) {
    if (ov.icms) {
      const cst = ov.icms.cst ?? (ov.icms.csosn ? null : t.icms.cst);
      const csosn = ov.icms.csosn ?? (ov.icms.cst ? null : t.icms.csosn);
      // O MESMO ICMS da base não é ajuste: desde que o caso de uso mescla por
      // tributo, ele reenvia o ICMS gravado a cada save — e o da base pode ser o
      // do fornecedor (00 numa empresa do Simples). Recusar aqui derrubava o
      // salvamento do PIS; quem barra a emissão por ele é `validarDevolucao`.
      const pEnviado = ov.icms.pICMS ?? t.icms.pICMS;
      const modBCEnviado = ov.icms.modBC ?? t.icms.modBC;
      const igualABase =
        cst === base.icms.cst &&
        csosn === base.icms.csosn &&
        pEnviado === base.icms.pICMS &&
        modBCEnviado === base.icms.modBC;
      // Decisão 5: o MESMO ICMS do ajuste já gravado não é ajuste novo — não se
      // julga de novo (uma troca de regime da empresa, p.ex., não pode barrar o
      // salvamento da quantidade). A família sai do próprio código, e quem barra
      // a emissão por ele é `validarDevolucao` (TRIBUTACAO_NAO_SUPORTADA/_REGIME_INCOMPATIVEL).
      const s = input.salvo?.icms;
      const igualAoSalvo =
        !!s &&
        cst === (s.cst ?? null) &&
        csosn === (s.csosn ?? null) &&
        pEnviado === (s.pICMS ?? t.icms.pICMS) &&
        modBCEnviado === (s.modBC ?? t.icms.modBC);
      const tagEmitente = igualABase ? null : tagIcmsParaDevolucao({ crt: input.crtEmitente, cst, csosn });
      const tag = tagEmitente ?? (igualAoSalvo ? tagIcmsParaDevolucao({ cst, csosn }) : null);
      if (igualABase) {
        // nada a fazer: t.icms já é o da base
      } else if (!tag && igualAoSalvo) {
        // Salvo com um código que nem existe na lista: guarda como está, sem grupo.
        t.icms.tag = null;
        t.icms.cst = cst;
        t.icms.csosn = csosn;
        t.icms.modBC = null;
        t.icms.vBC = 0;
        t.icms.pICMS = 0;
        t.icms.vICMS = 0;
      } else if (!tag) {
        const veredito = checarCodigoIcmsDevolucao({ crt: input.crtEmitente, codigo: csosn ?? cst });
        erros.push("ICMS: CST/CSOSN fora da lista suportada na devolução para o regime do emitente.");
        recusas.push({
          tributo: "ICMS",
          code: !veredito.ok && veredito.causa === "REGIME" ? "TRIBUTACAO_REGIME_INCOMPATIVEL" : "TRIBUTACAO_NAO_SUPORTADA",
          motivo: veredito.ok ? "CST/CSOSN fora da lista suportada na devolução." : veredito.motivo,
        });
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
          // Só o modBC que ELA mandou é julgado: explícito no override e diferente
          // do salvo. O herdado do XML (0/1/2 da nota original) não trava a troca
          // de grupo — o grupo novo sai com modBC 3 (N-icms-residual-4).
          const modBCExplicito =
            ov.icms.modBC !== undefined && ov.icms.modBC !== null && !(s && ov.icms.modBC === (s.modBC ?? null));
          const p = pEnviado;
          if (modBCExplicito && ov.icms.modBC !== "3") {
            recusar("ICMS", "TRIBUTACAO_NAO_SUPORTADA", "só a modalidade de base 3 (valor da operação) é suportada.");
          }
          if (!aliquotaValida(p)) {
            recusar("ICMS", "TRIBUTACAO_NAO_SUPORTADA", "a alíquota deve estar entre 0 e 100.");
          } else if (tag !== base.icms.tag || p !== base.icms.pICMS) {
            t.icms.modBC = "3";
            t.icms.pICMS = p;
            t.icms.vBC = p > 0 ? (t.icms.vBC > 0 ? t.icms.vBC : baseIcms) : 0;
            t.icms.vICMS = round2((t.icms.vBC * p) / 100);
          }
        }
      }
    }

    const tipoOperacao = input.tipoOperacao ?? "ENTRADA";
    for (const qual of ["pis", "cofins"] as const) {
      const o = ov[qual];
      if (!o) continue;
      const rotulo = qual === "pis" ? "PIS" : "COFINS";
      const cstEnviado = o.cst ?? t[qual].cst;
      const pEnviado = o.p ?? t[qual].p;
      // O MESMO valor que já está na base não é ajuste: o caso de uso reenvia o
      // ajuste gravado (PIS/COFINS inteiros) a cada salvamento. Recusar aqui um
      // código que veio da nota original (vazio, 03, ou 01 no Simples) derrubava
      // o salvamento de QUALQUER outra coisa do item; quem barra a emissão por
      // ele é `validarDevolucao`.
      if (cstEnviado === base[qual].cst && pEnviado === base[qual].p) continue;
      // Decisão 5: o MESMO valor do ajuste JÁ GRAVADO também não é ajuste novo.
      // Sem isto, o 01 que a DLS gravou no PIS do item 6 (Simples, rascunho
      // 4a3698ee) voltava 422 em TODO salvamento do item — até o da quantidade.
      // Regravado como está; `validarDevolucao` continua barrando a emissão.
      const s = input.salvo?.[qual];
      if (s && cstEnviado === (s.cst ?? t[qual].cst) && pEnviado === (s.p ?? t[qual].p)) {
        t[qual] = pisCofinsComoEsta(t[qual], cstEnviado, pEnviado, baseItem);
        continue;
      }
      // O juiz é o da tela (`checarCstPisCofinsDevolucao`): allowlist, regime do
      // emitente (01/02 e crédito no Simples), sentido (entrada numa saída) e
      // alíquota (0–100; 0 no Simples; 01/02 nunca a zero).
      const r = checarCstPisCofinsDevolucao({ crt: input.crtEmitente, tipo: tipoOperacao, codigo: cstEnviado, p: pEnviado });
      if (!r.ok) {
        recusar(rotulo, codigoRecusaPisCofins(r.causa, input.crtEmitente, pEnviado), r.motivo);
        continue;
      }
      if (!r.exigeAliquota) {
        t[qual] = { cst: r.codigo, vBC: 0, p: 0, v: 0 };
        continue;
      }
      const p = pEnviado;
      const vBC = p > 0 ? (t[qual].vBC > 0 ? t[qual].vBC : baseItem) : 0;
      t[qual] = { cst: r.codigo, vBC, p, v: round2((vBC * p) / 100) };
    }

    if (ov.ipiDevol === false) t.ipiDevol = null;

    if (erros.length > 0) return { ok: false, erros, recusas };

    t.fonte = "USUARIO";
    if (!t.motivosRevisao.includes("ALTERADA_PELO_USUARIO")) t.motivosRevisao.push("ALTERADA_PELO_USUARIO");
    t.requerRevisao = true;
    const cstsPisCofins = [t.pis.cst, t.cofins.cst];
    if (tipoOperacao === "ENTRADA") {
      // 49 também é de saída (tabela oficial: 01–49). Aqui é só AVISO — a regra
      // de REVISÃO da derivação continua em 01–09, para não travar a devolução
      // de venda do Simples, que herda o 49 das próprias vendas. O aviso que a
      // tela VÊ não depende desta marca: `validarDevolucao` o calcula do próprio
      // CST (decisão 4), então a derivação (sem marca no 49) e o ajuste (com
      // marca) dizem a mesma coisa na tela.
      const saida = cstsPisCofins.some((c) => !!c && /^(0[1-9]|49)$/.test(c));
      t.avisos = t.avisos.filter((a) => a !== "PIS_CST_SAIDA_EM_ENTRADA");
      if (saida) t.avisos.push("PIS_CST_SAIDA_EM_ENTRADA");
    } else {
      const entrada = cstsPisCofins.some((c) => sentidoCstPisCofins(c) === "ENTRADA");
      t.avisos = t.avisos.filter((a) => a !== "PIS_CST_ENTRADA_EM_SAIDA");
      if (entrada) t.avisos.push("PIS_CST_ENTRADA_EM_SAIDA");
    }
  }

  t.confirmada = input.confirmar === true;
  return { ok: true, tributacao: t };
}

// ─────────────── o imposto da nota original, na proporção devolvida ───────────────

/** "R$ 1.234,56" — sem depender do ICU do runtime (servidor, teste e navegador iguais). */
export function reais(valor: number): string {
  const n = round2(Number.isFinite(valor) ? valor : 0);
  const [inteiro, centavos] = Math.abs(n).toFixed(2).split(".");
  const milhar = inteiro.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${n < 0 ? "-" : ""}R$ ${milhar},${centavos}`;
}

function percentual(p: number): string {
  return `${String(round2(p)).replace(".", ",")}%`;
}

function quantidadeTexto(q: number): string {
  return String(q).replace(".", ",");
}

/** qDev/qOrig em unidades de 1/10000; null quando a quantidade original é desconhecida. */
function proporcaoDevolvida(
  quantidadeOriginal: number | string | null | undefined,
  quantidade: number | string,
): { orig: number; dev: number } | null {
  const orig =
    quantidadeOriginal === null || quantidadeOriginal === undefined ? null : quantidadeParaUnidades(quantidadeOriginal);
  const dev = quantidadeParaUnidades(quantidade);
  if (orig === null || orig <= 0 || dev === null || dev < 0) return null;
  return { orig, dev };
}

function naProporcao(valor: number | undefined, pr: { orig: number; dev: number } | null): number {
  const x = valor ?? 0;
  if (!pr) return round2(x);
  return pr.dev === pr.orig ? round2(x) : round2((x * pr.dev) / pr.orig);
}

/**
 * A nota original COBROU ICMS-ST neste item (vBCST/vICMSST destacados)? É a
 * mesma condição que marca `ICMS_ST_NAO_SUPORTADO` na derivação.
 */
export function originalTemIcmsSt(icms: IcmsOriginal | null | undefined): boolean {
  return !!icms && ((icms.vBCST ?? 0) > 0 || (icms.vICMSST ?? 0) > 0);
}

/**
 * A compra deste item envolveu ICMS-ST de algum jeito — cobrado nesta nota
 * (10/30/70, 201/202/203, ou vBCST/vICMSST) ou já retido antes (60, 500)? Usado
 * para avisar que o CSOSN 500 ("ICMS já cobrado por ST") declara uma ST que a
 * compra não teve.
 */
export function compraTeveIcmsSt(icms: IcmsOriginal | null | undefined): boolean {
  if (!icms) return false;
  if (originalTemIcmsSt(icms)) return true;
  if ((icms.vBCSTRet ?? 0) > 0 || (icms.vICMSSTRet ?? 0) > 0) return true;
  if (icms.cst && ["10", "30", "60", "70"].includes(icms.cst)) return true;
  if (icms.csosn && ["201", "202", "203", "500"].includes(icms.csosn)) return true;
  return /ST/.test(icms.grupo ?? "");
}

/**
 * ICMS-ST da nota original na quantidade devolvida — o valor que ficaria FORA
 * da nota de devolução (o construtor ainda não escreve ST). null = sem ST.
 * Quantidade original desconhecida: o da linha inteira, com `proporcional: false`.
 */
export function icmsStDaOriginal(entrada: {
  impostoOriginal: ImpostoOriginal | null | undefined;
  quantidadeOriginal: number | string | null | undefined;
  quantidade: number | string;
}): { vBCST: number; vICMSST: number; proporcional: boolean } | null {
  const icms = entrada.impostoOriginal?.icms ?? null;
  if (!originalTemIcmsSt(icms)) return null;
  const pr = proporcaoDevolvida(entrada.quantidadeOriginal, entrada.quantidade);
  return {
    vBCST: naProporcao(icms?.vBCST, pr),
    vICMSST: naProporcao(icms?.vICMSST, pr),
    proporcional: pr !== null,
  };
}

/**
 * ICMS destacado na nota original, na quantidade devolvida. null = sem ICMS
 * destacado, ou sem como proporcionalizar (quantidade original desconhecida).
 */
export function icmsDestacadoDaOriginal(entrada: {
  impostoOriginal: ImpostoOriginal | null | undefined;
  quantidadeOriginal: number | string | null | undefined;
  quantidade: number | string;
}): { vBC: number; pICMS: number; vICMS: number } | null {
  const icms = entrada.impostoOriginal?.icms ?? null;
  if (!icms || !((icms.vICMS ?? 0) > 0)) return null;
  const pr = proporcaoDevolvida(entrada.quantidadeOriginal, entrada.quantidade);
  if (!pr) return null;
  return { vBC: naProporcao(icms.vBC, pr), pICMS: icms.pICMS ?? 0, vICMS: naProporcao(icms.vICMS, pr) };
}

/**
 * O imposto do XML original deste item, do jeito que a TELA mostra ao lado do
 * seletor — na proporção devolvida, com a frase pronta. É o que faz o número
 * herdado deixar de ser implícito: "Na nota do fornecedor: CST 00 · base
 * R$ 123,56 · 12% · ICMS R$ 14,83".
 *
 * `null` quando não há imposto original (devolução manual sem XML): a tela diz
 * que não há imposto original para conferir.
 */
export function referenciaImpostoOriginal(entrada: {
  impostoOriginal: ImpostoOriginal | null | undefined;
  quantidadeOriginal: number | string | null | undefined;
  quantidade: number | string;
  tipo: TipoDevolucao;
}): ReferenciaImpostoOriginal | null {
  const imp = entrada.impostoOriginal;
  if (!imp) return null;
  const pr = proporcaoDevolvida(entrada.quantidadeOriginal, entrada.quantidade);
  const deQuem = entrada.tipo === "COMPRA_SAIDA" ? "FORNECEDOR" : "PROPRIA";
  const titulo = deQuem === "FORNECEDOR" ? "Na nota do fornecedor" : "Na sua nota de venda";
  const qOrig =
    entrada.quantidadeOriginal === null || entrada.quantidadeOriginal === undefined
      ? null
      : Number(entrada.quantidadeOriginal);
  const qDev = Number(entrada.quantidade);
  const escopo = !pr
    ? " (valores da linha inteira da nota: a quantidade original não é conhecida)"
    : pr.dev !== pr.orig && qOrig !== null
      ? ` (na proporção de ${quantidadeTexto(qDev)} de ${quantidadeTexto(qOrig)})`
      : "";

  const i = imp.icms;
  const icms = i
    ? {
        codigo: i.csosn ?? i.cst ?? null,
        tipo: i.csosn ? ("CSOSN" as const) : i.cst ? ("CST" as const) : null,
        vBC: naProporcao(i.vBC, pr),
        pICMS: i.pICMS ?? 0,
        vICMS: naProporcao(i.vICMS, pr),
        vBCST: naProporcao(i.vBCST, pr),
        vICMSST: naProporcao(i.vICMSST, pr),
      }
    : null;

  const pisOuCofins = (g: PisOriginal | CofinsOriginal | null, p: number | undefined, v: number | undefined) =>
    g
      ? {
          cst: g.cst || null,
          vBC: naProporcao(g.vBC, pr),
          p: p ?? 0,
          v: naProporcao(v, pr),
          porQuantidade: g.qBCProd !== undefined || g.vAliqProd !== undefined,
        }
      : null;
  const pis = pisOuCofins(imp.pis, imp.pis?.pPIS, imp.pis?.vPIS);
  const cofins = pisOuCofins(imp.cofins, imp.cofins?.pCOFINS, imp.cofins?.vCOFINS);
  const ipi = imp.ipi ? { cst: imp.ipi.cst || null, pIPI: imp.ipi.pIPI ?? 0, vIPI: naProporcao(imp.ipi.vIPI, pr) } : null;

  const fraseIcms = (() => {
    if (!icms) return "";
    const codigo = icms.codigo ? `${icms.tipo} ${icms.codigo}` : "sem código de ICMS";
    const valores =
      icms.vICMS > 0 || icms.vBC > 0
        ? ` · base ${reais(icms.vBC)} · ${percentual(icms.pICMS)} · ICMS ${reais(icms.vICMS)}`
        : " · sem ICMS destacado";
    const st = icms.vICMSST > 0 ? ` · ICMS-ST ${reais(icms.vICMSST)}` : "";
    return `${titulo}: ${codigo}${valores}${st}${escopo}.`;
  })();
  const frasePisCofins = (nome: string, g: typeof pis) => {
    if (!g) return "";
    const codigo = g.cst ? `${nome} CST ${g.cst}` : `${nome} sem CST`;
    const valores = g.porQuantidade
      ? " · calculado por quantidade"
      : g.v > 0 || g.p > 0
        ? ` · base ${reais(g.vBC)} · ${percentual(g.p)} · ${reais(g.v)}`
        : " · sem valor";
    return `${titulo}: ${codigo}${valores}${escopo}.`;
  };
  const fraseIpi = ipi && ipi.vIPI > 0 ? `${titulo}: IPI ${percentual(ipi.pIPI)} · ${reais(ipi.vIPI)}${escopo}.` : "";

  return {
    deQuem,
    titulo,
    proporcional: pr !== null,
    quantidadeOriginal: qOrig !== null && Number.isFinite(qOrig) ? qOrig : null,
    quantidadeDevolvida: Number.isFinite(qDev) ? qDev : 0,
    icms,
    pis,
    cofins,
    ipi,
    frases: {
      icms: fraseIcms,
      pis: frasePisCofins("PIS", pis),
      cofins: frasePisCofins("COFINS", cofins),
      ipi: fraseIpi,
    },
  };
}
