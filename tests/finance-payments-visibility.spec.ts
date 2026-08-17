// Fase 1.1 — o pagamento combinado era GRAVADO e ficava INVISÍVEL.
//
// O relato do cliente ("as formas não estão ficando salvas") descrevia o
// sintoma, não a causa: as linhas estavam em `ReceivablePayment` o tempo todo.
// Quebravam três superfícies de LEITURA, e este spec cobre as três:
//
//   1. LISTAGEM  — `findAll` usa um `select:` explícito que não incluía
//                  `payments`; a coluna "Forma" mostrava só o predominante.
//   2. REABERTURA— a edição lia apenas `entry.items` do `GET /:id` e
//                  descartava `entry.payments`, então o bloco reabria vazio.
//   3. RÓTULO    — sem um resumo, PIX+Crédito era indistinguível de Crédito.
//
// Compatibilidade: venda de UMA forma tem de continuar byte-idêntica.

import { describe, it, expect, beforeEach, vi } from "vitest";

// `vi.mock` é hoisted para o topo do arquivo, então a factory não pode
// fechar sobre uma `const` — só sobre uma function declaration (que também é
// hoisted). Mesmo padrão de tests/finance-multi-payment.spec.ts.
function makePrisma() {
  const fmodel = () => ({
    findMany: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
    groupBy: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
    createMany: vi.fn(),
  });
  const p: any = {
    receivable: fmodel(),
    payable: fmodel(),
    receivableItem: fmodel(),
    receivablePayment: fmodel(),
  };
  p.$transaction = vi.fn(async (cb: any) => cb(p));
  return p;
}

vi.mock("../app/lib/prisma", () => ({ default: makePrisma() }));
vi.mock("@/app/lib/prisma", () => ({ default: makePrisma() }));

import prismaDefault from "../app/lib/prisma";
import { FinanceRepository } from "../app/repositories/finance.repository";
import {
  entryPaymentsToForm,
  financeRowToFormSeed,
} from "../app/financeiro/lib/row-to-form";
import {
  paymentMethodsSummary,
  paymentMethodLabel,
} from "../app/lib/payment-methods";

const prismaMock = prismaDefault as any;
const USER = "user-owner";

function rawReceivable(over: Partial<any> = {}) {
  return {
    id: "r-1",
    userId: USER,
    customerId: "c-1",
    unidadeId: null,
    document: null,
    reason: null,
    debtDetails: null,
    totalAmount: "500.00",
    fineAmount: null,
    finePercent: null,
    interestPercent: null,
    toleranceDays: null,
    installments: 1,
    periodDays: null,
    dueDate: new Date("2026-09-01"),
    status: "PAGA",
    paidAt: new Date(),
    paymentMethod: "CREDITO",
    createdAt: new Date(),
    updatedAt: new Date(),
    customer: { id: "c-1", name: "Cliente", cpf: null, email: null },
    unidade: null,
    ...over,
  };
}

describe("Fase 1.1 — listagem devolve as linhas de pagamento", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.receivable.count.mockResolvedValue(1);
    prismaMock.receivable.groupBy.mockResolvedValue([]);
    prismaMock.receivablePayment.findMany.mockResolvedValue([]);
  });

  it("anexa as N formas na venda que as tem (cenário R$200 PIX + R$300 Crédito)", async () => {
    prismaMock.receivable.findMany.mockResolvedValue([rawReceivable()]);
    prismaMock.receivablePayment.findMany.mockResolvedValue([
      { receivableId: "r-1", method: "PIX", amount: "200.00" },
      { receivableId: "r-1", method: "CREDITO", amount: "300.00" },
    ]);

    const res = await new FinanceRepository().findAll(
      "receivable",
      { page: 1, limit: 20 },
      USER,
    );

    expect(res.items[0].payments).toEqual([
      { method: "PIX", amount: 200 },
      { method: "CREDITO", amount: 300 },
    ]);
    // O escalar continua sendo o predominante — os 41 leitores não mudam.
    expect(res.items[0].paymentMethod).toBe("CREDITO");
  });

  it("fecha o escopo de tenant (ReceivablePayment não tem userId)", async () => {
    prismaMock.receivable.findMany.mockResolvedValue([rawReceivable()]);

    await new FinanceRepository().findAll(
      "receivable",
      { page: 1, limit: 20 },
      USER,
    );

    const arg = prismaMock.receivablePayment.findMany.mock.calls[0][0];
    expect(arg.where.receivable).toEqual({ userId: USER });
    expect(arg.where.receivableId).toEqual({ in: ["r-1"] });
  });

  it("venda de UMA forma não ganha o campo (resposta idêntica à de hoje)", async () => {
    prismaMock.receivable.findMany.mockResolvedValue([rawReceivable()]);
    prismaMock.receivablePayment.findMany.mockResolvedValue([]);

    const res = await new FinanceRepository().findAll(
      "receivable",
      { page: 1, limit: 20 },
      USER,
    );

    expect(res.items[0].payments).toBeUndefined();
  });

  it("não consulta pagamentos em conta a pagar nem em página vazia", async () => {
    prismaMock.payable.findMany.mockResolvedValue([]);
    await new FinanceRepository().findAll(
      "payable",
      { page: 1, limit: 20 },
      USER,
    );
    expect(prismaMock.receivablePayment.findMany).not.toHaveBeenCalled();

    prismaMock.receivable.findMany.mockResolvedValue([]);
    await new FinanceRepository().findAll(
      "receivable",
      { page: 1, limit: 20 },
      USER,
    );
    expect(prismaMock.receivablePayment.findMany).not.toHaveBeenCalled();
  });
});

