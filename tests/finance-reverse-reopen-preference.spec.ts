import { describe, it, expect, beforeEach, vi } from "vitest";
import fastify from "fastify";

// ──────────────────────────────────────────────────────────
// Preferência do tenant: reabrir anúncio quando a peça volta ao estoque por
// CANCELAMENTO — caminho do ESTORNO DE VENDA DE BALCÃO.
//
// Diferença em relação ao caminho de pedido: aqui a leitura é um SELECT próprio
// (o estorno não carrega o User), então existe o cenário de FALHA de leitura —
// e ele tem de cair em LIGADO, que é o comportamento de sempre.
//
// Harness clonado de tests/finance-reverse.spec.ts, com UMA diferença: o factory
// do prisma ganha a tabela `user`, que é o dial da preferência. Nos specs
// legados essa tabela NÃO existe, e é justamente isso que prova o fail-open —
// eles continuam verdes sem nenhuma alteração.
// ──────────────────────────────────────────────────────────

vi.mock("../app/marketplaces/services/stock-deduction.service", () => ({
  StockDeductionService: {
    deductWithinTx: vi
      .fn()
      .mockResolvedValue({ deductions: [], oversellAlerts: [] }),
    restoreWithinTx: vi.fn(),
    firePostEffects: vi.fn(),
  },
}));
vi.mock("@/app/marketplaces/services/stock-deduction.service", () => ({
  StockDeductionService: {
    deductWithinTx: vi
      .fn()
      .mockResolvedValue({ deductions: [], oversellAlerts: [] }),
    restoreWithinTx: vi.fn(),
    firePostEffects: vi.fn(),
  },
}));

vi.mock("../app/marketplaces/services/scrap-status-reconcile.service", () => ({
  ScrapStatusReconcileService: { reconcileForReceivable: vi.fn() },
}));
vi.mock("@/app/marketplaces/services/scrap-status-reconcile.service", () => ({
  ScrapStatusReconcileService: { reconcileForReceivable: vi.fn() },
}));

// Factory DUPLICADO inline para os dois specifiers. Duas razões, e nenhuma é
// preguiça:
//  1. O vitest resolve mock por texto do specifier — os módulos da app importam
//     pelo alias `@/`, este spec importa relativo. Sem os dois, um dos lados
//     pega o prisma real.
//  2. `vi.mock` é IÇADO para o topo do arquivo. Extrair um helper compartilhado
//     dá "Cannot access before initialization" — tentei, e é por isso que todos
//     os specs desta família repetem o bloco.
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
    // ⭐ A ÚNICA diferença para o spec legado: lá `user` não existe, e é isso
    // que faz o fail-open ser exercitado por ele sem nenhuma alteração.
    user: { findUnique: vi.fn() },
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
    user: { findUnique: vi.fn() },
  };
  prisma.$transaction = vi.fn(async (cb: any) => cb(prisma));
  return { default: prisma };
});

// O header `x-test-user` permite dois tenants diferentes no mesmo arquivo,
// para o cenário de isolamento.
vi.mock("../app/middlewares/auth.middleware", () => ({
  authMiddleware: async (request: any, reply: any) => {
    const email = request.headers["email"];
    if (!email) return reply.status(401).send({ message: "Email is required" });
    const id = (request.headers["x-test-user"] as string) ?? "user-owner";
    request.user = { id, dataOwnerId: id };
  },
}));

import prisma from "../app/lib/prisma";
import { financeRoutes } from "../app/routes/finance.routes";
import { StockDeductionService } from "../app/marketplaces/services/stock-deduction.service";
import { ScrapStatusReconcileService } from "../app/marketplaces/services/scrap-status-reconcile.service";

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
    paidAt: new Date("2026-05-22"),
    createdAt: new Date(),
    updatedAt: new Date(),
    customer: { id: "c-1", name: "Cliente", cpf: null, email: null },
    unidade: null,
    items: [
      {
        id: "ri-1",
        productId: "p-1",
        listingId: null,
        quantity: 2,
        unitPrice: "50.00",
        createdAt: new Date(),
        product: { id: "p-1", sku: "SKU-1", name: "Produto" },
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (prisma as any).$transaction.mockImplementation(async (cb: any) =>
    cb(prisma),
  );
  (StockDeductionService as any).restoreWithinTx.mockResolvedValue({
    deductions: [
      {
        productId: "p-1",
        productName: "Produto",
        previousStock: 0,
        newStock: 2,
        quantity: 2,
      },
    ],
  });
  (prisma as any).receivable.findFirst.mockResolvedValue(makeReceivableRaw());
  (prisma as any).receivable.updateMany.mockResolvedValue({ count: 1 });
  (prisma as any).receivable.findUnique.mockResolvedValue(
    makeReceivableRaw({ status: "CANCELADA" }),
  );
});

