// Bug D — corrida de dupla baixa / duplo estorno.
//
// `markPaid` e `reverse` liam o status FORA da transação e escreviam dentro
// dela sem condição. Duas requisições simultâneas passavam AS DUAS pelo guard
// de idempotência (`if (status === "PAGA") return`) e executavam o efeito
// colateral inteiro duas vezes:
//
//   markPaid ×2 → estoque baixado em dobro E, em venda com peça avulsa, DOIS
//                 produtos de catálogo criados para a mesma peça (o
//                 `promoteManualItems` filtra sobre o mesmo snapshot).
//   reverse  ×2 → estoque RESTAURADO em dobro: infla peça que não voltou ao
//                 pátio e o marketplace passa a anunciar o que não existe.
//
// O caminho real não é exótico: o botão "Marcar como paga" do Financeiro não
// tem `disabled` nem estado de ocupação — duplo clique reproduz.
//
// A correção é um compare-and-swap no UPDATE (`status: { not: "PAGA" }` /
// `status: "PAGA"`), opt-in para não tocar o caminho do PUT. Sob READ
// COMMITTED, o perdedor bloqueia no row lock e ao destravar reavalia o
// predicado contra a linha nova — casa 0 e sai por rollback.
//
// ESCOPO: aqui simulamos a perda da corrida fazendo o `updateMany` devolver
// `count: 0` (que é o que o Postgres devolve ao perdedor). O que isto prova é
// o CONTRATO: perdeu ⇒ nada de estoque, nada de efeito pós-commit, resposta
// idêntica à do caminho idempotente. A serialização em si é do banco.

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../app/marketplaces/services/stock-deduction.service", () => ({
  StockDeductionService: {
    deductWithinTx: vi.fn().mockResolvedValue({ deductions: [] }),
    restoreWithinTx: vi.fn().mockResolvedValue({ deductions: [] }),
    firePostEffects: vi.fn(),
  },
}));

vi.mock("../app/marketplaces/services/scrap-status-reconcile.service", () => ({
  ScrapStatusReconcileService: { reconcileForReceivable: vi.fn() },
}));

function makePrisma() {
  const fmodel = () => ({
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn().mockResolvedValue([]),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    update: vi.fn(),
    create: vi.fn(),
    createMany: vi.fn(),
    deleteMany: vi.fn(),
    groupBy: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
  });
  const p: any = {
    receivable: fmodel(),
    payable: fmodel(),
    receivableItem: fmodel(),
    receivablePayment: fmodel(),
    product: fmodel(),
  };
  p.$transaction = vi.fn(async (cb: any) => cb(p));
  return p;
}

vi.mock("../app/lib/prisma", () => ({ default: makePrisma() }));
vi.mock("@/app/lib/prisma", () => ({ default: makePrisma() }));

import prismaDefault from "../app/lib/prisma";
import { FinanceUseCase } from "../app/usecases/finance.usecase";
import { StockDeductionService } from "../app/marketplaces/services/stock-deduction.service";
import { ScrapStatusReconcileService } from "../app/marketplaces/services/scrap-status-reconcile.service";

const prisma = prismaDefault as any;
const USER = "user-owner";

function conta(status: string) {
  return {
    id: "r-1",
    userId: USER,
    customerId: "c-1",
    totalAmount: "100.00",
    status,
    paidAt: null,
    paymentMethod: "PIX",
    dueDate: new Date(),
    installments: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    customer: null,
    unidade: null,
    items: [
      {
        id: "i-1",
        productId: "p-1",
        quantity: 2,
        unitPrice: "50.00",
        createdAt: new Date(),
      },
    ],
    payments: [],
  };
}

