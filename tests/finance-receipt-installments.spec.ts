import { describe, it, expect, beforeEach, vi } from "vitest";
import fastify from "fastify";

// ──────────────────────────────────────────────────────────
// Bloco B — o cupom de uma venda PARCELADA.
//
// O bug que isto trava: a conta-mãe carrega TODOS os itens (R$ 131,11) mas seu
// `totalAmount` é só a ENTRADA (R$ 100,00). Sem carregar as filhas, o cupom
// saía com itens somando 131,11 e TOTAL de 100,00 — aritmética quebrada na
// mão do cliente, e sem nenhuma menção ao saldo.
//
// O ponto de corte é a chamada de `ReceiptPdfService.generate`: provamos que a
// rota entrega as parcelas ao gerador (e que uma venda à vista continua
// chamando com TRÊS argumentos, aridade byte-idêntica à de sempre).
// ──────────────────────────────────────────────────────────

const generateMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
);
vi.mock("../app/financeiro/generators/receipt-pdf.service", () => ({
  ReceiptPdfService: class {
    generate = generateMock;
  },
}));
vi.mock("@/app/financeiro/generators/receipt-pdf.service", () => ({
  ReceiptPdfService: class {
    generate = generateMock;
  },
}));

vi.mock("../app/fiscal/generators/load-avatar", () => ({
  loadTenantAvatar: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/app/fiscal/generators/load-avatar", () => ({
  loadTenantAvatar: vi.fn().mockResolvedValue(null),
}));

vi.mock("../app/repositories/company-fiscal.repository", () => ({
  CompanyFiscalRepository: class {
    findByUserId = vi.fn().mockResolvedValue(null);
  },
}));
vi.mock("@/app/repositories/company-fiscal.repository", () => ({
  CompanyFiscalRepository: class {
    findByUserId = vi.fn().mockResolvedValue(null);
  },
}));

function makePrisma() {
  const fmodel = () => ({
    findMany: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
    create: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
    createMany: vi.fn(),
    groupBy: vi.fn().mockResolvedValue([]),
    aggregate: vi.fn().mockResolvedValue({ _sum: {}, _count: 0 }),
  });
  const prisma: any = {
    receivable: fmodel(),
    payable: fmodel(),
    receivableItem: fmodel(),
    receivablePayment: fmodel(),
    customer: { findFirst: vi.fn() },
    unidade: { findFirst: vi.fn() },
    product: fmodel(),
  };
  prisma.$transaction = vi.fn(async (cb: any) => cb(prisma));
  return prisma;
}
vi.mock("../app/lib/prisma", () => ({ default: makePrisma() }));
vi.mock("@/app/lib/prisma", () => ({ default: makePrisma() }));

vi.mock("../app/middlewares/auth.middleware", () => ({
  authMiddleware: async (request: any, reply: any) => {
    const email = request.headers["email"];
    if (!email) return reply.status(401).send({ message: "Email is required" });
    request.user = { id: "user-owner", dataOwnerId: "user-owner" };
  },
}));

import prisma from "../app/lib/prisma";
import { financeRoutes } from "../app/routes/finance.routes";

const OWNER = "owner@test.com";

function buildApp() {
  const app = fastify();
  app.register(financeRoutes, { prefix: "/finance" });
  return app;
}

/** Conta-ENTRADA: totalAmount = 100 (a entrada), itens somando 131,11. */
function maeRaw() {
  return {
    id: "r-mae",
    userId: "user-owner",
    customerId: "c-1",
    unidadeId: null,
    document: null,
    reason: "Venda balcão",
    debtDetails: null,
    totalAmount: "100.00",
    fineAmount: null,
    finePercent: null,
    interestPercent: null,
    toleranceDays: null,
    installments: 1,
    periodDays: null,
    dueDate: new Date("2026-08-08"),
    status: "PAGA",
    paidAt: new Date(),
    paymentMethod: "PIX",
    parentReceivableId: null,
    installmentNumber: null,
    installmentTotal: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    customer: { id: "c-1", name: "Cliente Teste PDV", cpf: null, email: null },
    unidade: null,
    items: [
      {
        id: "ri-1",
        productId: "p-1",
        description: null,
        scrapId: null,
        listingId: null,
        quantity: 1,
        unitPrice: "111.11",
        createdAt: new Date(),
        createCatalogProduct: false,
        autoCreatedProduct: false,
        product: { id: "p-1", sku: "35222", name: "Produto teste PDV balcão" },
      },
    ],
    payments: [
      { id: "pp-1", method: "PIX", amount: "100.00", createdAt: new Date() },
    ],
  };
}

function parcelaRaw() {
  return {
    ...maeRaw(),
    id: "r-p1",
    totalAmount: "31.11",
    status: "PENDENTE",
    paidAt: null,
    paymentMethod: null,
    parentReceivableId: "r-mae",
    installmentNumber: 1,
    installmentTotal: 1,
    items: undefined,
    payments: undefined,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  generateMock.mockResolvedValue(new Uint8Array([1, 2, 3]));
  (prisma as any).receivable.findFirst.mockResolvedValue(maeRaw());
});

describe("GET /receivables/:id/receipt — venda parcelada", () => {
  it("entrega as PARCELAS ao gerador do cupom", async () => {
    (prisma as any).receivable.findMany.mockResolvedValue([parcelaRaw()]);

    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/finance/receivables/r-mae/receipt",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    expect(generateMock).toHaveBeenCalledTimes(1);

    // 4 argumentos: entry, company, avatar, parcelas.
    const args = generateMock.mock.calls[0];
    expect(args).toHaveLength(4);
    expect(args[3]).toEqual([
      {
        numero: 1,
        total: 1,
        dueDate: expect.any(Date),
        amount: 31.11,
      },
    ]);
  });

  it("busca as filhas pelo vínculo, escopadas ao tenant", async () => {
    (prisma as any).receivable.findMany.mockResolvedValue([parcelaRaw()]);

    const app = buildApp();
    await app.inject({
      method: "GET",
      url: "/finance/receivables/r-mae/receipt",
      headers: { email: OWNER },
    });

    expect((prisma as any).receivable.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { parentReceivableId: "r-mae", userId: "user-owner" },
      }),
    );
  });

  // REGRESSÃO: venda à vista NÃO pode ganhar um 4º argumento — a aridade da
  // chamada é observável por quem espia o método (lição da Fase 5).
  it("REGRESSÃO: venda à vista chama generate com 3 argumentos", async () => {
    (prisma as any).receivable.findMany.mockResolvedValue([]);

    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/finance/receivables/r-mae/receipt",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    expect(generateMock.mock.calls[0]).toHaveLength(3);
  });

  it("404 continua não gerando cupom nenhum", async () => {
    (prisma as any).receivable.findFirst.mockResolvedValue(null);

    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/finance/receivables/inexistente/receipt",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(404);
    expect(generateMock).not.toHaveBeenCalled();
  });
});
