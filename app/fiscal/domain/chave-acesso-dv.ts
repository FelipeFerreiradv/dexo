/**
 * Chave de acesso de NF-e / NFC-e (44 dígitos) — normalização, dígito
 * verificador e decomposição, SEM `node:crypto`.
 *
 * Por que existe: `app/fiscal/sefaz/chave-acesso.ts` importa `randomInt` de
 * `node:crypto` (para gerar o cNF) e não roda no navegador. A devolução precisa
 * validar a chave digitada no wizard e no servidor com a MESMA regra. O DV aqui
 * replica `calcularDV` (módulo 11, pesos 2..9 da direita para a esquerda; resto
 * 0 ou 1 ⇒ DV "0") — paridade travada por teste contra o original.
 *
 * Formato (NT 2014.002): cUF(2) AAMM(4) CNPJ/CPF(14) mod(2) serie(3) nNF(9)
 * tpEmis(1) cNF(8) cDV(1).
 *
 * Módulo PURO (sem imports) — seguro para backend, testes e client.
 */

const SO_DIGITOS = /^\d*$/;
const SEPARADORES = /[\s.\-/]/g;

/** Código IBGE da UF (cUF) → sigla. */
export const UF_POR_CUF: Readonly<Record<string, string>> = {
  "11": "RO", "12": "AC", "13": "AM", "14": "RR", "15": "PA", "16": "AP", "17": "TO",
  "21": "MA", "22": "PI", "23": "CE", "24": "RN", "25": "PB", "26": "PE", "27": "AL",
  "28": "SE", "29": "BA", "31": "MG", "32": "ES", "33": "RJ", "35": "SP", "41": "PR",
  "42": "SC", "43": "RS", "50": "MS", "51": "MT", "52": "GO", "53": "DF",
};

/**
 * Normaliza a chave para só dígitos.
 * - Aceita o prefixo "NFe" (a Focus grava 47 caracteres: "NFe" + 44).
 * - Remove espaços, pontos, hífens e barras (chave colada formatada).
 * - Qualquer outro caractere ⇒ `null` (nunca "limpa" letra no meio: isso poderia
 *   transformar um erro de digitação numa chave de 44 dígitos aparentemente boa).
 * NÃO confere tamanho nem DV — use `isChaveAcessoValida`/`validarChaveAcesso`.
 */
export function normalizarChaveAcesso(valor: unknown): string | null {
  if (typeof valor !== "string") return null;
  let s = valor.trim();
  if (/^nfe/i.test(s)) s = s.slice(3);
  s = s.replace(SEPARADORES, "");
  return SO_DIGITOS.test(s) ? s : null;
}

/** DV módulo 11 sobre a base de 43 dígitos. `null` se a base não tiver 43 dígitos. */
export function calcularDvChaveAcesso(base43: string): string | null {
  if (typeof base43 !== "string" || !/^\d{43}$/.test(base43)) return null;
  let soma = 0;
  let peso = 2;
  for (let i = base43.length - 1; i >= 0; i--) {
    soma += (base43.charCodeAt(i) - 48) * peso;
    peso = peso === 9 ? 2 : peso + 1;
  }
  const dv = 11 - (soma % 11);
  return dv >= 10 ? "0" : String(dv);
}

/**
 * true ⇔ exatamente 44 dígitos (já normalizados) com DV correto.
 * Não normaliza: quem recebe entrada do usuário chama `normalizarChaveAcesso` antes.
 */
export function isChaveAcessoValida(chave: unknown): boolean {
  if (typeof chave !== "string" || !/^\d{44}$/.test(chave)) return false;
  return calcularDvChaveAcesso(chave.slice(0, 43)) === chave[43];
}

export interface ChaveAcessoPartes {
  /** 44 dígitos normalizados. */
  chave: string;
  cUF: string;
  /** Sigla da UF pelo cUF (null se o código não existe). */
  uf: string | null;
  aamm: string;
  ano: number;
  mes: number;
  /** 14 posições: CNPJ, ou "000" + CPF para emitente pessoa física. */
  cnpjCpf: string;
  modelo: string;
  serie: number;
  /** nNF REAL do documento (na Focus pode divergir de NfeEmitida.numero). */
  numero: number;
  tpEmis: string;
  cNF: string;
  dv: string;
  dvValido: boolean;
}

