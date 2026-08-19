import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import fastify from "fastify";

// ──────────────────────────────────────────────────────────
// BLOCO D — motivo do cancelamento da venda.
//
// O cliente pediu OBRIGATÓRIO; a decisão de produto foi OPCIONAL. Isso define
// o que este spec precisa provar, e a ordem importa:
//
//  1. NADA PODE IMPEDIR UM CANCELAMENTO. Body ausente, body lixo, código fora
//     do vocabulário, observação de 1 MB — em todos os casos a venda cancela e
//     o estoque volta. O motivo é um acessório; o cancelamento é a operação.
//  2. FLAG AUSENTE ⇒ o `data` do UPDATE é EXATAMENTE `{status:"CANCELADA"}`.
//     Não é preciosismo: as colunas podem ainda não existir no banco, e essa
//     escrita acontece DENTRO da transação do estorno — um erro ali derrubaria
//     o cancelamento inteiro, não só o registro do motivo.
//  3. O QUE O OPERADOR DIGITOU NÃO SE PERDE. Por isso a gravação é em coluna,
//     na mesma transação, e não no log de auditoria (que é best-effort).
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

function makePrisma() {
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
    receivableEvent: { create: vi.fn(), findMany: vi.fn() },
    customer: { findFirst: vi.fn(), create: vi.fn() },
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
    request.user = { id: "u-op", name: "Operador", dataOwnerId: "user-owner" };
  },
}));

import prisma from "../app/lib/prisma";
import { financeRoutes } from "../app/routes/finance.routes";
import { StockDeductionService } from "../app/marketplaces/services/stock-deduction.service";
import {
  CANCEL_NOTE_MAX,
  cancelReasonLabel,
  describeCancelReason,
  normalizeCancelReason,
} from "../app/financeiro/lib/cancel-reasons";

const OWNER = "owner@test.com";
const ORIG_FLAG = process.env.SALE_CANCEL_REASON_ENABLED;

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

/** Dispara o estorno e devolve o `data` que foi para o UPDATE de status. */
async function reverse(payload?: Record<string, unknown>) {
  (prisma as any).receivable.findFirst.mockResolvedValue(makeReceivableRaw());
  (prisma as any).receivable.updateMany.mockResolvedValue({ count: 1 });
  (prisma as any).receivable.findUnique.mockResolvedValue(
    makeReceivableRaw({ status: "CANCELADA" }),
  );

  const app = buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/finance/receivables/r-1/reverse",
    headers: { email: OWNER },
    ...(payload ? { payload } : {}),
  });

  // A primeira chamada é o UPDATE de status da venda; a segunda (quando há) é
  // o cancelamento em massa das parcelas filhas.
  const data = (prisma as any).receivable.updateMany.mock.calls[0]?.[0]?.data;
  return { res, data };
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
  delete process.env.SALE_CANCEL_REASON_ENABLED;
});

afterAll(() => {
  if (ORIG_FLAG === undefined) delete process.env.SALE_CANCEL_REASON_ENABLED;
  else process.env.SALE_CANCEL_REASON_ENABLED = ORIG_FLAG;
});

describe("Flag desligada — o UPDATE é byte-idêntico ao de hoje", () => {
  it("sem body: data é EXATAMENTE { status: 'CANCELADA' }", async () => {
    const { res, data } = await reverse();
    expect(res.statusCode).toBe(200);
    // Igualdade ESTRITA, não objectContaining: uma chave a mais aqui é uma
    // coluna a mais no UPDATE, e ela pode não existir no banco ainda.
    expect(data).toEqual({ status: "CANCELADA" });
  });

  it("COM body: o motivo é ignorado, o data continua idêntico", async () => {
    const { res, data } = await reverse({
      cancelReasonCode: "TROCA",
      cancelReason: "cliente trocou pela peça nova",
    });
    expect(res.statusCode).toBe(200);
    expect(data).toEqual({ status: "CANCELADA" });
  });
});

describe("Flag ligada — o motivo grava na MESMA transação", () => {
  beforeEach(() => {
    process.env.SALE_CANCEL_REASON_ENABLED = "1";
  });

  it("com código e observação: os três campos vão no UPDATE do estorno", async () => {
    const { res, data } = await reverse({
      cancelReasonCode: "PECA_DEFEITO",
      cancelReason: "  trinca no farol  ",
    });
    expect(res.statusCode).toBe(200);
    expect(data).toEqual({
      status: "CANCELADA",
      cancelledAt: expect.any(Date),
      cancelReasonCode: "PECA_DEFEITO",
      // Aparado nas pontas — o operador não escolheu mandar espaço.
      cancelReason: "trinca no farol",
    });
  });

  it("sem motivo informado: carimba a DATA, mas não inventa motivo", async () => {
    // "Cancelada sem justificativa" continua sendo um fato com data — e sem
    // `cancelledAt` o único carimbo seria `updatedAt`, que qualquer edição
    // posterior sobrescreve.
    const { data } = await reverse();
    expect(data).toEqual({
      status: "CANCELADA",
      cancelledAt: expect.any(Date),
    });
  });

  it("só observação, sem código: é um motivo válido", async () => {
    const { data } = await reverse({ cancelReason: "acordo com o cliente" });
    expect(data).toEqual({
      status: "CANCELADA",
      cancelledAt: expect.any(Date),
      cancelReason: "acordo com o cliente",
    });
  });

  it("as parcelas filhas NÃO herdam o motivo", async () => {
    // Replicar faria um GROUP BY cancelReasonCode contar a mesma decisão N+1
    // vezes. O motivo é da VENDA.
    await reverse({ cancelReasonCode: "TROCA" });
    const filhas = (prisma as any).receivable.updateMany.mock.calls[1]?.[0];
    expect(filhas?.data).toEqual({ status: "CANCELADA" });
  });
});