/** Um estorno, devolvendo a resposta e o argumento do firePostEffects. */
async function estornar(userHeader?: string) {
  const app = buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/finance/receivables/r-1/reverse",
    headers: {
      email: OWNER,
      ...(userHeader ? { "x-test-user": userHeader } : {}),
    },
  });
  const fire = (StockDeductionService as any).firePostEffects;
  return { res, fire, arg: fire.mock.calls[0]?.[0] as any };
}

describe("Preferência de reabertura — estorno de venda de balcão", () => {
  it("LIGADA: reabre (sem force — o balcão pausou localmente, o fast-path enxerga)", async () => {
    (prisma as any).user.findUnique.mockResolvedValue({
      reopenListingsOnSaleCancel: true,
    });
    const { res, arg } = await estornar();
    expect(res.statusCode).toBe(200);
    expect(arg.reopenOnRefill).toEqual({ userId: "user-owner" });
  });

  it("DESLIGADA: a chave SOME — e o estorno acontece igual", async () => {
    (prisma as any).user.findUnique.mockResolvedValue({
      reopenListingsOnSaleCancel: false,
    });
    const { res, arg } = await estornar();
    expect(res.statusCode).toBe(200);
    expect(arg.reopenOnRefill).toBeUndefined();
    expect(
      (StockDeductionService as any).restoreWithinTx,
    ).toHaveBeenCalledTimes(1);
    expect(arg.deductions).toHaveLength(1);
  });

  it("lê a preferência do TENANT (dataOwnerId), nunca de um id do request", async () => {
    (prisma as any).user.findUnique.mockResolvedValue({
      reopenListingsOnSaleCancel: true,
    });
    await estornar("tenant-X");
    expect((prisma as any).user.findUnique).toHaveBeenCalledWith({
      where: { id: "tenant-X" },
      // O select mínimo faz parte do contrato: este caminho não precisa do
      // usuário inteiro.
      select: { reopenListingsOnSaleCancel: true },
    });
  });

  describe("LEGADO / fail-open — nunca derruba o estorno", () => {
    it("coluna null (linha anterior ao DDL) ⇒ reabre", async () => {
      (prisma as any).user.findUnique.mockResolvedValue({
        reopenListingsOnSaleCancel: null,
      });
      const { res, arg } = await estornar();
      expect(res.statusCode).toBe(200);
      expect(arg.reopenOnRefill).toEqual({ userId: "user-owner" });
    });

    it("usuário inexistente ⇒ reabre", async () => {
      (prisma as any).user.findUnique.mockResolvedValue(null);
      const { res, arg } = await estornar();
      expect(res.statusCode).toBe(200);
      expect(arg.reopenOnRefill).toEqual({ userId: "user-owner" });
    });

    it("banco fora do ar ⇒ reabre, e o estorno responde 200", async () => {
      // Fail-CLOSED aqui transformaria um blip de banco em "o anúncio ficou
      // pausado e ninguém percebeu" — perda de venda invisível.
      (prisma as any).user.findUnique.mockRejectedValue(new Error("db down"));
      const { res, arg } = await estornar();
      expect(res.statusCode).toBe(200);
      expect(arg.reopenOnRefill).toEqual({ userId: "user-owner" });
    });
  });

  it("ALTERNÂNCIA: cada estorno relê — não há cache segurando valor antigo", async () => {
    const f = (prisma as any).user.findUnique;
    f.mockResolvedValueOnce({ reopenListingsOnSaleCancel: true });
    expect((await estornar()).arg.reopenOnRefill).toBeDefined();

    vi.clearAllMocks();
    (prisma as any).$transaction.mockImplementation(async (cb: any) =>
      cb(prisma),
    );
    (StockDeductionService as any).restoreWithinTx.mockResolvedValue({
      deductions: [
        {
          productId: "p-1",
          productName: "Produto",
          previousStock: 0,
          newStock: 2,
          quantity: 2,
        },
      ],
    });
    (prisma as any).receivable.findFirst.mockResolvedValue(makeReceivableRaw());
    (prisma as any).receivable.updateMany.mockResolvedValue({ count: 1 });
    (prisma as any).receivable.findUnique.mockResolvedValue(
      makeReceivableRaw({ status: "CANCELADA" }),
    );
    f.mockResolvedValueOnce({ reopenListingsOnSaleCancel: false });
    expect((await estornar()).arg.reopenOnRefill).toBeUndefined();
  });

  it("ISOLAMENTO: tenant A desligado e B ligado, cada um com o seu resultado", async () => {
    (prisma as any).user.findUnique.mockImplementation(
      async ({ where }: any) =>
        where.id === "tenant-off"
          ? { reopenListingsOnSaleCancel: false }
          : { reopenListingsOnSaleCancel: true },
    );

    const a = await estornar("tenant-off");
    expect(a.arg.reopenOnRefill).toBeUndefined();

    vi.clearAllMocks();
    (prisma as any).$transaction.mockImplementation(async (cb: any) =>
      cb(prisma),
    );
    (StockDeductionService as any).restoreWithinTx.mockResolvedValue({
      deductions: [
        {
          productId: "p-1",
          productName: "Produto",
          previousStock: 0,
          newStock: 2,
          quantity: 2,
        },
      ],
    });
    (prisma as any).receivable.findFirst.mockResolvedValue(makeReceivableRaw());
    (prisma as any).receivable.updateMany.mockResolvedValue({ count: 1 });
    (prisma as any).receivable.findUnique.mockResolvedValue(
      makeReceivableRaw({ status: "CANCELADA" }),
    );
    (prisma as any).user.findUnique.mockImplementation(
      async ({ where }: any) =>
        where.id === "tenant-off"
          ? { reopenListingsOnSaleCancel: false }
          : { reopenListingsOnSaleCancel: true },
    );

    const b = await estornar("tenant-on");
    expect(b.arg.reopenOnRefill).toEqual({ userId: "tenant-on" });
  });

  describe("NÃO-INTERFERÊNCIA", () => {
    it("DESLIGADA: firePostEffects continua sendo CHAMADO", async () => {
      // Ele também dispara o StockSyncRetryService. Pular a chamada faria o
      // estoque restaurado nunca chegar aos marketplaces.
      (prisma as any).user.findUnique.mockResolvedValue({
        reopenListingsOnSaleCancel: false,
      });
      const { fire } = await estornar();
      expect(fire).toHaveBeenCalledTimes(1);
    });

    it("DESLIGADA: a reconciliação de sucata continua rodando", async () => {
      (prisma as any).user.findUnique.mockResolvedValue({
        reopenListingsOnSaleCancel: false,
      });
      await estornar();
      expect(
        (ScrapStatusReconcileService as any).reconcileForReceivable,
      ).toHaveBeenCalledTimes(1);
    });

    it("DESLIGADA: nunca liga pauseOnZero", async () => {
      (prisma as any).user.findUnique.mockResolvedValue({
        reopenListingsOnSaleCancel: false,
      });
      const { arg } = await estornar();
      expect(arg.pauseOnZero).toBeUndefined();
    });

    it("o RECEBIMENTO da venda não consulta a preferência", async () => {
      // markPaid usa `pauseOnZero`, que é o espelho oposto e NÃO é governado
      // por esta preferência. Se a leitura vazasse para lá, o veto deixaria de
      // ser unidirecional.
      (prisma as any).receivable.findFirst.mockResolvedValue(
        makeReceivableRaw({ status: "PENDENTE", paidAt: null }),
      );
      const app = buildApp();
      await app.inject({
        method: "POST",
        url: "/finance/receivables/r-1/pay",
        headers: { email: OWNER },
      });
      expect((prisma as any).user.findUnique).not.toHaveBeenCalled();
    });
  });
});

