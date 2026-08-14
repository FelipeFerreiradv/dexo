import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fastify from "fastify";

// ─────────────────────────────────────────────────────────────────────────────
// Issue #273 — capacidade da localização passa a ser validada no SERVIDOR ao
// criar e ao editar produto pela tela.
//
// Este arquivo SUBSTITUI `location-capacity-not-enforced-on-product.spec.ts`,
// que era o teste de caracterização escrito para PROVAR a lacuna (#274). O que
// lá era "aceita e nem consulta", aqui é "rejeita com 422".
//
// Os dois casos que protegem a operação de quebrar:
//  - `maxCapacity = 0` (96% da base) nunca bloqueia;
//  - reeditar peça que JÁ está na localização nunca bloqueia, mesmo com a
//    localização acima do limite — senão as 209 peças hoje presas em 4
//    localizações estouradas ficariam impossíveis de corrigir.
// ─────────────────────────────────────────────────────────────────────────────

const {
  locationFindFirstMock,
  productCountMock,
  productFindFirstMock,
  productFindManyMock,
  productUpdateManyMock,
} = vi.hoisted(() => ({
  locationFindFirstMock: vi.fn(),
  productCountMock: vi.fn(),
  productFindFirstMock: vi.fn(),
  productFindManyMock: vi.fn(),
  productUpdateManyMock: vi.fn(),
}));

// Repetido nas duas fábricas: `vi.mock` é içado e não pode referenciar consts.
vi.mock("../app/lib/prisma", () => {
  const prisma: any = {
    location: { findFirst: locationFindFirstMock },
    product: {
      count: productCountMock,
      findFirst: productFindFirstMock,
      findMany: productFindManyMock,
      updateMany: productUpdateManyMock,
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    user: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn() },
    productListing: { findMany: vi.fn(), deleteMany: vi.fn() },
    stockLog: { create: vi.fn() },
    systemLog: { create: vi.fn(), findMany: vi.fn(), count: vi.fn() },
    $transaction: vi.fn(async (cb: any) => cb(prisma)),
  };
  return { default: prisma };
});
vi.mock("@/app/lib/prisma", () => {
  const prisma: any = {
    location: { findFirst: locationFindFirstMock },
    product: {
      count: productCountMock,
      findFirst: productFindFirstMock,
      findMany: productFindManyMock,
      updateMany: productUpdateManyMock,
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    user: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn() },
    productListing: { findMany: vi.fn(), deleteMany: vi.fn() },
    stockLog: { create: vi.fn() },
    systemLog: { create: vi.fn(), findMany: vi.fn(), count: vi.fn() },
    $transaction: vi.fn(async (cb: any) => cb(prisma)),
  };
  return { default: prisma };
});

