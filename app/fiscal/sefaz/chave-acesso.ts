/**
 * Geração e validação da chave de acesso de NFe (44 dígitos).
 *
 * Formato (NT 2014.002 v4.00):
 *   cUF(2) + AAMM(4) + CNPJ(14) + mod(2) + serie(3) + nNF(9) + tpEmis(1)
 *   + cNF(8) + cDV(1) = 44 caracteres numéricos
 *
 * cDV é o dígito verificador calculado por módulo 11 sobre os 43 primeiros
 * dígitos, com pesos cíclicos 2..9 (da direita para a esquerda).
 */

import { randomInt } from "node:crypto";

import { COD_UF, type UF } from "./endpoints";

export interface ChaveAcessoInput {
  uf: UF;
  /** Ano de emissão (4 dígitos). */
  ano: number;
  /** Mês de emissão (1-12). */
  mes: number;
  /** CNPJ apenas dígitos (14). */
  cnpj: string;
  /** Modelo do documento. Para NFe sempre "55". */
  modelo: "55" | "65";
  /** Série da nota (0-999). */
  serie: number;
  /** Número sequencial da nota (1..999999999). */
  numero: number;
  /** Tipo de emissão (1=normal, 6=SVC-AN, 7=SVC-RS, 9=contingência off-line). */
  tpEmis: 1 | 4 | 6 | 7 | 9;
  /**
   * Código numérico aleatório (cNF). Se omitido, será gerado.
   * Deve ter 8 dígitos. cNF NÃO pode ser igual ao número da NFe (regra 2014.002).
   */
  cNF?: string;
}

export interface ChaveAcessoParts {
  cUF: string;
  AAMM: string;
  CNPJ: string;
  mod: string;
  serie: string;
  nNF: string;
  tpEmis: string;
  cNF: string;
  cDV: string;
}

const onlyDigits = (s: string) => s.replace(/\D/g, "");
const pad = (value: number | string, len: number): string =>
  String(value).padStart(len, "0");

// Padroes de cNF vetados pela NT 2019.001 (Rejeicao 897 "Codigo numerico em
// formato invalido"): dezenas repetidas e sequencias ascendentes de 8 digitos.
const CNF_SEQUENCIAS_PROIBIDAS = new Set([
  "12345678", "23456789", "34567890", "45678901", "56789012",
  "67890123", "78901234", "89012345", "90123456", "01234567",
]);

/** true se o cNF (8 digitos) cai num padrao vetado pela Rejeicao 897. */
export function isCnfProibido(cNF: string): boolean {
  if (!/^\d{8}$/.test(cNF)) return true;
  if (/^(\d)\1{7}$/.test(cNF)) return true; // dezenas repetidas (00000000..99999999)
  return CNF_SEQUENCIAS_PROIBIDAS.has(cNF);
}

/**
 * Gera código cNF de 8 dígitos diferente de nNF e fora dos padroes proibidos
 * da Rejeicao 897 (NT 2019.001).
 *
 * Usa CSPRNG (crypto.randomInt) — a SEFAZ recomenda um codigo numerico
 * aleatorio e nao-previsivel; Math.random() e previsivel e nao deve gerar
 * identificadores fiscais.
 *
 * NOTA: o cNF e gerado a cada chamada. Para emissao deterministica/idempotente
 * (reaproveitar a MESMA chave num reenvio), passe `cNF` explicito em
 * ChaveAcessoInput — o chamador (ex.: use case) deve persistir o cNF/chave da
 * 1a tentativa e reusa-lo, em vez de regenerar.
 */
export function gerarCnf(nNF: number): string {
  const nNF8 = pad(nNF % 100_000_000, 8);
  for (let attempt = 0; attempt < 16; attempt++) {
    const candidate = pad(randomInt(0, 100_000_000), 8);
    if (candidate !== nNF8 && !isCnfProibido(candidate)) return candidate;
  }
  // Fallback deterministico valido (8 digitos, nao proibido, != nNF).
  const fallback = nNF8 === "10000007" ? "10000017" : "10000007";
  return fallback;
}

/**
 * Calcula DV módulo 11 da chave de acesso (sobre os 43 primeiros dígitos).
 */
