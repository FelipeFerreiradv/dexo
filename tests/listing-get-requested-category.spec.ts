import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fastify from "fastify";

/**
 * A CATEGORIA DO ANÚNCIO NÃO É A CATEGORIA DO PRODUTO.
 *
 * `ProductListing.requestedCategoryId` guarda a categoria com que o anúncio foi
 * de fato publicado (vem do `payload.category_id` no create). Ela existe no
 * banco desde sempre e não era devolvida por endpoint nenhum — então o modal de
 * edição só conseguia mostrar `mlCategoryOverride` e, quando não havia
 * override, caía na categoria do PRODUTO. Resultado: o operador editava um
 * anúncio achando que estava vendo os dados dele.
 *
 * Este spec trava as duas metades:
 *  - os campos NOVOS chegam (`requestedCategoryId` + `requestedCategoryPath`);
 *  - o contrato é ADITIVO: os 22 overrides, os 9 settings e o snapshot do
 *    produto continuam exatamente onde estavam.
 */

const shared = {
  productListing: { findUnique: vi.fn() },
  productCompatibility: { findMany: vi.fn() },
  marketplaceCategory: { findUnique: vi.fn() },
};

vi.mock("../app/lib/prisma", () => ({ default: shared }));
vi.mock("@/app/lib/prisma", () => ({ default: shared }));

vi.mock("../app/middlewares/auth.middleware", () => ({
  authMiddleware: async (request: any) => {
    request.user = { id: "user-1", dataOwnerId: "user-1" };
  },
}));

const OVERRIDES = [
  "titleOverride",
  "descriptionOverride",
  "priceOverride",
  "brandOverride",
  "modelOverride",
  "yearOverride",
  "versionOverride",
  "categoryOverride",
  "mlCategoryOverride",
  "shopeeCategoryOverride",
  "olxCategoryOverride",
  "fbCategoryOverride",
  "partNumberOverride",
  "qualityOverride",
  "heightCmOverride",
  "widthCmOverride",
  "lengthCmOverride",
  "weightKgOverride",
  "imageUrlsOverride",
  "attributesOverride",
  "compatibilitiesOverride",
  "sourceVehicleOverride",
];

const SETTINGS = [
  "listingType",
  "itemCondition",
  "hasWarranty",
  "warrantyUnit",
  "warrantyDuration",
  "shippingMode",
  "freeShipping",
  "localPickup",
  "manufacturingTime",
];

function produto() {
  return {
    id: "prod-1",
    userId: "user-1",
    name: "Fechadura Porta Dianteira Esquerda",
    sku: "33600",
    description: "desc",
    price: 299.9,
    brand: "Fiat",
    model: "Uno",
    year: "1996",
    version: null,
    category: "Acessórios para Veículos",
    // Categoria do PRODUTO — de propósito diferente da do anúncio.
    mlCategory: "MLB101763",
    mlCategoryId: "MLB101763",
    shopeeCategoryId: null,
    partNumber: "51234567",
    quality: "SEMINOVO",
    heightCm: 10,
    widthCm: 20,
    lengthCm: 30,
    weightKg: 1.5,
    imageUrl: "https://img/1.jpg",
    imageUrls: ["https://img/1.jpg"],
    attributes: { OEM: { value_name: "51234567" } },
    sourceVehicle: "Uno 1996",
  };
}

function anuncio(over: Record<string, any> = {}) {
  const base: Record<string, any> = {
    id: "listing-1",
    productId: "prod-1",
    externalListingId: "MLB123456789",
    externalSku: "SKU-1",
    permalink: "https://produto.mercadolivre.com.br/MLB-123456789",
    status: "active",
    updatedAt: new Date("2026-08-20T10:00:00.000Z"),
    // A categoria com que ESTE anúncio foi publicado.
    requestedCategoryId: "MLB1747",
    listingType: "gold_special",
    itemCondition: "new",
    hasWarranty: true,
    warrantyUnit: "meses",
    warrantyDuration: 3,
    shippingMode: "me2",
    freeShipping: false,
    localPickup: false,
    manufacturingTime: 0,
    product: produto(),
    marketplaceAccount: {
      id: "acc-1",
      accountName: "JOTABE-AUTOPECAS",
      platform: "MERCADO_LIVRE",
    },
  };
  for (const k of OVERRIDES) base[k] = null;
  return { ...base, ...over };
}

