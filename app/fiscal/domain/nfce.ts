/**
 * NFC-e (modelo 65) — regras de domínio da Fase 2 do PDV.
 *
 * Módulo puro (sem imports) — seguro no Fastify e no bundle do Next.
 */

/**
 * Limite de valor para emissão de NFC-e pelo PDV. Acima disso a venda deve
 * ser documentada por NF-e modelo 55 (fluxo de rascunho existente).
 * Guard aplicado no frontend (UX) E no backend (validate da emissão).
 */
export const NFCE_LIMITE_VALOR = 10_000;

/** Type guard: o documento é uma NFC-e? (default/ausente = NF-e 55). */
export function isNfce(
  modelo: string | null | undefined,
): modelo is "65" {
  return modelo === "65";
}
