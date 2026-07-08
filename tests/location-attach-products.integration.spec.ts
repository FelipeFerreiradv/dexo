import { describe, it, expect, beforeEach, vi } from "vitest";
import fastify from "fastify";

// ──────────────────────────────────────────────────────────
// Mocks que precisam preceder o import das rotas
// ──────────────────────────────────────────────────────────

vi.mock("../app/lib/prisma", () => {
  const prisma = {
    location: {
      findFirst: vi.fn(),
    },
    product: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
    $transaction: vi.fn(async (cb: any) => cb(prisma)),
  };
  return { default: prisma };
});

vi.mock("@/app/lib/prisma", () => {
  const prisma = {
    location: {
      findFirst: vi.fn(),
    },
    product: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
    $transaction: vi.fn(async (cb: any) => cb(prisma)),
  };
  return { default: prisma };
});

vi.mock("../app/services/system-log.service", () => ({
  SystemLogService: {
    logInfo: vi.fn(),
    logWarning: vi.fn(),
    logError: vi.fn(),
    log: vi.fn(),
  },
}));

// Mock authMiddleware para injetar dataOwnerId baseado no header
vi.mock("../app/middlewares/auth.middleware", () => ({
  authMiddleware: async (request: any, reply: any) => {
    const email = request.headers["email"];
    if (!email) return reply.status(401).send({ message: "Email is required" });
    const userId = email === "owner@test.com" ? "user-owner" : "user-other";
    request.user = { id: userId, dataOwnerId: userId };
  },
}));

// Mock do LocationRepositoryPrisma (usado por attachProducts/buildFullPath).
// `findById` agora é chamado FORA da transação (pré-cálculo do fullPath), então
// precisa devolver uma localização válida. Delegamos a um vi.fn hoisted para os
// testes configurarem a hierarquia por caso.
const { locationFindByIdMock } = vi.hoisted(() => ({
  locationFindByIdMock: vi.fn(),
}));

vi.mock("../app/repositories/location.repository", () => ({
  LocationRepositoryPrisma: class {
    findById(id: string, userId?: string) {
      return locationFindByIdMock(id, userId);
    }
  },
}));

import prisma from "../app/lib/prisma";
import { locationRoutes } from "../app/routes/location.routes";

const OWNER = "owner@test.com";

