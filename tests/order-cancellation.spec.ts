import { describe, it, expect, vi, afterEach } from "vitest";

// ──────────────────────────────────────────────────────────
// Cancelamento de pedido marketplace (OrderUseCase.processOrderCancellation).
//
// Prova:
//  - Claim atômico por transição de status (PAID|SHIPPED|DELIVERED →
//    CANCELLED) dentro da MESMA tx do estorno; corrida ⇒ no-op.
//  - Quantidades pelo "net" do StockLog (baixa − estornos anteriores) com
//    teto na quantidade do pedido — nunca estorna em dobro nem estoque
//    fantasma (baixa clampada por oversell).
//  - PENDING → só status (nunca teve baixa). Já CANCELLED → fast-path sem tx.
//  - firePostEffects com reopenOnRefill (sem pauseOnZero), só quando estornou.
//  - Kill-switch ORDER_CANCEL_RESTORE_DISABLED=1 ⇒ no-op total.
//  - Nunca lança (callers são setImmediate fire-and-forget).
// ──────────────────────────────────────────────────────────

// Stub do StockSyncRetryService — firePostEffects (quando não mockado) dispara
// setImmediate → runOnce() → prisma real. Tests-only, padrão order.usecase.spec.
vi.mock("@/app/marketplaces/services/stock-sync-retry.service", () => ({
  StockSyncRetryService: { runOnce: vi.fn().mockResolvedValue(undefined) },
}));

import { OrderUseCase } from "@/app/marketplaces/usecases/order.usercase";
import prisma from "@/app/lib/prisma";
import { StockDeductionService } from "@/app/marketplaces/services/stock-deduction.service";
import { SystemLogService } from "@/app/services/system-log.service";

const ACCOUNT_ID = "acc-1";
const EXT_ID = "123";

function makeOrder(over: Partial<any> = {}) {
  return {
    id: "o-1",
    status: "PAID",
    items: [{ productId: "p-1", quantity: 2 }],
    marketplaceAccount: { userId: "u-1" },
    ...over,
  };
}

/**
 * Monta o tx falso e o spy do $transaction que o injeta no callback,
 * capturando os opts. updateMany é sequenciado por chamada (claim, pending).
 */
function mockTx({
  updateManyCounts = [1],
  groupBy = [] as any[],
} = {}) {
  const updateMany = vi.fn();
  for (const count of updateManyCounts) {
    updateMany.mockResolvedValueOnce({ count });
  }
  const tx = {
    order: { updateMany },
    stockLog: { groupBy: vi.fn().mockResolvedValue(groupBy) },
    $queryRaw: vi.fn().mockResolvedValue([{ id: "p-1" }]),
  };
  const txSpy = vi
    .spyOn(prisma, "$transaction")
    .mockImplementation(async (cb: any, _opts?: any) => cb(tx));
  return { tx, txSpy };
}

function spyServices() {
  const restore = vi
    .spyOn(StockDeductionService, "restoreWithinTx")
    .mockResolvedValue({
      deductions: [
        {
          productId: "p-1",
          productName: "Peça",
          previousStock: 0,
          newStock: 2,
          quantity: 2,
        },
      ],
    });
  const fire = vi
    .spyOn(StockDeductionService, "firePostEffects")
    .mockImplementation(() => {});
  vi.spyOn(SystemLogService, "logInfo").mockResolvedValue(undefined as any);
  vi.spyOn(SystemLogService, "logError").mockResolvedValue(undefined as any);
  return { restore, fire };
}

