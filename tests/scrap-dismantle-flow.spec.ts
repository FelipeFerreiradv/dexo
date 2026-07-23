import { describe, it, expect, beforeEach, vi } from "vitest";
import fastify from "fastify";

// ──────────────────────────────────────────────────────────────────────────
// Fluxo de DESMEMBRAMENTO (fase: gerar peças + avançar para DISMANTLED).
// O fluxo reusa contratos existentes — este spec trava os invariantes que a
// UI nova depende:
//   1) peça = ProductRepository.create com scrapId (tenant-guard intacto);
//   2) PATCH /scraps/:id/logistics-status → DISMANTLED grava ScrapStatusEvent
//      {from,to} e SystemLog (timeline do detalhe);
//   3) DISMANTLED com 0 peças é permitido (decisão de UX, não de domínio —
//      lote vendido no balcão sem peça cadastrada é legítimo).
// ──────────────────────────────────────────────────────────────────────────

vi.mock("../app/lib/prisma", () => {
  const prisma: any = {
    scrap: {
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn(),
      update: vi.fn(),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    product: {
      create: vi.fn(),
      findFirst: vi.fn(),
      updateMany: vi.fn(),
    },
    scrapStatusEvent: { create: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn(),
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
    logWarning: vi.fn().mockResolvedValue(undefined),
    logError: vi.fn().mockResolvedValue(undefined),
    log: vi.fn().mockResolvedValue(undefined),
  },
}));

import prisma from "../app/lib/prisma";
import { SystemLogService } from "../app/services/system-log.service";
import { scrapRoutes } from "../app/routes/scrap.routes";
import { ProductRepositoryPrisma } from "../app/repositories/product.repository";

const OWNER = "owner@test.com";

function buildApp() {
  const app = fastify();
  app.register(scrapRoutes, { prefix: "/scraps" });
  return app;
}

const baseScrapRow = {
  id: "s-1",
  userId: "user-owner",
  brand: "VW",
  model: "Gol",
  nickname: null,
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
  logisticsStatus: "ON_LIFT",
  notes: null,
  createdAt: new Date("2026-06-01"),
  updatedAt: new Date("2026-06-01"),
  _count: { products: 0 },
};

// Linha "raw" mínima que o mapPrismaToProduct mapeia (price.toNumber()).
function makeProductRow(over: Record<string, unknown> = {}) {
  return {
    id: "p-1",
    userId: "user-owner",
    sku: "SKU-1",
    name: "Porta dianteira esquerda",
    stock: 1,
    price: { toNumber: () => 350 },
    createdAt: new Date(),
    updatedAt: new Date(),
    imageUrls: [],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  const s = (prisma as any).scrap;
  s.findFirst.mockReset();
  s.create.mockReset();
  s.update.mockReset();
  s.findMany.mockReset().mockResolvedValue([]);
  s.count.mockReset().mockResolvedValue(0);
  s.groupBy.mockReset().mockResolvedValue([]);
  (prisma as any).product.create.mockReset();
  (prisma as any).scrapStatusEvent.create.mockReset().mockResolvedValue({});
});

describe("Desmembrar — peça criada pré-vinculada ao lote (scrapId)", () => {
  const repo = new ProductRepositoryPrisma();

  it("cria a peça com scrapId do próprio tenant (guard consultado 1x)", async () => {
    (prisma as any).scrap.findFirst.mockResolvedValue({ id: "s-1" });
    (prisma as any).product.create.mockResolvedValue(
      makeProductRow({ scrapId: "s-1" }),
    );

    const out = await repo.create({
      userId: "user-owner",
      sku: "SKU-1",
      name: "Porta dianteira esquerda",
      stock: 1,
      price: 350,
      scrapId: "s-1",
    } as any);

    expect((prisma as any).scrap.findFirst).toHaveBeenCalledWith({
      where: { id: "s-1", userId: "user-owner" },
      select: { id: true },
    });
    const arg = (prisma as any).product.create.mock.calls[0][0];
    expect(arg.data.scrapId).toBe("s-1");
    expect(out.id).toBe("p-1");
  });

  it("scrapId de OUTRO tenant: rejeita e não cria (o dialog travado não burla o guard)", async () => {
    (prisma as any).scrap.findFirst.mockResolvedValue(null);

    await expect(
      repo.create({
        userId: "user-owner",
        sku: "SKU-1",
        name: "Porta",
        stock: 1,
        price: 350,
        scrapId: "sucata-alheia",
      } as any),
    ).rejects.toThrow(/inválido/i);

    expect((prisma as any).product.create).not.toHaveBeenCalled();
  });
});

describe("Desmembrar — PATCH logistics-status → DISMANTLED", () => {
  it("avança de ON_LIFT para DISMANTLED com evento {from,to} + SystemLog", async () => {
    (prisma as any).scrap.findFirst.mockResolvedValue({ ...baseScrapRow });
    (prisma as any).scrap.update.mockResolvedValue({
      ...baseScrapRow,
      logisticsStatus: "DISMANTLED",
    });

    const app = buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/scraps/s-1/logistics-status",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: { logisticsStatus: "DISMANTLED" },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).logisticsStatus).toBe("DISMANTLED");
    expect((prisma as any).scrapStatusEvent.create).toHaveBeenCalledWith({
      data: {
        scrapId: "s-1",
        userId: "user-owner",
        fromStatus: "ON_LIFT",
        toStatus: "DISMANTLED",
      },
    });
    expect((SystemLogService as any).logInfo).toHaveBeenCalledWith(
      "UPDATE_SCRAP",
      expect.any(String),
      expect.objectContaining({
        resource: "Scrap",
        resourceId: "s-1",
        details: expect.objectContaining({
          from: "ON_LIFT",
          to: "DISMANTLED",
        }),
      }),
    );
  });

  it("DISMANTLED com 0 peças cadastradas é permitido (sem restrição de contagem)", async () => {
    (prisma as any).scrap.findFirst.mockResolvedValue({
      ...baseScrapRow,
      _count: { products: 0 },
    });
    (prisma as any).scrap.update.mockResolvedValue({
      ...baseScrapRow,
      logisticsStatus: "DISMANTLED",
    });

    const app = buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/scraps/s-1/logistics-status",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: { logisticsStatus: "DISMANTLED" },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).logisticsStatus).toBe("DISMANTLED");
  });

  it("sucata de outro tenant: 404 e nenhum evento gravado", async () => {
    (prisma as any).scrap.findFirst.mockResolvedValue(null);

    const app = buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/scraps/s-X/logistics-status",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: { logisticsStatus: "DISMANTLED" },
    });

    expect(res.statusCode).toBe(404);
    expect((prisma as any).scrapStatusEvent.create).not.toHaveBeenCalled();
  });
});
