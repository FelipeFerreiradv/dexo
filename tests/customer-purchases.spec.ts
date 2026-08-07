import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fastify from "fastify";

// ──────────────────────────────────────────────────────────
// Bloco C — histórico de compras do cliente.
//
// O histórico é LEITURA PURA sobre endpoints que já existiam: o filtro
// `customerId` da listagem já estava implementado (finance.repository.ts:392) e
// simplesmente não tinha UI. A única adição de backend é `customerId` no
// `GET /finance/summary` — e o contrato dela é o mesmo dos dois filtros que já
// moravam lá: SEM o parâmetro, o `where` é byte-idêntico ao de hoje.
// ──────────────────────────────────────────────────────────

vi.mock("../app/lib/prisma", () => {
  const fmodel = () => ({
    findMany: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
    create: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
    groupBy: vi.fn().mockResolvedValue([]),
    aggregate: vi
      .fn()
      .mockResolvedValue({ _sum: { totalAmount: null }, _count: 0 }),
  });
  return {
    default: {
      receivable: fmodel(),
      payable: fmodel(),
      customer: { findFirst: vi.fn() },
      unidade: { findFirst: vi.fn() },
    },
  };
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
    groupBy: vi.fn().mockResolvedValue([]),
    aggregate: vi
      .fn()
      .mockResolvedValue({ _sum: { totalAmount: null }, _count: 0 }),
  });
  return {
    default: {
      receivable: fmodel(),
      payable: fmodel(),
      customer: { findFirst: vi.fn() },
      unidade: { findFirst: vi.fn() },
    },
  };
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
import {
  PURCHASES_PAGE_SIZE,
  fetchCustomerPurchases,
  fetchCustomerTotals,
  fetchPurchaseItems,
} from "../app/clientes/lib/customer-purchases";

const OWNER = "owner@test.com";

function buildApp() {
  const app = fastify();
  app.register(financeRoutes, { prefix: "/finance" });
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /finance/summary — customerId é aditivo", () => {
  it("REGRESSÃO: sem customerId o where do groupBy é { userId } (igual a hoje)", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/finance/summary",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    expect((prisma as any).receivable.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-owner" } }),
    );
    expect((prisma as any).payable.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-owner" } }),
    );
  });

  it("REGRESSÃO: customerId vazio é tratado como ausente", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/finance/summary?customerId=",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    expect((prisma as any).receivable.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-owner" } }),
    );
  });

  it("customerId=c1 injeta o filtro no groupBy", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/finance/summary?customerId=c1",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    expect((prisma as any).receivable.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-owner", customerId: "c1" },
      }),
    );
  });

  it("customerId + hasItems combinam (o resumo do histórico de compras)", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/finance/summary?customerId=c1&hasItems=true",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    expect((prisma as any).receivable.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: "user-owner",
          customerId: "c1",
          items: { some: {} },
        },
      }),
    );
    // hasItems é receivable-only: Payable não tem a relação `items`.
    expect((prisma as any).payable.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-owner", customerId: "c1" },
      }),
    );
  });

  it("o filtro também alcança o agregado de vencidos", async () => {
    const app = buildApp();
    await app.inject({
      method: "GET",
      url: "/finance/summary?customerId=c1",
      headers: { email: OWNER },
    });

    expect((prisma as any).receivable.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: "user-owner",
          customerId: "c1",
        }),
      }),
    );
  });
});

describe("GET /finance/receivables — filtro por cliente (já existia, agora com UI)", () => {
  it("customerId + hasItems montam o where do histórico", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/finance/receivables?customerId=c1&hasItems=true&page=1&limit=10",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    expect((prisma as any).receivable.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: "user-owner",
          customerId: "c1",
          items: { some: {} },
        },
        take: 10,
        skip: 0,
      }),
    );
  });

  it("a listagem NÃO traz itens (egress) — por isso a expansão é sob demanda", async () => {
    const app = buildApp();
    await app.inject({
      method: "GET",
      url: "/finance/receivables?customerId=c1&hasItems=true",
      headers: { email: OWNER },
    });

    const call = (prisma as any).receivable.findMany.mock.calls[0][0];
    expect(call.select).toBeDefined();
    expect(call.select.items).toBeUndefined();
    expect(call.include).toBeUndefined();
    // `reason` VEM na lista — é o resumo dos itens que o painel exibe sem
    // pagar um request por linha (gerado pelo ProductPickerBlock).
    expect(call.select.reason).toBe(true);
  });
});

// ── Cliente HTTP do painel ──

describe("customer-purchases — montagem das requisições", () => {
  const fetchMock = vi.fn();
  const realFetch = global.fetch;

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as any;
  });
  afterEach(() => {
    global.fetch = realFetch;
  });

  function url() {
    return String(fetchMock.mock.calls[0][0]);
  }

  it("pede sempre hasItems=true — venda de balcão, não cobrança avulsa", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ items: [], pagination: { total: 0, totalPages: 1 } }),
    });

    await fetchCustomerPurchases("c1", OWNER, 1);

    expect(url()).toContain("customerId=c1");
    expect(url()).toContain("hasItems=true");
  });

  it("pagina enxuto (10 por página, regra de egress da casa)", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ items: [], pagination: { total: 0, totalPages: 1 } }),
    });

    await fetchCustomerPurchases("c1", OWNER, 3);

    expect(PURCHASES_PAGE_SIZE).toBe(10);
    expect(url()).toContain(`limit=${PURCHASES_PAGE_SIZE}`);
    expect(url()).toContain("page=3");
  });

  it("propaga o e-mail da sessão como identidade", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ items: [], pagination: { total: 0, totalPages: 1 } }),
    });

    await fetchCustomerPurchases("c1", OWNER, 1);

    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      headers: { email: OWNER },
    });
  });

  it("erro na listagem lança — o painel precisa avisar que falhou", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    await expect(fetchCustomerPurchases("c1", OWNER, 1)).rejects.toThrow();
  });

  // Os totais são enfeite de cabeçalho: se falharem, a lista de compras — que
  // é o conteúdo de verdade — não pode sumir junto.
  it("totais NUNCA lançam: HTTP ruim vira null", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    await expect(fetchCustomerTotals("c1", OWNER)).resolves.toBeNull();
  });

  it("totais NUNCA lançam: erro de rede vira null", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    await expect(fetchCustomerTotals("c1", OWNER)).resolves.toBeNull();
  });

  it("totais leem o bucket de receivables do summary", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        summary: {
          receivables: {
            totalCount: 4,
            paidAmount: 1250.5,
            pendingAmount: 300,
            overdueAmount: 100,
          },
          payables: {},
        },
      }),
    });

    await expect(fetchCustomerTotals("c1", OWNER)).resolves.toEqual({
      count: 4,
      paidAmount: 1250.5,
      pendingAmount: 300,
      overdueAmount: 100,
    });
    expect(url()).toContain("customerId=c1");
    expect(url()).toContain("hasItems=true");
  });

  it("itens vêm do GET /:id (a lista não os traz) e toleram resposta vazia", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ entry: {} }) });
    await expect(fetchPurchaseItems("r1", OWNER)).resolves.toEqual([]);
    expect(url()).toContain("/finance/receivables/r1");
  });
});
