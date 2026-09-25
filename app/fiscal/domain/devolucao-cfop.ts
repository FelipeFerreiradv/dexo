/**
 * CFOP na NF-e de DEVOLUÇÃO (finNFe=4) — conjunto oficial, exceções, MEI e o
 * mapeamento da operação original para o CFOP de devolução.
 *
 * Fontes das regras (NT 2026.009 / MOC):
 * - Rejeição 327: finNFe=4 exige CFOP com indDevol=1 (105 códigos, I08-140) ou a
 *   exceção 1.949/2.949 (só em nota de ENTRADA).
 * - Rejeições 731/732/733: 1º dígito do CFOP × idDest (exterior 3/7 ⇔ 3;
 *   interestadual 2/6 ⇔ 2; interna 1/5 ⇔ 1).
 * - Rejeição 1179: emitente MEI (CRT=4) só usa a lista restrita.
 *
 * Nada aqui é "escolha fiscal inventada": quando não existe inverso oficial
 * inequívoco o resultado é ESCOLHA/SEM_INVERSO e a emissão fica bloqueada até o
 * usuário (com o contador) escolher.
 *
 * Módulo PURO (sem imports) — compartilhado por backend e wizard.
 */

export type TipoDevolucaoCfop = "VENDA_ENTRADA" | "COMPRA_SAIDA";
export type IdDestCfop = 1 | 2 | 3;
export type CrtCfop = "1" | "2" | "3" | "4";

// Sufixos com indDevol=1 por família (entrada nacional/exterior, saída nacional/exterior).
const E_NAC = ["201", "202", "203", "204", "208", "209", "212", "213", "214", "215", "216", "410", "411", "503", "504", "505", "506", "553", "660", "661", "662", "918", "919"];
const E_EXT = ["201", "202", "211", "212", "503", "553"];
const S_NAC = ["201", "202", "208", "209", "210", "213", "214", "215", "216", "410", "411", "412", "413", "503", "553", "555", "556", "660", "661", "662", "918", "919", "921"];
const S_EXT = ["201", "202", "210", "211", "212", "553", "556"];

/** NT 2026.009 I08-140 — CFOPs com indDevol=1 (105 códigos). */
export const CFOPS_DEVOLUCAO: ReadonlySet<string> = new Set([
  ...E_NAC.map((s) => "1" + s),
  ...E_NAC.map((s) => "2" + s),
  ...E_EXT.map((s) => "3" + s),
  ...S_NAC.map((s) => "5" + s),
  ...S_NAC.map((s) => "6" + s),
  ...S_EXT.map((s) => "7" + s),
]);

/** Exceção da rejeição 327: "outra entrada" — só em nota de ENTRADA (tpNF=0). */
export const EXCECAO_1949_2949: ReadonlySet<string> = new Set(["1949", "2949"]);

/** Rejeição 1179 — CFOPs de devolução permitidos ao emitente MEI (CRT=4). */
export const CFOPS_MEI_DEVOLUCAO: ReadonlySet<string> = new Set([
  "1202", "1553", "2202", "2553", "5202", "6202",
]);

/** Venda original → devolução (entrada). Inverso oficial inequívoco. */
const VENDA_PARA_DEVOLUCAO: Readonly<Record<string, string>> = {
  "5101": "1201", "5102": "1202", "5401": "1410", "5403": "1411", "5405": "1411",
  "5501": "1503", "5502": "1504", "5551": "1553",
  "6101": "2201", "6107": "2201", "6102": "2202", "6108": "2202",
  "6401": "2410", "6403": "2411",
  "6501": "2503", "6502": "2504", "6551": "2553",
  "7101": "3201", "7102": "3202", "7551": "3553",
};

/** Venda original sem inverso único: o usuário escolhe entre as opções. */
const VENDA_ESCOLHA: Readonly<Record<string, readonly string[]>> = {
  "6404": ["2411", "2949"],
  "5949": ["1949"],
  "6949": ["2949"],
  // 5929/6929 = lançamento de operação também registrada em ECF: o CFOP da
  // devolução segue a venda SUBJACENTE, que o XML não informa.
  "5929": ["1202", "1201", "1411", "1410", "1949"],
  "6929": ["2202", "2201", "2411", "2410", "2949"],
};

/**
 * COMPRA_SAIDA a partir do CFOP da NOSSA entrada (sufixo): 1102→5202, 2403→6411…
 * O dígito troca 1→5, 2→6, 3→7; resultado fora do conjunto oficial é descartado.
 */
const ENTRADA_PARA_DEVOLUCAO_SUFIXO: Readonly<Record<string, string>> = {
  "101": "201", "102": "202", "401": "410", "403": "411", "406": "412", "407": "413",
  "501": "503", "551": "553", "556": "556", "651": "660", "652": "661", "653": "662",
};

