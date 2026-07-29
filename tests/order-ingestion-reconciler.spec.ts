import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ──────────────────────────────────────────────────────────────────────────────
// Commit 3 — a quarentena se resolve sozinha quando a causa some.
//
// Registrar o problema não basta: sem re-tentativa, a pendência viraria uma
// lista de coisas para alguém rodar script à mão. O reconciliador fecha o
// ciclo — o cliente vincula o anúncio ao produto e, na varredura seguinte, o
// pedido entra com baixa sem ninguém fazer nada.
//
// A pendência que não se resolve NUNCA vira estado terminal silencioso:
// continua OPEN (visível na tela do cliente) e escala o SystemLog.
// ──────────────────────────────────────────────────────────────────────────────

vi.mock("@/app/lib/prisma", () => ({
  default: {
    orderIngestionIssue: {
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      upsert: vi.fn(),
    },
    // O reconciliador consulta o Order REAL para decidir se a pendencia se
    // resolveu — nao dá para julgar pelo retorno do import, porque o ramo
    // `already_exists` devolve itemsLinked=0 por construcao.
    order: { findFirst: vi.fn() },
  },
}));

vi.mock("@/app/services/system-log.service", () => ({
  SystemLogService: {
    logInfo: vi.fn().mockResolvedValue(undefined),
    logWarning: vi.fn().mockResolvedValue(undefined),
    logError: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/app/marketplaces/usecases/order.usercase", () => ({
  OrderUseCase: {
    importRecentShopeeOrdersForAccount: vi.fn(),
    retryStockDeduction: vi.fn(),
    completePartialShopeeOrder: vi.fn(),
  },
}));

import prisma from "@/app/lib/prisma";
import { SystemLogService } from "@/app/services/system-log.service";
import { OrderUseCase } from "@/app/marketplaces/usecases/order.usercase";
import { OrderIngestionReconcilerService } from "@/app/marketplaces/services/order-ingestion-reconciler.service";
import { OrderIngestionIssueService } from "@/app/marketplaces/services/order-ingestion-issue.service";

const issue = (over: Record<string, any> = {}) => ({
  id: "iss-1",
  marketplaceAccountId: "acc-1",
  platform: "SHOPEE",
  externalOrderId: "SN-1",
  reason: "NO_LINKED_ITEMS",
  status: "OPEN",
  attempts: 0,
  resolvedOrderId: null,
  // `userId` faz parte do select do reconciliador e e obrigatorio para
  // completar um pedido parcial (a remontagem dos itens precisa do dono).
  marketplaceAccount: {
    id: "acc-1",
    platform: "SHOPEE",
    status: "ACTIVE",
    userId: "dono-1",
  },
  ...over,
});

const importResult = (entry: any) => ({
  totalOrders: 1,
  imported: 0,
  alreadyExists: 0,
  noProducts: 0,
  errors: 0,
  stockDeductions: 0,
  results: entry ? [entry] : [],
});

beforeEach(() => {
  vi.mocked((prisma as any).orderIngestionIssue.update).mockResolvedValue({});
  vi.mocked((prisma as any).orderIngestionIssue.updateMany).mockResolvedValue({
    count: 1,
  });
  // Default: nenhum Order local. Cada caso que precisa sobrescreve.
  vi.mocked((prisma as any).order.findFirst).mockResolvedValue(null);
  vi.mocked(OrderUseCase.completePartialShopeeOrder).mockResolvedValue(
    0 as any,
  );
  OrderIngestionReconcilerService.stop();
});

afterEach(() => {
  OrderIngestionReconcilerService.stop();
  vi.clearAllMocks();
});

describe("OrderIngestionReconcilerService", () => {
  it("re-tenta a pendência e resolve quando o pedido finalmente vincula", async () => {
    vi.mocked((prisma as any).orderIngestionIssue.findMany).mockResolvedValue([
      issue(),
    ]);
    vi.mocked(
      OrderUseCase.importRecentShopeeOrdersForAccount,
    ).mockResolvedValue(
      importResult({
        success: true,
        orderId: "order-1",
        externalOrderId: "SN-1",
        status: "imported",
        message: "ok",
        stockDeducted: true,
        itemsLinked: 1,
        itemsTotal: 1,
      }) as any,
    );

    await OrderIngestionReconcilerService.runOnce();

    // Reingestão pelo caminho canônico, dirigida pelo order_sn.
    expect(
      OrderUseCase.importRecentShopeeOrdersForAccount,
    ).toHaveBeenCalledWith("acc-1", 1, true, { orderSns: ["SN-1"] });
    expect(
      (prisma as any).orderIngestionIssue.updateMany,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "RESOLVED",
          resolvedOrderId: "order-1",
        }),
      }),
    );
  });

  it("PARCIAL que continua parcial nao resolve — e o veredito vem do BANCO, nao do import", async () => {
    // O pedido tem 2 itens no marketplace e so 1 vinculado localmente; o
    // produto que falta continua sem vinculo, entao nada e acrescentado.
    vi.mocked((prisma as any).orderIngestionIssue.findMany).mockResolvedValue([
      issue({
        reason: "PARTIAL_LINK",
        attempts: 1,
        resolvedOrderId: "order-1",
        payload: { item_list: [{ item_id: 1 }, { item_id: 2 }] },
      }),
    ]);
    vi.mocked((prisma as any).order.findFirst).mockResolvedValue({
      id: "order-1",
      status: "SHIPPED",
      items: [{ id: "oi-1" }],
    });
    vi.mocked(OrderUseCase.completePartialShopeeOrder).mockResolvedValue(
      0 as any,
    );
    vi.mocked(OrderUseCase.retryStockDeduction).mockResolvedValue(true as any);
    vi.mocked(
      OrderUseCase.importRecentShopeeOrdersForAccount,
    ).mockResolvedValue(
      importResult({
        success: true,
        orderId: "order-1",
        externalOrderId: "SN-1",
        status: "already_exists",
        // O ramo already_exists SEMPRE devolve 0 aqui. Julgar por este numero
        // faria a pendencia nunca fechar, nem depois de resolvida.
        itemsLinked: 0,
        itemsTotal: 2,
        message: "ok",
        stockDeducted: false,
      }) as any,
    );

    await OrderIngestionReconcilerService.runOnce();

    const update = vi.mocked((prisma as any).orderIngestionIssue.update).mock
      .calls[0][0];
    expect(update.data.status).toBe("OPEN");
    expect(update.data.attempts).toBe(2);
    expect(update.data.detail).toContain("1/2");
    expect(
      (prisma as any).orderIngestionIssue.updateMany,
    ).not.toHaveBeenCalled();
  });

  it("PARCIAL RESOLVE quando o cliente vincula o produto que faltava", async () => {
    vi.mocked((prisma as any).orderIngestionIssue.findMany).mockResolvedValue([
      issue({
        reason: "PARTIAL_LINK",
        attempts: 2,
        resolvedOrderId: "order-1",
        payload: { item_list: [{ item_id: 1 }, { item_id: 2 }] },
      }),
    ]);
    vi.mocked((prisma as any).order.findFirst).mockResolvedValue({
      id: "order-1",
      status: "SHIPPED",
      items: [{ id: "oi-1" }],
    });
    // Agora o item que faltava vincula e e acrescentado ao Order existente.
    vi.mocked(OrderUseCase.completePartialShopeeOrder).mockResolvedValue(
      1 as any,
    );
    vi.mocked(OrderUseCase.retryStockDeduction).mockResolvedValue(true as any);
    vi.mocked(
      OrderUseCase.importRecentShopeeOrdersForAccount,
    ).mockResolvedValue(
      importResult({
        success: true,
        orderId: "order-1",
        externalOrderId: "SN-1",
        status: "already_exists",
        itemsLinked: 0,
        itemsTotal: 2,
        message: "ok",
        stockDeducted: false,
      }) as any,
    );

    await OrderIngestionReconcilerService.runOnce();

    expect(OrderUseCase.completePartialShopeeOrder).toHaveBeenCalled();
    expect(
      (prisma as any).orderIngestionIssue.updateMany,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "RESOLVED" }),
      }),
    );
  });

  it("respeita o backoff: nextRetryAt cresce com o número de tentativas", async () => {
    vi.mocked((prisma as any).orderIngestionIssue.findMany).mockResolvedValue([
      issue({ attempts: 0 }),
    ]);
    vi.mocked(
      OrderUseCase.importRecentShopeeOrdersForAccount,
    ).mockResolvedValue(importResult(null) as any);

    const antes = Date.now();
    await OrderIngestionReconcilerService.runOnce();
    const primeiro = vi.mocked((prisma as any).orderIngestionIssue.update).mock
      .calls[0][0].data.nextRetryAt as Date;

    vi.mocked((prisma as any).orderIngestionIssue.update).mockClear();
    vi.mocked((prisma as any).orderIngestionIssue.findMany).mockResolvedValue([
      issue({ attempts: 3 }),
    ]);
    await OrderIngestionReconcilerService.runOnce();
    const depois = vi.mocked((prisma as any).orderIngestionIssue.update).mock
      .calls[0][0].data.nextRetryAt as Date;

    expect(primeiro.getTime()).toBeGreaterThan(antes);
    expect(depois.getTime()).toBeGreaterThan(primeiro.getTime());
  });

  it("STOCK_DEDUCTION_FAILED re-tenta SÓ a baixa, sem reimportar o pedido", async () => {
    vi.mocked((prisma as any).orderIngestionIssue.findMany).mockResolvedValue([
      issue({
        reason: "STOCK_DEDUCTION_FAILED",
        resolvedOrderId: "order-1",
      }),
    ]);
    vi.mocked(OrderUseCase.retryStockDeduction).mockResolvedValue(true as any);

    await OrderIngestionReconcilerService.runOnce();

    expect(OrderUseCase.retryStockDeduction).toHaveBeenCalledWith(
      "order-1",
      "SHOPEE",
      "SN-1",
    );
    expect(
      OrderUseCase.importRecentShopeeOrdersForAccount,
    ).not.toHaveBeenCalled();
    expect(
      (prisma as any).orderIngestionIssue.updateMany,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "RESOLVED" }),
      }),
    );
  });

  it("conta não ACTIVE não bate na API e mantém a pendência aberta", async () => {
    vi.mocked((prisma as any).orderIngestionIssue.findMany).mockResolvedValue([
      issue({
        marketplaceAccount: { id: "acc-1", platform: "SHOPEE", status: "ERROR" },
      }),
    ]);

    await OrderIngestionReconcilerService.runOnce();

    expect(
      OrderUseCase.importRecentShopeeOrdersForAccount,
    ).not.toHaveBeenCalled();
    const update = vi.mocked((prisma as any).orderIngestionIssue.update).mock
      .calls[0][0];
    expect(update.data.status).toBe("OPEN");
  });

  it("uma pendência que explode não impede as outras de serem tentadas", async () => {
    vi.mocked((prisma as any).orderIngestionIssue.findMany).mockResolvedValue([
      issue({ id: "iss-1", externalOrderId: "SN-1" }),
      issue({ id: "iss-2", externalOrderId: "SN-2" }),
    ]);
    vi.mocked(OrderUseCase.importRecentShopeeOrdersForAccount)
      .mockRejectedValueOnce(new Error("Shopee fora do ar"))
      .mockResolvedValueOnce(
        importResult({
          success: true,
          orderId: "order-2",
          externalOrderId: "SN-2",
          status: "imported",
          message: "ok",
          stockDeducted: true,
          itemsLinked: 1,
          itemsTotal: 1,
        }) as any,
      );

    await OrderIngestionReconcilerService.runOnce();

    expect(
      OrderUseCase.importRecentShopeeOrdersForAccount,
    ).toHaveBeenCalledTimes(2);
  });

  it("após N tentativas escala o SystemLog mas NÃO fecha a pendência", async () => {
    vi.mocked((prisma as any).orderIngestionIssue.findMany).mockResolvedValue([
      issue({ attempts: 4 }),
    ]);
    vi.mocked(
      OrderUseCase.importRecentShopeeOrdersForAccount,
    ).mockResolvedValue(importResult(null) as any);

    await OrderIngestionReconcilerService.runOnce();

    expect(SystemLogService.logError).toHaveBeenCalledWith(
      "ORDER_INGESTION_ISSUE_STUCK",
      expect.stringContaining("SN-1"),
      expect.anything(),
    );
    // Nunca vira FAILED terminal: continua OPEN e visível.
    const update = vi.mocked((prisma as any).orderIngestionIssue.update).mock
      .calls[0][0];
    expect(update.data.status).toBe("OPEN");
  });

  it("kill-switch ORDER_INGESTION_RECONCILER_DISABLED=1 não faz nada", async () => {
    process.env.ORDER_INGESTION_RECONCILER_DISABLED = "1";
    try {
      await OrderIngestionReconcilerService.runOnce();
      expect(
        (prisma as any).orderIngestionIssue.findMany,
      ).not.toHaveBeenCalled();
    } finally {
      delete process.env.ORDER_INGESTION_RECONCILER_DISABLED;
    }
  });
});

describe("OrderIngestionIssueService.prunePayload", () => {
  it("guarda só o que a reingestão precisa e nenhum dado a mais do comprador", () => {
    const podado = OrderIngestionIssueService.prunePayload({
      order_sn: "SN-1",
      order_status: "SHIPPED",
      buyer_username: "cliente",
      recipient_address: { name: "Fulano", full_address: "Rua X, 123" },
      access_token: "NAO_PODE_VAZAR",
      item_list: [
        { item_id: 1, item_sku: "A", model_quantity_purchased: 1, extra: "x" },
      ],
    });

    expect(podado.order_sn).toBe("SN-1");
    expect(podado.item_list[0].item_sku).toBe("A");
    // Nem token, nem endereço do comprador.
    expect(JSON.stringify(podado)).not.toContain("NAO_PODE_VAZAR");
    expect(JSON.stringify(podado)).not.toContain("Rua X");
  });
});
