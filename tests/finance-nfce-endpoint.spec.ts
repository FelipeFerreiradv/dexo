import { describe, it, expect, beforeEach, vi } from "vitest";
import fastify from "fastify";

// ──────────────────────────────────────────────────────────
// Fase 2 (NFC-e) — POST /finance/receivables/:id/nfce.
// Idempotência por numeroPedido+modelo, limite R$ 10.000 (422) e mapeamento
// de erros. Pontos de corte: NfeDraftUseCase.createPopulatedFromReceivable,
// NfeEmissionUseCase.emit e NfeRepository.findByNumeroPedidoAndModelo.
// ──────────────────────────────────────────────────────────

const createPopulatedMock = vi.fn();
const lookupProductsMock = vi.fn().mockResolvedValue([]);
const emitMock = vi.fn();
const findByNumeroPedidoMock = vi.fn();

vi.mock("../app/usecases/nfe-draft.usecase", () => ({
  NfeDraftUseCase: class {
    createPopulatedFromReceivable = createPopulatedMock;
    lookupProducts = lookupProductsMock;
  },
}));
vi.mock("@/app/usecases/nfe-draft.usecase", () => ({
  NfeDraftUseCase: class {
    createPopulatedFromReceivable = createPopulatedMock;
    lookupProducts = lookupProductsMock;
  },
}));
vi.mock("../app/usecases/nfe-emission.usecase", () => ({
  NfeEmissionUseCase: class {
    emit = emitMock;
  },
}));
vi.mock("@/app/usecases/nfe-emission.usecase", () => ({
  NfeEmissionUseCase: class {
    emit = emitMock;
  },
}));
vi.mock("../app/repositories/nfe.repository", () => ({
  NfeRepository: class {
    findByNumeroPedidoAndModelo = findByNumeroPedidoMock;
  },
}));
vi.mock("@/app/repositories/nfe.repository", () => ({
  NfeRepository: class {
    findByNumeroPedidoAndModelo = findByNumeroPedidoMock;
  },
}));

vi.mock("../app/lib/prisma", () => {
  const fmodel = () => ({
    findMany: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
    create: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
    createMany: vi.fn(),
    groupBy: vi.fn().mockResolvedValue([]),
    aggregate: vi
      .fn()
      .mockResolvedValue({ _sum: { totalAmount: null }, _count: 0 }),
  });
  const prisma: any = {
    receivable: fmodel(),
    payable: fmodel(),
    receivableItem: fmodel(),
    customer: { findFirst: vi.fn(), create: vi.fn() },
    unidade: { findFirst: vi.fn() },
    product: fmodel(),
  };
  prisma.$transaction = vi.fn(async (cb: any) => cb(prisma));
  return { default: prisma };
});
vi.mock("@/app/lib/prisma", () => {
  const fmodel = () => ({
    findMany: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
    create: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
    createMany: vi.fn(),
    groupBy: vi.fn().mockResolvedValue([]),
    aggregate: vi
      .fn()
      .mockResolvedValue({ _sum: { totalAmount: null }, _count: 0 }),
  });
  const prisma: any = {
    receivable: fmodel(),
    payable: fmodel(),
    receivableItem: fmodel(),
    customer: { findFirst: vi.fn(), create: vi.fn() },
    unidade: { findFirst: vi.fn() },
    product: fmodel(),
  };
  prisma.$transaction = vi.fn(async (cb: any) => cb(prisma));
  return { default: prisma };
});

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

function makeReceivableRaw(overrides: Partial<any> = {}) {
  return {
    id: "r-1",
    userId: "user-owner",
    customerId: "c-1",
    unidadeId: null,
    document: null,
    reason: null,
    debtDetails: null,
    totalAmount: "100.00",
    fineAmount: null,
    finePercent: null,
    interestPercent: null,
    toleranceDays: null,
    installments: 1,
    periodDays: null,
    dueDate: new Date("2026-06-01"),
    status: "PAGA",
    paidAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    customer: { id: "c-1", name: "Cliente", cpf: null, email: null },
    unidade: null,
    items: [
      {
        id: "ri-1",
        productId: "p-1",
        listingId: null,
        quantity: 1,
        unitPrice: "100.00",
        createdAt: new Date(),
        product: { id: "p-1", sku: "SKU-1", name: "Pastilha de freio" },
      },
    ],
    ...overrides,
  };
}

function makeCustomer(overrides: Partial<any> = {}) {
  return {
    id: "c-1",
    userId: "user-owner",
    name: "Maria Silva",
    cpf: "39053344705",
    email: "maria@example.com",
    phone: "11999998888",
    cep: "88010000",
    street: "Rua Teste",
    number: "10",
    neighborhood: "Centro",
    city: "Florianopolis",
    state: "SC",
    ibge: "4205407",
    deliveryCnpj: null,
    deliveryCorporateName: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  findByNumeroPedidoMock.mockResolvedValue(null);
  createPopulatedMock.mockResolvedValue({ id: "draft-65", status: "DRAFT" });
  emitMock.mockResolvedValue({
    success: true,
    nfeId: "draft-65",
    status: "AUTHORIZED",
    numero: 1,
    serie: 1,
    chaveAcesso: "4".repeat(44),
    protocolo: "342260000000001",
    mensagem: "NF-e autorizada com sucesso",
  });
});

