import { describe, it, expect, vi, afterEach } from "vitest";

// ──────────────────────────────────────────────────────────
// Wiring de cancelamento no importador Magalu (ramo already_exists).
//
// Prova:
//  - Pedido JÁ importado que aparece cancelado no poll → handler idempotente
//    chamado (platformLabel "Magalu") + log MAGALU_CANCEL_DETECTED.
//  - ZERO REGRESSÃO: contadores e results do import permanecem idênticos;
//    pedido novo cancelado continua sendo pulado sem criar Order (filtro
//    pós-already_exists intacto).
//  - Kill-switch desliga a checagem.
// ──────────────────────────────────────────────────────────

import { OrderUseCase } from "@/app/marketplaces/usecases/order.usercase";
import { orderRepository } from "@/app/repositories/order.repository";
import prisma from "@/app/lib/prisma";
import { MarketplaceRepository } from "@/app/marketplaces/repositories/marketplace.repository";
import { SystemLogService } from "@/app/services/system-log.service";

const ACCOUNT = {
  id: "acc-mg",
  userId: "u-1",
  accessToken: "tok",
  refreshToken: "ref",
  externalUserId: "tenant-1",
};

function setup({
  magaluOrders = [] as any[],
  existing = [] as { externalOrderId: string }[],
}) {
  vi.spyOn(MarketplaceRepository, "findById").mockResolvedValue(
    ACCOUNT as any,
  );
  vi.spyOn(
    OrderUseCase as any,
    "getRecentMagaluOrdersWithRefresh",
  ).mockResolvedValue(magaluOrders);
  vi.spyOn(prisma.order, "findMany").mockResolvedValue(existing as any);
  vi.spyOn(prisma.productListing, "findMany").mockResolvedValue([] as any);
  const createSpy = vi.spyOn(orderRepository, "create");
  const cancelSpy = vi
    .spyOn(OrderUseCase, "processOrderCancellation")
    .mockResolvedValue({
      success: true,
      orderId: "o-1",
      externalOrderId: "MG-1",
      action: "cancelled_restored",
      restoredItems: 1,
    });
  const logInfo = vi
    .spyOn(SystemLogService, "logInfo")
    .mockResolvedValue(undefined as any);
  return { createSpy, cancelSpy, logInfo };
}