function buildApp() {
  const app = fastify();
  app.register(locationRoutes, { prefix: "/locations" });
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: localização sem pai → buildFullPath devolve só o próprio code.
  locationFindByIdMock.mockResolvedValue({
    id: "loc-1",
    userId: "user-owner",
    code: "CAIXA01",
    description: null,
    maxCapacity: 0,
    parentId: null,
    productsCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
});

describe("POST /locations/:id/attach-products", () => {
  it("vincula 3 produtos válidos retornando 200", async () => {
    (prisma as any).location.findFirst.mockResolvedValue({
      id: "loc-1",
      userId: "user-owner",
      code: "CAIXA01",
      description: null,
      maxCapacity: 0,
      parentId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      _count: { products: 0 },
    });
    (prisma as any).product.findMany.mockResolvedValue([
      { id: "p1", sku: "SKU1", name: "Peça 1", locationId: null },
      { id: "p2", sku: "SKU2", name: "Peça 2", locationId: null },
      { id: "p3", sku: "SKU3", name: "Peça 3", locationId: null },
    ]);
    (prisma as any).product.updateMany.mockResolvedValue({ count: 3 });

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/locations/loc-1/attach-products",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: { productIds: ["p1", "p2", "p3"] },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.attached).toHaveLength(3);
    expect(body.alreadyAttached).toHaveLength(0);
    expect(body.skipped).toHaveLength(0);
    expect(body.location.code).toBe("CAIXA01");
    expect(body.location.productsCount).toBe(3);
  });

  it("aborta com 422 quando excede capacidade", async () => {
    (prisma as any).location.findFirst.mockResolvedValue({
      id: "loc-1",
      userId: "user-owner",
      code: "CAIXA01",
      description: null,
      maxCapacity: 10,
      parentId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      _count: { products: 8 },
    });
    (prisma as any).product.findMany.mockResolvedValue([
      { id: "p1", sku: "SKU1", name: "Peça 1", locationId: null },
      { id: "p2", sku: "SKU2", name: "Peça 2", locationId: null },
      { id: "p3", sku: "SKU3", name: "Peça 3", locationId: null },
    ]);

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/locations/loc-1/attach-products",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: { productIds: ["p1", "p2", "p3"] },
    });

    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error).toContain("capacidade");
    expect(body.detail).toMatchObject({
      currentCount: 8,
      maxCapacity: 10,
      attempting: 3,
      wouldExceedBy: 1,
    });
    expect(body.detail.acceptedIds).toEqual(["p1", "p2"]);
    expect(body.detail.excededIds).toEqual(["p3"]);
    expect((prisma as any).product.updateMany).not.toHaveBeenCalled();
  });

  it("filtra produtos de outro tenant em skipped (not_found)", async () => {
    (prisma as any).location.findFirst.mockResolvedValue({
      id: "loc-1",
      userId: "user-owner",
      code: "CAIXA01",
      description: null,
      maxCapacity: 0,
      parentId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      _count: { products: 0 },
    });
    // Apenas p1 e p2 pertencem ao user; p3 é de outro tenant
    (prisma as any).product.findMany.mockResolvedValue([
      { id: "p1", sku: "SKU1", name: "Peça 1", locationId: null },
      { id: "p2", sku: "SKU2", name: "Peça 2", locationId: null },
    ]);
    (prisma as any).product.updateMany.mockResolvedValue({ count: 2 });

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/locations/loc-1/attach-products",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: { productIds: ["p1", "p2", "p3"] },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.attached).toHaveLength(2);
    expect(body.skipped).toEqual([{ productId: "p3", reason: "not_found" }]);
  });

  it("é idempotente: re-attach retorna tudo em alreadyAttached", async () => {
    (prisma as any).location.findFirst.mockResolvedValue({
      id: "loc-1",
      userId: "user-owner",
      code: "CAIXA01",
      description: null,
      maxCapacity: 0,
      parentId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      _count: { products: 2 },
    });
    // Produtos já vinculados a loc-1
    (prisma as any).product.findMany.mockResolvedValue([
      { id: "p1", sku: "SKU1", name: "Peça 1", locationId: "loc-1" },
      { id: "p2", sku: "SKU2", name: "Peça 2", locationId: "loc-1" },
    ]);

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/locations/loc-1/attach-products",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: { productIds: ["p1", "p2"] },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.attached).toHaveLength(0);
    expect(body.alreadyAttached).toHaveLength(2);
    expect((prisma as any).product.updateMany).not.toHaveBeenCalled();
  });

  it("retorna 404 quando a localização não pertence ao user", async () => {
    (prisma as any).location.findFirst.mockResolvedValue(null);

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/locations/loc-other/attach-products",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: { productIds: ["p1"] },
    });

    expect(res.statusCode).toBe(404);
  });

  it("400 quando productIds está vazio", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/locations/loc-1/attach-products",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: { productIds: [] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("400 quando productIds excede 200 itens", async () => {
    const productIds = Array.from({ length: 201 }, (_, i) => `p${i}`);
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/locations/loc-1/attach-products",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: { productIds },
    });
    expect(res.statusCode).toBe(400);
  });

  it("dedupe silencioso de productIds duplicados", async () => {
    (prisma as any).location.findFirst.mockResolvedValue({
      id: "loc-1",
      userId: "user-owner",
      code: "CAIXA01",
      description: null,
      maxCapacity: 0,
      parentId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      _count: { products: 0 },
    });
    (prisma as any).product.findMany.mockResolvedValue([
      { id: "p1", sku: "SKU1", name: "Peça 1", locationId: null },
    ]);
    (prisma as any).product.updateMany.mockResolvedValue({ count: 1 });

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/locations/loc-1/attach-products",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: { productIds: ["p1", "p1", "p1"] },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.attached).toHaveLength(1);
    // findMany deve ser chamado com a lista deduplicada (1 id)
    expect((prisma as any).product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { in: ["p1"] },
        }),
      }),
    );
  });

  it("Bug A: hierarquia profunda vincula gravando fullPath correto", async () => {
    // buildFullPath sobe loc-sub → loc-prat → loc-gal (fora da transação).
    const chain: Record<string, any> = {
      "loc-sub": {
        id: "loc-sub",
        userId: "user-owner",
        code: "SUB-03",
        description: null,
        maxCapacity: 0,
        parentId: "loc-prat",
        productsCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      "loc-prat": {
        id: "loc-prat",
        userId: "user-owner",
        code: "PRAT-02",
        description: null,
        maxCapacity: 0,
        parentId: "loc-gal",
        productsCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      "loc-gal": {
        id: "loc-gal",
        userId: "user-owner",
        code: "GAL-01",
        description: null,
        maxCapacity: 0,
        parentId: null,
        productsCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    };
    locationFindByIdMock.mockImplementation(async (id: string) => chain[id] ?? null);

    (prisma as any).location.findFirst.mockResolvedValue({
      id: "loc-sub",
      userId: "user-owner",
      code: "SUB-03",
      description: null,
      maxCapacity: 0,
      parentId: "loc-prat",
      createdAt: new Date(),
      updatedAt: new Date(),
      _count: { products: 0 },
    });
    (prisma as any).product.findMany.mockResolvedValue([
      { id: "p1", sku: "SKU1", name: "Peça 1", locationId: null },
    ]);
    (prisma as any).product.updateMany.mockResolvedValue({ count: 1 });

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/locations/loc-sub/attach-products",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: { productIds: ["p1"] },
    });

    expect(res.statusCode).toBe(200);
    expect((prisma as any).product.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          locationId: "loc-sub",
          location: "GAL-01 > PRAT-02 > SUB-03",
        }),
      }),
    );
  });

  it("401 quando email não é enviado no header", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/locations/loc-1/attach-products",
      headers: { "content-type": "application/json" },
      payload: { productIds: ["p1"] },
    });
    expect(res.statusCode).toBe(401);
  });
});
