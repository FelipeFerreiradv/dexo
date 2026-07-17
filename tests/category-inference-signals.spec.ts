import { describe, it, expect, vi } from "vitest";
import {
  partTypeMapVote,
  catalogStatVote,
  type CatalogStatDeps,
  type CatalogStatModes,
} from "../app/marketplaces/lib/category-inference/signals";
import type { PartTypeCategoryMap } from "../app/marketplaces/lib/category-inference/part-type-category-map";

/**
 * Sinais A (mapa curado) e B (base interna). Contratos críticos:
 *  - namespace: voto SEMPRE no id da árvore local (MLB… / SHP_…);
 *  - fail-safe: sem dado/cuid órfão/erro → SEM voto (nunca lança);
 *  - gates da família partType-only (modeShare) aplicados aqui, não no caller.
 */

const MAP: PartTypeCategoryMap = {
  farol: { ml: "MLB7863", shopee: "102297", source: "prod-mode" },
  "parachoque-dianteiro": { ml: "MLB63801", source: "prod-mode" },
  lanterna: { ml: "MLB22645", source: "domain-discovery" },
};

describe("partTypeMapVote (Sinal A)", () => {
  it("ML: chave sem posição casando como extraída = match pleno (0.9)", () => {
    const vote = partTypeMapVote("MLB", { partType: "farol", position: null }, MAP);
    expect(vote).toMatchObject({
      externalId: "MLB7863",
      strength: 0.9,
      signal: "part-type-map",
    });
  });

  it("cair para a base descartando a posição custa força (0.85)", () => {
    const vote = partTypeMapVote(
      "MLB",
      { partType: "farol-dianteiro-esquerdo", position: "dianteiro-esquerdo" },
      MAP,
    );
    expect(vote).toMatchObject({ externalId: "MLB7863", strength: 0.85 });
  });

  it("Shopee: prefixa SHP_ (mapa guarda o id puro, árvore usa prefixo)", () => {
    const vote = partTypeMapVote("SHP", { partType: "farol", position: null }, MAP);
    expect(vote?.externalId).toBe("SHP_102297");
  });

  it("chave dobrada exata ganha força maior", () => {
    const vote = partTypeMapVote(
      "MLB",
      { partType: "parachoque-dianteiro", position: "dianteiro" },
      MAP,
    );
    expect(vote?.strength).toBe(0.9);
  });

  it("entrada domain-discovery leva desconto", () => {
    const vote = partTypeMapVote("MLB", { partType: "lanterna", position: null }, MAP);
    expect(vote?.strength).toBeCloseTo(0.9 * 0.85, 10);
  });

  it("sem partType, sem cobertura do marketplace ou site desconhecido → null", () => {
    expect(partTypeMapVote("MLB", { partType: null, position: null }, MAP)).toBeNull();
    expect(
      partTypeMapVote("SHP", { partType: "lanterna", position: null }, MAP),
    ).toBeNull();
    expect(
      partTypeMapVote("MLA", { partType: "farol", position: null }, MAP),
    ).toBeNull();
  });
});

const modes = (over: Partial<CatalogStatModes>): CatalogStatModes => ({
  mlCategoryIdMode: null,
  mlCategoryIdModeCount: null,
  shopeeCategoryIdMode: null,
  shopeeCategoryIdModeCount: null,
  sampleSize: 0,
  ...over,
});

const makeDeps = (over: Partial<CatalogStatDeps> = {}): CatalogStatDeps => ({
  findFamilyModes: vi.fn(async () => null),
  findPartTypeOnlyModes: vi.fn(async () => null),
  mlCuidToExternalId: vi.fn(async () => null),
  ...over,
});

const PARTS = { partType: "farol", brand: "Fiat", model: "Palio" };

describe("catalogStatVote (Sinal B)", () => {
  it("família exata: converte cuid→externalId e escala força com amostra/moda", () => {
    const deps = makeDeps({
      findFamilyModes: vi.fn(async () =>
        modes({
          mlCategoryIdMode: "cuid-farol",
          mlCategoryIdModeCount: 30,
          sampleSize: 30,
        }),
      ),
      mlCuidToExternalId: vi.fn(async () => "MLB7863"),
    });

    return catalogStatVote("MLB", PARTS, deps).then((vote) => {
      expect(vote).toMatchObject({ externalId: "MLB7863", signal: "catalog-stat" });
      // 0.55 + 0.15*log10(30) + 0.15*1 ≈ 0.9216 → cap 0.85
      expect(vote?.strength).toBe(0.85);
      expect(deps.findPartTypeOnlyModes).not.toHaveBeenCalled();
    });
  });

  it("Shopee: usa a moda shopee com prefixo SHP_, sem conversão de cuid", async () => {
    const deps = makeDeps({
      findFamilyModes: vi.fn(async () =>
        modes({
          shopeeCategoryIdMode: "102297",
          shopeeCategoryIdModeCount: 8,
          sampleSize: 10,
        }),
      ),
    });
    const vote = await catalogStatVote("SHP", PARTS, deps);
    expect(vote?.externalId).toBe("SHP_102297");
    expect(deps.mlCuidToExternalId).not.toHaveBeenCalled();
  });

  it("cuid órfão (fora da árvore) → sem voto, sem erro", async () => {
    const deps = makeDeps({
      findFamilyModes: vi.fn(async () =>
        modes({
          mlCategoryIdMode: "cuid-orfao",
          mlCategoryIdModeCount: 20,
          sampleSize: 20,
        }),
      ),
      mlCuidToExternalId: vi.fn(async () => null),
    });
    expect(await catalogStatVote("MLB", PARTS, deps)).toBeNull();
  });

  it("sem brand/model cai direto na família partType-only", async () => {
    const deps = makeDeps({
      findPartTypeOnlyModes: vi.fn(async () =>
        modes({
          mlCategoryIdMode: "cuid-farol",
          mlCategoryIdModeCount: 50,
          sampleSize: 100,
        }),
      ),
      mlCuidToExternalId: vi.fn(async () => "MLB7863"),
    });
    const vote = await catalogStatVote(
      "MLB",
      { partType: "farol", brand: null, model: null },
      deps,
    );
    expect(deps.findFamilyModes).not.toHaveBeenCalled();
    expect(vote?.externalId).toBe("MLB7863");
    // família partType-only é descontada e tem teto próprio
    expect(vote!.strength).toBeLessThanOrEqual(0.65);
  });

  it("partType-only com moda difusa (share < 0.3) → sem voto", async () => {
    const deps = makeDeps({
      findPartTypeOnlyModes: vi.fn(async () =>
        modes({
          mlCategoryIdMode: "cuid-farol",
          mlCategoryIdModeCount: 20,
          sampleSize: 100,
        }),
      ),
      mlCuidToExternalId: vi.fn(async () => "MLB7863"),
    });
    expect(
      await catalogStatVote("MLB", { ...PARTS, brand: null, model: null }, deps),
    ).toBeNull();
  });

  it("sem partType → null; erro nas deps → null (fail-safe)", async () => {
    expect(
      await catalogStatVote("MLB", { ...PARTS, partType: null }, makeDeps()),
    ).toBeNull();
    const deps = makeDeps({
      findFamilyModes: vi.fn(async () => {
        throw new Error("db down");
      }),
    });
    expect(await catalogStatVote("MLB", PARTS, deps)).toBeNull();
  });
});