describe("Nada impede um cancelamento", () => {
  beforeEach(() => {
    process.env.SALE_CANCEL_REASON_ENABLED = "1";
  });

  it("código fora do vocabulário é descartado, a venda cancela", async () => {
    // Nunca gravar lixo numa coluna de onde sai relatório — mas o descarte é
    // silencioso de propósito: rejeitar seria abortar o estorno por causa do
    // acessório.
    const { res, data } = await reverse({
      cancelReasonCode: "SEI_LA",
      cancelReason: "motivo real",
    });
    expect(res.statusCode).toBe(200);
    expect(data.cancelReasonCode).toBeUndefined();
    expect(data.cancelReason).toBe("motivo real");
    expect(data.status).toBe("CANCELADA");
  });

  it("observação gigante é truncada, não rejeitada", async () => {
    const { res, data } = await reverse({ cancelReason: "x".repeat(5_000) });
    expect(res.statusCode).toBe(200);
    expect(data.cancelReason).toHaveLength(CANCEL_NOTE_MAX);
  });

  it("body com tipos errados não derruba nada", async () => {
    const { res, data } = await reverse({
      cancelReasonCode: 42,
      cancelReason: { nada: "disso" },
    } as any);
    expect(res.statusCode).toBe(200);
    expect(data).toEqual({
      status: "CANCELADA",
      cancelledAt: expect.any(Date),
    });
  });

  it("o estoque volta em qualquer um desses casos", async () => {
    await reverse({ cancelReasonCode: "SEI_LA" });
    expect(StockDeductionService.restoreWithinTx).toHaveBeenCalledTimes(1);
  });
});

describe("normalizeCancelReason — a fronteira de tipo", () => {
  const ON = { SALE_CANCEL_REASON_ENABLED: "1" };

  it("flag ausente ⇒ tudo nulo, mesmo com body válido", () => {
    expect(
      normalizeCancelReason(
        { cancelReasonCode: "TROCA", cancelReason: "x" },
        {},
      ),
    ).toEqual({ code: null, note: null });
  });

  it("só a string exata '1' liga", () => {
    expect(
      normalizeCancelReason(
        { cancelReasonCode: "TROCA" },
        { SALE_CANCEL_REASON_ENABLED: "true" },
      ),
    ).toEqual({ code: null, note: null });
  });

  it("body ausente, nulo ou não-objeto ⇒ tudo nulo", () => {
    expect(normalizeCancelReason(undefined, ON)).toEqual({
      code: null,
      note: null,
    });
    expect(normalizeCancelReason(null, ON)).toEqual({ code: null, note: null });
    expect(normalizeCancelReason("TROCA", ON)).toEqual({
      code: null,
      note: null,
    });
  });

  it("observação em branco é ausência, não valor", () => {
    expect(normalizeCancelReason({ cancelReason: "   " }, ON)).toEqual({
      code: null,
      note: null,
    });
  });

  it("aceita os cinco códigos do vocabulário", () => {
    for (const code of [
      "CLIENTE_DESISTIU",
      "ERRO_LANCAMENTO",
      "PECA_DEFEITO",
      "TROCA",
      "OUTRO",
    ]) {
      expect(normalizeCancelReason({ cancelReasonCode: code }, ON).code).toBe(
        code,
      );
    }
  });

  it("não confunde chave herdada do Object com código válido", () => {
    // `"toString" in obj` seria true num objeto literal — a checagem tem de
    // ser contra o vocabulário, não contra o protótipo.
    expect(
      normalizeCancelReason({ cancelReasonCode: "toString" }, ON).code,
    ).toBeNull();
    expect(
      normalizeCancelReason({ cancelReasonCode: "constructor" }, ON).code,
    ).toBeNull();
  });
});

describe("Exibição", () => {
  it("traduz o código e devolve desconhecido cru", () => {
    expect(cancelReasonLabel("TROCA")).toBe("Troca por outra peça");
    expect(cancelReasonLabel("FUTURO")).toBe("FUTURO");
    expect(cancelReasonLabel(null)).toBeNull();
  });

  it("junta rótulo e observação, e some quando não há nada", () => {
    expect(describeCancelReason("TROCA", "pela do outro carro")).toBe(
      "Troca por outra peça — pela do outro carro",
    );
    expect(describeCancelReason("TROCA", null)).toBe("Troca por outra peça");
    expect(describeCancelReason(null, "só a observação")).toBe(
      "só a observação",
    );
    expect(describeCancelReason(null, "   ")).toBeNull();
    expect(describeCancelReason(null, null)).toBeNull();
  });
});
