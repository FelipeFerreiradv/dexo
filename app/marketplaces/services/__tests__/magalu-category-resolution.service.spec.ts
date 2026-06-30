import { describe, it, expect, vi, beforeEach } from "vitest";
import { MagaluApiService } from "../magalu-api.service";
import { MagaluCategoryResolutionService } from "../magalu-category-resolution.service";
import { MAGALU_CATEGORY_MAP } from "../../magalu/magalu-category-map";

vi.mock("../magalu-api.service");

beforeEach(() => {
  vi.restoreAllMocks();
  for (const k of Object.keys(MAGALU_CATEGORY_MAP)) delete MAGALU_CATEGORY_MAP[k];
});

describe("MagaluCategoryResolutionService.resolveCategoryId", () => {
  it("usa product.magaluCategoryId quando presente (sem buscar)", async () => {
    const id = await MagaluCategoryResolutionService.resolveCategoryId("tok", {
      magaluCategoryId: "cat-x",
      name: "Foo",
    });
    expect(id).toBe("cat-x");
  });

  it("de-para: casa o tipo da peça antes de buscar (prefixo mais longo)", async () => {
    MAGALU_CATEGORY_MAP["tampa"] = "cat-tampa";
    MAGALU_CATEGORY_MAP["tampa reservatorio"] = "cat-reservatorio";
    (MagaluApiService as any).searchCategories = vi.fn();
    const id = await MagaluCategoryResolutionService.resolveCategoryId("tok", {
      name: "Tampa Reservatório Renault Sandero 2009",
    });
    expect(id).toBe("cat-reservatorio"); // prefixo mais longo vence
    expect(MagaluApiService.searchCategories).not.toHaveBeenCalled(); // não busca
  });

  it("de-para: ignora chave que não é prefixo do nome", async () => {
    MAGALU_CATEGORY_MAP["farol"] = "cat-farol";
    (MagaluApiService as any).searchCategories = vi.fn().mockResolvedValue([]);
    const id = await MagaluCategoryResolutionService.resolveCategoryId("tok", {
      name: "Tampa Reservatorio",
    });
    expect(id).toBeNull(); // "farol" não casa → cai na busca (vazia) → null
  });

  it("viés de domínio: prefere o resultado no path do hint (Veículos e Peças)", async () => {
    // Nome cru não acha; só a 1ª palavra ("Tampa") acha, e entre os resultados
    // pega o que está em "Veículos e Peças" (não o de cozinha).
    (MagaluApiService as any).searchCategories = vi
      .fn()
      .mockResolvedValueOnce([]) // "Tampa Reservatorio Renault Sandero 2009"
      .mockResolvedValueOnce([]) // "Tampa Reservatorio Renault"
      .mockResolvedValueOnce([]) // "Tampa Reservatorio"
      .mockResolvedValueOnce([
        { id: "cozinha", path: "Casa e Jardim/Utensílios/Tampa Champagne" },
        { id: "auto", path: "Veículos e Peças/Peças de Motor/Junta da Tampa" },
      ]); // "Tampa"
    const id = await MagaluCategoryResolutionService.resolveCategoryId("tok", {
      name: "Tampa Reservatorio Renault Sandero 2009",
    });
    expect(id).toBe("auto");
  });

  it("retorna null quando há resultados mas nenhum no domínio", async () => {
    (MagaluApiService as any).searchCategories = vi
      .fn()
      .mockResolvedValue([
        { id: "x", path: "Casa e Jardim/Utensílios/Tampa Champagne" },
      ]);
    const id = await MagaluCategoryResolutionService.resolveCategoryId("tok", {
      name: "Tampa",
    });
    expect(id).toBeNull();
  });

  it("hint vazio: cai no 1º resultado", async () => {
    (MagaluApiService as any).searchCategories = vi
      .fn()
      .mockResolvedValue([{ id: "c1", path: "Qualquer" }]);
    const id = await MagaluCategoryResolutionService.resolveCategoryId("tok", {
      name: "Tampa",
      magaluCategoryRootHint: "",
    });
    expect(id).toBe("c1");
  });

  it("retorna null quando não há nome nem id", async () => {
    expect(
      await MagaluCategoryResolutionService.resolveCategoryId("tok", {}),
    ).toBeNull();
  });
});

describe("MagaluCategoryResolutionService.buildCategoryFields", () => {
  it("preenche required mapeados do produto + fallback p/ não mapeados", async () => {
    (MagaluApiService as any).getCategoryAttributes = vi.fn().mockResolvedValue([
      {
        id: "a1",
        name: "Cor",
        required: "required",
        variation: true,
        type: "choice",
        choices: ["Preto", "Branco"],
      },
    ]);
    (MagaluApiService as any).getCategoryDatasheet = vi.fn().mockResolvedValue([
      { id: "d1", name: "Marca", required: "required", type: "text" },
      { id: "d2", name: "Garantia", required: "required", type: "text" },
      { id: "d3", name: "Linha", required: "recommended", type: "text" },
    ]);

    const f = await MagaluCategoryResolutionService.buildCategoryFields(
      "tok",
      "cat-1",
      { brand: "Renault" },
    );

    expect(f.category).toEqual({ id: "cat-1" });
    // Cor sem product.color → fallback choices[0]
    expect(f.attributes).toEqual([{ name: "Cor", value: "Preto" }]);
    // Marca → product.brand; Garantia → "3 meses" (default); Linha (recommended) ignorada
    expect(f.datasheet).toEqual([
      { name: "Marca", value: "Renault" },
      { name: "Garantia", value: "3 meses" },
    ]);
    expect(f.usedFallback).toContain("Cor");
    expect(f.usedFallback).not.toContain("Marca");
  });

  it("limita attributes a 3 e ignora não-obrigatórios", async () => {
    (MagaluApiService as any).getCategoryAttributes = vi.fn().mockResolvedValue([
      { id: "1", name: "A1", required: "required", choices: ["x"] },
      { id: "2", name: "A2", required: "required", choices: ["x"] },
      { id: "3", name: "A3", required: "required", choices: ["x"] },
      { id: "4", name: "A4", required: "required", choices: ["x"] },
      { id: "5", name: "A5", required: "optional", choices: ["x"] },
    ]);
    (MagaluApiService as any).getCategoryDatasheet = vi.fn().mockResolvedValue([]);
    const f = await MagaluCategoryResolutionService.buildCategoryFields(
      "tok",
      "cat-1",
      {},
    );
    expect(f.attributes).toHaveLength(3);
  });
});
