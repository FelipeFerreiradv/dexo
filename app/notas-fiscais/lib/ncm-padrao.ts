/**
 * NCM padrão (Fase 2 — NFC-e/PDV): autopreenchimento de NCM vazio com o
 * `ncmPadrao` da configuração fiscal. Módulo puro (testável em node).
 *
 * Regra: NUNCA sobrescreve um NCM já preenchido; o padrão só entra quando o
 * campo está vazio E o padrão é um NCM válido (8 dígitos). NCM continua
 * obrigatório na emissão — sem padrão configurado, o campo segue vazio e a
 * validação existente aponta o erro.
 */
export function applyNcmPadrao(
  ncm: string | null | undefined,
  ncmPadrao: string | null | undefined,
): string {
  const atual = (ncm ?? "").trim();
  if (atual) return atual;
  const padrao = (ncmPadrao ?? "").replace(/\D/g, "");
  return padrao.length === 8 ? padrao : "";
}
