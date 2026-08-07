import { describe, it, expect, beforeEach, vi } from "vitest";
import fastify from "fastify";

// ──────────────────────────────────────────────────────────
// Bloco E — permissão por AÇÃO para cancelar/estornar venda.
//
// A regra do prompt é explícita: "esconder botão não é permissão". Aqui se
// prova que o bloqueio vale na API — um colaborador sem a permissão recebe 403
// e o estoque NÃO é devolvido, mesmo chamando o endpoint por fora da UI.
//
// E, do outro lado, a regra que vale mais: o default é PERMITIR. Quem hoje
// consegue excluir/estornar continua conseguindo no dia em que isto subir.
// ──────────────────────────────────────────────────────────

vi.mock("../app/marketplaces/services/stock-deduction.service", () => ({
  StockDeductionService: {
    deductWithinTx: vi
      .fn()
      .mockResolvedValue({ deductions: [], oversellAlerts: [] }),
    restoreWithinTx: vi.fn().mockResolvedValue({ deductions: [] }),
    firePostEffects: vi.fn(),
  },
}));
vi.mock("@/app/marketplaces/services/stock-deduction.service", () => ({
  StockDeductionService: {
    deductWithinTx: vi
      .fn()
      .mockResolvedValue({ deductions: [], oversellAlerts: [] }),
    restoreWithinTx: vi.fn().mockResolvedValue({ deductions: [] }),
    firePostEffects: vi.fn(),
  },
}));

vi.mock("../app/marketplaces/services/scrap-status-reconcile.service", () => ({
  ScrapStatusReconcileService: { reconcileForReceivable: vi.fn() },
}));
vi.mock("@/app/marketplaces/services/scrap-status-reconcile.service", () => ({
  ScrapStatusReconcileService: { reconcileForReceivable: vi.fn() },
}));

