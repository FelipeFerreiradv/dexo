import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fastify from "fastify";

/**
 * O ELO QUE JÁ QUEBROU UMA VEZ.
 *
 * Na correção das categorias eu consertei `GET /categories` — e a tela lê
 * `GET /category-suggest`. O código ficou certo, o sintoma ficou idêntico, e só
 * o teste em produção mostrou. A lição não é "prestar mais atenção": é travar o
 * ENDPOINT QUE A TELA CONSOME, não o vizinho de nome parecido.
 *
 * O link do Facebook depende de um dado que nasce na conta (`fbCatalogId`) e
 * precisa atravessar uma rota até o componente. Resolver o link certo não
 * adianta nada se o payload chegar sem o campo — o botão volta a ficar
 * desabilitado e ninguém percebe, porque o resolvedor continua verde.
 *
 * Aqui trava-se o `GET /listings/status`, que é o que o modal "Anúncios
 * publicados" da tela de Produtos realmente chama (com `live=1`).
 */

vi.mock("../app/lib/prisma", () => ({
  default: {
    product: { findFirst: vi.fn() },
    productListing: { findMany: vi.fn() },
  },
}));
vi.mock("@/app/lib/prisma", () => ({
  default: {
    product: { findFirst: vi.fn() },
    productListing: { findMany: vi.fn() },
  },
}));

vi.mock("../app/middlewares/auth.middleware", () => ({
  authMiddleware: async (request: any) => {
    request.user = { id: "user-1", dataOwnerId: "user-1" };
  },
}));

vi.mock("../app/marketplaces/services/listing-status-refresh.service", () => ({
  ListingStatusRefreshService: {
    // Sem refresh remoto: o que está em teste é o TRANSPORTE do campo.
    refreshRowsBestEffort: vi.fn().mockResolvedValue(new Map()),
  },
}));

const CATALOG = "1395647917674862";

function linha(over: Record<string, any> = {}) {
  return {
    id: "listing-fb",
    status: "active",
    externalListingId: "SKU-35873",
    permalink: "https://facebook.com/jotabeautopecas",
    lastError: null,
    retryAttempts: 0,
    retryEnabled: false,
    nextRetryAt: null,
    updatedAt: new Date("2026-08-19T12:00:00.000Z"),
    marketplaceAccount: {
      id: "acc-fb",
      accountName: "Jotabê Autopeças",
      platform: "FACEBOOK",
      fbCatalogId: CATALOG,
    },
    ...over,
  };
}

describe("GET /listings/status — o catálogo do Facebook chega na tela", () => {
  let app: ReturnType<typeof fastify>;
  let prisma: any;

  beforeEach(async () => {
    const { listingRoutes } = await import("../app/routes/listing.routes");
    app = fastify();
    await app.register(listingRoutes, { prefix: "/listings" });
    prisma = (await import("../app/lib/prisma")).default as any;
    prisma.product.findFirst.mockResolvedValue({ id: "prod-1" });
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await app.close();
  });

  const chamar = (url: string) =>
    app.inject({ method: "GET", url, headers: { email: "t@e.com" } });

  it("live=1 (o que o modal chama) devolve fbCatalogId na linha do Facebook", async () => {
    prisma.productListing.findMany.mockResolvedValue([linha()]);

    const res = await chamar("/listings/status?productId=prod-1&live=1");

    expect(res.statusCode).toBe(200);
    const [item] = JSON.parse(res.payload).listings;
    expect(item.platform).toBe("FACEBOOK");
    expect(item.fbCatalogId).toBe(CATALOG);
  });

  it("sem live=1 também devolve — o campo não é insumo de refresh", async () => {
    prisma.productListing.findMany.mockResolvedValue([linha()]);

    const res = await chamar("/listings/status?productId=prod-1");

    const [item] = JSON.parse(res.payload).listings;
    expect(item.fbCatalogId).toBe(CATALOG);
  });

  it("o SELECT pede fbCatalogId nos dois modos (é daí que o campo vem)", async () => {
    prisma.productListing.findMany.mockResolvedValue([]);

    await chamar("/listings/status?productId=prod-1");
    await chamar("/listings/status?productId=prod-1&live=1");

    for (const call of prisma.productListing.findMany.mock.calls) {
      const conta = call[0].select.marketplaceAccount.select;
      expect(conta.fbCatalogId).toBe(true);
    }
  });

  it("conta do Facebook sem catálogo devolve null, não some do payload", async () => {
    prisma.productListing.findMany.mockResolvedValue([
      linha({
        marketplaceAccount: {
          id: "acc-fb",
          accountName: "Sem catálogo",
          platform: "FACEBOOK",
          fbCatalogId: null,
        },
      }),
    ]);

    const res = await chamar("/listings/status?productId=prod-1&live=1");

    const [item] = JSON.parse(res.payload).listings;
    expect(item).toHaveProperty("fbCatalogId");
    expect(item.fbCatalogId).toBeNull();
  });

  it("nos outros canais o payload segue igual ao de antes — o campo nem aparece", async () => {
    prisma.productListing.findMany.mockResolvedValue([
      linha({
        id: "listing-ml",
        externalListingId: "MLB123",
        permalink: "https://produto.mercadolivre.com.br/MLB123",
        marketplaceAccount: {
          id: "acc-ml",
          accountName: "Loja ML",
          platform: "MERCADO_LIVRE",
          fbCatalogId: null,
        },
      }),
      linha({
        id: "listing-olx",
        marketplaceAccount: {
          id: "acc-olx",
          accountName: "Loja OLX",
          platform: "OLX",
          fbCatalogId: null,
        },
      }),
    ]);

    const res = await chamar("/listings/status?productId=prod-1&live=1");

    for (const item of JSON.parse(res.payload).listings) {
      expect(item, item.platform).not.toHaveProperty("fbCatalogId");
    }
  });

  it("credencial nenhuma vaza junto — o mapeamento continua campo a campo", async () => {
    prisma.productListing.findMany.mockResolvedValue([linha()]);

    const res = await chamar("/listings/status?productId=prod-1&live=1");

    const payload = res.payload;
    for (const proibido of [
      "accessToken",
      "refreshToken",
      "marketplaceAccount",
    ]) {
      expect(payload).not.toContain(proibido);
    }
  });
});
