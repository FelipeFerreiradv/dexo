import { describe, it, expect, beforeEach, vi } from "vitest";
import { NfeRepository } from "../app/repositories/nfe.repository";

// Mock do prisma client usado por NfeRepository.lookupProducts.
const { mockFindMany } = vi.hoisted(() => ({ mockFindMany: vi.fn() }));

vi.mock("../app/lib/prisma", () => ({
  default: {
    product: { findMany: mockFindMany },
  },
}));

/**
 * BLOCO 2 — o picker do financeiro/orçamento usa NfeRepository.lookupProducts.
 * Antes era um OR `contains` puro: "208" casava "1208"/"2089" (over-match).
 * Agora, query "code-like" → igualdade (skuNormalized/sku/partNumber); query
 * descritiva → `contains` (recall preservado).
 */
describe("NfeRepository.lookupProducts — precisão de SKU", () => {
  beforeEach(() => {
    mockFindMany.mockReset();
    mockFindMany.mockResolvedValue([]);
  });

  function whereOf() {
    return mockFindMany.mock.calls[0][0].where;
  }

  it("query code-like (numérica) casa por IGUALDADE, não por contains", async () => {
    const repo = new NfeRepository();
    await repo.lookupProducts("user-1", "208");

    const where = whereOf();
    expect(where.userId).toBe("user-1");
    // Nada de substring `contains` (que casaria "1208"/"2089").
    expect(JSON.stringify(where)).not.toContain("contains");
    expect(where.OR).toEqual(
      expect.arrayContaining([
        { skuNormalized: "208" },
        { sku: { equals: "208", mode: "insensitive" } },
        { partNumber: { equals: "208", mode: "insensitive" } },
      ]),
    );
  });

  it("query code-like alfanumérica normaliza o SKU (case-insensitive)", async () => {
    const repo = new NfeRepository();
    await repo.lookupProducts("user-1", "ABC-1");

    const where = whereOf();
    expect(where.OR).toEqual(
      expect.arrayContaining([{ skuNormalized: "abc-1" }]),
    );
    expect(JSON.stringify(where)).not.toContain("contains");
  });

  it("query descritiva mantém contains (recall do picker preservado)", async () => {
    const repo = new NfeRepository();
    await repo.lookupProducts("user-1", "mola");

    const where = whereOf();
    expect(where.userId).toBe("user-1");
    expect(where.OR).toEqual([
      { name: { contains: "mola", mode: "insensitive" } },
      { sku: { contains: "mola", mode: "insensitive" } },
      { partNumber: { contains: "mola", mode: "insensitive" } },
    ]);
  });

  it("query descritiva multi-palavra mantém contains", async () => {
    const repo = new NfeRepository();
    await repo.lookupProducts("user-1", "filtro de oleo");
    expect(JSON.stringify(whereOf())).toContain("contains");
  });
});