describe("OrderUseCase.importRecentMagaluOrdersForAccount — cancelamento", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ORDER_CANCEL_RESTORE_DISABLED;
  });

  it("pedido já importado + cancelado no poll → handler chamado, contadores/results idênticos", async () => {
    const { cancelSpy, logInfo } = setup({
      magaluOrders: [{ id: "MG-1", status: "cancelled", items: [] }],
      existing: [{ externalOrderId: "MG-1", status: "PAID" } as any],
    });

    const result = await OrderUseCase.importRecentMagaluOrdersForAccount(
      "acc-mg",
      2,
      true,
    );

    // Comportamento existente byte-idêntico.
    expect(result).toMatchObject({
      totalOrders: 1,
      imported: 0,
      alreadyExists: 1,
      errors: 0,
    });
    expect(result.results[0]).toEqual({
      success: true,
      orderId: null,
      externalOrderId: "MG-1",
      status: "already_exists",
      message: "Pedido já importado anteriormente",
      stockDeducted: false,
      itemsLinked: 0,
      itemsTotal: 0,
    });
    // Checagem nova.
    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(cancelSpy).toHaveBeenCalledWith({
      marketplaceAccountId: "acc-mg",
      externalOrderId: "MG-1",
      platformLabel: "Magalu",
    });
    // Log só na transição real (handler retornou cancelled_restored).
    expect(logInfo).toHaveBeenCalledWith(
      "MAGALU_CANCEL_DETECTED",
      expect.stringContaining("MG-1"),
      expect.objectContaining({
        details: expect.objectContaining({ rawStatus: "cancelled" }),
      }),
    );
  });

  it("pedido já CANCELLED local (poll repetido) → EGRESS: handler nem é chamado (snapshot pula)", async () => {
    const { cancelSpy, logInfo } = setup({
      magaluOrders: [{ id: "MG-1", status: "cancelled", items: [] }],
      existing: [{ externalOrderId: "MG-1", status: "CANCELLED" } as any],
    });

    const result = await OrderUseCase.importRecentMagaluOrdersForAccount(
      "acc-mg",
      2,
      true,
    );

    // Custo recorrente zero em regime: nenhuma query extra por ciclo.
    expect(result.alreadyExists).toBe(1);
    expect(cancelSpy).not.toHaveBeenCalled();
    expect(logInfo).not.toHaveBeenCalled();
  });

  it("snapshot stale (status local não-cancelado) → handler idempotente roda e decide", async () => {
    const { cancelSpy, logInfo } = setup({
      magaluOrders: [{ id: "MG-1", status: "cancelled", items: [] }],
      existing: [{ externalOrderId: "MG-1", status: "PAID" } as any],
    });
    // Corrida: outro processo cancelou entre o snapshot e o handler —
    // o fast-path do handler segura a idempotência.
    cancelSpy.mockResolvedValue({
      success: true,
      orderId: "o-1",
      externalOrderId: "MG-1",
      action: "already_cancelled",
      restoredItems: 0,
    });

    await OrderUseCase.importRecentMagaluOrdersForAccount("acc-mg", 2, true);

    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(logInfo).not.toHaveBeenCalled();
  });

  it("'unavailable' (cancelado por INDISPONIBILIDADE — peça não existe) → NÃO estorna", async () => {
    const { cancelSpy, logInfo } = setup({
      magaluOrders: [{ id: "MG-1", status: "unavailable", items: [] }],
      existing: [{ externalOrderId: "MG-1", status: "PAID" } as any],
    });

    const result = await OrderUseCase.importRecentMagaluOrdersForAccount(
      "acc-mg",
      2,
      true,
    );

    // Estornar aqui criaria estoque fantasma (oversell cross-channel).
    expect(result.alreadyExists).toBe(1);
    expect(cancelSpy).not.toHaveBeenCalled();
    expect(logInfo).not.toHaveBeenCalled();
  });

  it("pedido já importado NÃO-cancelado (approved) → handler não é chamado", async () => {
    const { cancelSpy, logInfo } = setup({
      magaluOrders: [{ id: "MG-1", status: "approved", items: [] }],
      existing: [{ externalOrderId: "MG-1", status: "PAID" } as any],
    });

    const result = await OrderUseCase.importRecentMagaluOrdersForAccount(
      "acc-mg",
      2,
      true,
    );

    expect(result.alreadyExists).toBe(1);
    expect(cancelSpy).not.toHaveBeenCalled();
    expect(logInfo).not.toHaveBeenCalled();
  });

  it("pedido NOVO já cancelado → continua pulado sem criar Order (filtro intacto) e sem handler", async () => {
    const { createSpy, cancelSpy } = setup({
      magaluOrders: [{ id: "MG-2", status: "cancelled", items: [] }],
      existing: [],
    });

    const result = await OrderUseCase.importRecentMagaluOrdersForAccount(
      "acc-mg",
      2,
      true,
    );

    expect(result).toMatchObject({
      totalOrders: 1,
      imported: 0,
      alreadyExists: 0,
      errors: 0,
    });
    expect(createSpy).not.toHaveBeenCalled();
    expect(cancelSpy).not.toHaveBeenCalled();
  });

  it("kill-switch → pedido cancelado já importado não dispara handler nem log", async () => {
    process.env.ORDER_CANCEL_RESTORE_DISABLED = "1";
    const { cancelSpy, logInfo } = setup({
      magaluOrders: [{ id: "MG-1", status: "cancelled", items: [] }],
      existing: [{ externalOrderId: "MG-1", status: "PAID" } as any],
    });

    const result = await OrderUseCase.importRecentMagaluOrdersForAccount(
      "acc-mg",
      2,
      true,
    );

    expect(result.alreadyExists).toBe(1);
    expect(cancelSpy).not.toHaveBeenCalled();
    expect(logInfo).not.toHaveBeenCalled();
  });
});
