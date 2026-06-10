import { describe, it, expect, beforeEach, vi } from "vitest";
import fastify from "fastify";

// ──────────────────────────────────────────────────────────────────────────
// Fase 2 — Status logístico de sucatas (backend).
//   - GET /scraps: filtro OPCIONAL logisticsStatus; sem ele = comportamento atual.
//   - GET /scraps/pipeline: contadores por estágio num único request (sem N+1).
//   - PATCH /scraps/:id/logistics-status: transição com validação + ownership +
//     log {from,to} via SystemLogService.
//   - POST/PUT: aceitam logisticsStatus/extraCosts (campos novos, opcionais).
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
    product: { updateMany: vi.fn() },
    scrapStatusEvent: { create: vi.fn().mockResolvedValue({}) },
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

// Log estruturado da transição é gravado aqui — mockamos para asseverar a
// chamada sem tocar no SystemLogRepository/prisma.
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

const OWNER = "owner@test.com";

function buildApp() {
  const app = fastify();
  app.register(scrapRoutes, { prefix: "/scraps" });
  return app;
}

// Linha "crua" do Prisma (campos Decimal como null para não chamar .toNumber()).
const baseScrapRow = {
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
  const s = (prisma as any).scrap;
  s.findFirst.mockReset();
  s.create.mockReset();
  s.update.mockReset();
  s.findMany.mockReset().mockResolvedValue([]);
  s.count.mockReset().mockResolvedValue(0);
  s.groupBy.mockReset().mockResolvedValue([]);
  (prisma as any).scrapStatusEvent.create.mockReset().mockResolvedValue({});
});

describe("Fase 2 — GET /scraps (filtro logístico retrocompatível)", () => {
  it("sem params novos: where = { userId } apenas (idêntico ao atual)", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/scraps",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body).toHaveProperty("scraps");
    expect(body).toHaveProperty("pagination");
    // Crítico p/ não-regressão: nenhum filtro extra é injetado no where.
    expect((prisma as any).scrap.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-owner" } }),
    );
  });

  it("?logisticsStatus=ON_LIFT aplica o filtro logístico", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/scraps?logisticsStatus=ON_LIFT",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    expect((prisma as any).scrap.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-owner", logisticsStatus: "ON_LIFT" },
      }),
    );
  });

  it("?logisticsStatus=BOGUS ignora valor inválido (sem filtro)", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/scraps?logisticsStatus=BOGUS",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    expect((prisma as any).scrap.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-owner" } }),
    );
  });
});

describe("Fase 2 — GET /scraps/pipeline (contadores sem N+1)", () => {
  it("retorna os 4 estágios com contadores num único request", async () => {
    (prisma as any).scrap.groupBy.mockResolvedValue([
      { logisticsStatus: "IN_YARD", _count: { _all: 3 } },
      { logisticsStatus: "ON_LIFT", _count: { _all: 1 } },
    ]);
    (prisma as any).scrap.findMany.mockResolvedValue([]);

    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/scraps/pipeline",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(Object.keys(body.stages).sort()).toEqual([
      "DISMANTLED",
      "IN_TRANSIT",
      "IN_YARD",
      "ON_LIFT",
    ]);
    expect(body.stages.IN_YARD.count).toBe(3);
    expect(body.stages.ON_LIFT.count).toBe(1);
    expect(body.stages.IN_TRANSIT.count).toBe(0);
    expect(body.stages.DISMANTLED.count).toBe(0);

    // Sem N+1: 1 groupBy de contagem + 1 findMany por estágio.
    expect((prisma as any).scrap.groupBy).toHaveBeenCalledTimes(1);
    expect((prisma as any).scrap.findMany).toHaveBeenCalledTimes(4);
    expect((prisma as any).scrap.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ["logisticsStatus"],
        where: { userId: "user-owner" },
      }),
    );
  });
});

describe("Fase 2 — PATCH /scraps/:id/logistics-status", () => {
  it("transiciona, registra {from,to} e devolve a sucata atualizada", async () => {
    (prisma as any).scrap.findFirst.mockResolvedValue({
      ...baseScrapRow,
      logisticsStatus: "IN_YARD",
    });
    (prisma as any).scrap.update.mockResolvedValue({
      ...baseScrapRow,
      logisticsStatus: "ON_LIFT",
    });

    const app = buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/scraps/s-1/logistics-status",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: { logisticsStatus: "ON_LIFT" },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).logisticsStatus).toBe("ON_LIFT");
    expect((prisma as any).scrap.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "s-1" },
        data: { logisticsStatus: "ON_LIFT" },
      }),
    );
    // Carimbo de tempo/auditoria da transição com from->to.
    expect((SystemLogService as any).logInfo).toHaveBeenCalledWith(
      "UPDATE_SCRAP",
      expect.any(String),
      expect.objectContaining({
        resource: "Scrap",
        resourceId: "s-1",
        details: expect.objectContaining({ from: "IN_YARD", to: "ON_LIFT" }),
      }),
    );

    // Diferencial F: evento estruturado de transição gravado.
    expect((prisma as any).scrapStatusEvent.create).toHaveBeenCalledWith({
      data: {
        scrapId: "s-1",
        userId: "user-owner",
        fromStatus: "IN_YARD",
        toStatus: "ON_LIFT",
      },
    });
  });

  it("valor inválido => 400 e nada é persistido/lido", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/scraps/s-1/logistics-status",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: { logisticsStatus: "FLYING" },
    });

    expect(res.statusCode).toBe(400);
    expect((prisma as any).scrap.findFirst).not.toHaveBeenCalled();
    expect((prisma as any).scrap.update).not.toHaveBeenCalled();
    expect((SystemLogService as any).logInfo).not.toHaveBeenCalled();
  });

  it("sucata de outro tenant => 404 (multi-tenant preservado)", async () => {
    (prisma as any).scrap.findFirst.mockResolvedValue(null);

    const app = buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/scraps/s-X/logistics-status",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: { logisticsStatus: "ON_LIFT" },
    });

    expect(res.statusCode).toBe(404);
    expect((prisma as any).scrap.update).not.toHaveBeenCalled();
  });
});

describe("Fase 2 — POST/GET com campos novos", () => {
  it("POST aceita logisticsStatus e extraCosts", async () => {
    (prisma as any).scrap.create.mockResolvedValue({
      ...baseScrapRow,
      logisticsStatus: "IN_TRANSIT",
    });

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/scraps",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: {
        brand: "VW",
        model: "Gol",
        logisticsStatus: "IN_TRANSIT",
        extraCosts: 500,
      },
    });

    expect(res.statusCode).toBe(201);
    expect((prisma as any).scrap.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          logisticsStatus: "IN_TRANSIT",
          extraCosts: 500,
        }),
      }),
    );
  });

  it("POST sem logisticsStatus: default IN_YARD na criação", async () => {
    (prisma as any).scrap.create.mockResolvedValue({ ...baseScrapRow });

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/scraps",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: { brand: "VW", model: "Gol" },
    });

    expect(res.statusCode).toBe(201);
    expect((prisma as any).scrap.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          logisticsStatus: "IN_YARD",
          extraCosts: null,
        }),
      }),
    );
  });

  it("GET /scraps/:id devolve a sucata com logisticsStatus", async () => {
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
    expect(body.logisticsStatus).toBe("IN_YARD");
  });
});