describe("OrderUseCase.processOrderCancellation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ORDER_CANCEL_RESTORE_DISABLED;
  });

  it("feliz (ML): claim PAID→CANCELLED + estorno net do StockLog + reopenOnRefill", async () => {
    vi.spyOn(prisma.order, "findFirst").mockResolvedValue(makeOrder() as any);
    const { tx, txSpy } = mockTx({
      updateManyCounts: [1],
      groupBy: [{ productId: "p-1", _sum: { change: -2 } }],
    });
    const { restore, fire } = spyServices();

    const res = await OrderUseCase.processOrderCancellation({
      marketplaceAccountId: ACCOUNT_ID,
      externalOrderId: EXT_ID,
      platformLabel: "ML",
    });

    expect(res).toMatchObject({
      success: true,
      orderId: "o-1",
      action: "cancelled_restored",
      restoredItems: 1,
    });
    // Claim atômico: transição de status (PENDING incluso — net decide), na tx.
    expect(tx.order.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: {
        id: "o-1",
        status: { in: ["PENDING", "PAID", "SHIPPED", "DELIVERED"] },
      },
      data: { status: "CANCELLED" },
    });
    // Net do StockLog: reasons exatas da baixa, do estorno e da reativação
    // (un-cancel) — o net fecha em qualquer alternância cancel/un-cancel.
    expect(tx.stockLog.groupBy).toHaveBeenCalledWith({
      by: ["productId"],
      where: {
        productId: { in: ["p-1"] },
        reason: {
          in: [
            "Venda ML #123",
            "Estorno venda ML #123",
            "Reativação venda ML #123",
          ],
        },
      },
      _sum: { change: true },
    });
    // Estorno reutiliza o motor, na MESMA tx, com reason determinística.
    expect(restore).toHaveBeenCalledTimes(1);
    expect(restore).toHaveBeenCalledWith(tx, {
      items: [{ productId: "p-1", quantity: 2 }],
      reason: "Estorno venda ML #123",
      orderId: "o-1",
      logPrefix: "[OrderUseCase]",
    });
    // Mesmos opts de tx do reverse/deductStockForOrder.
    expect(txSpy).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 60_000,
      maxWait: 20_000,
    });
    // Pós-commit: reopenOnRefill com o userId da conta e force (o sync pausa
    // item ML só remotamente — sem force o fast-path local faria no-op);
    // SEM pauseOnZero.
    expect(fire).toHaveBeenCalledTimes(1);
    const fireArg = fire.mock.calls[0][0];
    expect(fireArg.reopenOnRefill).toEqual({ userId: "u-1", force: true });
    expect(fireArg.pauseOnZero).toBeUndefined();
    expect(fireArg.deductions).toHaveLength(1);
  });

  it("idempotência fast-path: já CANCELLED → no-op sem abrir transação", async () => {
    vi.spyOn(prisma.order, "findFirst").mockResolvedValue(
      makeOrder({ status: "CANCELLED" }) as any,
    );
    const txSpy = vi.spyOn(prisma, "$transaction");
    const { restore, fire } = spyServices();

    const res = await OrderUseCase.processOrderCancellation({
      marketplaceAccountId: ACCOUNT_ID,
      externalOrderId: EXT_ID,
      platformLabel: "ML",
    });

    expect(res.action).toBe("already_cancelled");
    expect(txSpy).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
    expect(fire).not.toHaveBeenCalled();
  });

  it("corrida: outro processo cancelou entre o findFirst e a tx → no-op", async () => {
    vi.spyOn(prisma.order, "findFirst").mockResolvedValue(makeOrder() as any);
    // Claim perde (0) — concorrente já transicionou o status.
    const { tx } = mockTx({ updateManyCounts: [0] });
    const { restore, fire } = spyServices();

    const res = await OrderUseCase.processOrderCancellation({
      marketplaceAccountId: ACCOUNT_ID,
      externalOrderId: EXT_ID,
      platformLabel: "ML",
    });

    expect(res.action).toBe("already_cancelled");
    expect(tx.order.updateMany).toHaveBeenCalledTimes(1);
    expect(restore).not.toHaveBeenCalled();
    expect(fire).not.toHaveBeenCalled();
  });

  it("PENDING COM baixa (ex.: Shopee TO_CONFIRM_RECEIVE): estorna pelo net", async () => {
    vi.spyOn(prisma.order, "findFirst").mockResolvedValue(
      makeOrder({ status: "PENDING" }) as any,
    );
    mockTx({
      updateManyCounts: [1],
      groupBy: [{ productId: "p-1", _sum: { change: -2 } }],
    });
    const { restore } = spyServices();

    const res = await OrderUseCase.processOrderCancellation({
      marketplaceAccountId: ACCOUNT_ID,
      externalOrderId: EXT_ID,
      platformLabel: "Shopee",
    });

    expect(res.action).toBe("cancelled_restored");
    expect(restore).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        items: [{ productId: "p-1", quantity: 2 }],
      }),
    );
  });

  it("PENDING sem baixa: vira CANCELLED sem estorno (net 0)", async () => {
    vi.spyOn(prisma.order, "findFirst").mockResolvedValue(
      makeOrder({ status: "PENDING" }) as any,
    );
    const { tx } = mockTx({ updateManyCounts: [1], groupBy: [] });
    const { restore, fire } = spyServices();

    const res = await OrderUseCase.processOrderCancellation({
      marketplaceAccountId: ACCOUNT_ID,
      externalOrderId: EXT_ID,
      platformLabel: "ML",
    });

    expect(res.action).toBe("cancelled_no_restore");
    expect(tx.order.updateMany).toHaveBeenCalledTimes(1);
    expect(restore).not.toHaveBeenCalled();
    expect(fire).not.toHaveBeenCalled();
  });

  it("net=0 (nunca baixou ou já estornado): cancela sem estorno", async () => {
    vi.spyOn(prisma.order, "findFirst").mockResolvedValue(makeOrder() as any);
    const { tx } = mockTx({ updateManyCounts: [1], groupBy: [] });
    const { restore, fire } = spyServices();

    const res = await OrderUseCase.processOrderCancellation({
      marketplaceAccountId: ACCOUNT_ID,
      externalOrderId: EXT_ID,
      platformLabel: "ML",
    });

    expect(res.action).toBe("cancelled_no_restore");
    expect(tx.stockLog.groupBy).toHaveBeenCalledTimes(1);
    expect(restore).not.toHaveBeenCalled();
    expect(fire).not.toHaveBeenCalled();
  });

  it("baixa clampada por oversell: estorna só o que foi baixado (Σ=-1, qty 2 → 1)", async () => {
    vi.spyOn(prisma.order, "findFirst").mockResolvedValue(makeOrder() as any);
    mockTx({
      updateManyCounts: [1],
      groupBy: [{ productId: "p-1", _sum: { change: -1 } }],
    });
    const { restore } = spyServices();

    await OrderUseCase.processOrderCancellation({
      marketplaceAccountId: ACCOUNT_ID,
      externalOrderId: EXT_ID,
      platformLabel: "ML",
    });

    expect(restore).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        items: [{ productId: "p-1", quantity: 1 }],
      }),
    );
  });

  it("teto na quantidade do pedido: net inflado (Σ=-4, qty 2) estorna no máximo 2", async () => {
    vi.spyOn(prisma.order, "findFirst").mockResolvedValue(makeOrder() as any);
    mockTx({
      updateManyCounts: [1],
      groupBy: [{ productId: "p-1", _sum: { change: -4 } }],
    });
    const { restore } = spyServices();

    await OrderUseCase.processOrderCancellation({
      marketplaceAccountId: ACCOUNT_ID,
      externalOrderId: EXT_ID,
      platformLabel: "ML",
    });

    expect(restore).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        items: [{ productId: "p-1", quantity: 2 }],
      }),
    );
  });

  it("itens repetidos do mesmo produto agregam em um único item de estorno", async () => {
    vi.spyOn(prisma.order, "findFirst").mockResolvedValue(
      makeOrder({
        items: [
          { productId: "p-1", quantity: 1 },
          { productId: "p-1", quantity: 1 },
        ],
      }) as any,
    );
    mockTx({
      updateManyCounts: [1],
      groupBy: [{ productId: "p-1", _sum: { change: -2 } }],
    });
    const { restore } = spyServices();

    await OrderUseCase.processOrderCancellation({
      marketplaceAccountId: ACCOUNT_ID,
      externalOrderId: EXT_ID,
      platformLabel: "ML",
    });

    expect(restore).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        items: [{ productId: "p-1", quantity: 2 }],
      }),
    );
  });

  it("reasons por plataforma: Shopee usa 'Venda Shopee #<id>' / 'Estorno venda Shopee #<id>'", async () => {
    vi.spyOn(prisma.order, "findFirst").mockResolvedValue(makeOrder() as any);
    const { tx } = mockTx({
      updateManyCounts: [1],
      groupBy: [{ productId: "p-1", _sum: { change: -2 } }],
    });
    const { restore } = spyServices();

    await OrderUseCase.processOrderCancellation({
      marketplaceAccountId: ACCOUNT_ID,
      externalOrderId: "SN-9",
      platformLabel: "Shopee",
    });

    expect(tx.stockLog.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          reason: {
            in: [
              "Venda Shopee #SN-9",
              "Estorno venda Shopee #SN-9",
              "Reativação venda Shopee #SN-9",
            ],
          },
        }),
      }),
    );
    expect(restore).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reason: "Estorno venda Shopee #SN-9" }),
    );
  });

  it("kill-switch ORDER_CANCEL_RESTORE_DISABLED=1 → no-op total (nem consulta o pedido)", async () => {
    process.env.ORDER_CANCEL_RESTORE_DISABLED = "1";
    const findFirst = vi.spyOn(prisma.order, "findFirst");
    const { restore } = spyServices();

    const res = await OrderUseCase.processOrderCancellation({
      marketplaceAccountId: ACCOUNT_ID,
      externalOrderId: EXT_ID,
      platformLabel: "ML",
    });

    expect(res.action).toBe("disabled");
    expect(findFirst).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
  });

  it("pedido inexistente → not_found sem transação", async () => {
    vi.spyOn(prisma.order, "findFirst").mockResolvedValue(null);
    const txSpy = vi.spyOn(prisma, "$transaction");
    spyServices();

    const res = await OrderUseCase.processOrderCancellation({
      marketplaceAccountId: ACCOUNT_ID,
      externalOrderId: EXT_ID,
      platformLabel: "ML",
    });

    expect(res.action).toBe("not_found");
    expect(txSpy).not.toHaveBeenCalled();
  });

  it("erro na transação → { success:false, action:'error' } SEM lançar (rollback implícito)", async () => {
    vi.spyOn(prisma.order, "findFirst").mockResolvedValue(makeOrder() as any);
    vi.spyOn(prisma, "$transaction").mockRejectedValue(
      new Error("deadlock simulado"),
    );
    const { fire } = spyServices();

    const res = await OrderUseCase.processOrderCancellation({
      marketplaceAccountId: ACCOUNT_ID,
      externalOrderId: EXT_ID,
      platformLabel: "ML",
    });

    expect(res.success).toBe(false);
    expect(res.action).toBe("error");
    expect(res.message).toMatch(/deadlock/);
    expect(fire).not.toHaveBeenCalled();
  });
});

