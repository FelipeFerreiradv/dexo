import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fastify from "fastify";
import { productRoutes } from "../app/routes/product.routes";
import { UserRepositoryPrisma } from "../app/repositories/user.repository";
import { ProductRepositoryPrisma } from "../app/repositories/product.repository";

/**
 * Markup calculado no SERVIDOR + limites numéricos (22/09/2026).
 *
 * Caso de produção que motivou: preço 26000 com o custo padrão do usuário
 * (R$ 0,01) ⇒ o navegador calculava 259.999.900%, que não cabe em
 * `Decimal(10,2)`; o Postgres recusava e o produto INTEIRO não era criado
 * (500 com o texto do Prisma). Agora: o servidor ignora o markup do cliente,
 * recalcula de preço e custo, e grava vazio quando não cabe.
 */

vi.mock("../app/marketplaces/usecases/listing.usercase", () => ({
  ListingUseCase: {
    createMLListing: vi.fn(),
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
    productListing: {
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    stockLog: { create: vi.fn() },
    systemLog: { create: vi.fn(), findMany: vi.fn(), count: vi.fn() },
  },
}));

vi.mock("../app/marketplaces/services/category-resolution.service", () => ({
  CategoryResolutionService: {
    resolveMLCategory: vi.fn().mockResolvedValue({
      externalId: "MLB-MOCK",
      fullPath: "Mock > Category",
      source: "explicit",
    }),
    ensureLeafLocalOnly: vi.fn().mockResolvedValue({
      externalId: "MLB-MOCK",
      fullPath: "Mock > Category",
    }),
    assertWithinVehicleRoot: vi.fn().mockResolvedValue({ ok: true }),
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

const base = {
  sku: "PROD-MK",
  name: "Motor parcial Hilux 2016",
  stock: 1,
  imageUrl: "http://localhost:3333/uploads/test.jpg",
};

describe("POST /products — markup calculado no servidor e limites", () => {
  let app: ReturnType<typeof fastify>;
  let create: any;

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
    create = vi
      .spyOn(ProductRepositoryPrisma.prototype, "create")
      .mockImplementation(
        async (data: any) =>
          ({
            id: "prod-1",
            ...data,
            createdAt: new Date(),
            updatedAt: new Date(),
          }) as any,
      );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  const post = (payload: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: "/products",
      headers: { email: "test@example.com" },
      payload: payload as any,
    });

  const gravado = () => create.mock.calls.at(-1)?.[0];

  it("caso de produção (26000 / custo 0,01): o produto É criado, markup vazio", async () => {
    const res = await post({
      ...base,
      price: 26000,
      costPrice: 0.01,
      markup: 259999900,
    });
    expect(res.statusCode, res.payload).toBe(201);
    expect(gravado().price).toBe(26000);
    expect(gravado().costPrice).toBe(0.01);
    expect(gravado().markup).toBeUndefined();
  });

  it("markup do cliente é ignorado: grava o calculado de preço e custo", async () => {
    const res = await post({ ...base, price: 89.9, costPrice: 35, markup: 999 });
    expect(res.statusCode, res.payload).toBe(201);
    expect(gravado().markup).toBe(156.86);
  });

  it("sem custo não grava markup (mesmo que o cliente mande um velho)", async () => {
    const res = await post({ ...base, price: 150, markup: 12345 });
    expect(res.statusCode, res.payload).toBe(201);
    expect(gravado().markup).toBeUndefined();
  });

  it("produto normal barato continua igual", async () => {
    const res = await post({ ...base, price: 10, costPrice: 4 });
    expect(res.statusCode, res.payload).toBe(201);
    expect(gravado().markup).toBe(150);
    expect(gravado().price).toBe(10);
  });

  it("preço acima da coluna ⇒ 400 legível (antes: 500 do Prisma)", async () => {
    const res = await post({ ...base, price: 100_000_000 });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toMatch(/Preço acima do limite/);
    expect(create).not.toHaveBeenCalled();
  });

  it("preço infinito ⇒ 400", async () => {
    const res = await post({ ...base, price: "Infinity" });
    expect(res.statusCode).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it("medida fracionada ⇒ 400 (a coluna é Int; antes era 500)", async () => {
    const res = await post({ ...base, price: 10, heightCm: 12.5 });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toMatch(/Altura inválida/);
  });

  it("peso acima de Decimal(6,2) ⇒ 400", async () => {
    const res = await post({ ...base, price: 10, weightKg: 10000 });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toMatch(/Peso inválido/);
  });

  it("medidas e peso normais passam como hoje", async () => {
    const res = await post({
      ...base,
      price: 10,
      heightCm: 25,
      widthCm: 25,
      lengthCm: 45,
      weightKg: 10.5,
    });
    expect(res.statusCode, res.payload).toBe(201);
    expect(gravado().heightCm).toBe(25);
    expect(gravado().weightKg).toBe(10.5);
  });

  it("custo negativo continua aceito como hoje (o banco aceita), sem markup", async () => {
    const res = await post({ ...base, price: 10, costPrice: -1 });
    expect(res.statusCode, res.payload).toBe(201);
    expect(gravado().markup).toBeUndefined();
  });

  it("estouro numérico que escapar vira 422 legível, não 500 cru", async () => {
    // O spy substitui o repositório inteiro; o erro tipado é o que o repositório
    // real lança ao traduzir P2020/22003 (coberto em product-numeric-overflow).
    const { NumericOverflowError } = await import(
      "../app/repositories/numeric-overflow-error"
    );
    create.mockRejectedValueOnce(new NumericOverflowError());
    const res = await post({ ...base, price: 10 });
    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.payload).error).toMatch(/acima do limite/);
  });
});

describe("PUT /products/:id — markup recalculado a partir do produto", () => {
  let app: ReturnType<typeof fastify>;
  let update: any;

  const existente = {
    id: "prod-1",
    sku: "PROD-MK",
    name: "Motor parcial Hilux 2016",
    price: 100,
    costPrice: 40,
    markup: 150,
    stock: 1,
    userId: "user-1",
    createdAt: new Date(),
    updatedAt: new Date(),
  } as any;

  beforeEach(async () => {
    app = fastify();
    await app.register(productRoutes, { prefix: "/products" });
    vi.spyOn(UserRepositoryPrisma.prototype, "findByEmail").mockResolvedValue(
      fakeUser,
    );
    vi.spyOn(UserRepositoryPrisma.prototype, "findById").mockResolvedValue(
      fakeUser,
    );
    vi.spyOn(ProductRepositoryPrisma.prototype, "findById").mockResolvedValue(
      existente,
    );
    update = vi
      .spyOn(ProductRepositoryPrisma.prototype, "update")
      .mockImplementation(
        async (_id: any, data: any) => ({ ...existente, ...data }) as any,
      );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  const put = (payload: Record<string, unknown>) =>
    app.inject({
      method: "PUT",
      url: "/products/prod-1",
      headers: { email: "test@example.com" },
      payload: payload as any,
    });

  const gravado = () => update.mock.calls.at(-1)?.[1];

  it("preço alto com custo 0,01 salva e grava markup null (antes: 500)", async () => {
    const res = await put({ price: 26000, costPrice: 0.01, markup: 259999900 });
    expect(res.statusCode, res.payload).toBe(200);
    expect(gravado().markup).toBeNull();
    expect(gravado().price).toBe(26000);
  });

  it("edição só de preço recalcula com o custo que o produto já tem", async () => {
    const res = await put({ price: 120 });
    expect(res.statusCode, res.payload).toBe(200);
    expect(gravado().markup).toBe(200);
  });

  it("custo apagado (null) limpa o markup", async () => {
    const res = await put({ price: 100, costPrice: null, markup: 150 });
    expect(res.statusCode, res.payload).toBe(200);
    expect(gravado().markup).toBeNull();
  });

  it("edição que não toca preço/custo/markup não mexe na coluna", async () => {
    const res = await put({ name: "Motor parcial Hilux 2017" });
    expect(res.statusCode, res.payload).toBe(200);
    // undefined = o repositório não inclui a coluna no UPDATE.
    expect(gravado().markup).toBeUndefined();
  });

  it("preço acima da coluna ⇒ 400 antes de tocar o banco", async () => {
    const res = await put({ price: 100_000_000 });
    expect(res.statusCode).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });
});