describe("POST /finance/receivables/:id/nfce", () => {
  it("fluxo novo: cria rascunho 65 (modelo no input) e emite; 200 authorized", async () => {
    (prisma as any).receivable.findFirst.mockResolvedValue(makeReceivableRaw());
    (prisma as any).customer.findFirst.mockResolvedValue(makeCustomer());

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/finance/receivables/r-1/nfce",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    const { nfce } = res.json();
    expect(nfce.state).toBe("authorized");
    expect(nfce.numero).toBe(1);
    expect(createPopulatedMock).toHaveBeenCalledWith(
      "user-owner",
      expect.objectContaining({ modelo: "65", receivableId: "r-1" }),
    );
    expect(emitMock).toHaveBeenCalledWith("user-owner", "draft-65");
  });

  it("idempotência: nota 65 AUTHORIZED existente → retorna sem reemitir", async () => {
    (prisma as any).receivable.findFirst.mockResolvedValue(makeReceivableRaw());
    findByNumeroPedidoMock.mockResolvedValue({
      id: "nfe-old",
      status: "AUTHORIZED",
      numero: 9,
      serie: 1,
      chaveAcesso: "4".repeat(44),
      danfePdfPath: "/tmp/danfe.pdf",
      motivoRejeicao: null,
    });

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/finance/receivables/r-1/nfce",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    const { nfce } = res.json();
    expect(nfce.state).toBe("authorized");
    expect(nfce.alreadyEmitted).toBe(true);
    expect(nfce.danfeDisponivel).toBe(true);
    expect(emitMock).not.toHaveBeenCalled();
    expect(createPopulatedMock).not.toHaveBeenCalled();
  });

  it("idempotência: SENDING → processing, sem reemitir", async () => {
    (prisma as any).receivable.findFirst.mockResolvedValue(makeReceivableRaw());
    findByNumeroPedidoMock.mockResolvedValue({
      id: "nfe-mid",
      status: "SENDING",
      numero: 9,
      serie: 1,
      chaveAcesso: null,
      danfePdfPath: null,
      motivoRejeicao: null,
    });

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/finance/receivables/r-1/nfce",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().nfce.state).toBe("processing");
    expect(emitMock).not.toHaveBeenCalled();
  });

  it("REJECTED existente → reemite a MESMA linha (sem novo rascunho)", async () => {
    (prisma as any).receivable.findFirst.mockResolvedValue(makeReceivableRaw());
    findByNumeroPedidoMock.mockResolvedValue({
      id: "nfe-rej",
      status: "REJECTED",
      numero: 9,
      serie: 1,
      chaveAcesso: null,
      danfePdfPath: null,
      motivoRejeicao: "Rejeicao 999",
    });

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/finance/receivables/r-1/nfce",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    expect(createPopulatedMock).not.toHaveBeenCalled();
    expect(emitMock).toHaveBeenCalledWith("user-owner", "nfe-rej");
  });

  it("acima de R$ 10.000 → 422 com mensagem clara; nada é criado", async () => {
    (prisma as any).receivable.findFirst.mockResolvedValue(
      makeReceivableRaw({ totalAmount: "10000.01" }),
    );

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/finance/receivables/r-1/nfce",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatch(/R\$ 10\.000/);
    expect(createPopulatedMock).not.toHaveBeenCalled();
    expect(emitMock).not.toHaveBeenCalled();
  });

  it("sem itens → 400; conta inexistente → 404", async () => {
    (prisma as any).receivable.findFirst.mockResolvedValue(
      makeReceivableRaw({ items: [] }),
    );
    const app = buildApp();
    let res = await app.inject({
      method: "POST",
      url: "/finance/receivables/r-1/nfce",
      headers: { email: OWNER },
    });
    expect(res.statusCode).toBe(400);

    (prisma as any).receivable.findFirst.mockResolvedValue(null);
    res = await app.inject({
      method: "POST",
      url: "/finance/receivables/r-x/nfce",
      headers: { email: OWNER },
    });
    expect(res.statusCode).toBe(404);
  });

  it("erro de pré-requisito da emissão (CSC) → 400 acionável", async () => {
    (prisma as any).receivable.findFirst.mockResolvedValue(makeReceivableRaw());
    (prisma as any).customer.findFirst.mockResolvedValue(makeCustomer());
    emitMock.mockRejectedValue(
      new Error(
        "CSC nao configurado — informe Id e Codigo do CSC na configuracao fiscal para emitir NFC-e",
      ),
    );

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/finance/receivables/r-1/nfce",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/CSC/);
  });

  it("DOCUMENTA: Content-Type json com body vazio morre no parse do Fastify (por isso o front não envia o header)", async () => {
    (prisma as any).receivable.findFirst.mockResolvedValue(makeReceivableRaw());
    (prisma as any).customer.findFirst.mockResolvedValue(makeCustomer());

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/finance/receivables/r-1/nfce",
      headers: { email: OWNER, "content-type": "application/json" },
    });

    // Rejeição ANTES do handler (em prod o handler global transforma isso em
    // { error: "Erro interno do servidor" } com 400 — o incidente do PDV).
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("FST_ERR_CTP_EMPTY_JSON_BODY");
    expect(emitMock).not.toHaveBeenCalled();
    expect(createPopulatedMock).not.toHaveBeenCalled();
  });

  it("REGRESSAO: /fiscal-draft (55) segue sem modelo no input", async () => {
    (prisma as any).receivable.findFirst.mockResolvedValue(makeReceivableRaw());
    (prisma as any).customer.findFirst.mockResolvedValue(makeCustomer());

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/finance/receivables/r-1/fiscal-draft",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(201);
    const input = createPopulatedMock.mock.calls[0][1];
    expect(input).not.toHaveProperty("modelo");
  });
});