describe("OrderUseCase.deductStockForOrder — guard de pedido cancelado", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ORDER_CANCEL_RESTORE_DISABLED;
  });

  const orderForDeduct = {
    id: "o-1",
    items: [{ productId: "p-1", quantity: 1 }],
    marketplaceAccount: { platform: "MERCADO_LIVRE" },
  };

  function mockDeductTx(orderStatus: string) {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ status: orderStatus }]),
    };
    vi.spyOn(prisma, "$transaction").mockImplementation(async (cb: any) =>
      cb(tx),
    );
    const deduct = vi
      .spyOn(StockDeductionService, "deductWithinTx")
      .mockResolvedValue({ deductions: [], oversellAlerts: [] });
    const fire = vi
      .spyOn(StockDeductionService, "firePostEffects")
      .mockImplementation(() => {});
    return { tx, deduct, fire };
  }

  it("pedido já CANCELLED (cancelamento venceu a corrida) → NÃO deduz", async () => {
    const { tx, deduct } = mockDeductTx("CANCELLED");

    const result = await (OrderUseCase as any).deductStockForOrder(
      orderForDeduct,
      "Venda ML #123",
    );

    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(deduct).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it("pedido PAID → deduz normalmente (guard transparente)", async () => {
    const { deduct } = mockDeductTx("PAID");

    await (OrderUseCase as any).deductStockForOrder(
      orderForDeduct,
      "Venda ML #123",
    );

    expect(deduct).toHaveBeenCalledTimes(1);
    expect(deduct).toHaveBeenCalledWith(expect.anything(), {
      items: [{ productId: "p-1", quantity: 1 }],
      reason: "Venda ML #123",
      orderId: "o-1",
      logPrefix: "[OrderUseCase]",
    });
  });

  it("kill-switch → nem consulta o status (caminho byte-idêntico ao atual)", async () => {
    process.env.ORDER_CANCEL_RESTORE_DISABLED = "1";
    const { tx, deduct } = mockDeductTx("CANCELLED");

    await (OrderUseCase as any).deductStockForOrder(
      orderForDeduct,
      "Venda ML #123",
    );

    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(deduct).toHaveBeenCalledTimes(1);
  });
});

