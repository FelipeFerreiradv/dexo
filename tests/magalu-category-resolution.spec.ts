import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Resolução de categoria Magalu com o motor de inferência por tipo de peça:
 * passo 2.5 (magaluId do mapa resolve SEM chamada de API), termos canônicos
 * liderando a busca progressiva, cache por termo, e — crítico — os fallbacks
 * atuais 100% preservados (explícito, DE-PARA por prefixo, null→DRAFT).
 */

const { mockSearch } = vi.hoisted(() => ({ mockSearch: vi.fn() }));
vi.mock("../app/marketplaces/services/magalu-api.service", () => ({
  MagaluApiService: { searchCategories: mockSearch },
}));

const { mockLookup } = vi.hoisted(() => ({ mockLookup: vi.fn() }));
vi.mock(
  "../app/marketplaces/lib/category-inference/part-type-category-map",
  async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    return { ...actual, lookupPartTypeCategory: mockLookup };
  },
);

import { MagaluCategoryResolutionService } from "../app/marketplaces/services/magalu-category-resolution.service";

const VEICULOS = "Veículos e Peças > Peças Automotivas";

describe("MagaluCategoryResolutionService.resolveCategoryId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    MagaluCategoryResolutionService.__clearSearchCache();
    mockLookup.mockReturnValue(null);
    mockSearch.mockResolvedValue([]);
  });

  it("explícito vence sempre, sem API", async () => {
    const id = await MagaluCategoryResolutionService.resolveCategoryId("tok", {
      magaluCategoryId: "uuid-explicito",
      name: "Farol Palio",
    });
    expect(id).toBe("uuid-explicito");
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it("passo 2.5: magaluId do mapa de inferência resolve SEM chamada de API", async () => {
    mockLookup.mockReturnValue({
      entry: { magaluId: "uuid-farois", source: "manual" },
      key: "farol",
      exact: true,
    });
    const id = await MagaluCategoryResolutionService.resolveCategoryId("tok", {
      name: "Par de Faróis Palio 2010",
    });
    expect(id).toBe("uuid-farois");
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it("termo canônico do tipo lidera a busca progressiva", async () => {
    mockSearch.mockImplementation(async (_tok: string, { name }: any) =>
      name === "farol"
        ? [{ id: "uuid-busca-farol", path: `${VEICULOS} > Faróis` }]
        : [],
    );
    const id = await MagaluCategoryResolutionService.resolveCategoryId("tok", {
      name: "Par de Faróis Palio 2010",
    });
    expect(id).toBe("uuid-busca-farol");
    // 1ª busca já foi com o termo canônico — o nome cru nem precisou.
    expect(mockSearch.mock.calls[0][1]).toEqual({ name: "farol" });
    expect(mockSearch).toHaveBeenCalledTimes(1);
  });

  it("título composto ('Reator Farol') NÃO busca pelo tipo da peça-mãe", async () => {
    await MagaluCategoryResolutionService.resolveCategoryId("tok", {
      name: "Reator Farol Palio 2010",
    });
    const termos = mockSearch.mock.calls.map((c: any[]) => c[1].name);
    expect(termos[0]).toBe("Reator Farol Palio 2010"); // cauda atual, sem canônico
    expect(termos).not.toContain("farol");
  });

  // "bandeja" não tem DE-PARA por prefixo — exercita a busca de verdade.
  it("viés de domínio preservado: fora do domínio → null (DRAFT)", async () => {
    mockSearch.mockResolvedValue([
      { id: "uuid-cozinha", path: "Casa e Cozinha > Utensílios" },
    ]);
    const id = await MagaluCategoryResolutionService.resolveCategoryId("tok", {
      name: "Bandeja Palio 2010",
    });
    expect(id).toBeNull();
  });

  it("cache por termo: mesma busca não repete a chamada", async () => {
    mockSearch.mockResolvedValue([]);
    await MagaluCategoryResolutionService.resolveCategoryId("tok", {
      name: "Bandeja Palio 2010",
    });
    const calls = mockSearch.mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    await MagaluCategoryResolutionService.resolveCategoryId("tok", {
      name: "Bandeja Palio 2010",
    });
    // Todos os termos do 2º produto (idênticos) vieram do cache.
    expect(mockSearch.mock.calls.length).toBe(calls);
  });

  it("DE-PARA por prefixo continua vencendo a busca (comportamento atual)", async () => {
    const id = await MagaluCategoryResolutionService.resolveCategoryId("tok", {
      name: "Farol Palio 2010",
    });
    // "farol" está no MAGALU_CATEGORY_MAP real — resolve no passo 2, sem API.
    expect(id).toBe("298cf208-e58e-4783-80e5-c907c01f7e0d");
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it("sem tipo reconhecível a cauda atual segue intacta (nome → 3 → 2 → 1)", async () => {
    await MagaluCategoryResolutionService.resolveCategoryId("tok", {
      name: "Peca Generica Qualquer Coisa",
    });
    const termos = mockSearch.mock.calls.map((c: any[]) => c[1].name);
    expect(termos).toEqual([
      "Peca Generica Qualquer Coisa",
      "Peca Generica Qualquer",
      "Peca Generica",
      "Peca",
    ]);
  });
});
