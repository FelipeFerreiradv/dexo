import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ──────────────────────────────────────────────────────────────────────────────
// Commit 3 (C8) — a baixa que falha deixa de ser um beco sem saída.
//
// Antes: `deductStockForOrder` lançava, o catch engolia com um console.error,
// `stockDeducted` ficava false e NÃO existia retry. Na passada seguinte o
// pedido caía em `already_exists` e ninguém tentava de novo. Resultado: pedido
// visível na tela, estoque intacto — e nem dava para consultar "pedidos sem
// baixa", porque a única evidência era o `reason` do StockLog, texto livre.
//
// Agora: `Order.stockDeductedAt` é gravado DENTRO da transação da baixa, e a
// re-tentativa é ancorada no NET do StockLog — o mesmo mecanismo que o
// cancelamento usa — para não baixar duas vezes.
// ──────────────────────────────────────────────────────────────────────────────

vi.mock("@/app/marketplaces/services/stock-sync-retry.service", () => ({
  StockSyncRetryService: { runOnce: vi.fn().mockResolvedValue(undefined) },
}));

import { OrderUseCase } from "@/app/marketplaces/usecases/order.usercase";
import { StockDeductionService } from "@/app/marketplaces/services/stock-deduction.service";
import prisma from "@/app/lib/prisma";

const ORDER = {
  id: "order-1",
  status: "SHIPPED",
  stockDeductedAt: null,
  items: [{ productId: "p1", quantity: 2, unitPrice: 10, listingId: null }],
};

const buildTx = () => ({
  $queryRaw: vi.fn().mockResolvedValue([{ status: "SHIPPED" }]),
  order: { update: vi.fn().mockResolvedValue({}) },
});

// A suíte roda com ORDER_STOCK_DEDUCTED_AT_DISABLED=1 (vitest.config), para os
// specs de estoque existentes — que montam o `tx` à mão — ficarem
// byte-idênticos. Aqui ligamos a feature.
let flagAnterior: string | undefined;

beforeEach(() => {
  flagAnterior = process.env.ORDER_STOCK_DEDUCTED_AT_DISABLED;
  delete process.env.ORDER_STOCK_DEDUCTED_AT_DISABLED;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (flagAnterior === undefined) {
    delete process.env.ORDER_STOCK_DEDUCTED_AT_DISABLED;
  } else {
    process.env.ORDER_STOCK_DEDUCTED_AT_DISABLED = flagAnterior;
  }
});

describe("stockDeductedAt", () => {
  it("é gravado na MESMA transação da baixa", async () => {
    const tx = buildTx();
    vi.spyOn(prisma, "$transaction").mockImplementation(async (cb: any) =>
      cb(tx),
    );
    vi.spyOn(StockDeductionService, "deductWithinTx").mockResolvedValue({
      deductions: [],
      oversellAlerts: [],
    } as any);
    vi.spyOn(StockDeductionService, "firePostEffects").mockImplementation(
      () => {},
    );

    await (OrderUseCase as any).deductStockForOrder(
      ORDER,
      "Venda Shopee #SN-1",
    );

    expect(StockDeductionService.deductWithinTx).toHaveBeenCalled();
    expect(tx.order.update).toHaveBeenCalledWith({
      where: { id: "order-1" },
      data: { stockDeductedAt: expect.any(Date) },
    });
  });

  it("kill-switch ORDER_STOCK_DEDUCTED_AT_DISABLED=1 não grava a marca", async () => {
    process.env.ORDER_STOCK_DEDUCTED_AT_DISABLED = "1";
    const tx = buildTx();
    vi.spyOn(prisma, "$transaction").mockImplementation(async (cb: any) =>
      cb(tx),
    );
    vi.spyOn(StockDeductionService, "deductWithinTx").mockResolvedValue({
      deductions: [],
      oversellAlerts: [],
    } as any);
    vi.spyOn(StockDeductionService, "firePostEffects").mockImplementation(
      () => {},
    );

    await (OrderUseCase as any).deductStockForOrder(
      ORDER,
      "Venda Shopee #SN-1",
    );

    expect(tx.order.update).not.toHaveBeenCalled();
  });

  it("pedido já CANCELLED não baixa nem marca", async () => {
    const tx = buildTx();
    tx.$queryRaw.mockResolvedValue([{ status: "CANCELLED" }]);
    vi.spyOn(prisma, "$transaction").mockImplementation(async (cb: any) =>
      cb(tx),
    );
    vi.spyOn(StockDeductionService, "deductWithinTx").mockResolvedValue({
      deductions: [],
      oversellAlerts: [],
    } as any);
    vi.spyOn(StockDeductionService, "firePostEffects").mockImplementation(
      () => {},
    );

    await (OrderUseCase as any).deductStockForOrder(
      ORDER,
      "Venda Shopee #SN-1",
    );

    expect(StockDeductionService.deductWithinTx).not.toHaveBeenCalled();
    expect(tx.order.update).not.toHaveBeenCalled();
  });
});

