import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ──────────────────────────────────────────────────────────────────────────
// A FIAÇÃO do webhook ML — o único produtor de `desfecho` em produção.
//
// Por que este arquivo existe: `tests/webhook-cancellation.spec.ts` afirma que
// o handler é chamado com um objeto de EXATAMENTE 4 chaves. Ele passa porque a
// suíte liga `ORDER_RETURN_HOLD_DISABLED` em vitest.config — ou seja, aquele
// spec cobre o ramo que NÃO roda em produção. O classificador tem spec próprio
// e o consumidor também; o fio entre os dois não tinha nenhum.
//
// Aqui o kill-switch é DESLIGADO, que é o estado de produção.
// ──────────────────────────────────────────────────────────────────────────

import prisma from "@/app/lib/prisma";
import { WebhookUseCase } from "@/app/marketplaces/usecases/webhook.usercase";
import { MarketplaceRepository } from "@/app/marketplaces/repositories/marketplace.repository";
import { MLApiService } from "@/app/marketplaces/services/ml-api.service";
import { OrderUseCase } from "@/app/marketplaces/usecases/order.usercase";
import { OrderReturnPendencyService } from "@/app/marketplaces/services/order-return-pendency.service";

const emptyImport = {
  totalOrders: 0,
  imported: 0,
  alreadyExists: 1,
  noProducts: 0,
  errors: 0,
  stockDeductions: 0,
  results: [],
};

const mlPayload = (over: Record<string, any> = {}) => ({
  resource: "/orders/123456",
  user_id: 555,
  topic: "orders_v2",
  application_id: 1,
  attempts: 1,
  sent: "2026-09-01T10:00:00Z",
  received: "2026-09-01T10:00:01Z",
  ...over,
});

const account = (over: Record<string, any> = {}) => ({
  id: "acc-1",
  userId: "u-1",
  status: "ACTIVE",
  accessToken: "tok",
  refreshToken: "ref",
  expiresAt: new Date(Date.now() + 3_600_000),
  ...over,
});

/** Pedido devolvido depois de entregue — o caso dos 49 de mediação. */
const PEDIDO_DEVOLVIDO = {
  status: "cancelled",
  tags: ["delivered", "not_paid"],
  cancel_detail: { group: "mediations", code: "mediations" },
  shipping: { id: 4783 },
};

/** Cancelamento antes do envio — o caso dos 16 `buyer_cancel_express`. */
const PEDIDO_CANCELADO_ANTES = {
  status: "cancelled",
  tags: ["not_delivered", "not_paid"],
  cancel_detail: { group: "buyer", code: "buyer_cancel_express" },
  shipping: { id: 4784 },
};

function setup({ mlOrder = PEDIDO_DEVOLVIDO as any, shipment = null as any } = {}) {
  vi.spyOn(prisma.webhookEventLog as any, "create").mockResolvedValue({});
  vi.spyOn(MarketplaceRepository, "findAllByExternalUserId").mockResolvedValue([
    account(),
  ] as any);
  vi.spyOn(prisma.marketplaceAccount, "findUnique").mockResolvedValue(
    account({ accessToken: "tok-fresh" }) as any,
  );
  vi.spyOn(OrderUseCase, "importRecentOrdersForAccount").mockResolvedValue(
    emptyImport as any,
  );
  vi.spyOn(prisma.order, "findFirst").mockResolvedValue({
    id: "o-1",
    status: "PAID",
  } as any);
  const getOrder = vi
    .spyOn(MLApiService, "getOrderDetails")
    .mockResolvedValue(mlOrder);
  const getShipment = vi
    .spyOn(MLApiService, "getShipmentDetails")
    .mockResolvedValue(shipment);
  const cancelSpy = vi
    .spyOn(OrderUseCase, "processOrderCancellation")
    .mockResolvedValue({
      success: true,
      orderId: "o-1",
      externalOrderId: "123456",
      action: "cancelled_return_pending",
      restoredItems: 0,
    });
  const abrirPendencia = vi
    .spyOn(OrderReturnPendencyService, "open")
    .mockResolvedValue(undefined);
  return { getOrder, getShipment, cancelSpy, abrirPendencia };
}

beforeEach(() => {
  // Estado de PRODUÇÃO: a retenção está ligada.
  delete process.env.ORDER_RETURN_HOLD_DISABLED;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env.ORDER_RETURN_HOLD_DISABLED = "1";
});

