import { describe, it, expect, beforeEach, vi } from "vitest";
import fastify from "fastify";

// ──────────────────────────────────────────────────────────────────────────
// Fase E — Visão de Balcão: GET /scraps/balcao.
//   - Reusa o ranking de produtos (ProductRepositoryPrisma.findAll) e enriquece
//     cada peça com o lote de origem (Scrap) + estágio logístico, num batch só.
//   - q < 2 chars: não busca. scrapId órfão/ausente => source null.
//   - Multi-tenant: findAll e findStagesByIds recebem o userId.
// ──────────────────────────────────────────────────────────────────────────

const { findAllMock } = vi.hoisted(() => ({ findAllMock: vi.fn() }));

vi.mock("../app/repositories/product.repository", () => ({
  ProductRepositoryPrisma: class {
    findAll = findAllMock;
  },
}));

vi.mock("../app/lib/prisma", () => {
  const prisma: any = {
    scrap: { findMany: vi.fn().mockResolvedValue([]) },
  };
  return { default: prisma };
});

vi.mock("../app/middlewares/auth.middleware", () => ({
  authMiddleware: async (request: any, reply: any) => {
    const email = request.headers["email"];
    if (!email) return reply.status(401).send({ message: "Email is required" });
    request.user = { id: "user-owner", dataOwnerId: "user-owner" };
  },
}));

vi.mock("../app/services/system-log.service", () => ({
  SystemLogService: {
    logInfo: vi.fn().mockResolvedValue(undefined),
    log: vi.fn().mockResolvedValue(undefined),
  },
}));

import prisma from "../app/lib/prisma";
import { scrapRoutes } from "../app/routes/scrap.routes";

const OWNER = "owner@test.com";

function buildApp() {
  const app = fastify();
  app.register(scrapRoutes, { prefix: "/scraps" });
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  findAllMock.mockReset();
  (prisma as any).scrap.findMany.mockReset().mockResolvedValue([]);
});

describe("Fase E — GET /scraps/balcao", () => {
  it("q < 2 chars: retorna [] sem buscar produtos nem estágios", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/scraps/balcao?q=a",
      headers: { email: OWNER },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ results: [] });
    expect(findAllMock).not.toHaveBeenCalled();
    expect((prisma as any).scrap.findMany).not.toHaveBeenCalled();
  });

  it("enriquece a peça com o lote de origem e o estágio logístico", async () => {
    findAllMock.mockResolvedValue({
      products: [
        {
          id: "p-1",
          name: "Farol Gol",
          sku: "SKU-1",
          partNumber: "FAR-1",
          price: 150,
          stock: 2,
          scrapId: "s-1",
        },
      ],
      total: 1,
    });
    (prisma as any).scrap.findMany.mockResolvedValue([
      {
        id: "s-1",
        brand: "VW",
        model: "Gol",
        year: "2006",
        plate: "ABC1D23",
        logisticsStatus: "ON_LIFT",
      },
    ]);

    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/scraps/balcao?q=farol",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({
      id: "p-1",
      name: "Farol Gol",
      sku: "SKU-1",
      partNumber: "FAR-1",
      price: 150,
      stock: 2,
      source: {
        scrapId: "s-1",
        brand: "VW",
        model: "Gol",
        year: "2006",
        plate: "ABC1D23",
        logisticsStatus: "ON_LIFT",
      },
    });
    // Ranking reusado + escopo por userId
    expect(findAllMock).toHaveBeenCalledWith(
      { search: "farol", limit: 12 },
      "user-owner",
    );
    expect((prisma as any).scrap.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ["s-1"] }, userId: "user-owner" },
      }),
    );
  });

  it("peça com scrapId órfão (lote não encontrado) => source null", async () => {
    findAllMock.mockResolvedValue({
      products: [
        {
          id: "p-2",
          name: "Porta",
          sku: "SKU-2",
          price: 90,
          stock: 0,
          scrapId: "s-x",
        },
      ],
      total: 1,
    });
    (prisma as any).scrap.findMany.mockResolvedValue([]);

    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/scraps/balcao?q=porta",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).results[0].source).toBeNull();
  });

  it("peça sem scrapId => source null e não consulta estágios", async () => {
    findAllMock.mockResolvedValue({
      products: [
        {
          id: "p-3",
          name: "Parafuso",
          sku: "SKU-3",
          price: 5,
          stock: 100,
          scrapId: null,
        },
      ],
      total: 1,
    });

    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/scraps/balcao?q=parafuso",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).results[0].source).toBeNull();
    // sem scrapIds => findStagesByIds curto-circuita (ids vazios), sem hit no banco
    expect((prisma as any).scrap.findMany).not.toHaveBeenCalled();
  });
});
