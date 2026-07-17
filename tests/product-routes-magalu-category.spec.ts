import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fastify from "fastify";
import { productRoutes } from "../app/routes/product.routes";
import { UserRepositoryPrisma } from "../app/repositories/user.repository";
import { ProductRepositoryPrisma } from "../app/repositories/product.repository";
import { ListingDispatcher } from "../app/marketplaces/services/listing-dispatcher.service";

/**
 * Persistência da categoria Magalu no Product (paridade com ML/Shopee).
 *
 * Antes, a categoria escolhida no modal só viajava como parâmetro do anúncio
 * (listings[].categoryId) e morria ali — o publish re-resolvia ao vivo a cada
 * envio e o caminho "explícito" do resolveCategoryId era código morto. Agora
 * POST/PUT gravam magaluCategoryId/Source/ChosenAt.
 */

vi.mock("../app/marketplaces/usecases/listing.usercase", () => ({
  ListingUseCase: {
    createMLListing: async () => ({ success: true, listingId: "l-1" }),
    removeListing: vi.fn(),
    updateListingFields: vi.fn(),
  },
}));

vi.mock("../app/lib/prisma", () => ({
  default: {
    product: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    user: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn() },
    productListing: { findMany: vi.fn(), deleteMany: vi.fn() },
    stockLog: { create: vi.fn() },
    systemLog: { create: vi.fn(), findMany: vi.fn(), count: vi.fn() },
  },
}));

vi.mock("../app/services/system-log.service", () => ({
  SystemLogService: {
    logError: vi.fn(),
    logWarning: vi.fn(),
    logInfo: vi.fn(),
    log: vi.fn(),
    logProductCreate: vi.fn(),
    logProductDelete: vi.fn(),
    logProductUpdate: vi.fn(),
    logListingDeleteFailed: vi.fn(),
  },
}));

const fakeUser = {
  id: "user-1",
  email: "test@example.com",
  name: "Test User",
  dataOwnerId: "user-1",
} as any;

const basePayload = () => ({
  sku: "PROD-MAGALU",
  name: "Farol Dianteiro Gol",
  price: 100.0,
  stock: 5,
  imageUrl: "http://localhost:3333/uploads/test.jpg",
  category: "Carroceria e Lataria",
});

describe("categoria Magalu persistida no Product", () => {
  let app: ReturnType<typeof fastify>;
  let createSpy: any;
  let updateSpy: any;

  beforeEach(async () => {
    app = fastify();
    await app.register(productRoutes, { prefix: "/products" });

    vi.spyOn(UserRepositoryPrisma.prototype, "findByEmail").mockResolvedValue(
      fakeUser,
    );
    vi.spyOn(UserRepositoryPrisma.prototype, "findById").mockResolvedValue(
      fakeUser,
    );
    vi.spyOn(
      ProductRepositoryPrisma.prototype,
      "existsBySku",
    ).mockResolvedValue(false);
    createSpy = vi
      .spyOn(ProductRepositoryPrisma.prototype, "create")
      .mockImplementation(
        async (data: any) =>
          ({
            id: "prod-1",
            sku: data.sku,
            name: data.name,
            price: data.price ?? 0,
            stock: data.stock ?? 0,
            createdAt: new Date(),
            updatedAt: new Date(),
          }) as any,
      );
    vi.spyOn(ListingDispatcher, "dispatch").mockReturnValue({
      queued: [],
    } as any);

    vi.spyOn(ProductRepositoryPrisma.prototype, "findById").mockResolvedValue({
      id: "prod-1",
      sku: "PROD-MAGALU",
      name: "Farol Dianteiro Gol",
      price: 100,
      stock: 5,
      userId: "user-1",
      listings: [],
    } as any);
    updateSpy = vi
      .spyOn(ProductRepositoryPrisma.prototype, "update")
      .mockImplementation(async (_id: string, data: any) => ({
        id: "prod-1",
        ...data,
      }) as any);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  const post = (payload: unknown) =>
    app.inject({
      method: "POST",
      url: "/products",
      headers: { email: "test@example.com" },
      payload: payload as any,
    });

  it("POST com magaluCategory de nível superior persiste como manual", async () => {
    const res = await post({
      ...basePayload(),
      magaluCategory: "uuid-magalu-farois",
    });

    expect(res.statusCode, res.payload).toBe(201);
    const data = createSpy.mock.calls[0][0];
    expect(data.magaluCategoryId).toBe("uuid-magalu-farois");
    expect(data.magaluCategorySource).toBe("manual");
    expect(data.magaluCategoryChosenAt).toBeInstanceOf(Date);
  });

  it("POST sem nível superior herda do listings[].categoryId (MAGALU) como auto", async () => {
    const res = await post({
      ...basePayload(),
      listings: [
        {
          platform: "MAGALU",
          accountIds: ["acc-mg-1"],
          categoryId: "uuid-do-anuncio",
        },
      ],
    });

    expect(res.statusCode, res.payload).toBe(201);
    const data = createSpy.mock.calls[0][0];
    expect(data.magaluCategoryId).toBe("uuid-do-anuncio");
    expect(data.magaluCategorySource).toBe("auto");
  });

  it("POST sem categoria Magalu segue sem os campos (comportamento atual)", async () => {
    const res = await post(basePayload());

    expect(res.statusCode, res.payload).toBe(201);
    const data = createSpy.mock.calls[0][0];
    expect(data.magaluCategoryId).toBeUndefined();
    expect(data.magaluCategorySource).toBeUndefined();
    expect(data.magaluCategoryChosenAt).toBeUndefined();
  });

  it("PUT com magaluCategory grava no update; sem ela não toca os campos", async () => {
    const put = (payload: unknown) =>
      app.inject({
        method: "PUT",
        url: "/products/prod-1",
        headers: { email: "test@example.com" },
        payload: payload as any,
      });

    const res = await put({ name: "Farol", magaluCategory: "uuid-editado" });
    expect(res.statusCode, res.payload).toBe(200);
    const data = updateSpy.mock.calls[0][1];
    expect(data.magaluCategoryId).toBe("uuid-editado");
    expect(data.magaluCategorySource).toBe("manual");

    updateSpy.mockClear();
    const res2 = await put({ name: "Farol 2" });
    expect(res2.statusCode, res2.payload).toBe(200);
    const data2 = updateSpy.mock.calls[0][1];
    // undefined = repository não escreve (guard `!== undefined`) — edição sem
    // mexer na categoria não pode apagar a persistida.
    expect(data2.magaluCategoryId).toBeUndefined();
  });
});
