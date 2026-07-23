import { describe, it, expect, beforeEach, vi } from "vitest";
import fastify from "fastify";

// ──────────────────────────────────────────────────────────────────────────
// Apelido do veículo (Scrap.nickname) — campo ADITIVO String?.
//   - POST /scraps: aceita nickname opcional; ausente => null (default do repo).
//   - PUT /scraps/:id: cliente que NÃO envia nickname não pode apagá-lo
//     (spread condicional no repo — guarda anti-wipe).
//   - GET /scraps?search=: nickname entra no OR de busca SEM remover os 5
//     campos atuais (brand/model/plate/chassis/lot).
//   - GET /scraps/:id: mapper expõe nickname; null vira campo ausente.
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

vi.mock("../app/services/system-log.service", () => ({
  SystemLogService: {
    logInfo: vi.fn().mockResolvedValue(undefined),
    logWarning: vi.fn().mockResolvedValue(undefined),
    logError: vi.fn().mockResolvedValue(undefined),
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

// Linha "crua" do Prisma (Decimais null para não chamar .toNumber()).
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
});

describe("POST /scraps — nickname aditivo", () => {
  it("com nickname: persiste e ecoa na resposta 201", async () => {
    (prisma as any).scrap.create.mockResolvedValue({
      ...baseScrapRow,
      nickname: "Gol bola azul",
    });

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/scraps",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: { brand: "VW", model: "Gol", nickname: "Gol bola azul" },
    });

    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.payload).nickname).toBe("Gol bola azul");
    expect((prisma as any).scrap.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ nickname: "Gol bola azul" }),
      }),
    );
  });

  it("sem nickname: cria com null (default do repo) — retrocompatível", async () => {
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
        data: expect.objectContaining({ nickname: null }),
      }),
    );
  });
});

describe("PUT /scraps/:id — nickname parcial (guarda anti-wipe)", () => {
  it("com nickname no body: update recebe data.nickname", async () => {
    (prisma as any).scrap.findFirst.mockResolvedValue({ ...baseScrapRow });
    (prisma as any).scrap.update.mockResolvedValue({
      ...baseScrapRow,
      nickname: "Bolinha",
    });

    const app = buildApp();
    const res = await app.inject({
      method: "PUT",
      url: "/scraps/s-1",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: { nickname: "Bolinha" },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).nickname).toBe("Bolinha");
    const arg = (prisma as any).scrap.update.mock.calls[0][0];
    expect(arg.data.nickname).toBe("Bolinha");
  });

  it("SEM nickname no body: a chave não entra no data (não apaga o valor)", async () => {
    (prisma as any).scrap.findFirst.mockResolvedValue({
      ...baseScrapRow,
      nickname: "Gol bola azul",
    });
    (prisma as any).scrap.update.mockResolvedValue({
      ...baseScrapRow,
      nickname: "Gol bola azul",
      color: "Azul",
    });

    const app = buildApp();
    const res = await app.inject({
      method: "PUT",
      url: "/scraps/s-1",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: { color: "Azul" },
    });

    expect(res.statusCode).toBe(200);
    const arg = (prisma as any).scrap.update.mock.calls[0][0];
    expect(Object.prototype.hasOwnProperty.call(arg.data, "nickname")).toBe(
      false,
    );
  });
});

describe("GET /scraps?search= — nickname no OR sem regressão", () => {
  it("busca casa por nickname E mantém os 5 campos atuais no OR", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/scraps?search=bola",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    const arg = (prisma as any).scrap.findMany.mock.calls[0][0];
    const or = arg.where.OR as Array<Record<string, unknown>>;
    // Aditivo: os 5 campos originais continuam presentes…
    expect(or).toEqual(
      expect.arrayContaining([
        { brand: { contains: "bola", mode: "insensitive" } },
        { model: { contains: "bola", mode: "insensitive" } },
        { plate: { contains: "bola", mode: "insensitive" } },
        { chassis: { contains: "bola", mode: "insensitive" } },
        { lot: { contains: "bola", mode: "insensitive" } },
        // …e o nickname entra como 6º item.
        { nickname: { contains: "bola", mode: "insensitive" } },
      ]),
    );
    expect(or).toHaveLength(6);
  });

  it("sem search: nenhum OR é injetado (comportamento atual intacto)", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/scraps",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    expect((prisma as any).scrap.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-owner" } }),
    );
  });
});

describe("GET /scraps/:id — mapper do nickname", () => {
  it("linha com nickname: resposta expõe o campo", async () => {
    (prisma as any).scrap.findFirst.mockResolvedValue({
      ...baseScrapRow,
      nickname: "Gol bola azul",
    });

    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/scraps/s-1",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).nickname).toBe("Gol bola azul");
  });

  it("linha com nickname null: campo ausente da resposta (?? undefined)", async () => {
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
    expect("nickname" in body).toBe(false);
  });
});