vi.mock("../app/services/system-log.service", () => ({
  SystemLogService: { logUserActivity: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("@/app/services/system-log.service", () => ({
  SystemLogService: { logUserActivity: vi.fn().mockResolvedValue(undefined) },
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
    deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
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
  return prisma;
}

vi.mock("../app/lib/prisma", () => ({ default: makePrisma() }));
vi.mock("@/app/lib/prisma", () => ({ default: makePrisma() }));

// Usuário injetado pelo authMiddleware — mutável por teste.
let currentUser: any = null;

vi.mock("../app/middlewares/auth.middleware", () => ({
  authMiddleware: async (request: any, reply: any) => {
    const email = request.headers["email"];
    if (!email) return reply.status(401).send({ message: "Email is required" });
    request.user = currentUser;
  },
}));

import prisma from "../app/lib/prisma";
import { financeRoutes } from "../app/routes/finance.routes";
import { StockDeductionService } from "../app/marketplaces/services/stock-deduction.service";
import { SystemLogService } from "../app/services/system-log.service";
import {
  ACTION_DEFS,
  actionPermissionKey,
  hasActionAccess,
} from "../app/lib/action-access";

const OWNER = "owner@test.com";
const CANCEL_KEY = actionPermissionKey("pdv.cancelar-venda");

function buildApp() {
  const app = fastify();
  app.register(financeRoutes, { prefix: "/finance" });
  return app;
}

function admin(pagePermissions: any = null) {
  return {
    id: "user-owner",
    dataOwnerId: "user-owner",
    parentUserId: null,
    pagePermissions,
  };
}

function collaborator(pagePermissions: any) {
  return {
    id: "user-collab",
    name: "Colaborador",
    dataOwnerId: "user-owner",
    parentUserId: "user-owner",
    pagePermissions,
  };
}

function paidSaleRaw(overrides: Partial<any> = {}) {
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
  currentUser = admin();
  (prisma as any).$transaction.mockImplementation(async (cb: any) => cb(prisma));
  (StockDeductionService as any).restoreWithinTx.mockResolvedValue({
    deductions: [],
  });
  (prisma as any).receivable.deleteMany.mockResolvedValue({ count: 1 });
  // `updateSingle` do repositório faz updateMany + re-fetch por findUnique.
  (prisma as any).receivable.updateMany.mockResolvedValue({ count: 1 });
  (prisma as any).receivable.findUnique.mockResolvedValue(
    paidSaleRaw({ status: "CANCELADA" }),
  );
});

// ── A regra pura ──

describe("hasActionAccess — o default é PERMITIR", () => {
  it("sem usuário: nega (é ausência de sessão, não de permissão)", () => {
    expect(hasActionAccess(null, "pdv.cancelar-venda")).toBe(false);
    expect(hasActionAccess(undefined, "pdv.cancelar-venda")).toBe(false);
  });

  it("admin/superadmin sempre pode, mesmo com a chave em false", () => {
    expect(hasActionAccess(admin(), "pdv.cancelar-venda")).toBe(true);
    expect(
      hasActionAccess(admin({ [CANCEL_KEY]: false }), "pdv.cancelar-venda"),
    ).toBe(true);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["objeto vazio", {}],
    ["só permissões de página", { produtos: false, financeiro: false }],
  ])("colaborador com pagePermissions %s: PODE (zero regressão)", (_l, perms) => {
    expect(hasActionAccess(collaborator(perms), "pdv.cancelar-venda")).toBe(
      true,
    );
  });

  it("só `=== false` na chave da ação bloqueia", () => {
    expect(
      hasActionAccess(
        collaborator({ [CANCEL_KEY]: false }),
        "pdv.cancelar-venda",
      ),
    ).toBe(false);
    expect(
      hasActionAccess(collaborator({ [CANCEL_KEY]: true }), "pdv.cancelar-venda"),
    ).toBe(true);
  });

  it("a chave de ação é prefixada — não colide com PageId", () => {
    expect(CANCEL_KEY).toBe("action:pdv.cancelar-venda");
    // Desligar a PÁGINA pdv não desliga a AÇÃO (e vice-versa).
    expect(hasActionAccess(collaborator({ pdv: false }), "pdv.cancelar-venda")).toBe(
      true,
    );
  });

  it("toda ação declarada tem rótulo e explicação", () => {
    for (const a of ACTION_DEFS) {
      expect(a.label.length).toBeGreaterThan(0);
      expect(a.hint.length).toBeGreaterThan(0);
    }
  });
});

// ── O guard de verdade: backend ──

describe("POST /finance/receivables/:id/reverse — guard de ação", () => {
  it("REGRESSÃO: colaborador SEM a chave estorna normalmente (igual a hoje)", async () => {
    currentUser = collaborator(null);
    (prisma as any).receivable.findFirst.mockResolvedValue(paidSaleRaw());
    (prisma as any).receivable.updateMany.mockResolvedValue({ count: 1 });

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/finance/receivables/r-1/reverse",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    expect((StockDeductionService as any).restoreWithinTx).toHaveBeenCalled();
  });

  it("colaborador com a permissão DESLIGADA recebe 403 ACTION_FORBIDDEN", async () => {
    currentUser = collaborator({ [CANCEL_KEY]: false });
    (prisma as any).receivable.findFirst.mockResolvedValue(paidSaleRaw());

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/finance/receivables/r-1/reverse",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("ACTION_FORBIDDEN");
    expect(res.json().actionId).toBe("pdv.cancelar-venda");
  });

  // O ponto do bloco: não basta esconder o botão.
  it("o 403 acontece ANTES do handler — o estoque NÃO é devolvido", async () => {
    currentUser = collaborator({ [CANCEL_KEY]: false });
    (prisma as any).receivable.findFirst.mockResolvedValue(paidSaleRaw());

    const app = buildApp();
    await app.inject({
      method: "POST",
      url: "/finance/receivables/r-1/reverse",
      headers: { email: OWNER },
    });

    expect((StockDeductionService as any).restoreWithinTx).not.toHaveBeenCalled();
    expect((prisma as any).$transaction).not.toHaveBeenCalled();
    expect((prisma as any).receivable.findFirst).not.toHaveBeenCalled();
  });

  it("admin estorna mesmo com a chave em false", async () => {
    currentUser = admin({ [CANCEL_KEY]: false });
    (prisma as any).receivable.findFirst.mockResolvedValue(paidSaleRaw());
    (prisma as any).receivable.updateMany.mockResolvedValue({ count: 1 });

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/finance/receivables/r-1/reverse",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
  });

  it("colaborador autorizado explicitamente estorna", async () => {
    currentUser = collaborator({ [CANCEL_KEY]: true, produtos: false });
    (prisma as any).receivable.findFirst.mockResolvedValue(paidSaleRaw());
    (prisma as any).receivable.updateMany.mockResolvedValue({ count: 1 });

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/finance/receivables/r-1/reverse",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
  });
});

describe("DELETE /finance/receivables/:id — mesma permissão", () => {
  it("REGRESSÃO: colaborador sem a chave exclui normalmente", async () => {
    currentUser = collaborator({});
    (prisma as any).receivable.findFirst.mockResolvedValue(
      paidSaleRaw({ status: "PENDENTE", items: [] }),
    );

    const app = buildApp();
    const res = await app.inject({
      method: "DELETE",
      url: "/finance/receivables/r-1",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    expect((prisma as any).receivable.deleteMany).toHaveBeenCalled();
  });

  it("permissão desligada => 403 e nada é apagado", async () => {
    currentUser = collaborator({ [CANCEL_KEY]: false });

    const app = buildApp();
    const res = await app.inject({
      method: "DELETE",
      url: "/finance/receivables/r-1",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(403);
    expect((prisma as any).receivable.deleteMany).not.toHaveBeenCalled();
  });

  // Payable está fora do escopo do Bloco E: segue sem guard nenhum.
  it("REGRESSÃO: DELETE de conta a PAGAR não é afetado pela permissão", async () => {
    currentUser = collaborator({ [CANCEL_KEY]: false });
    (prisma as any).payable.deleteMany.mockResolvedValue({ count: 1 });

    const app = buildApp();
    const res = await app.inject({
      method: "DELETE",
      url: "/finance/payables/p-1",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    expect((prisma as any).payable.deleteMany).toHaveBeenCalled();
  });
});

describe("auditoria — o financeiro passa a deixar rastro", () => {
  it("estorno registra QUEM operou (o colaborador, não o dono dos dados)", async () => {
    currentUser = collaborator(null);
    (prisma as any).receivable.findFirst.mockResolvedValue(paidSaleRaw());
    (prisma as any).receivable.updateMany.mockResolvedValue({ count: 1 });

    const app = buildApp();
    await app.inject({
      method: "POST",
      url: "/finance/receivables/r-1/reverse",
      headers: { email: OWNER },
    });

    expect(SystemLogService.logUserActivity).toHaveBeenCalledWith(
      "user-collab", // o operador — dataOwnerId seria "user-owner"
      expect.stringContaining("cancelada"),
      expect.objectContaining({
        event: "SALE_REVERSED",
        receivableId: "r-1",
        totalAmount: 100,
      }),
    );
  });

  it("exclusão também é auditada", async () => {
    currentUser = collaborator(null);
    (prisma as any).receivable.findFirst.mockResolvedValue(
      paidSaleRaw({ status: "PENDENTE", items: [] }),
    );

    const app = buildApp();
    await app.inject({
      method: "DELETE",
      url: "/finance/receivables/r-1",
      headers: { email: OWNER },
    });

    expect(SystemLogService.logUserActivity).toHaveBeenCalledWith(
      "user-collab",
      expect.stringContaining("excluído"),
      expect.objectContaining({ event: "FINANCE_ENTRY_DELETED" }),
    );
  });

  // Scripts e importadores chamam o usecase direto, sem actor: nada é logado e
  // o comportamento segue byte-idêntico ao de antes do Bloco E.
  it("sem operador identificado, nada é logado", async () => {
    const { FinanceUseCase } = await import("../app/usecases/finance.usecase");
    (prisma as any).receivable.findFirst.mockResolvedValue(
      paidSaleRaw({ status: "PENDENTE", items: [] }),
    );

    await new FinanceUseCase().delete("receivable", "r-1", "user-owner");

    expect(SystemLogService.logUserActivity).not.toHaveBeenCalled();
  });
});
