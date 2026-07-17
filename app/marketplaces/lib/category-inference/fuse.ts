/**
 * Fusão de votos por categoria (noisy-or) + regra de auto-aplicação.
 *
 * noisy-or: confidence = 1 − Π(1 − sᵢ). Propriedades que interessam aqui:
 *  - MONOTÔNICA: adicionar um voto NUNCA reduz a confiança de uma categoria
 *    (invariante anti-regressão — a fusão não pode piorar o que já acerta);
 *  - CONCORDÂNCIA EMERGENTE: dois sinais independentes médios (0.85 e 0.75)
 *    valem mais que qualquer um sozinho (→ 0.96), sem pesos mágicos;
 *  - um voto fraco discordante (keyword 0.2) não polui os fortes.
 *
 * Teto MAX_CONFIDENCE < 1: nenhuma inferência é certeza — o usuário sempre
 * pode trocar a categoria.
 */

import type { CategoryVote, FusedCandidate, SignalKind } from "./types";

export const MAX_CONFIDENCE = 0.98;

/** Limiar mínimo de confiança para auto-aplicação por fusão. */
export const AUTO_APPLY_MIN_CONFIDENCE = 0.75;

/** Força mínima do mapa curado para auto-aplicar SOZINHO (sem 2º sinal). */
export const AUTO_APPLY_SOLO_MAP_STRENGTH = 0.85;

/** Agrupa votos por externalId e combina as forças via noisy-or. */
export function fuseVotes(votes: CategoryVote[]): FusedCandidate[] {
  const byCategory = new Map<string, CategoryVote[]>();
  for (const vote of votes) {
    if (!vote.externalId || vote.strength <= 0) continue;
    const list = byCategory.get(vote.externalId);
    if (list) list.push(vote);
    else byCategory.set(vote.externalId, [vote]);
  }

  const fused: FusedCandidate[] = [];
  for (const [externalId, categoryVotes] of byCategory) {
    let complement = 1;
    const signals = new Set<SignalKind>();
    const reasons: string[] = [];
    for (const v of categoryVotes) {
      complement *= 1 - Math.min(1, v.strength);
      signals.add(v.signal);
      if (v.reason && !reasons.includes(v.reason)) reasons.push(v.reason);
    }
    fused.push({
      externalId,
      confidence: Math.min(MAX_CONFIDENCE, 1 - complement),
      signals: Array.from(signals),
      reasons,
      votes: categoryVotes,
    });
  }

  return fused.sort((a, b) => b.confidence - a.confidence);
}

/**
 * Auto-aplicação concedida pela FUSÃO (soma-se à regra atual do alias via OR —
 * nunca revoga um autoApply que já existia):
 *  - confiança ≥ 0.75, E
 *  - ≥ 2 sinais DISTINTOS concordando, OU o mapa curado sozinho com força alta.
 * Keyword sozinho nunca auto-aplica (1 sinal e não é o mapa).
 */
export function shouldAutoApply(candidate: FusedCandidate): boolean {
  if (candidate.confidence < AUTO_APPLY_MIN_CONFIDENCE) return false;
  if (candidate.signals.length >= 2) return true;
  return candidate.votes.some(
    (v) =>
      v.signal === "part-type-map" &&
      v.strength >= AUTO_APPLY_SOLO_MAP_STRENGTH,
  );
}