describe("retryStockDeduction — não baixa duas vezes", () => {
  it("não re-baixa quando o net do StockLog já cobre a quantidade", async () => {
    vi.spyOn(prisma.order, "findUnique").mockResolvedValue(ORDER as any);
    // Já existe -2 para p1 com a mesma `reason`.
    vi.spyOn(prisma.stockLog as any, "groupBy").mockResolvedValue([
      { productId: "p1", _sum: { change: -2 } },
    ] as any);
    vi.spyOn(prisma.order, "update").mockResolvedValue({} as any);
    const deduct = vi
      .spyOn(OrderUseCase as any, "deductStockForOrder")
      .mockResolvedValue([]);

    const ok = await OrderUseCase.retryStockDeduction(
      "order-1",
      "SHOPEE",
      "SN-1",
    );

    expect(ok).toBe(true);
    expect(deduct).not.toHaveBeenCalled();
    // Só a marca de auditoria, que faltava.
    expect(prisma.order.update).toHaveBeenCalledWith({
      where: { id: "order-1" },
      data: { stockDeductedAt: expect.any(Date) },
    });
  });

  it("baixa quando o net mostra que ainda falta", async () => {
    vi.spyOn(prisma.order, "findUnique").mockResolvedValue(ORDER as any);
    vi.spyOn(prisma.stockLog as any, "groupBy").mockResolvedValue([] as any);
    const deduct = vi
      .spyOn(OrderUseCase as any, "deductStockForOrder")
      .mockResolvedValue([]);

    const ok = await OrderUseCase.retryStockDeduction(
      "order-1",
      "SHOPEE",
      "SN-1",
    );

    expect(ok).toBe(true);
    expect(deduct).toHaveBeenCalledWith(ORDER, "Venda Shopee #SN-1");
  });

  it("baixa PARCIAL (clamp de oversell) completa só o que falta", async () => {
    vi.spyOn(prisma.order, "findUnique").mockResolvedValue(ORDER as any);
    // Baixou 1 de 2 — o clamp de oversell deixou faltando 1.
    vi.spyOn(prisma.stockLog as any, "groupBy").mockResolvedValue([
      { productId: "p1", _sum: { change: -1 } },
    ] as any);
    const deduct = vi
      .spyOn(OrderUseCase as any, "deductStockForOrder")
      .mockResolvedValue([]);

    await OrderUseCase.retryStockDeduction("order-1", "SHOPEE", "SN-1");

    expect(deduct).toHaveBeenCalled();
  });

  it("pedido CANCELLED não baixa e encerra a pendência", async () => {
    vi.spyOn(prisma.order, "findUnique").mockResolvedValue({
      ...ORDER,
      status: "CANCELLED",
    } as any);
    const deduct = vi
      .spyOn(OrderUseCase as any, "deductStockForOrder")
      .mockResolvedValue([]);

    const ok = await OrderUseCase.retryStockDeduction(
      "order-1",
      "SHOPEE",
      "SN-1",
    );

    expect(ok).toBe(true);
    expect(deduct).not.toHaveBeenCalled();
  });

  it("falha na re-tentativa devolve false (a pendência segue aberta)", async () => {
    vi.spyOn(prisma.order, "findUnique").mockResolvedValue(ORDER as any);
    vi.spyOn(prisma.stockLog as any, "groupBy").mockResolvedValue([] as any);
    vi.spyOn(OrderUseCase as any, "deductStockForOrder").mockRejectedValue(
      new Error("deadlock"),
    );

    const ok = await OrderUseCase.retryStockDeduction(
      "order-1",
      "SHOPEE",
      "SN-1",
    );

    expect(ok).toBe(false);
  });

  it("pedido inexistente devolve false", async () => {
    vi.spyOn(prisma.order, "findUnique").mockResolvedValue(null as any);

    const ok = await OrderUseCase.retryStockDeduction(
      "sumiu",
      "SHOPEE",
      "SN-1",
    );

    expect(ok).toBe(false);
  });
});
