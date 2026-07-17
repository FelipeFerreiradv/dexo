import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Engine da inferência: guards de título (ambíguo/composto), coleta de votos
 * e caches. Os guards vêm de casos REAIS da validação com 800 produtos:
 * "REATOR farol" vendia reator, não farol; "Lanterna TAMPA Voyage" é a
 * lanterna da tampa (folha própria), não Faróis Traseiros.
 */

const { mockFindFirst, mockFindUnique } = vi.hoisted(() => ({
  mockFindFirst: vi.fn(),
  mockFindUnique: vi.fn(),
}));

vi.mock("../app/lib/prisma", () => ({
  default: {
    catalogStat: { findFirst: mockFindFirst },
    marketplaceCategory: { findUnique: mockFindUnique },
  },
}));

import { CategoryInferenceEngine } from "../app/marketplaces/lib/category-inference/engine";

describe("CategoryInferenceEngine.collectVotes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    CategoryInferenceEngine.__clearCache();
    mockFindFirst.mockResolvedValue(null);
    mockFindUnique.mockResolvedValue(null);
  });

  it("título com tipo conhecido e mapeado → voto do mapa + pieceType", async () => {
    const res = await CategoryInferenceEngine.collectVotes(
      "MLB",
      "Farol Gol G5 2010",
    );
    expect(res.pieceType).toBe("farol");
    const mapVote = res.votes.find((v) => v.signal === "part-type-map");
    expect(mapVote).toMatchObject({ externalId: "MLB7863" });
  });

  it("sem tipo de peça reconhecível → sem votos", async () => {
    const res = await CategoryInferenceEngine.collectVotes(
      "MLB",
      "Produto genérico qualquer",
    );
    expect(res).toEqual({ votes: [], pieceType: null });
    expect(mockFindFirst).not.toHaveBeenCalled();
  });

  it("label ambíguo ('tampa', 'sensor') → sem votos, nem via base interna", async () => {
    for (const title of [
      "Tampa Caixa Filtro Ar Gol G3",
      "Sensor Traseiro Gol G4 2008",
    ]) {
      const res = await CategoryInferenceEngine.collectVotes("MLB", title);
      expect(res.votes, title).toEqual([]);
    }
    expect(mockFindFirst).not.toHaveBeenCalled();
  });

  it("título composto (componente de outra peça) → sem votos", async () => {
    for (const title of [
      "Reator Farol Direito Haval H6 2023",
      "Par dobradica capo C4 Pallas 2008",
      "Parafusos do cabeçote Captiva 2.4",
      "Hard Disk Cinta Airbag Mercedes C180",
      "Lanterna Tampa Esquerda Voyage G6 2013", // "tampa" fora do tipo extraído
    ]) {
      const res = await CategoryInferenceEngine.collectVotes("MLB", title);
      expect(res.votes, title).toEqual([]);
    }
  });

  it("label cujo NOME contém termo ambíguo não se auto-bloqueia", async () => {
    // "tampa-de-reservatorio" contém "tampa", mas o token pertence ao próprio
    // tipo — não é um segundo tipo no título.
    const res = await CategoryInferenceEngine.collectVotes(
      "MLB",
      "Tampa de reservatorio Gol 2010",
    );
    expect(res.pieceType).toBe("tampa-de-reservatorio");
    // (a entrada pode ou não estar no mapa; o que importa é não ter sido
    // bloqueada pelo guard — pieceType presente prova que passou)
  });

  it("Sinal B: consulta a família exata com colunas kebab e converte cuid→externalId", async () => {
    mockFindFirst.mockResolvedValue({
      mlCategoryIdMode: "cuid-farol",
      mlCategoryIdModeCount: 20,
      shopeeCategoryIdMode: null,
      shopeeCategoryIdModeCount: null,
      sampleSize: 25,
    });
    mockFindUnique.mockResolvedValue({ externalId: "MLB7863" });

    const res = await CategoryInferenceEngine.collectVotes(
      "MLB",
      "Farol Fiat Palio 2010",
    );
    const statVote = res.votes.find((v) => v.signal === "catalog-stat");
    expect(statVote?.externalId).toBe("MLB7863");
    expect(mockFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          partType: "farol",
          brand: "fiat",
          model: "palio",
          version: "*",
        }),
      }),
    );
  });

  it("cache: segunda chamada da mesma família não repete a consulta", async () => {
    mockFindFirst.mockResolvedValue(null);
    await CategoryInferenceEngine.collectVotes("MLB", "Farol Fiat Palio 2010");
    const calls = mockFindFirst.mock.calls.length;
    await CategoryInferenceEngine.collectVotes("MLB", "Farol Fiat Palio 2012");
    expect(mockFindFirst.mock.calls.length).toBe(calls);
  });

  it("prisma explodindo → sem votos (fail-open), sem lançar", async () => {
    mockFindFirst.mockRejectedValue(new Error("db caiu"));
    const res = await CategoryInferenceEngine.collectVotes(
      "MLB",
      "Farol Fiat Palio 2010",
    );
    // O voto do mapa (síncrono, sem DB) sobrevive; o da base interna some.
    expect(res.votes.some((v) => v.signal === "catalog-stat")).toBe(false);
    expect(res.votes.some((v) => v.signal === "part-type-map")).toBe(true);
  });
});
