import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fastify from "fastify";
import { listingRoutes } from "../app/routes/listing.routes";
import { UserRepositoryPrisma } from "../app/repositories/user.repository";
import { ProductRepositoryPrisma } from "../app/repositories/product.repository";
import { MarketplaceRepository } from "../app/marketplaces/repositories/marketplace.repository";
import { ShopeeApiService } from "../app/marketplaces/services/shopee-api.service";

/**
 * POST /listings/bulk/preflight com `categoryOverrides` (Revisão individual).
 *
 * Bug original: o preflight validava SÓ o shopeeCategoryId PERSISTIDO no
 * produto, enquanto a publicação usa a categoria do form da revisão
 * (perProductOverrides.shopee.categoryId). Produto nunca salvo com categoria
 * Shopee reprovava mesmo com categoria válida escolhida na tela — bloqueando
 * o bulk Shopee-only inteiro ("Todos os produtos têm categoria Shopee
 * inválida..."). Agora o preflight valida a categoria EFETIVA
 * (override ?? persistida), o mesmo precedente do dispatch.
 */

vi.mock("../app/marketplaces/usecases/listing.usercase", () => ({
  ListingUseCase: {},
}));

vi.mock("../app/marketplaces/services/listing-dispatcher.service", () => ({
  ListingDispatcher: { dispatch: vi.fn() },
}));

vi.mock(
  "../app/marketplaces/repositories/bulk-listing-job.repository",
  () => ({ BulkListingJobRepository: {} }),
);

vi.mock("../app/marketplaces/repositories/marketplace.repository", () => ({
  MarketplaceRepository: { findByIdAndUser: vi.fn() },
}));

vi.mock("../app/marketplaces/services/shopee-api.service", () => ({
  ShopeeApiService: { assertLeafCategory: vi.fn() },
}));

vi.mock("../app/services/system-log.service", () => ({
  SystemLogService: {
    logError: vi.fn(),
    logWarning: vi.fn(),
    logInfo: vi.fn(),
    log: vi.fn(),
  },
}));

vi.mock("../app/lib/prisma", () => ({
  default: {
    product: { findMany: vi.fn(), findUnique: vi.fn() },
    productListing: { findMany: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));

const fakeUser = {
  id: "user-1",
  email: "test@example.com",
  name: "Test User",
  dataOwnerId: "user-1",
} as any;

const SHOPEE_ACCOUNT = {
  id: "acc-shp-1",
  accessToken: "tok",
  shopId: "138",
} as any;

/** Produtos do cenário: p1 SEM categoria persistida, p2 COM. */
const PRODUCTS: Record<string, { id: string; shopeeCategoryId: string | null }> =
  {
    p1: { id: "p1", shopeeCategoryId: null },
    p2: { id: "p2", shopeeCategoryId: "102297" },
  };

describe("POST /listings/bulk/preflight — categoryOverrides", () => {
  let app: ReturnType<typeof fastify>;
  let leanFetchSpy: any;

  beforeEach(async () => {
    app = fastify();
    await app.register(listingRoutes, { prefix: "/listings" });

    vi.spyOn(UserRepositoryPrisma.prototype, "findByEmail").mockResolvedValue(
      fakeUser,
    );
    vi.spyOn(UserRepositoryPrisma.prototype, "findById").mockResolvedValue(
      fakeUser,
    );
    (MarketplaceRepository.findByIdAndUser as any).mockResolvedValue(
      SHOPEE_ACCOUNT,
    );
    // Projeção egress-lean: o preflight busca só (id, shopeeCategoryId) do
    // lote numa única query — produto inexistente simplesmente não vem.
    leanFetchSpy = vi
      .spyOn(ProductRepositoryPrisma.prototype, "findShopeeCategoryIds")
      .mockImplementation(async (ids: string[]) =>
        ids.filter((id) => PRODUCTS[id]).map((id) => PRODUCTS[id]),
      );
    (ShopeeApiService.assertLeafCategory as any).mockResolvedValue(undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  const preflight = (payload: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: "/listings/bulk/preflight",
      headers: { email: "test@example.com" },
      payload: { shopeeAccountId: "acc-shp-1", ...payload },
    });

  it("sem categoryOverrides mantém o comportamento original (persistida)", async () => {
    const res = await preflight({ productIds: ["p1", "p2"] });

    expect(res.statusCode, res.payload).toBe(200);
    const { issues } = res.json();
    // p1 sem persistida → missing; p2 com persistida válida → ok.
    expect(issues).toEqual([
      expect.objectContaining({
        productId: "p1",
        code: "shopee_category_missing",
      }),
    ]);
    // EGRESS: uma ÚNICA query para o lote (não N findById com linha completa).
    expect(leanFetchSpy).toHaveBeenCalledTimes(1);
    expect(leanFetchSpy).toHaveBeenCalledWith(["p1", "p2"], "user-1");
  });

  it("produto inexistente/de outro dono é pulado sem gerar issue", async () => {
    const res = await preflight({
      productIds: ["p1", "fantasma"],
      categoryOverrides: { fantasma: "102294" },
    });

    expect(res.statusCode, res.payload).toBe(200);
    // p1 → missing; "fantasma" não vem do banco → skip (dispatchBatch reporta).
    expect(res.json().issues).toEqual([
      expect.objectContaining({ productId: "p1" }),
    ]);
  });

  it("override válido supre a persistida ausente (o caso do bug)", async () => {
    const res = await preflight({
      productIds: ["p1"],
      categoryOverrides: { p1: "102294" },
    });

    expect(res.statusCode, res.payload).toBe(200);
    expect(res.json().issues).toEqual([]);
    expect(ShopeeApiService.assertLeafCategory).toHaveBeenCalledWith(
      "tok",
      "138",
      102294,
    );
  });

  it("override com prefixo SHP_ (externalId da árvore) é normalizado", async () => {
    const res = await preflight({
      productIds: ["p1"],
      categoryOverrides: { p1: "SHP_102294" },
    });

    expect(res.statusCode, res.payload).toBe(200);
    expect(res.json().issues).toEqual([]);
    expect(ShopeeApiService.assertLeafCategory).toHaveBeenCalledWith(
      "tok",
      "138",
      102294,
    );
  });

  it("override não-folha vira shopee_category_not_leaf", async () => {
    (ShopeeApiService.assertLeafCategory as any).mockRejectedValue(
      new Error("should use leaf category"),
    );
    const res = await preflight({
      productIds: ["p1"],
      categoryOverrides: { p1: "102000" },
    });

    expect(res.statusCode, res.payload).toBe(200);
    expect(res.json().issues).toEqual([
      expect.objectContaining({
        productId: "p1",
        code: "shopee_category_not_leaf",
      }),
    ]);
  });

  it("mistura: override para um produto, persistida para o outro", async () => {
    const res = await preflight({
      productIds: ["p1", "p2"],
      categoryOverrides: { p1: "102294" },
    });

    expect(res.statusCode, res.payload).toBe(200);
    expect(res.json().issues).toEqual([]);
    const validated = (ShopeeApiService.assertLeafCategory as any).mock.calls.map(
      (c: any[]) => c[2],
    );
    expect(validated).toEqual([102294, 102297]);
  });

  it("override vazio/whitespace não substitui a persistida", async () => {
    const res = await preflight({
      productIds: ["p1"],
      categoryOverrides: { p1: "   " },
    });

    expect(res.statusCode, res.payload).toBe(200);
    expect(res.json().issues).toEqual([
      expect.objectContaining({
        productId: "p1",
        code: "shopee_category_missing",
      }),
    ]);
  });
});
