import {
  RegimeTributario,
  CstPisCofins,
  OrigemMercadoria,
} from "../domain/nfe.types";

// ── Alíquotas padrão por regime tributário ──

export interface AliquotasPadrao {
  icms: number; // % (ex: 18 = 18%)
  ipi: number;
  pis: number;
  cofins: number;
}

/**
 * Alíquotas padrão quando o item não traz override.
 * Simples Nacional: ICMS/IPI zerados (recolhidos via DAS).
 * Lucro Presumido: PIS 0.65%, COFINS 3% (regime cumulativo).
 * Lucro Real: PIS 1.65%, COFINS 7.6% (regime não-cumulativo).
 */
const ALIQUOTAS_POR_REGIME: Record<RegimeTributario, AliquotasPadrao> = {
  SIMPLES: { icms: 0, ipi: 0, pis: 0, cofins: 0 },
  LUCRO_PRESUMIDO: { icms: 18, ipi: 0, pis: 0.65, cofins: 3 },
  LUCRO_REAL: { icms: 18, ipi: 0, pis: 1.65, cofins: 7.6 },
};

export function getAliquotasPadrao(regime: RegimeTributario): AliquotasPadrao {
  return ALIQUOTAS_POR_REGIME[regime];
}

// ── ICMS interestadual (tabela simplificada) ──

const ALIQUOTA_ICMS_INTERESTADUAL: Record<string, number> = {
  // Sul e Sudeste (exceto ES) → outros estados = 12%
  // Norte, Nordeste, Centro-Oeste, ES → outros estados = 7%
  // Default genérico (simplificado para MVP)
  DEFAULT_INTERNA: 18,
  DEFAULT_INTERESTADUAL_SUL_SUDESTE: 12,
  DEFAULT_INTERESTADUAL_DEMAIS: 7,
};

const UFS_SUL_SUDESTE = new Set(["SP", "RJ", "MG", "PR", "SC", "RS"]);

export function getAliquotaIcmsInterestadual(
  ufOrigem: string,
  ufDestino: string,
): number {
  if (ufOrigem === ufDestino) {
    return ALIQUOTA_ICMS_INTERESTADUAL.DEFAULT_INTERNA;
  }
  if (UFS_SUL_SUDESTE.has(ufOrigem.toUpperCase())) {
    return ALIQUOTA_ICMS_INTERESTADUAL.DEFAULT_INTERESTADUAL_SUL_SUDESTE;
  }
  return ALIQUOTA_ICMS_INTERESTADUAL.DEFAULT_INTERESTADUAL_DEMAIS;
}

// ── Helpers para decidir se tributo incide ──

/** CSTs de PIS/COFINS que geram tributação (01 e 02 = tributado) */
const CST_PIS_COFINS_TRIBUTADOS = new Set<CstPisCofins>(["01", "02"]);

export function isPisCofinsTributado(cst: CstPisCofins): boolean {
  return CST_PIS_COFINS_TRIBUTADOS.has(cst);
}

/** CSTs ICMS regime normal que geram tributação integral */
const CST_ICMS_TRIBUTADO_INTEGRAL = new Set(["00"]);
/** CSTs ICMS com redução de base */
const CST_ICMS_COM_REDUCAO = new Set(["20", "70"]);
/** CSTs ICMS isentos / não-tributados */
const CST_ICMS_ISENTO = new Set(["40", "41", "50", "60"]);

export function isIcmsTributado(cstIcms: string): boolean {
  return (
    CST_ICMS_TRIBUTADO_INTEGRAL.has(cstIcms) ||
    CST_ICMS_COM_REDUCAO.has(cstIcms)
  );
}

export function isIcmsComReducao(cstIcms: string): boolean {
  return CST_ICMS_COM_REDUCAO.has(cstIcms);
}

export function isIcmsIsento(cstIcms: string): boolean {
  return CST_ICMS_ISENTO.has(cstIcms);
}

/** CSOSNs Simples Nacional que geram crédito de ICMS */
const CSOSN_COM_CREDITO = new Set(["101", "201"]);

export function isSimplesComCredito(csosn: string): boolean {
  return CSOSN_COM_CREDITO.has(csosn);
}

// ── Origem da mercadoria ──

export function isImportado(origem: OrigemMercadoria): boolean {
  return origem >= 1 && origem <= 8 && origem !== 0;
}

// ── Arredondamento fiscal (2 casas) ──

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
