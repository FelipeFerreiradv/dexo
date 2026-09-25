import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fastify from "fastify";

// GET /products/export — rota da planilha "Exportar todos os produtos".

const { productFindManyMock, productCountMock, locationFindManyMock, queryRawMock } =
  vi.hoisted(() => ({
    productFindManyMock: vi.fn(),
    productCountMock: vi.fn(),
    locationFindManyMock: vi.fn(),
    queryRawMock: vi.fn(),
  }));

// Repetido nas duas fábricas: `vi.mock` é içado e não pode referenciar consts.
vi.mock("../app/lib/prisma", () => {
  const prisma: any = {
    location: { findMany: locationFindManyMock, findFirst: vi.fn() },
    product: {
      count: productCountMock,
      findMany: productFindManyMock,
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
    },
    user: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn() },
    productListing: { findMany: vi.fn(), deleteMany: vi.fn() },
    stockLog: { create: vi.fn() },
    systemLog: { create: vi.fn(), findMany: vi.fn(), count: vi.fn() },
    $queryRaw: queryRawMock,
    $transaction: vi.fn(async (cb: any) => cb(prisma)),
  };
  return { default: prisma };
});
vi.mock("@/app/lib/prisma", () => {
  const prisma: any = {
    location: { findMany: locationFindManyMock, findFirst: vi.fn() },
    product: {
      count: productCountMock,
      findMany: productFindManyMock,
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
    },
    user: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn() },
    productListing: { findMany: vi.fn(), deleteMany: vi.fn() },
    stockLog: { create: vi.fn() },
    systemLog: { create: vi.fn(), findMany: vi.fn(), count: vi.fn() },
    $queryRaw: queryRawMock,
    $transaction: vi.fn(async (cb: any) => cb(prisma)),
  };
  return { default: prisma };
});

vi.mock("../app/marketplaces/usecases/listing.usercase", () => ({
  ListingUseCase: {
    createMLListing: vi.fn(),
    removeListing: vi.fn(),
    updateListingFields: vi.fn(),
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

import { productRoutes } from "../app/routes/product.routes";
import { UserRepositoryPrisma } from "../app/repositories/user.repository";
import { resetMlAttributeNamesCache } from "../app/usecases/product-export.usecase";

const dono = {
  id: "owner-1",
  email: "dono.exportacao@example.com",
  name: "Dono",
  parentUserId: null,
  isActive: true,
} as any;

const colaborador = {
  id: "colab-1",
  email: "colab.exportacao@example.com",
  name: "Colaborador",
  parentUserId: "owner-1",
  isActive: true,
} as any;

const produto = (id: string) => ({
  id,
  sku: id.toUpperCase(),
  name: `Peça ${id}`,
  price: { toString: () => "10.00" },
  stock: 1,
  reservedStock: 0,
  imageUrls: [],
  locationId: null,
  location: "Prateleira 1",
  listings: [],
  compatibilities: [],
  attributes: null,
  createdAt: new Date("2026-09-25T12:00:00.000Z"),
  updatedAt: new Date("2026-09-25T12:00:00.000Z"),
});

describe("GET /products/export", () => {
  let app: ReturnType<typeof fastify>;

  beforeEach(async () => {
    vi.clearAllMocks();
    resetMlAttributeNamesCache();
    queryRawMock.mockResolvedValue([]);
    productCountMock.mockResolvedValue(2);
    locationFindManyMock.mockResolvedValue([]);
    app = fastify();
    await app.register(productRoutes, { prefix: "/products" });
    vi.spyOn(UserRepositoryPrisma.prototype, "findByEmail").mockImplementation(
      async (email: string) =>
        email === dono.email ? dono : email === colaborador.email ? colaborador : null,
    );
    vi.spyOn(UserRepositoryPrisma.prototype, "findById").mockImplementation(
      async (id: string) => (id === dono.id ? dono : id === colaborador.id ? colaborador : null),
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  it("devolve a página com localização, total e cursor", async () => {
    productFindManyMock.mockResolvedValue([produto("a"), produto("b")]);
    const res = await app.inject({
      method: "GET",
      url: "/products/export?limit=2",
      headers: { email: dono.email },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(2);
    expect(body.nextCursor).toBe("b");
    expect(body.products).toHaveLength(2);
    expect(body.products[0].location.path).toBe("Prateleira 1");
    expect(body.products[0].price).toBe(10);
    expect(productFindManyMock.mock.calls[0][0].where).toEqual({ userId: "owner-1" });
  });

  it("colaborador exporta a base do DONO (dataOwnerId), nunca a própria", async () => {
    productFindManyMock.mockResolvedValue([]);
    const res = await app.inject({
      method: "GET",
      url: "/products/export?cursor=b",
      headers: { email: colaborador.email },
    });
    expect(res.statusCode).toBe(200);
    expect(productFindManyMock.mock.calls[0][0].where).toEqual({
      userId: "owner-1",
      id: { gt: "b" },
    });
    expect(productFindManyMock.mock.calls[0][0].take).toBe(500);
  });

  it("limite acima do teto vira 1000", async () => {
    productFindManyMock.mockResolvedValue([]);
    await app.inject({
      method: "GET",
      url: "/products/export?limit=999999",
      headers: { email: dono.email },
    });
    expect(productFindManyMock.mock.calls[0][0].take).toBe(1000);
  });

  it("parâmetro inválido dá 400 sem consultar o banco", async () => {
    for (const url of [
      "/products/export?cursor=abc%27%20OR%201%3D1",
      "/products/export?limit=abc",
      "/products/export?limit=0",
    ]) {
      const res = await app.inject({ method: "GET", url, headers: { email: dono.email } });
      expect(res.statusCode).toBe(400);
    }
    expect(productFindManyMock).not.toHaveBeenCalled();
  });

  it("sem autenticação não chega ao banco", async () => {
    const res = await app.inject({ method: "GET", url: "/products/export" });
    expect(res.statusCode).toBe(401);
    expect(productFindManyMock).not.toHaveBeenCalled();
  });

  it("erro interno vira 500 com mensagem genérica (sem detalhe do banco)", async () => {
    productFindManyMock.mockRejectedValue(
      new Error('connect ECONNREFUSED 10.0.0.5:5432 relation "Product"'),
    );
    const res = await app.inject({
      method: "GET",
      url: "/products/export",
      headers: { email: dono.email },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      error: "Erro ao exportar produtos. Tente novamente.",
    });
  });

  it("não é capturada pela rota /:id", async () => {
    productFindManyMock.mockResolvedValue([]);
    const res = await app.inject({
      method: "GET",
      url: "/products/export",
      headers: { email: dono.email },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty("products");
  });
});