/**
 * COMPRA_SAIDA a partir do CFOP de SAÍDA do fornecedor: só sugestão (a finalidade da nossa entrada é desconhecida).
 *
 * Combustível/lubrificante (65x): a venda do fornecedor diz o destino da compra
 * — industrialização (651/654), comercialização (652/655) ou consumo (653/656) —,
 * e a devolução de compra é o 660/661/662 correspondente, a MESMA família que
 * `ENTRADA_PARA_DEVOLUCAO_SUFIXO` já usa a partir da nossa entrada (1652→5661).
 * Sem isto, o 5655 da DISAUTO (óleo LUBRAX) nem oferecia o 5661.
 */
const VENDA_FORNECEDOR_SUGESTAO_SUFIXO: Readonly<Record<string, string>> = {
  "101": "201", "102": "202", "107": "201", "108": "202",
  "401": "410", "403": "411", "404": "411", "405": "411",
  "651": "660", "654": "660", "652": "661", "655": "661", "653": "662", "656": "662",
};

const cfopDigitos = (cfop: unknown): string =>
  typeof cfop === "string" || typeof cfop === "number"
    ? String(cfop).replace(/\D/g, "")
    : "";

/** true ⇔ CFOP está no conjunto oficial indDevol=1 (sem a exceção 1949/2949). */
export function isCfopDevolucao(cfop: unknown): boolean {
  return CFOPS_DEVOLUCAO.has(cfopDigitos(cfop));
}

/** Regra 327 completa: conjunto oficial, ou 1949/2949 quando a nota é de ENTRADA (tpNF=0). */
export function isCfopPermitidoEmDevolucao(cfop: unknown, tpNF: "0" | "1"): boolean {
  const c = cfopDigitos(cfop);
  return CFOPS_DEVOLUCAO.has(c) || (tpNF === "0" && EXCECAO_1949_2949.has(c));
}

/** idDest implicado pelo 1º dígito do CFOP (1/5→1, 2/6→2, 3/7→3); null se não é CFOP. */
export function idDestDoCfop(cfop: unknown): IdDestCfop | null {
  const c = cfopDigitos(cfop);
  if (c.length !== 4) return null;
  switch (c[0]) {
    case "1":
    case "5":
      return 1;
    case "2":
    case "6":
      return 2;
    case "3":
    case "7":
      return 3;
    default:
      return null;
  }
}

/** Rejeições 731/732/733: 1º dígito do CFOP × idDest. */
export function validarCfopVsIdDest(cfop: unknown, idDest: unknown): boolean {
  const esperado = idDestDoCfop(cfop);
  const n = Number(idDest);
  return esperado !== null && esperado === n;
}

const isMei = (crt: unknown) => String(crt ?? "") === "4";

const digitoDevolucao = (tipo: TipoDevolucaoCfop, idDest: IdDestCfop): string =>
  String(tipo === "VENDA_ENTRADA" ? idDest : idDest + 4);

/**
 * Todos os CFOPs aceitáveis para a devolução no contexto (ordem estável):
 * conjunto oficial com o dígito do idDest (+ 1949/2949 na entrada nacional),
 * filtrado pela lista MEI quando CRT=4.
 */
export function cfopsPermitidosDevolucao(ctx: {
  tipo: TipoDevolucaoCfop;
  idDest: IdDestCfop;
  crt?: CrtCfop | string | null;
}): string[] {
  const d = digitoDevolucao(ctx.tipo, ctx.idDest);
  const lista = Array.from(CFOPS_DEVOLUCAO)
    .filter((c) => c[0] === d)
    .sort();
  if (ctx.tipo === "VENDA_ENTRADA" && ctx.idDest !== 3) lista.push(d + "949");
  return isMei(ctx.crt) ? lista.filter((c) => CFOPS_MEI_DEVOLUCAO.has(c)) : lista;
}

export type StatusMapeamentoCfop = "MAPEADO" | "ESCOLHA" | "SEM_INVERSO";

export type MotivoMapeamentoCfop =
  | "TABELA"
  | "MEI_RESTRITO"
  | "SEM_INVERSO_OFICIAL"
  | "DESTINO_DIVERGENTE"
  | "FINALIDADE_DA_ENTRADA_DESCONHECIDA"
  | "SEM_MAPEAMENTO";

export interface MapeamentoCfopDevolucao {
  status: StatusMapeamentoCfop;
  /** Preenchido só em MAPEADO. */
  cfop: string | null;
  opcoes: string[];
  motivo: MotivoMapeamentoCfop;
}