// ── O ESPELHO: `keepPausedOnRefill` ────────────────────────────────────────
//
// Somar casos, sem tocar em nenhum dos de cima. Suprimir `reopenOnRefill` era
// metade da resposta: o `firePostEffects` continua (e tem de continuar)
// disparando o sync de estoque, e é o empurrão de quantidade que traz o
// anúncio de volta — no ML porque o `out_of_stock` cai sozinho, na OLX porque
// republicar é a única forma de sincronizar, no Facebook porque a peça volta a
// "in stock". Por isso o estorno com a preferência OFF precisa mandar PAUSAR.
describe("Estorno de balcão — o espelho keepPausedOnRefill", () => {
  it("DESLIGADA: manda manter pausado", async () => {
    (prisma as any).user.findUnique.mockResolvedValue({
      reopenListingsOnSaleCancel: false,
    });
    const { res, arg } = await estornar();
    expect(res.statusCode).toBe(200);
    expect(arg.keepPausedOnRefill).toEqual({ userId: "user-owner" });
    expect(arg.reopenOnRefill).toBeUndefined();
  });

  it("LIGADA: nunca manda pausar", async () => {
    (prisma as any).user.findUnique.mockResolvedValue({
      reopenListingsOnSaleCancel: true,
    });
    const { arg } = await estornar();
    expect(arg.keepPausedOnRefill).toBeUndefined();
    expect(arg.reopenOnRefill).toEqual({ userId: "user-owner" });
  });

  it("FAIL-OPEN: leitura falhando não manda pausar", async () => {
    // Pausar por engano é o erro caro e silencioso: o lojista não vê o anúncio
    // sumir. Na dúvida, reabre.
    (prisma as any).user.findUnique.mockRejectedValue(new Error("db down"));
    const { res, arg } = await estornar();
    expect(res.statusCode).toBe(200);
    expect(arg.keepPausedOnRefill).toBeUndefined();
    expect(arg.reopenOnRefill).toEqual({ userId: "user-owner" });
  });

  it("ISOLAMENTO: a decisão de um tenant não vaza para o outro", async () => {
    (prisma as any).user.findUnique.mockImplementation(
      async ({ where }: any) =>
        where.id === "tenant-off"
          ? { reopenListingsOnSaleCancel: false }
          : { reopenListingsOnSaleCancel: true },
    );
    const a = await estornar("tenant-off");
    expect(a.arg.keepPausedOnRefill).toEqual({ userId: "tenant-off" });
  });
});
