import { describe, it, expect, beforeEach, vi } from "vitest";
import fastify from "fastify";

// ──────────────────────────────────────────────────────────────────────────
// Fase 4 — Agregados financeiros em GET /scraps/:id.
//   - Sem ?include= : resposta IDÊNTICA à de hoje (sem financials/products,
//     sem nenhuma query extra) → retrocompat (regra 5).
//   - ?include=financials : investimento (cost+extraCosts), receita realizada
//     (marketplace + balcão), potencial e ROI.
//   - ?include=products : peças com etiqueta IN_STOCK/SOLD.
//   - Multi-tenant: sucata de outro usuário → 404 (sem agregar).
// ──────────────────────────────────────────────────────────────────────────

vi.mock("../app/lib/prisma", () => {
  const prisma: any = {
    scrap: { findFirst: vi.fn() },
    product: { findMany: vi.fn().mockResolvedValue([]) },
    orderItem: { groupBy: vi.fn().mockResolvedValue([]) },
    receivableItem: { groupBy: vi.fn().mockResolvedValue([]) },
    $queryRaw: vi
      .fn()
      .mockResolvedValue([{ marketplace: 0, counter: 0, potential: 0 }]),
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

// Fake Decimal (Prisma devolve Decimal com .toNumber()).
const dec = (n: number) => ({ toNumber: () => n });

const baseScrapRow: any = {
  id: "s-1",
  userId: "user-owner",
  brand: "VW",
  model: "Gol",
  year: "2006",
  version: null,
  color: null,
  plate: "ABC1D23",
  chassis: null,
  engineNumber: null,
  renavam: null,
  lot: null,
  deregistrationCert: null,
  cost: null,
  extraCosts: null,
  paymentMethod: null,
  locationId: null,
  location: null,
  ncm: null,
  supplierCnpj: null,
  accessKey: null,
  issueDate: null,
  entryDate: null,
  nfeNumber: null,
  nfeProtocol: null,
  operationNature: null,
  nfeSeries: null,
  fiscalModel: null,
  icmsValue: null,
  icmsCtValue: null,
  freightMode: null,
  issuePurpose: null,
  imageUrls: [],
  status: "AVAILABLE",
  logisticsStatus: "IN_YARD",
  notes: null,
  createdAt: new Date("2026-06-01"),
  updatedAt: new Date("2026-06-01"),
  _count: { products: 0 },
};

beforeEach(() => {
  vi.clearAllMocks();
  (prisma as any).scrap.findFirst.mockReset();
  (prisma as any).product.findMany.mockReset().mockResolvedValue([]);
  (prisma as any).orderItem.groupBy.mockReset().mockResolvedValue([]);
  (prisma as any).receivableItem.groupBy.mockReset().mockResolvedValue([]);
  (prisma as any).$queryRaw
    .mockReset()
    .mockResolvedValue([{ marketplace: 0, counter: 0, potential: 0 }]);
});

describe("Fase 4 — GET /scraps/:id sem include (retrocompat)", () => {
  it("retorna a sucata sem financials/products e sem queries extras", async () => {
    (prisma as any).scrap.findFirst.mockResolvedValue({ ...baseScrapRow });

    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/scraps/s-1",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.id).toBe("s-1");
    expect(body.financials).toBeUndefined();
    expect(body.products).toBeUndefined();
    // Nenhum agregado é executado quando não há ?include=.
    expect((prisma as any).$queryRaw).not.toHaveBeenCalled();
    expect((prisma as any).product.findMany).not.toHaveBeenCalled();
  });
});

describe("Fase 4 — GET /scraps/:id?include=financials", () => {
  it("calcula investimento (cost+extraCosts), receita realizada e ROI", async () => {
    (prisma as any).scrap.findFirst.mockResolvedValue({
      ...baseScrapRow,
      cost: dec(1000),
      extraCosts: dec(200),
    });
    (prisma as any).$queryRaw.mockResolvedValue([
      { marketplace: 2000, counter: 400, potential: 5000 },
    ]);

    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/scraps/s-1?include=financials",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.financials).toBeDefined();
    expect(body.financials.investment).toBe(1200);
    expect(body.financials.realizedRevenue).toEqual({
      marketplace: 2000,
      counter: 400,
      total: 2400,
    });
    expect(body.financials.potentialRevenue).toBe(5000);
    // ROI = (2400 - 1200) / 1200 * 100 = 100
    expect(body.financials.roi).toBe(100);
    // Um único request de agregação (sem N+1).
    expect((prisma as any).$queryRaw).toHaveBeenCalledTimes(1);
    expect(body.products).toBeUndefined();
  });

  it("ROI = null quando o investimento é 0", async () => {
    (prisma as any).scrap.findFirst.mockResolvedValue({ ...baseScrapRow });
    (prisma as any).$queryRaw.mockResolvedValue([
      { marketplace: 500, counter: 0, potential: 0 },
    ]);

    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/scraps/s-1?include=financials",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.financials.investment).toBe(0);
    expect(body.financials.roi).toBeNull();
  });
});

describe("Fase 4 — GET /scraps/:id?include=products", () => {
  it("lista peças com etiqueta IN_STOCK/SOLD por estoque", async () => {
    (prisma as any).scrap.findFirst.mockResolvedValue({ ...baseScrapRow });
    (prisma as any).product.findMany.mockResolvedValue([
      {
        id: "p-1",
        name: "Farol",
        sku: "SKU-1",
        partNumber: "FAR-001",
        price: "150.00",
        stock: 3,
      },
      {
        id: "p-2",
        name: "Porta",
        sku: "SKU-2",
        partNumber: null,
        price: "90.00",
        stock: 0,
      },
    ]);

    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/scraps/s-1?include=products",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.products).toHaveLength(2);
    expect(body.products[0]).toMatchObject({
      id: "p-1",
      name: "Farol",
      sku: "SKU-1",
      partNumber: "FAR-001",
      price: 150,
      stock: 3,
      status: "IN_STOCK",
    });
    expect(body.products[1]).toMatchObject({
      id: "p-2",
      price: 90,
      stock: 0,
      status: "SOLD",
    });
    expect((prisma as any).product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { scrapId: "s-1" } }),
    );
    // financials não foi pedido → não agrega.
    expect((prisma as any).$queryRaw).not.toHaveBeenCalled();
  });
});

describe("Diferencial G — peças enriquecidas (quality/segurança/vendidas)", () => {
  it("inclui quality, isSecurityItem e soldQuantity (marketplace + balcão)", async () => {
    (prisma as any).scrap.findFirst.mockResolvedValue({ ...baseScrapRow });
    (prisma as any).product.findMany.mockResolvedValue([
      {
        id: "p-1",
        name: "Farol",
        sku: "SKU-1",
        partNumber: "FAR-001",
        price: "150.00",
        stock: 1,
        quality: "SEMINOVO",
        isSecurityItem: true,
        isTraceable: false,
      },
    ]);
    (prisma as any).orderItem.groupBy.mockResolvedValue([
      { productId: "p-1", _sum: { quantity: 2 } },
    ]);
    (prisma as any).receivableItem.groupBy.mockResolvedValue([
      { productId: "p-1", _sum: { quantity: 1 } },
    ]);

    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/scraps/s-1?include=products",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.products[0]).toMatchObject({
      id: "p-1",
      quality: "SEMINOVO",
      isSecurityItem: true,
      isTraceable: false,
      soldQuantity: 3, // 2 marketplace + 1 balcão
    });
    // Vendas escopadas por userId do tenant.
    expect((prisma as any).orderItem.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ["productId"],
        where: expect.objectContaining({
          productId: { in: ["p-1"] },
          order: expect.objectContaining({
            marketplaceAccount: { userId: "user-owner" },
          }),
        }),
      }),
    );
  });
});

describe("Fase 4 — multi-tenant", () => {
  it("sucata de outro tenant => 404 e não agrega", async () => {
    (prisma as any).scrap.findFirst.mockResolvedValue(null);

    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/scraps/s-X?include=financials,products",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(404);
    expect((prisma as any).$queryRaw).not.toHaveBeenCalled();
    expect((prisma as any).product.findMany).not.toHaveBeenCalled();
  });
});