describe("webhook ML → classificador → handler", () => {
  it("⭐ devolução: busca o envio e passa o desfecho que RETÉM o estorno", async () => {
    const { getShipment, cancelSpy } = setup({
      shipment: {
        status: "delivered",
        status_history: { date_delivered: "2026-08-18T14:03:00.000-04:00" },
      },
    });

    await WebhookUseCase.processOrderWebhook(mlPayload() as any);

    // O envio é buscado com o token FRESCO e o id que veio do pedido.
    expect(getShipment).toHaveBeenCalledWith("tok-fresh", 4783);

    const arg = cancelSpy.mock.calls[0][0];
    expect(arg.platformLabel).toBe("ML");
    expect(arg.desfecho).toBeDefined();
    expect(arg.desfecho!.peca).toBe("COM_COMPRADOR");
    expect(arg.desfecho!.reterEstorno).toBe(true);
  });

  it("⭐ cancelamento antes do envio: passa o desfecho que MANTÉM o estorno", async () => {
    const { cancelSpy } = setup({
      mlOrder: PEDIDO_CANCELADO_ANTES,
      shipment: { status: "cancelled", status_history: {} },
    });

    await WebhookUseCase.processOrderWebhook(mlPayload() as any);

    const arg = cancelSpy.mock.calls[0][0];
    expect(arg.desfecho!.peca).toBe("NO_PATIO");
    expect(arg.desfecho!.reterEstorno).toBe(false);
  });

  it("API do envio fora do ar → INDETERMINADO, e o estorno acontece como hoje", async () => {
    // `getShipmentDetails` nunca lança: devolve null. Indisponibilidade não
    // pode fazer peça sumir do estoque.
    const { cancelSpy } = setup({
      mlOrder: {
        status: "cancelled",
        tags: [],
        cancel_detail: { group: "seller", code: "seller_out_of_stock" },
        shipping: { id: 1 },
      },
      shipment: null,
    });

    await WebhookUseCase.processOrderWebhook(mlPayload() as any);

    expect(cancelSpy.mock.calls[0][0].desfecho!.peca).toBe("INDETERMINADO");
    expect(cancelSpy.mock.calls[0][0].desfecho!.reterEstorno).toBe(false);
  });

  it("pedido sem envio não quebra: classifica sem buscar shipment", async () => {
    const { getShipment, cancelSpy } = setup({
      mlOrder: { ...PEDIDO_DEVOLVIDO, shipping: { id: null } },
    });

    await WebhookUseCase.processOrderWebhook(mlPayload() as any);

    expect(getShipment).not.toHaveBeenCalled();
    // A tag `delivered` sozinha já basta para saber que a peça saiu.
    expect(cancelSpy.mock.calls[0][0].desfecho!.peca).toBe("COM_COMPRADOR");
  });

  it("kill-switch: volta a chamar o handler com as 4 chaves de sempre", async () => {
    process.env.ORDER_RETURN_HOLD_DISABLED = "1";
    const { getShipment, cancelSpy } = setup();

    await WebhookUseCase.processOrderWebhook(mlPayload() as any);

    expect(getShipment).not.toHaveBeenCalled();
    expect(cancelSpy).toHaveBeenCalledWith({
      marketplaceAccountId: "acc-1",
      externalOrderId: "123456",
      platformLabel: "ML",
      logPrefix: "[WebhookUseCase]",
    });
  });

  it("falha na busca do envio é best-effort: o webhook responde igual", async () => {
    const { cancelSpy } = setup();
    vi.spyOn(MLApiService, "getShipmentDetails").mockRejectedValue(
      new Error("ML 503"),
    );

    const res = await WebhookUseCase.processOrderWebhook(mlPayload() as any);

    // O bloco inteiro é best-effort: nada explode e o retorno é o de sempre.
    expect(res.success).toBe(true);
    expect(cancelSpy).not.toHaveBeenCalled();
  });
});

describe("§5.7 — reembolso parcial abre pendência sem tocar em estoque", () => {
  it("partially_refunded: nenhuma chamada ao handler de cancelamento", async () => {
    const { cancelSpy, abrirPendencia } = setup({
      mlOrder: { status: "partially_refunded", tags: ["paid"], shipping: {} },
    });

    await WebhookUseCase.processOrderWebhook(mlPayload() as any);

    expect(cancelSpy).not.toHaveBeenCalled();
    expect(abrirPendencia).toHaveBeenCalledWith(
      expect.objectContaining({
        marketplaceAccountId: "acc-1",
        platform: "MERCADO_LIVRE",
        externalOrderId: "123456",
        reason: "ML_PARTIALLY_REFUNDED",
      }),
    );
  });

  it("kill-switch: reembolso parcial volta a ser ignorado", async () => {
    process.env.ORDER_RETURN_HOLD_DISABLED = "1";
    const { abrirPendencia } = setup({
      mlOrder: { status: "partially_refunded", tags: ["paid"], shipping: {} },
    });

    await WebhookUseCase.processOrderWebhook(mlPayload() as any);
    expect(abrirPendencia).not.toHaveBeenCalled();
  });
});

describe("mapMLStatusToLocal — partially_refunded não rebaixa para PENDING", () => {
  const map = (status: string) =>
    (OrderUseCase as any).mapMLStatusToLocal(status);

  it("partially_refunded vira PAID (venda concretizada com reembolso parcial)", () => {
    expect(map("partially_refunded")).toBe("PAID");
  });

  it("kill-switch restaura o PENDING de antes", () => {
    process.env.ORDER_RETURN_HOLD_DISABLED = "1";
    expect(map("partially_refunded")).toBe("PENDING");
  });

  it("nenhum outro status muda", () => {
    expect(map("paid")).toBe("PAID");
    expect(map("cancelled")).toBe("CANCELLED");
    expect(map("shipped")).toBe("SHIPPED");
    expect(map("delivered")).toBe("DELIVERED");
    expect(map("payment_required")).toBe("PENDING");
    expect(map("pending_cancel")).toBe("PENDING");
    expect(map("qualquer_coisa_nova")).toBe("PENDING");
  });
});
