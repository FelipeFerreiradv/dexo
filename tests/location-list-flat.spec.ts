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
const { findManyMock, countMock, locationGroupByMock, productGroupByMock } =
  vi.hoisted(() => ({
    findManyMock: vi.fn(),
    countMock: vi.fn(),
    locationGroupByMock: vi.fn(),
    productGroupByMock: vi.fn(),
  }));

vi.mock("../app/lib/prisma", () => ({
  default: {
    location: {
      findMany: (...args: any[]) => findManyMock(...args),
      count: (...args: any[]) => countMock(...args),
      groupBy: (...args: any[]) => locationGroupByMock(...args),
    },
    product: {
      groupBy: (...args: any[]) => productGroupByMock(...args),
    },
  },
}));
vi.mock("@/app/lib/prisma", () => ({
  default: {
    location: {
      findMany: (...args: any[]) => findManyMock(...args),
      count: (...args: any[]) => countMock(...args),
      groupBy: (...args: any[]) => locationGroupByMock(...args),
    },
    product: {
      groupBy: (...args: any[]) => productGroupByMock(...args),
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
  it("retorna lista achatada com counts dos groupBy escopados e occupancy calculada", async () => {
    // Caminho NOVO do findAllFlat: findMany sem _count + 2 groupBy escopados
    // nos ids retornados (Product por locationId, Location por parentId).
    findManyMock.mockResolvedValue([
      row({ id: "g1", code: "G1", maxCapacity: 0, parentId: null }),
      row({
        id: "p1",
        code: "PRAT-01",
        description: "Prateleira",
        maxCapacity: 10,
        parentId: "g1",
      }),
    ]);
    productGroupByMock.mockResolvedValue([
      { locationId: "g1", _count: { _all: 2 } },
      { locationId: "p1", _count: { _all: 5 } },
    ]);
    locationGroupByMock.mockResolvedValue([
      { parentId: "g1", _count: { _all: 3 } },
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
    expect(g1.childrenCount).toBe(3); // do groupBy por parentId, NÃO de children.length
    expect(g1.productsCount).toBe(2);
    expect(g1.occupancy).toBe(0); // maxCapacity 0 ⇒ 0
    expect(g1.children).toBeUndefined(); // sem nested children

    const p1 = body.locations.find((l: any) => l.id === "p1");
    expect(p1.childrenCount).toBe(0);
    expect(p1.productsCount).toBe(5);
    expect(p1.occupancy).toBe(50); // 5/10
    expect(p1.parentId).toBe("g1");

    // findMany: 1 chamada, where só por userId, sem paginação nem _count;
    // count não usado
    expect(findManyMock).toHaveBeenCalledTimes(1);
    const arg = findManyMock.mock.calls[0][0];
    expect(arg.where).toEqual({ userId: "user-1" });
    expect(arg.skip).toBeUndefined();
    expect(arg.take).toBeUndefined();
    expect(arg.include).toBeUndefined();
    expect(countMock).not.toHaveBeenCalled();

    // groupBy ESCOPADOS nos ids retornados (nunca a tabela inteira)
    expect(productGroupByMock).toHaveBeenCalledTimes(1);
    expect(productGroupByMock.mock.calls[0][0].where).toEqual({
      locationId: { in: ["g1", "p1"] },
    });
    expect(locationGroupByMock).toHaveBeenCalledTimes(1);
    expect(locationGroupByMock.mock.calls[0][0].where).toEqual({
      parentId: { in: ["g1", "p1"] },
    });
  });

  it("occupancy satura em 100 quando ocupação excede a capacidade", async () => {
    findManyMock.mockResolvedValue([row({ id: "c1", code: "CX", maxCapacity: 2 })]);
    productGroupByMock.mockResolvedValue([
      { locationId: "c1", _count: { _all: 5 } },
    ]);
    locationGroupByMock.mockResolvedValue([]);

    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/locations?tree=full",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().locations[0].occupancy).toBe(100);
  });

  it("kill-switch LOCATION_FLAT_COUNTS_DISABLED=1 usa o include legado (_count)", async () => {
    process.env.LOCATION_FLAT_COUNTS_DISABLED = "1";
    try {
      findManyMock.mockResolvedValue([
        row({
          id: "g1",
          code: "G1",
          maxCapacity: 10,
          _count: { products: 4, children: 2 },
        }),
      ]);

      const app = buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/locations?tree=full",
        headers: { email: OWNER },
      });

      expect(res.statusCode).toBe(200);
      const loc = res.json().locations[0];
      expect(loc.productsCount).toBe(4);
      expect(loc.childrenCount).toBe(2);
      // caminho legado: findMany com include._count e NENHUM groupBy
      expect(findManyMock.mock.calls[0][0].include).toEqual({
        _count: { select: { products: true, children: true } },
      });
      expect(productGroupByMock).not.toHaveBeenCalled();
      expect(locationGroupByMock).not.toHaveBeenCalled();
    } finally {
      delete process.env.LOCATION_FLAT_COUNTS_DISABLED;
    }
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
