import { describe, it, expect, beforeEach, vi } from "vitest";
import fastify from "fastify";

// ──────────────────────────────────────────────────────────
// Fase 8 — POST /finance/receivables/:id/fiscal-draft (Cupom fiscal A).
//
// FinanceUseCase.createFiscalDraftFromReceivable carrega a conta + cliente,
// mapeia para o input do NfeDraftUseCase e chama createPopulatedFromReceivable.
// Aqui mockamos esse método final para focar no MAPEAMENTO (destinatário PF/PJ,
// itens com defaults, pagamento DINHEIRO) e no roteamento (códigos HTTP).
// ──────────────────────────────────────────────────────────

// Mock NfeDraftUseCase: createPopulatedFromReceivable é o "ponto de corte".
// O resto do usecase (lookupProducts, etc.) ainda existe — só interceptamos
// esse método. Como o FinanceUseCase instancia NfeDraftUseCase via `new`,
// substituir a classe inteira é o caminho mais limpo.
const createPopulatedMock = vi.fn();
const lookupProductsMock = vi.fn().mockResolvedValue([]);
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
    status: "PENDENTE",
    paidAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    customer: { id: "c-1", name: "Cliente", cpf: null, email: null },
    unidade: null,
    items: [],
    ...overrides,
  };
}

function makeCustomer(overrides: Partial<any> = {}) {
  return {
    id: "c-1",
    userId: "user-owner",
    name: "Maria Silva",
    cpf: "39053344705",
    rg: null,
    email: "maria@example.com",
    phone: "11999998888",
    mobile: null,
    cep: "01310100",
    street: "Av Paulista",
    number: "1000",
    complement: null,
    neighborhood: "Bela Vista",
    city: "São Paulo",
    state: "SP",
    ibge: "3550308",
    deliveryCnpj: null,
    deliveryCorporateName: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  createPopulatedMock.mockResolvedValue({
    id: "draft-1",
    userId: "user-owner",
    status: "DRAFT",
    itens: [],
  });
});

