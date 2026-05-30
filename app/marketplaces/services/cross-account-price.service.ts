import { round2 } from "./bulk-listing-rules.service";

/**
 * Aumento percentual escalonado (cascata/composto) de preço entre contas do
 * Mercado Livre. O ML penaliza empresas que publicam anúncios idênticos (mesmo
 * preço) em contas diferentes; este módulo diferencia o preço por conta no
 * momento da publicação em massa.
 *
 * Regra (composta, NÃO linear sobre o preço base):
 *   preço_conta_N = preço_base × (1 + percentual/100)^(N-1)
 *
 * Onde N é a posição 1-based da conta na ordem de seleção. Em índice 0-based:
 *   preço(idx) = preço_base × (1 + percentual/100)^idx
 *
 * A 1ª conta (idx 0) sempre mantém o preço base. O arredondamento é aplicado
 * SOMENTE no preço final de cada conta (sem arredondar degraus intermediários),
 * fiel à fórmula. Usa `round2` (ROUND_HALF_UP para preços positivos).
 *
 * Módulo puro e isolado: roda tanto no backend (cálculo real no dispatcher)
 * quanto no front (preview no wizard). Não tem efeitos colaterais.
 */

/**
 * Preço escalonado de uma conta específica.
 *
 * @param basePrice  preço base (já com a regra de preço do bulk aplicada, se houver)
 * @param accountIndex índice 0-based da conta na ordem de seleção (0 = preço base)
 * @param percent    percentual de aumento em pontos (ex.: 10 = 10%, 5.5 = 5,5%)
 */
export function computeStaggeredPrice(
  basePrice: number,
  accountIndex: number,
  percent: number,
): number {
  // Base inválida/zero/negativa: devolve sem escalar (o caller decide ignorar).
  if (!Number.isFinite(basePrice) || basePrice <= 0) return basePrice;
  // Percentual desativado (0 ou inválido) ⇒ preço base, comportamento atual.
  if (!Number.isFinite(percent) || percent <= 0) return round2(basePrice);
  // 1ª conta (ou índice inválido) ⇒ preço base, sem aumento.
  if (!Number.isFinite(accountIndex) || accountIndex <= 0)
    return round2(basePrice);

  return round2(basePrice * Math.pow(1 + percent / 100, accountIndex));
}

/**
 * Vetor de preços escalonados para `accountCount` contas (índices 0..N-1).
 * Usado pelo preview do wizard para exibir a escada de preços por conta.
 */
export function computeStaggeredPrices(
  basePrice: number,
  accountCount: number,
  percent: number,
): number[] {
  const out: number[] = [];
  for (let i = 0; i < Math.max(0, accountCount); i++) {
    out.push(computeStaggeredPrice(basePrice, i, percent));
  }
  return out;
}