/**
 * Decompõe a chave (aceita prefixo "NFe" e separadores). `null` quando não dá
 * 44 dígitos. O DV NÃO é exigido aqui — vem em `dvValido`.
 */
export function parseChaveAcesso(chave: string): ChaveAcessoPartes | null {
  const c = normalizarChaveAcesso(chave);
  if (c === null || c.length !== 44) return null;
  const aamm = c.slice(2, 6);
  return {
    chave: c,
    cUF: c.slice(0, 2),
    uf: UF_POR_CUF[c.slice(0, 2)] ?? null,
    aamm,
    ano: 2000 + Number(aamm.slice(0, 2)),
    mes: Number(aamm.slice(2, 4)),
    cnpjCpf: c.slice(6, 20),
    modelo: c.slice(20, 22),
    serie: Number(c.slice(22, 25)),
    numero: Number(c.slice(25, 34)),
    tpEmis: c.slice(34, 35),
    cNF: c.slice(35, 43),
    dv: c.slice(43, 44),
    dvValido: calcularDvChaveAcesso(c.slice(0, 43)) === c[43],
  };
}

export type CodigoErroChave =
  | "VAZIA"
  | "CARACTER_INVALIDO"
  | "TAMANHO"
  | "DV"
  | "MODELO"
  | "MES";

export type ValidacaoChaveAcesso =
  | { ok: true; chave: string; partes: ChaveAcessoPartes }
  | { ok: false; codigo: CodigoErroChave; mensagem: string };

/**
 * Validação completa para entrada do usuário (wizard, devolução manual, rotas).
 * `modelos` default ["55","65"] (originais de NF-e e NFC-e podem ser devolvidas).
 */
export function validarChaveAcesso(
  raw: unknown,
  opts?: { modelos?: readonly string[] },
): ValidacaoChaveAcesso {
  if (raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "")) {
    return { ok: false, codigo: "VAZIA", mensagem: "Informe a chave de acesso." };
  }
  const c = normalizarChaveAcesso(raw);
  if (c === null) {
    return {
      ok: false,
      codigo: "CARACTER_INVALIDO",
      mensagem: "A chave de acesso tem só números (44 dígitos).",
    };
  }
  if (c.length !== 44) {
    const diff = 44 - c.length;
    return {
      ok: false,
      codigo: "TAMANHO",
      mensagem:
        diff > 0
          ? `Faltam ${diff} dígitos.`
          : `A chave tem 44 dígitos — sobraram ${-diff}.`,
    };
  }
  const partes = parseChaveAcesso(c) as ChaveAcessoPartes;
  if (!partes.dvValido) {
    return {
      ok: false,
      codigo: "DV",
      mensagem: "Chave inválida: o dígito verificador não confere. Confira a digitação.",
    };
  }
  const modelos = opts?.modelos ?? ["55", "65"];
  if (!modelos.includes(partes.modelo)) {
    return {
      ok: false,
      codigo: "MODELO",
      mensagem: `Esta chave não é de NF-e nem de NFC-e (modelo ${partes.modelo}).`,
    };
  }
  if (partes.mes < 1 || partes.mes > 12) {
    return {
      ok: false,
      codigo: "MES",
      mensagem: `Chave inválida: mês de emissão ${partes.aamm.slice(2, 4)}.`,
    };
  }
  return { ok: true, chave: c, partes };
}

/** Chave em grupos de 4 (11 grupos), para exibição. Entrada inválida volta como veio. */
export function formatarChaveAcesso(chave: string): string {
  const c = normalizarChaveAcesso(chave);
  if (c === null || c.length !== 44) return chave;
  return c.replace(/(\d{4})(?=\d)/g, "$1 ");
}