vi.mock("../app/marketplaces/usecases/listing.usercase", () => ({
  ListingUseCase: {
    createMLListing: async () => ({ success: true, listingId: "l-1" }),
    removeListing: vi.fn(),
    updateListingFields: vi.fn(),
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
import { ProductRepositoryPrisma } from "../app/repositories/product.repository";
import { ListingDispatcher } from "../app/marketplaces/services/listing-dispatcher.service";

const LOTADA = { id: "loc-lotada", code: "CAIXA-01", maxCapacity: 1 };
const SEM_LIMITE = { id: "loc-livre", code: "PRAT-LIVRE", maxCapacity: 0 };

const dono = {
  id: "owner-1",
  email: "dono.capacidade-273-fix@example.com",
  name: "Dono",
  parentUserId: null,
} as any;

const base = {
  name: "Farol Dianteiro Gol",
  price: 100,
  stock: 1,
  imageUrl: "http://localhost:3333/uploads/test.jpg",
};

describe("issue #273 — capacidade validada no servidor", () => {
  let app: ReturnType<typeof fastify>;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = fastify();
    await app.register(productRoutes, { prefix: "/products" });

    vi.spyOn(UserRepositoryPrisma.prototype, "findByEmail").mockResolvedValue(
      dono,
    );
    vi.spyOn(UserRepositoryPrisma.prototype, "findById").mockResolvedValue(
      dono,
    );
    vi.spyOn(
      ProductRepositoryPrisma.prototype,
      "existsBySku",
    ).mockResolvedValue(false);
    vi.spyOn(ProductRepositoryPrisma.prototype, "create").mockImplementation(
      async (data: any) =>
        ({
          id: "prod-novo",
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
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  const criar = (payload: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: "/products",
      headers: { email: dono.email },
      payload: { ...base, ...payload },
    });

  // ── O que a issue #273 conserta ───────────────────────────────────────────
  it("POST /products RECUSA localização lotada com 422", async () => {
    locationFindFirstMock.mockResolvedValue(LOTADA);
    productCountMock.mockResolvedValue(1); // já tem 1, capacidade 1

    const res = await criar({ sku: "PECA-1", locationId: LOTADA.id });

    expect(res.statusCode, res.payload).toBe(422);
    expect(res.json().error).toMatch(/lotada/i);
    expect(res.json().detail).toMatchObject({
      currentCount: 1,
      maxCapacity: 1,
      attempting: 1,
      wouldExceedBy: 1,
    });
    // Nada foi criado.
    expect(ProductRepositoryPrisma.prototype.create).not.toHaveBeenCalled();
  });

  it("a mensagem diz o que o operador precisa saber (nome e ocupação)", async () => {
    locationFindFirstMock.mockResolvedValue({ ...LOTADA, maxCapacity: 50 });
    productCountMock.mockResolvedValue(50);

    const res = await criar({ sku: "PECA-2", locationId: LOTADA.id });
    expect(res.json().error).toBe('Localização "CAIXA-01" está lotada (50/50)');
  });

  // ── O que NÃO pode quebrar ────────────────────────────────────────────────
  it("com vaga sobrando, cria normalmente", async () => {
    locationFindFirstMock.mockResolvedValue({ ...LOTADA, maxCapacity: 10 });
    productCountMock.mockResolvedValue(4);

    const res = await criar({ sku: "PECA-3", locationId: LOTADA.id });
    expect(res.statusCode, res.payload).toBe(201);
    expect(ProductRepositoryPrisma.prototype.create).toHaveBeenCalled();
  });

  it("maxCapacity = 0 significa SEM limite — nunca bloqueia", async () => {
    locationFindFirstMock.mockResolvedValue(SEM_LIMITE);
    productCountMock.mockResolvedValue(99999);

    const res = await criar({ sku: "PECA-4", locationId: SEM_LIMITE.id });
    expect(res.statusCode, res.payload).toBe(201);
    // Nem chega a contar: o limite 0 corta antes.
    expect(productCountMock).not.toHaveBeenCalled();
  });

  it("sem locationId, nada é consultado nem bloqueado", async () => {
    const res = await criar({ sku: "PECA-5" });
    expect(res.statusCode, res.payload).toBe(201);
    expect(locationFindFirstMock).not.toHaveBeenCalled();
  });

  it("localização de OUTRO tenant não bloqueia aqui (a FK decide)", async () => {
    locationFindFirstMock.mockResolvedValue(null); // escopo por userId não achou
    const res = await criar({ sku: "PECA-6", locationId: "loc-de-outro" });
    expect(res.statusCode, res.payload).toBe(201);
    expect(productCountMock).not.toHaveBeenCalled();
  });

  it("sem dono resolvido, não consulta nada — `userId` undefined no Prisma viraria consulta sem escopo de tenant", async () => {
    const { LocationUseCase } =
      await import("../app/usecases/location.usercase");
    await new LocationUseCase().assertHasRoomForOne(
      "loc-qualquer",
      undefined as unknown as string,
    );
    expect(locationFindFirstMock).not.toHaveBeenCalled();
    expect(productCountMock).not.toHaveBeenCalled();
  });

  // ── Edição: o caso que protege as 209 peças já presas ─────────────────────
  it("PUT: reeditar peça que JÁ está na localização NÃO bloqueia, mesmo estourada", async () => {
    // A peça já mora na localização, que está muito acima do limite (148/55).
    productFindFirstMock.mockResolvedValue({ locationId: LOTADA.id });
    locationFindFirstMock.mockResolvedValue({ ...LOTADA, maxCapacity: 55 });
    productCountMock.mockResolvedValue(147);

    vi.spyOn(ProductRepositoryPrisma.prototype, "findById").mockResolvedValue({
      id: "prod-preso",
      userId: "owner-1",
      sku: "PECA-PRESA",
      name: "Retrovisor",
      price: 50,
      stock: 1,
      locationId: LOTADA.id,
    } as any);
    vi.spyOn(ProductRepositoryPrisma.prototype, "update").mockImplementation(
      async (_id: any, data: any) => ({ id: "prod-preso", ...data }) as any,
    );

    const res = await app.inject({
      method: "PUT",
      url: "/products/prod-preso",
      headers: { email: dono.email },
      payload: { name: "Retrovisor corrigido", locationId: LOTADA.id },
    });

    expect(res.statusCode, res.payload).toBe(200);
    expect(ProductRepositoryPrisma.prototype.update).toHaveBeenCalled();
    // Nem contou: saiu no atalho "já está aqui".
    expect(productCountMock).not.toHaveBeenCalled();
  });

  it("PUT: MOVER para uma localização lotada é recusado com 422", async () => {
    // A peça está em outro lugar e tenta entrar na lotada.
    productFindFirstMock.mockResolvedValue({ locationId: "loc-origem" });
    locationFindFirstMock.mockResolvedValue(LOTADA);
    productCountMock.mockResolvedValue(1);

    vi.spyOn(ProductRepositoryPrisma.prototype, "update").mockImplementation(
      async (_id: any, data: any) => ({ id: "prod-x", ...data }) as any,
    );

    const res = await app.inject({
      method: "PUT",
      url: "/products/prod-x",
      headers: { email: dono.email },
      payload: { locationId: LOTADA.id },
    });

    expect(res.statusCode, res.payload).toBe(422);
    expect(res.json().error).toMatch(/lotada/i);
    expect(ProductRepositoryPrisma.prototype.update).not.toHaveBeenCalled();
  });

  it("PUT: a própria peça não disputa vaga consigo mesma", async () => {
    // Vindo de outro lugar para uma com 1 vaga livre (capacidade 2, 1 ocupada).
    productFindFirstMock.mockResolvedValue({ locationId: "loc-origem" });
    locationFindFirstMock.mockResolvedValue({ ...LOTADA, maxCapacity: 2 });
    productCountMock.mockResolvedValue(1);

    vi.spyOn(ProductRepositoryPrisma.prototype, "findById").mockResolvedValue({
      id: "prod-y",
      userId: "owner-1",
      sku: "PECA-Y",
      name: "Lanterna",
      price: 50,
      stock: 1,
      locationId: "loc-origem",
    } as any);
    vi.spyOn(ProductRepositoryPrisma.prototype, "update").mockImplementation(
      async (_id: any, data: any) => ({ id: "prod-y", ...data }) as any,
    );

    const res = await app.inject({
      method: "PUT",
      url: "/products/prod-y",
      headers: { email: dono.email },
      payload: { locationId: LOTADA.id },
    });

    expect(res.statusCode, res.payload).toBe(200);
    // A contagem exclui a propria peça.
    expect(productCountMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          locationId: LOTADA.id,
          id: { not: "prod-y" },
        }),
      }),
    );
  });
});
