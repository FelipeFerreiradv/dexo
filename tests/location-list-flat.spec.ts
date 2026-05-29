import { describe, it, expect, beforeEach, vi } from "vitest";
import fastify from "fastify";

// ──────────────────────────────────────────────────────────
// GET /locations?tree=full — listagem achatada (todos os níveis)
// para busca/navegação client-side. Param opcional e retrocompatível:
// sem ele, o caminho legado (listLocations + paginação) deve ficar
// idêntico. Mockamos só o prisma para exercitar a cadeia real
// rota → usecase → repositório.
// ──────────────────────────────────────────────────────────

// vi.mock é içado ao topo do arquivo, então as refs dos mocks precisam vir de
// vi.hoisted (senão "Cannot access before initialization").
const { findManyMock, countMock } = vi.hoisted(() => ({
  findManyMock: vi.fn(),
  countMock: vi.fn(),
}));

vi.mock("../app/lib/prisma", () => ({
  default: {
    location: {
      findMany: (...args: any[]) => findManyMock(...args),
      count: (...args: any[]) => countMock(...args),
    },
  },
}));
vi.mock("@/app/lib/prisma", () => ({
  default: {
    location: {
      findMany: (...args: any[]) => findManyMock(...args),
      count: (...args: any[]) => countMock(...args),
    },
  },
}));

vi.mock("../app/middlewares/auth.middleware", () => ({
  authMiddleware: async (request: any, reply: any) => {
    const email = request.headers["email"];
    if (!email) return reply.status(401).send({ message: "Email is required" });
    request.user = { id: "user-1", dataOwnerId: "user-1" };
  },
}));

import { locationRoutes } from "../app/routes/location.routes";

const OWNER = "owner@test.com";

function buildApp() {
  const app = fastify();
  app.register(locationRoutes, { prefix: "/locations" });
  return app;
}

function row(over: Record<string, any>) {
  return {
    id: "x",
    userId: "user-1",
    code: "X",
    description: null,
    maxCapacity: 0,
    parentId: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    _count: { products: 0, children: 0 },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /locations?tree=full", () => {
  it("retorna lista achatada com childrenCount do _count e occupancy calculada", async () => {
    findManyMock.mockResolvedValue([
      row({
        id: "g1",
        code: "G1",
        maxCapacity: 0,
        parentId: null,
        _count: { products: 2, children: 3 },
      }),
      row({
        id: "p1",
        code: "PRAT-01",
        description: "Prateleira",
        maxCapacity: 10,
        parentId: "g1",
        _count: { products: 5, children: 0 },
      }),
    ]);

    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/locations?tree=full",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();

    // Shape de paginação compatível com o que o front lê (data.pagination.total)
    expect(body.pagination).toEqual({
      page: 1,
      limit: 2,
      total: 2,
      totalPages: 1,
    });
    expect(body.locations).toHaveLength(2);

    const g1 = body.locations.find((l: any) => l.id === "g1");
    expect(g1.childrenCount).toBe(3); // do _count, NÃO de children.length
    expect(g1.productsCount).toBe(2);
    expect(g1.occupancy).toBe(0); // maxCapacity 0 ⇒ 0
    expect(g1.children).toBeUndefined(); // sem nested children

    const p1 = body.locations.find((l: any) => l.id === "p1");
    expect(p1.childrenCount).toBe(0);
    expect(p1.productsCount).toBe(5);
    expect(p1.occupancy).toBe(50); // 5/10
    expect(p1.parentId).toBe("g1");

    // findMany: 1 chamada, where só por userId, sem paginação; count não usado
    expect(findManyMock).toHaveBeenCalledTimes(1);
    const arg = findManyMock.mock.calls[0][0];
    expect(arg.where).toEqual({ userId: "user-1" });
    expect(arg.skip).toBeUndefined();
    expect(arg.take).toBeUndefined();
    expect(countMock).not.toHaveBeenCalled();
  });

  it("occupancy satura em 100 quando ocupação excede a capacidade", async () => {
    findManyMock.mockResolvedValue([
      row({
        id: "c1",
        code: "CX",
        maxCapacity: 2,
        _count: { products: 5, children: 0 },
      }),
    ]);

    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/locations?tree=full",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().locations[0].occupancy).toBe(100);
  });

  it("regressão: sem tree=full mantém listLocations (root-only + paginação)", async () => {
    findManyMock.mockResolvedValue([
      row({
        id: "g1",
        code: "G1",
        parentId: null,
        _count: { products: 0, children: 1 },
        children: [
          {
            id: "c1",
            userId: "user-1",
            code: "C1",
            description: null,
            maxCapacity: 0,
            parentId: "g1",
            createdAt: new Date("2026-01-01"),
            updatedAt: new Date("2026-01-01"),
            _count: { products: 0, children: 0 },
          },
        ],
      }),
    ]);
    countMock.mockResolvedValue(1);

    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/locations?limit=100",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.pagination.total).toBe(1);
    expect(body.pagination.totalPages).toBe(1);
    // childrenCount do caminho legado vem de children.length (enrichWithOccupancy)
    expect(body.locations[0].childrenCount).toBe(1);
    // comportamento root-only preservado + count consultado
    expect(countMock).toHaveBeenCalledTimes(1);
    expect(findManyMock.mock.calls[0][0].where.parentId).toBe(null);
  });
});
