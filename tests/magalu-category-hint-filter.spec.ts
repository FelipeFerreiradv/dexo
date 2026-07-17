import { describe, it, expect, vi } from "vitest";

vi.mock("@/app/lib/prisma", () => ({ default: {} }));
vi.mock("../app/lib/prisma", () => ({ default: {} }));

import { MagaluCategoryResolutionService } from "../app/marketplaces/services/magalu-category-resolution.service";

const cat = (id: string, path: string) => ({ id, path, name: path });

describe("MagaluCategoryResolutionService.filterCategoriesByRootHint", () => {
  it("mantém só os que começam pelo hint (acento-insensível)", () => {
    const cats = [
      cat("1", "Veículos e Peças > Autopeças > Faróis"),
      cat("2", "Casa e Construção > Cozinha"),
      cat("3", "Veiculos e Pecas > Suspensão"),
    ];
    const out = MagaluCategoryResolutionService.filterCategoriesByRootHint(
      cats as any,
    ).map((c) => c.id);
    expect(out).toEqual(["1", "3"]);
  });

  it("fail-open-to-raw: se nada casa o hint, devolve tudo", () => {
    const cats = [cat("1", "Casa e Construção"), cat("2", "Moda")];
    const out = MagaluCategoryResolutionService.filterCategoriesByRootHint(
      cats as any,
    ).map((c) => c.id);
    expect(out).toEqual(["1", "2"]);
  });

  it("hint vazio devolve tudo (sem viés)", () => {
    const cats = [cat("1", "Casa"), cat("2", "Moda")];
    const out = MagaluCategoryResolutionService.filterCategoriesByRootHint(
      cats as any,
      "",
    ).map((c) => c.id);
    expect(out).toEqual(["1", "2"]);
  });
});
