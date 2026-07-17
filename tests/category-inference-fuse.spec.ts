import { describe, it, expect } from "vitest";
import {
  MAX_CONFIDENCE,
  fuseVotes,
  shouldAutoApply,
} from "../app/marketplaces/lib/category-inference/fuse";
import type { CategoryVote } from "../app/marketplaces/lib/category-inference/types";

/**
 * Fusão noisy-or: as propriedades daqui são INVARIANTES anti-regressão do
 * motor — em especial a monotonicidade (voto novo nunca reduz confiança) e o
 * keyword nunca auto-aplicar sozinho.
 */

const vote = (over: Partial<CategoryVote>): CategoryVote => ({
  externalId: "MLB1",
  strength: 0.5,
  signal: "part-type-map",
  reason: "r",
  ...over,
});

describe("fuseVotes", () => {
  it("noisy-or: dois sinais médios concordando valem mais que qualquer um sozinho", () => {
    const [fused] = fuseVotes([
      vote({ strength: 0.85, signal: "part-type-map" }),
      vote({ strength: 0.75, signal: "catalog-stat" }),
    ]);
    expect(fused.confidence).toBeCloseTo(1 - 0.15 * 0.25, 10); // 0.9625
    expect(fused.signals).toEqual(["part-type-map", "catalog-stat"]);
  });

  it("teto MAX_CONFIDENCE: nenhuma inferência vira certeza", () => {
    const [fused] = fuseVotes([
      vote({ strength: 0.99 }),
      vote({ strength: 0.99, signal: "catalog-stat" }),
      vote({ strength: 0.99, signal: "alias" }),
    ]);
    expect(fused.confidence).toBe(MAX_CONFIDENCE);
  });

  it("MONOTONICIDADE: adicionar um voto nunca reduz a confiança", () => {
    const base = [vote({ strength: 0.8 })];
    const withWeak = [...base, vote({ strength: 0.05, signal: "keyword" })];
    const a = fuseVotes(base)[0].confidence;
    const b = fuseVotes(withWeak)[0].confidence;
    expect(b).toBeGreaterThanOrEqual(a);
  });

  it("votos em categorias diferentes não se misturam; ordena por confiança", () => {
    const fused = fuseVotes([
      vote({ externalId: "MLB1", strength: 0.3 }),
      vote({ externalId: "MLB2", strength: 0.9, signal: "catalog-stat" }),
    ]);
    expect(fused.map((f) => f.externalId)).toEqual(["MLB2", "MLB1"]);
  });

  it("ignora votos sem categoria ou com força zero; deduplica razões", () => {
    const fused = fuseVotes([
      vote({ externalId: "", strength: 0.9 }),
      vote({ strength: 0 }),
      vote({ strength: 0.5, reason: "mesma razão" }),
      vote({ strength: 0.4, signal: "alias", reason: "mesma razão" }),
    ]);
    expect(fused).toHaveLength(1);
    expect(fused[0].reasons).toEqual(["mesma razão"]);
  });
});

describe("shouldAutoApply", () => {
  it("keyword sozinho NUNCA auto-aplica, mesmo com força alta", () => {
    const [fused] = fuseVotes([vote({ strength: 0.9, signal: "keyword" })]);
    expect(shouldAutoApply(fused)).toBe(false);
  });

  it("mapa curado sozinho com força alta auto-aplica", () => {
    const [fused] = fuseVotes([
      vote({ strength: 0.85, signal: "part-type-map" }),
    ]);
    expect(shouldAutoApply(fused)).toBe(true);
  });

  it("mapa curado sozinho com força descontada (domain-discovery) NÃO auto-aplica", () => {
    const [fused] = fuseVotes([
      vote({ strength: 0.765, signal: "part-type-map" }),
    ]);
    expect(shouldAutoApply(fused)).toBe(false);
  });

  it("dois sinais distintos concordando acima do limiar auto-aplicam", () => {
    const [fused] = fuseVotes([
      vote({ strength: 0.6, signal: "catalog-stat" }),
      vote({ strength: 0.5, signal: "alias" }),
    ]);
    expect(fused.confidence).toBeGreaterThanOrEqual(0.75);
    expect(shouldAutoApply(fused)).toBe(true);
  });

  it("abaixo do limiar de confiança nunca auto-aplica", () => {
    const [fused] = fuseVotes([
      vote({ strength: 0.4, signal: "catalog-stat" }),
      vote({ strength: 0.4, signal: "alias" }),
    ]);
    expect(fused.confidence).toBeLessThan(0.75);
    expect(shouldAutoApply(fused)).toBe(false);
  });
});