describe("OrderUseCase.processOrderUncancellation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ORDER_CANCEL_RESTORE_DISABLED;
  });

  function makeCancelledOrder(over: Partial<any> = {}) {
    return {
      id: "o-1",
      status: "CANCELLED",
      items: [{ productId: "p-1", quantity: 2 }],
      marketplaceAccount: { platform: "MERCADO_LIVRE" },
      ...over,
    };
  }

  function spyUncancelServices(
    oversellAlerts: any[] = [],
  ): {
    deduct: ReturnType<typeof vi.spyOn>;
    fire: ReturnType<typeof vi.spyOn>;
    logWarning: ReturnType<typeof vi.spyOn>;
  } {
    const deduct = vi
      .spyOn(StockDeductionService, "deductWithinTx")
      .mockResolvedValue({
        deductions: [
          {
            productId: "p-1",
            productName: "Peça",
            previousStock: 2,
            newStock: 0,
            quantity: 2,
          },
        ],
        oversellAlerts,
      });
    const fire = vi
      .spyOn(StockDeductionService, "firePostEffects")
      .mockImplementation(() => {});
    vi.spyOn(SystemLogService, "logInfo").mockResolvedValue(undefined as any);
    vi.spyOn(SystemLogService, "logError").mockResolvedValue(undefined as any);
    const logWarning = vi
      .spyOn(SystemLogService, "logWarning")
      .mockResolvedValue(undefined as any);
    return { deduct, fire, logWarning } as any;
  }

  it("feliz: claim CANCELLED→PAID + re-deduz o net dos estornos com reason de reativação", async () => {
    vi.spyOn(prisma.order, "findFirst").mockResolvedValue(
      makeCancelledOrder() as any,
    );
    const { tx, txSpy } = mockTx({
      updateManyCounts: [1],
      groupBy: [{ productId: "p-1", _sum: { change: 2 } }], // estorno +2, sem reativações
    });
    const { deduct, fire } = spyUncancelServices();

    const res = await OrderUseCase.processOrderUncancellation({
      marketplaceAccountId: ACCOUNT_ID,
      externalOrderId: EXT_ID,
      platformLabel: "ML",
      targetStatus: "PAID",
    });

    expect(res).toMatchObject({
      success: true,
      orderId: "o-1",
      action: "reactivated_rededucted",
      deductedItems: 1,
    });
    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: { id: "o-1", status: "CANCELLED" },
      data: { status: "PAID" },
    });
    // Net só dos estornos/reativações — nunca cria dedução "nova".
    expect(tx.stockLog.groupBy).toHaveBeenCalledWith({
      by: ["productId"],
      where: {
        productId: { in: ["p-1"] },
        reason: { in: ["Estorno venda ML #123", "Reativação venda ML #123"] },
      },
      _sum: { change: true },
    });
    expect(deduct).toHaveBeenCalledWith(tx, {
      items: [{ productId: "p-1", quantity: 2 }],
      reason: "Reativação venda ML #123",
      orderId: "o-1",
      logPrefix: "[OrderUseCase]",
    });
    expect(txSpy).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 60_000,
      maxWait: 20_000,
    });
    // Pós-commit: propaga estoque; SEM reopenOnRefill e SEM pauseOnZero.
    expect(fire).toHaveBeenCalledTimes(1);
    const fireArg = (fire.mock.calls[0] as any[])[0];
    expect(fireArg.reopenOnRefill).toBeUndefined();
    expect(fireArg.pauseOnZero).toBeUndefined();
  });

  it("fast-path: pedido não está CANCELLED → not_cancelled sem transação", async () => {
    vi.spyOn(prisma.order, "findFirst").mockResolvedValue(
      makeCancelledOrder({ status: "PAID" }) as any,
    );
    const txSpy = vi.spyOn(prisma, "$transaction");
    spyUncancelServices();

    const res = await OrderUseCase.processOrderUncancellation({
      marketplaceAccountId: ACCOUNT_ID,
      externalOrderId: EXT_ID,
      platformLabel: "ML",
      targetStatus: "PAID",
    });

    expect(res.action).toBe("not_cancelled");
    expect(txSpy).not.toHaveBeenCalled();
  });

  it("corrida: claim perde (outro processo reativou) → not_cancelled sem deduzir", async () => {
    vi.spyOn(prisma.order, "findFirst").mockResolvedValue(
      makeCancelledOrder() as any,
    );
    mockTx({ updateManyCounts: [0] });
    const { deduct, fire } = spyUncancelServices();

    const res = await OrderUseCase.processOrderUncancellation({
      marketplaceAccountId: ACCOUNT_ID,
      externalOrderId: EXT_ID,
      platformLabel: "ML",
      targetStatus: "PAID",
    });

    expect(res.action).toBe("not_cancelled");
    expect(deduct).not.toHaveBeenCalled();
    expect(fire).not.toHaveBeenCalled();
  });

  it("cancelamento nada estornou (net 0) → reativa sem deduzir (nunca cria dedução nova)", async () => {
    vi.spyOn(prisma.order, "findFirst").mockResolvedValue(
      makeCancelledOrder() as any,
    );
    mockTx({ updateManyCounts: [1], groupBy: [] });
    const { deduct, fire } = spyUncancelServices();

    const res = await OrderUseCase.processOrderUncancellation({
      marketplaceAccountId: ACCOUNT_ID,
      externalOrderId: EXT_ID,
      platformLabel: "ML",
      targetStatus: "PAID",
    });

    expect(res.action).toBe("reactivated_no_deduct");
    expect(deduct).not.toHaveBeenCalled();
    expect(fire).not.toHaveBeenCalled();
  });

  it("repetição (estorno +2 já re-deduzido -2 ⇒ Σ=0) → não deduz em dobro", async () => {
    vi.spyOn(prisma.order, "findFirst").mockResolvedValue(
      makeCancelledOrder() as any,
    );
    mockTx({
      updateManyCounts: [1],
      groupBy: [{ productId: "p-1", _sum: { change: 0 } }],
    });
    const { deduct } = spyUncancelServices();

    const res = await OrderUseCase.processOrderUncancellation({
      marketplaceAccountId: ACCOUNT_ID,
      externalOrderId: EXT_ID,
      platformLabel: "ML",
      targetStatus: "PAID",
    });

    expect(res.action).toBe("reactivated_no_deduct");
    expect(deduct).not.toHaveBeenCalled();
  });

  it("teto na quantidade do pedido: Σ=+4 com qty 2 → deduz no máximo 2", async () => {
    vi.spyOn(prisma.order, "findFirst").mockResolvedValue(
      makeCancelledOrder() as any,
    );
    mockTx({
      updateManyCounts: [1],
      groupBy: [{ productId: "p-1", _sum: { change: 4 } }],
    });
    const { deduct } = spyUncancelServices();

    await OrderUseCase.processOrderUncancellation({
      marketplaceAccountId: ACCOUNT_ID,
      externalOrderId: EXT_ID,
      platformLabel: "ML",
      targetStatus: "PAID",
    });

    expect(deduct).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        items: [{ productId: "p-1", quantity: 2 }],
      }),
    );
  });

  it("peça vendida em outro canal nesse meio-tempo → clamp do motor + alerta OVERSELL_DETECTED", async () => {
    vi.spyOn(prisma.order, "findFirst").mockResolvedValue(
      makeCancelledOrder() as any,
    );
    mockTx({
      updateManyCounts: [1],
      groupBy: [{ productId: "p-1", _sum: { change: 2 } }],
    });
    const { logWarning } = spyUncancelServices([
      { productId: "p-1", productName: "Peça", requested: 2, available: 1 },
    ]);

    const res = await OrderUseCase.processOrderUncancellation({
      marketplaceAccountId: ACCOUNT_ID,
      externalOrderId: EXT_ID,
      platformLabel: "ML",
      targetStatus: "PAID",
    });

    expect(res.success).toBe(true);
    expect(logWarning).toHaveBeenCalledWith(
      "OVERSELL_DETECTED",
      expect.stringContaining("reativar"),
      expect.objectContaining({ resourceId: "o-1" }),
    );
  });

  it("kill-switch → no-op total", async () => {
    process.env.ORDER_CANCEL_RESTORE_DISABLED = "1";
    const findFirst = vi.spyOn(prisma.order, "findFirst");
    const { deduct } = spyUncancelServices();

    const res = await OrderUseCase.processOrderUncancellation({
      marketplaceAccountId: ACCOUNT_ID,
      externalOrderId: EXT_ID,
      platformLabel: "ML",
      targetStatus: "PAID",
    });

    expect(res.action).toBe("disabled");
    expect(findFirst).not.toHaveBeenCalled();
    expect(deduct).not.toHaveBeenCalled();
  });

  it("erro na transação → { success:false, action:'error' } SEM lançar; rollback mantém CANCELLED", async () => {
    vi.spyOn(prisma.order, "findFirst").mockResolvedValue(
      makeCancelledOrder() as any,
    );
    vi.spyOn(prisma, "$transaction").mockRejectedValue(new Error("db down"));
    const { fire } = spyUncancelServices();

    const res = await OrderUseCase.processOrderUncancellation({
      marketplaceAccountId: ACCOUNT_ID,
      externalOrderId: EXT_ID,
      platformLabel: "ML",
      targetStatus: "PAID",
    });

    expect(res.success).toBe(false);
    expect(res.action).toBe("error");
    expect(fire).not.toHaveBeenCalled();
  });
});