export interface MapearCfopDevolucaoInput {
  cfopOriginal: string;
  tipo: TipoDevolucaoCfop;
  /** idDest da nota ORIGINAL (a devolução espelha). */
  idDestOriginal: IdDestCfop;
  /** CRT do emitente da DEVOLUÇÃO ("4" = MEI, lista restrita). */
  crt?: CrtCfop | string | null;
}

/**
 * Sugere o CFOP da devolução.
 * - VENDA_ENTRADA: `cfopOriginal` é o CFOP da venda (NF-e ou NFC-e, mesmos códigos).
 * - COMPRA_SAIDA: `cfopOriginal` é, de preferência, o CFOP da NOSSA entrada
 *   (1102→5202, 2403→6411, 1556→5556…). Se vier o CFOP de saída do fornecedor
 *   (5xxx/6xxx), só há sugestão: ESCOLHA.
 */
export function mapearCfopDevolucao(input: MapearCfopDevolucaoInput): MapeamentoCfopDevolucao {
  const { tipo, idDestOriginal: idDest, crt } = input;
  const c = cfopDigitos(input.cfopOriginal);
  const d = digitoDevolucao(tipo, idDest);
  const permitidos = cfopsPermitidosDevolucao({ tipo, idDest, crt });
  const permitido = (x: string) => permitidos.includes(x);

  const semInverso = (): MapeamentoCfopDevolucao => ({
    status: "SEM_INVERSO",
    cfop: null,
    opcoes: permitidos,
    motivo: "SEM_MAPEAMENTO",
  });

  // MEI: lista fechada — só a devolução "de mercadoria" (x202) ou ativo (x553).
  const aplicarMei = (candidato: string | null): MapeamentoCfopDevolucao | null => {
    if (!isMei(crt)) return null;
    if (candidato && permitido(candidato)) {
      return { status: "MAPEADO", cfop: candidato, opcoes: [candidato], motivo: "MEI_RESTRITO" };
    }
    const x202 = d + "202";
    if (permitido(x202)) {
      return { status: "MAPEADO", cfop: x202, opcoes: [x202], motivo: "MEI_RESTRITO" };
    }
    return { status: "ESCOLHA", cfop: null, opcoes: [], motivo: "MEI_RESTRITO" };
  };

  if (c.length !== 4) return aplicarMei(null) ?? semInverso();

  let candidato: string | null = null;
  let escolha: readonly string[] | null = null;
  let motivoEscolha: MotivoMapeamentoCfop = "SEM_INVERSO_OFICIAL";

  if (tipo === "VENDA_ENTRADA") {
    candidato = VENDA_PARA_DEVOLUCAO[c] ?? null;
    escolha = candidato ? null : VENDA_ESCOLHA[c] ?? null;
  } else if ("123".includes(c[0])) {
    const suf = ENTRADA_PARA_DEVOLUCAO_SUFIXO[c.slice(1)];
    const alvo = suf ? String(Number(c[0]) + 4) + suf : null;
    candidato = alvo && CFOPS_DEVOLUCAO.has(alvo) ? alvo : null;
  } else if ("567".includes(c[0])) {
    const suf = VENDA_FORNECEDOR_SUGESTAO_SUFIXO[c.slice(1)];
    const sugestao = suf ? d + suf : null;
    escolha = [sugestao, d + "202", d + "201", d + "411", d + "410", d + "553", d + "556"]
      .filter((x): x is string => !!x);
    motivoEscolha = "FINALIDADE_DA_ENTRADA_DESCONHECIDA";
  }

  const mei = aplicarMei(candidato);
  if (mei) return mei;

  if (candidato) {
    if (candidato[0] === d && permitido(candidato)) {
      return { status: "MAPEADO", cfop: candidato, opcoes: [candidato], motivo: "TABELA" };
    }
    // idDest da original não bate com o dígito do inverso: oferece o mesmo
    // sufixo no dígito certo (quando existe), senão a lista permitida.
    const ajustado = d + candidato.slice(1);
    return {
      status: "ESCOLHA",
      cfop: null,
      opcoes: permitido(ajustado) ? [ajustado] : permitidos,
      motivo: "DESTINO_DIVERGENTE",
    };
  }

  if (escolha) {
    const opcoes = uniq(escolha.map((x) => d + x.slice(1))).filter(permitido);
    const divergente = escolha.some((x) => x[0] !== d);
    return {
      status: "ESCOLHA",
      cfop: null,
      opcoes: opcoes.length > 0 ? opcoes : permitidos,
      motivo: divergente && motivoEscolha === "SEM_INVERSO_OFICIAL" ? "DESTINO_DIVERGENTE" : motivoEscolha,
    };
  }

  return semInverso();
}

function uniq(xs: string[]): string[] {
  return xs.filter((x, i) => xs.indexOf(x) === i);
}