describe("Fase 8 — POST /finance/receivables/:id/fiscal-draft", () => {
  it("PF: mapeia destinatário, itens (CFOP 5102/origem 0/unidade UN/NCM em branco) e pagamento DINHEIRO", async () => {
    (prisma as any).receivable.findFirst.mockResolvedValue(
      makeReceivableRaw({
        totalAmount: "150.00",
        items: [
          {
            id: "ri-1",
            productId: "p-1",
            listingId: null,
            quantity: 2,
            unitPrice: "50.00",
            createdAt: new Date(),
            product: { id: "p-1", sku: "SKU-1", name: "Pastilha de freio" },
          },
          {
            id: "ri-2",
            productId: "p-2",
            listingId: null,
            quantity: 1,
            unitPrice: "50.00",
            createdAt: new Date(),
            product: { id: "p-2", sku: "SKU-2", name: "Filtro de óleo" },
          },
        ],
      }),
    );
    (prisma as any).customer.findFirst.mockResolvedValue(makeCustomer());

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/finance/receivables/r-1/fiscal-draft",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(201);
    expect(createPopulatedMock).toHaveBeenCalledTimes(1);
    const [calledUserId, calledInput] = createPopulatedMock.mock.calls[0];
    expect(calledUserId).toBe("user-owner");
    expect(calledInput).toMatchObject({
      customerId: "c-1",
      receivableId: "r-1",
      destinatario: expect.objectContaining({
        tipoPessoa: "PF",
        cpfCnpj: "39053344705",
        nome: "Maria Silva",
        email: "maria@example.com",
        cep: "01310100",
        logradouro: "Av Paulista",
        municipio: "São Paulo",
        uf: "SP",
        codPais: "1058",
        pais: "BRASIL",
      }),
      pagamentos: [{ meio: "DINHEIRO", valor: 150 }],
    });
    // Itens: defaults seguros conforme decisão da Fase 1.
    expect(calledInput.itens).toHaveLength(2);
    expect(calledInput.itens[0]).toMatchObject({
      numero: 1,
      productId: "p-1",
      codigo: "SKU-1",
      descricao: "Pastilha de freio",
      ncm: "",
      cfop: "5102",
      origem: 0,
      unidade: "UN",
      quantidade: 2,
      valorUnitario: 50,
      valorTotal: 100,
    });
    expect(calledInput.itens[1]).toMatchObject({
      numero: 2,
      productId: "p-2",
      codigo: "SKU-2",
      cfop: "5102",
      origem: 0,
      quantidade: 1,
      valorTotal: 50,
    });
  });

  it("item MANUAL (sem produto): codigo vazio + descricao vinda de description (Opção A)", async () => {
    (prisma as any).receivable.findFirst.mockResolvedValue(
      makeReceivableRaw({
        totalAmount: "30.00",
        items: [
          {
            id: "ri-m1",
            productId: null,
            description: "Peça avulsa sem cadastro",
            scrapId: null,
            listingId: null,
            quantity: 1,
            unitPrice: "30.00",
            createdAt: new Date(),
            product: null,
          },
        ],
      }),
    );
    (prisma as any).customer.findFirst.mockResolvedValue(makeCustomer());

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/finance/receivables/r-1/fiscal-draft",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(201);
    const [, calledInput] = createPopulatedMock.mock.calls[0];
    expect(calledInput.itens).toHaveLength(1);
    // Opção A: item manual entra com defaults editáveis (NCM em branco, CFOP
    // 5102, origem 0). codigo vazio (sem SKU); descricao vem da description.
    expect(calledInput.itens[0]).toMatchObject({
      numero: 1,
      productId: null,
      codigo: "",
      descricao: "Peça avulsa sem cadastro",
      ncm: "",
      cfop: "5102",
      origem: 0,
      unidade: "UN",
      quantidade: 1,
      valorUnitario: 30,
      valorTotal: 30,
    });
  });

  it("PJ: deliveryCnpj presente vira destinatário tipo PJ", async () => {
    (prisma as any).receivable.findFirst.mockResolvedValue(
      makeReceivableRaw({
        items: [
          {
            id: "ri-1",
            productId: "p-1",
            listingId: null,
            quantity: 1,
            unitPrice: "100.00",
            createdAt: new Date(),
            product: { id: "p-1", sku: "SKU-1", name: "Item" },
          },
        ],
      }),
    );
    (prisma as any).customer.findFirst.mockResolvedValue(
      makeCustomer({
        deliveryCnpj: "12345678000190",
        deliveryCorporateName: "Empresa LTDA",
      }),
    );

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/finance/receivables/r-1/fiscal-draft",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(201);
    const calledInput = createPopulatedMock.mock.calls[0][1];
    expect(calledInput.destinatario).toMatchObject({
      tipoPessoa: "PJ",
      cpfCnpj: "12345678000190",
      nome: "Empresa LTDA",
    });
  });

  it("sem itens: 400 'inválida'", async () => {
    (prisma as any).receivable.findFirst.mockResolvedValue(
      makeReceivableRaw({ items: [] }),
    );

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/finance/receivables/r-1/fiscal-draft",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toMatch(/inválida/i);
    expect(createPopulatedMock).not.toHaveBeenCalled();
  });

  it("receivable não encontrado: 404", async () => {
    (prisma as any).receivable.findFirst.mockResolvedValue(null);

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/finance/receivables/nope/fiscal-draft",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.payload).error).toMatch(/não encontrada/i);
    expect(createPopulatedMock).not.toHaveBeenCalled();
  });

  it("customer da conta não encontrado: 404", async () => {
    (prisma as any).receivable.findFirst.mockResolvedValue(
      makeReceivableRaw({
        items: [
          {
            id: "ri-1",
            productId: "p-1",
            listingId: null,
            quantity: 1,
            unitPrice: "10.00",
            createdAt: new Date(),
            product: { id: "p-1", sku: "SKU-1", name: "X" },
          },
        ],
      }),
    );
    (prisma as any).customer.findFirst.mockResolvedValue(null);

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/finance/receivables/r-1/fiscal-draft",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.payload).error).toMatch(/não encontrado/i);
    expect(createPopulatedMock).not.toHaveBeenCalled();
  });

  it("propaga erro de config fiscal do NfeDraftUseCase (500 se não casar com regex)", async () => {
    (prisma as any).receivable.findFirst.mockResolvedValue(
      makeReceivableRaw({
        items: [
          {
            id: "ri-1",
            productId: "p-1",
            listingId: null,
            quantity: 1,
            unitPrice: "10.00",
            createdAt: new Date(),
            product: { id: "p-1", sku: "SKU-1", name: "X" },
          },
        ],
      }),
    );
    (prisma as any).customer.findFirst.mockResolvedValue(makeCustomer());
    createPopulatedMock.mockRejectedValueOnce(
      new Error(
        "Configuração fiscal não encontrada. Configure o emissor antes de emitir cupom fiscal.",
      ),
    );

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/finance/receivables/r-1/fiscal-draft",
      headers: { email: OWNER },
    });

    // "não encontrada" mapeia para 404 no error handler da rota.
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.payload).error).toMatch(/configuração fiscal/i);
  });

  // ── Forma de pagamento → MeioPagamento (mapeamento Dexo → SEFAZ) ──
  const oneItem = [
    {
      id: "ri-1",
      productId: "p-1",
      listingId: null,
      quantity: 1,
      unitPrice: "200.00",
      createdAt: new Date(),
      product: { id: "p-1", sku: "S", name: "N" },
    },
  ];

  it("paymentMethod PIX => meio PIX no rascunho", async () => {
    (prisma as any).receivable.findFirst.mockResolvedValue(
      makeReceivableRaw({
        paymentMethod: "PIX",
        totalAmount: "200.00",
        items: oneItem,
      }),
    );
    (prisma as any).customer.findFirst.mockResolvedValue(makeCustomer());

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/finance/receivables/r-1/fiscal-draft",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(201);
    expect(createPopulatedMock.mock.calls[0][1].pagamentos).toEqual([
      { meio: "PIX", valor: 200 },
    ]);
  });

  it("paymentMethod CREDITO => meio CARTAO_CREDITO (mapeamento 1:1)", async () => {
    (prisma as any).receivable.findFirst.mockResolvedValue(
      makeReceivableRaw({
        paymentMethod: "CREDITO",
        totalAmount: "200.00",
        items: oneItem,
      }),
    );
    (prisma as any).customer.findFirst.mockResolvedValue(makeCustomer());

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/finance/receivables/r-1/fiscal-draft",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(201);
    expect(createPopulatedMock.mock.calls[0][1].pagamentos).toEqual([
      { meio: "CARTAO_CREDITO", valor: 200 },
    ]);
  });

  it("REGRESSÃO: sem paymentMethod => mantém meio DINHEIRO (fallback)", async () => {
    (prisma as any).receivable.findFirst.mockResolvedValue(
      makeReceivableRaw({ totalAmount: "200.00", items: oneItem }),
    );
    (prisma as any).customer.findFirst.mockResolvedValue(makeCustomer());

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/finance/receivables/r-1/fiscal-draft",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(201);
    expect(createPopulatedMock.mock.calls[0][1].pagamentos).toEqual([
      { meio: "DINHEIRO", valor: 200 },
    ]);
  });
});