describe("Fase 1.1 — reabertura repopula o bloco de pagamento", () => {
  it("mapeia as linhas do GET /:id para o formulário", () => {
    const out = entryPaymentsToForm([
      { id: "p1", method: "PIX", amount: "200.00", createdAt: new Date() },
      { id: "p2", method: "CREDITO", amount: 300, createdAt: new Date() },
    ]);

    expect(out).toEqual([
      { method: "PIX", amount: 200 },
      { method: "CREDITO", amount: 300 },
    ]);
  });

  it("NÃO reidrata `tendered` (troco é estado de tela, nunca foi salvo)", () => {
    const out = entryPaymentsToForm([{ method: "DINHEIRO", amount: 100 }]);
    expect(out![0]).not.toHaveProperty("tendered");
  });

  it("devolve undefined sem linhas — nunca [], que significa APAGAR", () => {
    // `payments: []` no submit manda o backend deletar as linhas gravadas.
    // Se o detalhe não trouxer nada, o certo é não tocar no campo.
    expect(entryPaymentsToForm([])).toBeUndefined();
    expect(entryPaymentsToForm(undefined)).toBeUndefined();
    expect(entryPaymentsToForm(null)).toBeUndefined();
  });

  it("descarta linha sem método em vez de quebrar o formulário", () => {
    const out = entryPaymentsToForm([
      { method: "PIX", amount: 50 },
      { method: "", amount: 10 },
      { amount: 10 },
    ]);
    expect(out).toEqual([{ method: "PIX", amount: 50 }]);
  });

  it("o seed da linha não inventa payments (vêm só do detalhe)", () => {
    const seed = financeRowToFormSeed({
      id: "r-1",
      document: null,
      reason: null,
      totalAmount: 500,
      installments: 1,
      dueDate: "2026-09-01T00:00:00.000Z",
    });
    expect(seed).not.toHaveProperty("payments");
  });
});

describe("Fase 1.1 — rótulo da coluna Forma", () => {
  it("com 2+ formas mostra o predominante + contagem, e o detalhe no tooltip", () => {
    const { label, detail } = paymentMethodsSummary("CREDITO", [
      { method: "PIX", amount: 200 },
      { method: "CREDITO", amount: 300 },
    ]);

    expect(label).toBe(`${paymentMethodLabel("CREDITO")} +1`);
    expect(detail).toContain(paymentMethodLabel("PIX"));
    expect(detail).toContain(paymentMethodLabel("CREDITO"));
  });

  it("com 0 ou 1 forma é IDÊNTICO ao rótulo de hoje, sem tooltip", () => {
    for (const payments of [
      undefined,
      null,
      [],
      [{ method: "PIX", amount: 10 }],
    ]) {
      const { label, detail } = paymentMethodsSummary("PIX", payments as any);
      expect(label).toBe(paymentMethodLabel("PIX"));
      expect(detail).toBeNull();
    }
  });

  it("três formas contam duas extras", () => {
    const { label } = paymentMethodsSummary("DINHEIRO", [
      { method: "DINHEIRO", amount: 100 },
      { method: "PIX", amount: 50 },
      { method: "DEBITO", amount: 50 },
    ]);
    expect(label).toBe(`${paymentMethodLabel("DINHEIRO")} +2`);
  });
});
