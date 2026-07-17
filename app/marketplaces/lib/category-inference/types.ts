/**
 * Contratos do motor de inferência de categoria (ML/Shopee/Magalu).
 *
 * A inferência trabalha com VOTOS: cada sinal independente (mapa curado por
 * tipo de peça, base interna agregada, alias, keyword) emite no máximo um voto
 * por categoria, com uma força 0–1. A fusão (fuse.ts) combina votos por
 * categoria via noisy-or — sinais independentes concordando elevam a confiança
 * naturalmente, sem pesos mágicos de "concordância".
 *
 * Namespace: `externalId` é SEMPRE o id da árvore local sincronizada
 * (MarketplaceCategory.externalId): "MLB…" para o Mercado Livre e "SHP_<id>"
 * para a Shopee. Quem produz voto a partir de outro namespace (cuid do ML,
 * id numérico puro da Shopee) converte ANTES de votar.
 */

export type SignalKind = "part-type-map" | "catalog-stat" | "alias" | "keyword";

export interface CategoryVote {
  /** externalId no namespace da árvore local (MLB… / SHP_…). */
  externalId: string;
  /** Força do sinal, 0–1. */
  strength: number;
  signal: SignalKind;
  /** Razão legível — vai direto para o `reasons[]` da sugestão. */
  reason: string;
}

export interface FusedCandidate {
  externalId: string;
  /** Confiança combinada (noisy-or, teto em MAX_CONFIDENCE). */
  confidence: number;
  /** Sinais DISTINTOS que votaram nesta categoria. */
  signals: SignalKind[];
  /** Razões deduplicadas, na ordem dos votos. */
  reasons: string[];
  /** Votos originais (para regras que dependem da força por sinal). */
  votes: CategoryVote[];
}
