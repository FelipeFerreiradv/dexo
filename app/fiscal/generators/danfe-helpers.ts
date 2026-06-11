/**
 * Helpers puros do DANFE (sem pdf-lib / sem I/O), testáveis isoladamente.
 */

export interface CstCsosn {
  /** Rótulo da coluna conforme o regime: "CSOSN" (Simples) ou "CST" (normal). */
  label: string;
  /** Código tributário do ICMS exibido. */
  value: string;
}

/**
 * Resolve o código tributário do ICMS para exibição no DANFE.
 *
 * No Simples Nacional usa-se CSOSN (default 102 — "tributada sem permissão de
 * crédito"); no regime normal usa-se CST (default 00). É o mesmo default que o
 * gerador de XML aplica na emissão (`item.cstIcms ?? (SIMPLES ? "102" : "00")`),
 * então o valor exibido reflete o que foi efetivamente enviado quando o item
 * não traz um CST/CSOSN específico.
 */
export function resolveCstCsosn(
  regime: string | null | undefined,
  cstIcms?: string | null,
): CstCsosn {
  const isSimples = regime === "SIMPLES";
  const value =
    cstIcms && cstIcms.trim() ? cstIcms.trim() : isSimples ? "102" : "00";
  return { label: isSimples ? "CSOSN" : "CST", value };
}