describe("GET /listings/:id — categoria real do anúncio (contrato aditivo)", () => {
  let app: ReturnType<typeof fastify>;

  beforeEach(async () => {
    const { listingRoutes } = await import("../app/routes/listing.routes");
    app = fastify();
    await app.register(listingRoutes, { prefix: "/listings" });
    shared.productCompatibility.findMany.mockResolvedValue([]);
    shared.marketplaceCategory.findUnique.mockResolvedValue(null);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await app.close();
  });

  const chamar = (id = "listing-1") =>
    app.inject({
      method: "GET",
      url: "/listings/" + id,
      headers: { email: "t@e.com" },
    });

  it("devolve requestedCategoryId com o nome resolvido do catálogo local", async () => {
    shared.productListing.findUnique.mockResolvedValue(anuncio());
    shared.marketplaceCategory.findUnique.mockResolvedValue({
      fullPath: "Acessórios para Veículos > Carroceria > Fechaduras",
      name: "Fechaduras",
    });

    const res = await chamar();

    expect(res.statusCode).toBe(200);
    const { listing } = JSON.parse(res.payload);
    expect(listing.requestedCategoryId).toBe("MLB1747");
    expect(listing.requestedCategoryPath).toBe(
      "Acessórios para Veículos > Carroceria > Fechaduras",
    );
    // A do produto continua no snapshot, e continua sendo OUTRA.
    expect(listing.product.mlCategory).toBe("MLB101763");
  });

  it("categoria sem fullPath cai para o nome", async () => {
    shared.productListing.findUnique.mockResolvedValue(anuncio());
    shared.marketplaceCategory.findUnique.mockResolvedValue({
      fullPath: "",
      name: "Fechaduras",
    });

    const { listing } = JSON.parse((await chamar()).payload);
    expect(listing.requestedCategoryPath).toBe("Fechaduras");
  });

  it("categoria desconhecida no catálogo local devolve o id sem rótulo", async () => {
    shared.productListing.findUnique.mockResolvedValue(anuncio());
    shared.marketplaceCategory.findUnique.mockResolvedValue(null);

    const res = await chamar();

    expect(res.statusCode).toBe(200);
    const { listing } = JSON.parse(res.payload);
    expect(listing.requestedCategoryId).toBe("MLB1747");
    expect(listing.requestedCategoryPath).toBeNull();
  });

  it("erro no lookup da categoria não derruba a rota", async () => {
    shared.productListing.findUnique.mockResolvedValue(anuncio());
    shared.marketplaceCategory.findUnique.mockRejectedValue(
      new Error("catálogo indisponível"),
    );

    const res = await chamar();

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).listing.requestedCategoryPath).toBeNull();
  });

  it("anúncio sem requestedCategoryId devolve null nos dois campos", async () => {
    shared.productListing.findUnique.mockResolvedValue(
      anuncio({ requestedCategoryId: null }),
    );

    const { listing } = JSON.parse((await chamar()).payload);
    expect(listing.requestedCategoryId).toBeNull();
    expect(listing.requestedCategoryPath).toBeNull();
    expect(shared.marketplaceCategory.findUnique).not.toHaveBeenCalled();
  });

  it("fora do ML não consulta o catálogo do ML — devolve o id sem rótulo", async () => {
    shared.productListing.findUnique.mockResolvedValue(
      anuncio({
        requestedCategoryId: "SHP_101710",
        marketplaceAccount: {
          id: "acc-2",
          accountName: "Shopee Shop",
          platform: "SHOPEE",
        },
      }),
    );

    const { listing } = JSON.parse((await chamar()).payload);
    expect(listing.requestedCategoryId).toBe("SHP_101710");
    expect(listing.requestedCategoryPath).toBeNull();
    expect(shared.marketplaceCategory.findUnique).not.toHaveBeenCalled();
  });

  it("ADITIVO: os 22 overrides e os 9 settings continuam no payload", async () => {
    shared.productListing.findUnique.mockResolvedValue(
      anuncio({
        titleOverride: "Título só deste anúncio",
        priceOverride: 310.5,
        mlCategoryOverride: "MLB999",
        attributesOverride: { OEM: { value_name: "ABC" } },
      }),
    );

    const { listing } = JSON.parse((await chamar()).payload);

    for (const k of OVERRIDES) expect(listing).toHaveProperty(k);
    for (const k of SETTINGS) expect(listing).toHaveProperty(k);
    expect(listing.titleOverride).toBe("Título só deste anúncio");
    expect(listing.priceOverride).toBe(310.5);
    expect(listing.mlCategoryOverride).toBe("MLB999");
    expect(listing.attributesOverride).toEqual({ OEM: { value_name: "ABC" } });
  });

  it("ADITIVO: snapshot do produto e conta seguem intactos", async () => {
    shared.productListing.findUnique.mockResolvedValue(anuncio());
    shared.productCompatibility.findMany.mockResolvedValue([
      { id: "c1", brand: "Fiat", model: "Uno", yearFrom: 1990, yearTo: 2000 },
    ]);

    const { listing } = JSON.parse((await chamar()).payload);

    expect(listing.product.id).toBe("prod-1");
    expect(listing.product.sku).toBe("33600");
    expect(listing.product.price).toBe(299.9);
    expect(listing.product.attributes).toEqual({
      OEM: { value_name: "51234567" },
    });
    expect(listing.product.compatibilities).toHaveLength(1);
    expect(listing.account).toEqual({
      id: "acc-1",
      accountName: "JOTABE-AUTOPECAS",
      platform: "MERCADO_LIVRE",
    });
    expect(listing.externalListingId).toBe("MLB123456789");
    expect(listing.permalink).toBe(
      "https://produto.mercadolivre.com.br/MLB-123456789",
    );
  });

  it("continua barrando anúncio de outro dono (403) e inexistente (404)", async () => {
    shared.productListing.findUnique.mockResolvedValue(
      anuncio({ product: { ...produto(), userId: "outro" } }),
    );
    expect((await chamar()).statusCode).toBe(403);

    shared.productListing.findUnique.mockResolvedValue(null);
    expect((await chamar("nao-existe")).statusCode).toBe(404);
  });
});