describe("Bug D — markPaid perde a corrida", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.receivable.findFirst.mockResolvedValue(conta("PENDENTE"));
    prisma.receivable.findUnique.mockResolvedValue(conta("PAGA"));
  });

  it("a transição do markPaid é GUARDADA por status", async () => {
    prisma.receivable.updateMany.mockResolvedValue({ count: 1 });
    await new FinanceUseCase().markPaid("receivable", "r-1", USER);

    const call = prisma.receivable.updateMany.mock.calls.find(
      (c: any[]) => c[0]?.data?.status === "PAGA",
    );
    expect(call[0].where).toEqual({
      id: "r-1",
      userId: USER,
      status: { not: "PAGA" },
    });
  });

  it("perdendo a corrida NÃO baixa estoque nem dispara pós-commit", async () => {
    // count 0 = o Postgres não casou a linha: outra tx já marcou PAGA.
    prisma.receivable.updateMany.mockResolvedValue({ count: 0 });
    // 1ª leitura vê PENDENTE (a corrida ainda não foi decidida); a releitura
    // pós-conflito já enxerga o que o vencedor gravou.
    prisma.receivable.findFirst
      .mockResolvedValueOnce(conta("PENDENTE"))
      .mockResolvedValue(conta("PAGA"));

    const res = await new FinanceUseCase().markPaid("receivable", "r-1", USER);

    expect(StockDeductionService.deductWithinTx).not.toHaveBeenCalled();
    expect(StockDeductionService.firePostEffects).not.toHaveBeenCalled();
    expect(
      ScrapStatusReconcileService.reconcileForReceivable,
    ).not.toHaveBeenCalled();
    // Contrato idêntico ao do caminho idempotente: devolve a conta, não erro.
    expect(res.id).toBe("r-1");
    expect(res.status).toBe("PAGA");
  });

  it("conta JÁ PAGA continua saindo cedo, sem abrir transação", async () => {
    prisma.receivable.findFirst.mockResolvedValue(conta("PAGA"));

    await new FinanceUseCase().markPaid("receivable", "r-1", USER);

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(StockDeductionService.deductWithinTx).not.toHaveBeenCalled();
  });

  it("linha APAGADA no meio continua virando 404, não 200 com null", async () => {
    // `count: 0` tem DUAS causas: perdeu a corrida (a linha virou PAGA) ou a
    // conta foi excluída entre a leitura e o UPDATE. Se o tratamento do
    // conflito devolvesse a entry cegamente, o segundo caso responderia 200
    // com `{ entry: null }` — e a tela mostraria "Conta marcada como paga"
    // para uma conta que não existe mais. A rota mapeia "não encontrado"
    // para 404 por substring, então a mensagem importa.
    prisma.receivable.updateMany.mockResolvedValue({ count: 0 });
    prisma.receivable.findFirst
      .mockResolvedValueOnce(conta("PENDENTE"))
      .mockResolvedValue(null);

    await expect(
      new FinanceUseCase().markPaid("receivable", "r-1", USER),
    ).rejects.toThrow(/não encontrado/);

    expect(StockDeductionService.deductWithinTx).not.toHaveBeenCalled();
  });
});

describe("Bug D — reverse perde a corrida", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.receivable.findFirst.mockResolvedValue(conta("PAGA"));
    prisma.receivable.findUnique.mockResolvedValue(conta("CANCELADA"));
  });

  it("a transição do reverse é GUARDADA por status", async () => {
    prisma.receivable.updateMany.mockResolvedValue({ count: 1 });
    await new FinanceUseCase().reverse("r-1", USER);

    const call = prisma.receivable.updateMany.mock.calls.find(
      (c: any[]) => c[0]?.data?.status === "CANCELADA" && c[0]?.where?.id,
    );
    expect(call[0].where).toEqual({ id: "r-1", userId: USER, status: "PAGA" });
  });

  it("perdendo a corrida NÃO restaura estoque em dobro", async () => {
    prisma.receivable.updateMany.mockResolvedValue({ count: 0 });
    prisma.receivable.findFirst
      .mockResolvedValueOnce(conta("PAGA"))
      .mockResolvedValue(conta("CANCELADA"));

    const res = await new FinanceUseCase().reverse("r-1", USER);

    expect(StockDeductionService.restoreWithinTx).not.toHaveBeenCalled();
    expect(StockDeductionService.firePostEffects).not.toHaveBeenCalled();
    expect(res.status).toBe("CANCELADA");
  });

  it("conta JÁ CANCELADA continua saindo cedo, sem abrir transação", async () => {
    prisma.receivable.findFirst.mockResolvedValue(conta("CANCELADA"));

    await new FinanceUseCase().reverse("r-1", USER);

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(StockDeductionService.restoreWithinTx).not.toHaveBeenCalled();
  });

  it("linha APAGADA no meio continua virando 404 no estorno", async () => {
    // A rota do estorno mapeia "não encontrada" (feminino) para 404.
    prisma.receivable.updateMany.mockResolvedValue({ count: 0 });
    prisma.receivable.findFirst
      .mockResolvedValueOnce(conta("PAGA"))
      .mockResolvedValue(null);

    await expect(new FinanceUseCase().reverse("r-1", USER)).rejects.toThrow(
      /não encontrada/,
    );

    expect(StockDeductionService.restoreWithinTx).not.toHaveBeenCalled();
  });
});
