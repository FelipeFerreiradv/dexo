import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fastify from "fastify";

// Stub do prisma (dependência transitiva) + auth permissivo.
vi.mock("@/app/lib/prisma", () => ({ default: {} }));
vi.mock("../app/lib/prisma", () => ({ default: {} }));
vi.mock("../app/middlewares/auth.middleware", () => ({
  authMiddleware: async () => {},
}));

import CategoryRepository from "../app/marketplaces/repositories/category.repository";
import { __resetCategoryGuardCacheForTests } from "../app/marketplaces/services/category-resolution.service";
import { marketplaceRoutes } from "../app/routes/marketplace.routes";

// Árvore MLB: MLB5672 (raiz veicular) com descendentes; MLB_CASA fora da raiz.
const ML_TREE = [
  { externalId: "MLB5672", parentExternalId: null },
  { externalId: "MLB1743", parentExternalId: "MLB5672" },
  { externalId: "MLB101763", parentExternalId: "MLB1743" },
  { externalId: "MLB_MOTOS", parentExternalId: "MLB5672" },
  { externalId: "MLB_CASA", parentExternalId: null },
];
const ML_FLAT = [
  { externalId: "MLB5672", fullPath: "Acessorios para Veiculos" },
  {
    externalId: "MLB1743",
    fullPath: "Acessorios para Veiculos > Pecas de Carros e Caminhonetes",
  },
  {
    externalId: "MLB101763",
    fullPath:
      "Acessorios para Veiculos > Pecas de Carros e Caminhonetes > Portas",
  },
  {
    externalId: "MLB_MOTOS",
    fullPath: "Acessorios para Veiculos > Motos e Quadriciclos > Escapamentos",
  },
  { externalId: "MLB_CASA", fullPath: "Casa, Moveis e Decoracao > Cozinha" },
];

const SHP_FLAT = [
  { externalId: "SHP1", fullPath: "Veiculos e Pecas > Pecas Automotivas" },
  { externalId: "SHP2", fullPath: "Motocicletas > Pecas" },
  { externalId: "SHP3", fullPath: "Casa e Decoracao > Cozinha" },
  { externalId: "SHP4", fullPath: "Automotivo > Oleo" },
];

const idsOf = (payload: string): string[] =>
  JSON.parse(payload)
    .categories.map((c: any) => c.id)
    .sort();

describe("GET /marketplace/ml/categories — filtro de nicho", () => {
  let app: ReturnType<typeof fastify>;
  beforeEach(async () => {
    __resetCategoryGuardCacheForTests();
    app = fastify();
    await app.register(marketplaceRoutes, { prefix: "/marketplace" });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  it("por padrão devolve só descendentes de MLB5672, sem ramos bloqueados", async () => {
    vi.spyOn(CategoryRepository, "listFlattenedOptions").mockResolvedValue(
      ML_FLAT as any,
    );
    vi.spyOn(CategoryRepository, "listWithParents").mockResolvedValue(
      ML_TREE as any,
    );
    const res = await app.inject({
      method: "GET",
      url: "/marketplace/ml/categories",
    });
    expect(res.statusCode).toBe(200);
    // MLB_MOTOS cai por ramo bloqueado; MLB_CASA por estar fora da raiz.
    expect(idsOf(res.payload)).toEqual(["MLB101763", "MLB1743", "MLB5672"]);
  });

  it("?all=1 desliga o filtro (todas as categorias)", async () => {
    vi.spyOn(CategoryRepository, "listFlattenedOptions").mockResolvedValue(
      ML_FLAT as any,
    );
    vi.spyOn(CategoryRepository, "listWithParents").mockResolvedValue(
      ML_TREE as any,
    );
    const res = await app.inject({
      method: "GET",
      url: "/marketplace/ml/categories?all=1",
    });
    expect(idsOf(res.payload)).toEqual([
      "MLB101763",
      "MLB1743",
      "MLB5672",
      "MLB_CASA",
      "MLB_MOTOS",
    ]);
  });

  it("fail-open: árvore não sincronizada (set vazio) devolve tudo", async () => {
    vi.spyOn(CategoryRepository, "listFlattenedOptions").mockResolvedValue(
      ML_FLAT as any,
    );
    vi.spyOn(CategoryRepository, "listWithParents").mockResolvedValue([] as any);
    const res = await app.inject({
      method: "GET",
      url: "/marketplace/ml/categories",
    });
    expect(idsOf(res.payload)).toEqual([
      "MLB101763",
      "MLB1743",
      "MLB5672",
      "MLB_CASA",
      "MLB_MOTOS",
    ]);
  });
});

describe("GET /marketplace/shopee/categories — filtro de nicho", () => {
  let app: ReturnType<typeof fastify>;
  beforeEach(async () => {
    __resetCategoryGuardCacheForTests();
    app = fastify();
    await app.register(marketplaceRoutes, { prefix: "/marketplace" });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  it("mantém automotivas, dropa bloqueadas (motos) e fora do nicho", async () => {
    vi.spyOn(CategoryRepository, "listFlattenedOptions").mockResolvedValue(
      SHP_FLAT as any,
    );
    const res = await app.inject({
      method: "GET",
      url: "/marketplace/shopee/categories",
    });
    expect(idsOf(res.payload)).toEqual(["SHP1", "SHP4"]);
  });

  it("?all=1 devolve tudo", async () => {
    vi.spyOn(CategoryRepository, "listFlattenedOptions").mockResolvedValue(
      SHP_FLAT as any,
    );
    const res = await app.inject({
      method: "GET",
      url: "/marketplace/shopee/categories?all=1",
    });
    expect(idsOf(res.payload)).toEqual(["SHP1", "SHP2", "SHP3", "SHP4"]);
  });

  it("fail-open-to-raw: sem marcador automotivo, devolve os NÃO-bloqueados", async () => {
    const noMarkers = [
      { externalId: "X1", fullPath: "Ferramentas > Chaves" },
      { externalId: "X2", fullPath: "Motocicletas > Pecas" },
    ];
    vi.spyOn(CategoryRepository, "listFlattenedOptions").mockResolvedValue(
      noMarkers as any,
    );
    const res = await app.inject({
      method: "GET",
      url: "/marketplace/shopee/categories",
    });
    // X2 bloqueada (motocicleta) cai; X1 sobrevive via fail-open-to-raw.
    expect(idsOf(res.payload)).toEqual(["X1"]);
  });
});
