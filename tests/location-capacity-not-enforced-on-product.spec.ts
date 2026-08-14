import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fastify from "fastify";

// ─────────────────────────────────────────────────────────────────────────────
// TESTE DE CARACTERIZAÇÃO — issue #273.
//
// Documenta o comportamento ATUAL, que é o defeito: `maxCapacity` é defendido
// em `attachProducts` (scan) e em `moveProducts`, mas NÃO no caminho que o
// operador mais usa — criar produto pela tela. Lá o `locationId` é repassado
// direto para o repositório, sem que a Location sequer seja consultada.
//
// Consequência: a única trava nesse caminho é o `isFull` do combobox
// (`app/produtos/components/location-combobox.tsx:139`), que é client-side —
// e por isso não dá para cachear `isFull` (issue #269) sem permitir estouro
// silencioso de capacidade.
//
// ⚠️ QUANDO A #273 FOR CORRIGIDA, ESTE ARQUIVO PRECISA SER INVERTIDO: o bloco
// "hoje NÃO valida" passa a esperar rejeição (ou aviso, conforme a opção
// escolhida na issue). Ele existe para PROVAR a lacuna, não para protegê-la.
// ─────────────────────────────────────────────────────────────────────────────

const { locationFindFirstMock, productFindManyMock, productUpdateManyMock } =
  vi.hoisted(() => ({
    locationFindFirstMock: vi.fn(),
    productFindManyMock: vi.fn(),
    productUpdateManyMock: vi.fn(),
  }));

// Repetido nas duas fábricas de propósito: `vi.mock` é içado ao topo do
// arquivo e não pode referenciar uma const declarada aqui fora.
vi.mock("../app/lib/prisma", () => {
  const prisma: any = {
    location: { findFirst: locationFindFirstMock },
    product: {
      findMany: productFindManyMock,
      updateMany: productUpdateManyMock,
      create: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
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
      findMany: productFindManyMock,
      updateMany: productUpdateManyMock,
      create: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
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
import { locationRoutes } from "../app/routes/location.routes";
import { UserRepositoryPrisma } from "../app/repositories/user.repository";
import { ProductRepositoryPrisma } from "../app/repositories/product.repository";
import { ListingDispatcher } from "../app/marketplaces/services/listing-dispatcher.service";

/** A MESMA localização nos dois cenários: capacidade 1, já com 1 produto. */
const LOTADA = {
  id: "loc-lotada",
  userId: "owner-1",
  code: "CAIXA-01",
  description: null,
  maxCapacity: 1,
  parentId: null,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

// E-mail exclusivo deste spec: o auth.middleware tem cache de usuário por
// e-mail (60s) em nível de módulo.
const dono = {
  id: "owner-1",
  email: "dono.capacidade-273@example.com",
  name: "Dono",
  parentUserId: null,
} as any;

describe("issue #273 — capacidade da localização no caminho de produto", () => {
  let app: ReturnType<typeof fastify>;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = fastify();
    await app.register(productRoutes, { prefix: "/products" });
    await app.register(locationRoutes, { prefix: "/locations" });

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

  // ── O invariante É defendido aqui ─────────────────────────────────────────
  it("attach-products RECUSA vincular a uma localização lotada (422)", async () => {
    // A localização lotada, do jeito que `attachProducts` a lê.
    locationFindFirstMock.mockResolvedValue({
      ...LOTADA,
      _count: { products: 1 },
    });
    // O produto que se tenta vincular ainda não está nela.
    productFindManyMock.mockResolvedValue([
      { id: "prod-novo", locationId: null },
    ]);

    const res = await app.inject({
      method: "POST",
      url: "/locations/loc-lotada/attach-products",
      headers: { email: dono.email },
      payload: { productIds: ["prod-novo"] },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatch(/capacidade/i);
    // Nada foi gravado.
    expect(productUpdateManyMock).not.toHaveBeenCalled();
  });

  // ── …mas NÃO aqui. É o defeito da #273. ───────────────────────────────────
  it("POST /products ACEITA a mesma localização lotada — sem validar nada", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/products",
      headers: { email: dono.email },
      payload: {
        sku: "PECA-ALEM-DO-LIMITE",
        name: "Farol Dianteiro Gol",
        price: 100,
        stock: 1,
        imageUrl: "http://localhost:3333/uploads/test.jpg",
        locationId: LOTADA.id,
      },
    });

    // Comportamento ATUAL: passa.
    expect(res.statusCode, res.payload).toBe(201);
    expect(ProductRepositoryPrisma.prototype.create).toHaveBeenCalledWith(
      expect.objectContaining({ locationId: LOTADA.id }),
    );
  });

  it("POST /products sequer CONSULTA a localização — não há o que validar", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/products",
      headers: { email: dono.email },
      payload: {
        sku: "PECA-ALEM-DO-LIMITE-2",
        name: "Lanterna Traseira Gol",
        price: 100,
        stock: 1,
        imageUrl: "http://localhost:3333/uploads/test.jpg",
        locationId: LOTADA.id,
      },
    });

    // Trava OBRIGATÓRIA: sem confirmar que o cadastro chegou até o fim, a
    // asserção seguinte passaria de graça em qualquer 4xx precoce (validação
    // de payload, auth...) — provaria que a rota não rodou, não que ela não
    // valida capacidade.
    expect(res.statusCode, res.payload).toBe(201);

    // Esta é a prova mais direta: a rota não lê a Location em momento algum,
    // então `maxCapacity` nunca entra na conta. Não é um check que falha —
    // é um check que não existe.
    expect(locationFindFirstMock).not.toHaveBeenCalled();
  });

  it("o mesmo vale para o PUT /products/:id (mover para uma lotada)", async () => {
    vi.spyOn(ProductRepositoryPrisma.prototype, "findById").mockResolvedValue({
      id: "prod-existente",
      userId: "owner-1",
      sku: "PECA-EXISTENTE",
      name: "Retrovisor",
      price: 50,
      stock: 1,
      locationId: null,
    } as any);
    vi.spyOn(ProductRepositoryPrisma.prototype, "update").mockImplementation(
      async (_id: any, data: any) => ({ id: "prod-existente", ...data }) as any,
    );

    const res = await app.inject({
      method: "PUT",
      url: "/products/prod-existente",
      headers: { email: dono.email },
      payload: { locationId: LOTADA.id },
    });

    expect(res.statusCode, res.payload).toBe(200);
    expect(ProductRepositoryPrisma.prototype.update).toHaveBeenCalledWith(
      "prod-existente",
      expect.objectContaining({ locationId: LOTADA.id }),
      expect.anything(),
    );
    expect(locationFindFirstMock).not.toHaveBeenCalled();
  });
});