export function calcularDV(base43: string): string {
  const digits = onlyDigits(base43);
  if (digits.length !== 43) {
    throw new Error(
      `Base para calculo do DV deve ter 43 digitos (recebido: ${digits.length})`,
    );
  }

  let soma = 0;
  let peso = 2;
  for (let i = digits.length - 1; i >= 0; i--) {
    soma += Number(digits[i]) * peso;
    peso = peso === 9 ? 2 : peso + 1;
  }

  const resto = soma % 11;
  const dv = 11 - resto;
  return dv >= 10 ? "0" : String(dv);
}

export function montarChave(input: ChaveAcessoInput): ChaveAcessoParts {
  const cnpj = onlyDigits(input.cnpj);
  if (cnpj.length !== 14) {
    throw new Error(`CNPJ deve ter 14 digitos (recebido: ${cnpj.length})`);
  }
  if (input.mes < 1 || input.mes > 12) {
    throw new Error(`Mes invalido: ${input.mes}`);
  }
  if (input.ano < 2000 || input.ano > 2099) {
    throw new Error(`Ano fora do range suportado: ${input.ano}`);
  }
  if (input.numero < 1 || input.numero > 999_999_999) {
    throw new Error(`Numero da NF fora do range (1..999999999): ${input.numero}`);
  }
  if (input.serie < 0 || input.serie > 999) {
    throw new Error(`Serie fora do range (0..999): ${input.serie}`);
  }

  const cUF = pad(COD_UF[input.uf], 2);
  const AAMM = pad(input.ano % 100, 2) + pad(input.mes, 2);
  const CNPJ = cnpj;
  const mod = input.modelo;
  const serie = pad(input.serie, 3);
  const nNF = pad(input.numero, 9);
  const tpEmis = String(input.tpEmis);
  const cNF = input.cNF ? pad(onlyDigits(input.cNF), 8) : gerarCnf(input.numero);

  if (cNF.length !== 8) {
    throw new Error(`cNF deve ter 8 digitos (recebido: ${cNF.length})`);
  }
  // Rejeição 778: cNF não pode ser igual ao nNF quando comparados como número
  // (ignorando padding de zeros). nNF tem 9 dígitos, cNF tem 8 — comparação
  // string-direta nunca dispararia.
  if (Number(cNF) === Number(nNF)) {
    throw new Error("cNF nao pode ser igual ao numero da NFe (Rejeicao 778)");
  }
  if (isCnfProibido(cNF)) {
    throw new Error(
      `cNF em formato invalido (dezena repetida ou sequencia): ${cNF} (Rejeicao 897)`,
    );
  }

  const base43 = cUF + AAMM + CNPJ + mod + serie + nNF + tpEmis + cNF;
  const cDV = calcularDV(base43);

  return { cUF, AAMM, CNPJ, mod, serie, nNF, tpEmis, cNF, cDV };
}

export function chaveToString(parts: ChaveAcessoParts): string {
  return (
    parts.cUF +
    parts.AAMM +
    parts.CNPJ +
    parts.mod +
    parts.serie +
    parts.nNF +
    parts.tpEmis +
    parts.cNF +
    parts.cDV
  );
}

/**
 * Valida formato da chave + DV. Retorna parts se válida, lança senão.
 */
export function parseChave(chave: string): ChaveAcessoParts {
  const digits = onlyDigits(chave);
  if (digits.length !== 44) {
    throw new Error(
      `Chave deve ter 44 digitos (recebido: ${digits.length})`,
    );
  }
  const parts: ChaveAcessoParts = {
    cUF: digits.slice(0, 2),
    AAMM: digits.slice(2, 6),
    CNPJ: digits.slice(6, 20),
    mod: digits.slice(20, 22),
    serie: digits.slice(22, 25),
    nNF: digits.slice(25, 34),
    tpEmis: digits.slice(34, 35),
    cNF: digits.slice(35, 43),
    cDV: digits.slice(43, 44),
  };

  const dvCalc = calcularDV(digits.slice(0, 43));
  if (dvCalc !== parts.cDV) {
    throw new Error(
      `DV invalido — esperado=${dvCalc}, recebido=${parts.cDV}`,
    );
  }

  return parts;
}
