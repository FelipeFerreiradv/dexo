import { describe, it, expect, vi, beforeEach } from "vitest";

// ──────────────────────────────────────────────────────────────────────────
// Reconciliador da pendência de devolução (contrato §5.5, §5.6 e §5.7).
//
// O que ele faz: reconsulta o ML para ver se o desfecho MUDOU. Se o
// marketplace desfez a devolução e manteve a venda (o dinheiro ficou com o
// vendedor), o pedido volta a ser venda concretizada — e se o estoque já tinha
// voltado por um cancelamento anterior, ele é re-baixado pelo net do StockLog,
// nunca duas vezes.
//
// ⭐ O QUE ELE NÃO FAZ, e é o ponto: NUNCA repõe estoque. Nem quando o próprio
// ML diz que a peça voltou. Isso é sempre decisão de gente (§5.3).
// ──────────────────────────────────────────────────────────────────────────

var __prisma: any;
function makePrisma() {
  if (!__prisma) {
    __prisma = {
      orderReturnPendency: {
        findMany: vi.fn(),
        update: vi.fn(),
      },
      order: { findFirst: vi.fn() },
      marketplaceAccount: { findUnique: vi.fn() },
    };
  }
  return __prisma;
}

vi.mock("../app/lib/prisma", () => ({ default: makePrisma() }));
vi.mock("@/app/lib/prisma", () => ({ default: makePrisma() }));

import { OrderReturnPendencyReconcilerService } from "@/app/marketplaces/services/order-return-pendency-reconciler.service";
import { OrderReturnPendencyService } from "@/app/marketplaces/services/order-return-pendency.service";
import { MLApiService } from "@/app/marketplaces/services/ml-api.service";
import { OrderUseCase } from "@/app/marketplaces/usecases/order.usercase";
import { SystemLogService } from "@/app/services/system-log.service";
import prismaReal from "@/app/lib/prisma";

const prismaMock = prismaReal as any;

const CONTA = {
  id: "acc-1",
  platform: "MERCADO_LIVRE",
  status: "ACTIVE",
  userId: "u-1",
};

function pendencia(over: Partial<any> = {}) {
  return {
    id: "pend-1",
    externalOrderId: "999",
    reason: "PECA_COM_COMPRADOR",
    attempts: 0,
    marketplaceAccount: CONTA,
    ...over,
  };
}

const PEDIDO_AINDA_DEVOLVIDO = {
  id: 999,
  status: "cancelled",
  tags: ["delivered", "not_paid"],
  cancel_detail: { group: "mediations", code: "mediations" },
  shipping: { id: 42 },
};

const ENVIO_ENTREGUE = {
  status: "delivered",
  status_history: { date_delivered: "2026-08-18T14:03:00.000-04:00" },
};

let resolveSpy: any;
let openSpy: any;
let uncancelSpy: any;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.ORDER_RETURN_RECONCILER_DISABLED;
  (OrderReturnPendencyReconcilerService as any).runInProgress = false;

  prismaMock.marketplaceAccount.findUnique.mockResolvedValue({
    id: "acc-1",
    accessToken: "tok",
    refreshToken: "ref",
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  prismaMock.orderReturnPendency.update.mockResolvedValue({});

  resolveSpy = vi
    .spyOn(OrderReturnPendencyService, "resolve")
    .mockResolvedValue(true);
  openSpy = vi
    .spyOn(OrderReturnPendencyService, "open")
    .mockResolvedValue(undefined);
  uncancelSpy = vi
    .spyOn(OrderUseCase, "processOrderUncancellation")
    .mockResolvedValue({
      success: true,
      orderId: "o-1",
      externalOrderId: "999",
      action: "reactivated_rededucted",
      deductedItems: 1,
    });
  vi.spyOn(SystemLogService, "logInfo").mockResolvedValue(undefined as any);
});

describe("§5.5/§5.6 — o ML desfaz a devolução e mantém a venda", () => {
  it("pedido voltou a 'paid' e o local está CANCELLED → re-baixa e fecha", async () => {
    prismaMock.orderReturnPendency.findMany.mockResolvedValue([pendencia()]);
    vi.spyOn(MLApiService, "getOrderDetails").mockResolvedValue({
      status: "paid",
    } as any);
    prismaMock.order.findFirst.mockResolvedValue({
      id: "o-1",
      status: "CANCELLED",
    });

    const r = await OrderReturnPendencyReconcilerService.runOnce();

    expect(uncancelSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        marketplaceAccountId: "acc-1",
        externalOrderId: "999",
        platformLabel: "ML",
        targetStatus: "PAID",
      }),
    );
    expect(resolveSpy).toHaveBeenCalledWith(
      "acc-1",
      "999",
      "VENDA_MANTIDA",
      null,
    );
    expect(r.fechadas).toBe(1);
    expect(SystemLogService.logInfo).toHaveBeenCalledWith(
      "ORDER_RETURN_SALE_REINSTATED",
      expect.any(String),
      expect.anything(),
    );
  });

  it("pedido voltou a 'paid' e o local JÁ está PAID → só fecha, não re-baixa", async () => {
    // É o caso real do pedido 2000017646326142: o sistema nunca viu o
    // cancelamento, o estoque nunca voltou, e o desfecho já estava certo.
    prismaMock.orderReturnPendency.findMany.mockResolvedValue([pendencia()]);
    vi.spyOn(MLApiService, "getOrderDetails").mockResolvedValue({
      status: "paid",
    } as any);
    prismaMock.order.findFirst.mockResolvedValue({ id: "o-1", status: "PAID" });

    await OrderReturnPendencyReconcilerService.runOnce();

    expect(uncancelSpy).not.toHaveBeenCalled();
    expect(resolveSpy).toHaveBeenCalledWith(
      "acc-1",
      "999",
      "VENDA_MANTIDA",
      null,
    );
  });

  it("§5.7 reembolso parcial também é venda concretizada — fecha sem tocar estoque", async () => {
    prismaMock.orderReturnPendency.findMany.mockResolvedValue([
      pendencia({ reason: "ML_PARTIALLY_REFUNDED" }),
    ]);
    vi.spyOn(MLApiService, "getOrderDetails").mockResolvedValue({
      status: "partially_refunded",
    } as any);
    prismaMock.order.findFirst.mockResolvedValue({ id: "o-1", status: "PAID" });

    await OrderReturnPendencyReconcilerService.runOnce();

    expect(uncancelSpy).not.toHaveBeenCalled();
    expect(resolveSpy).toHaveBeenCalledWith(
      "acc-1",
      "999",
      "VENDA_MANTIDA",
      null,
    );
  });
});

describe("⭐ o reconciliador NUNCA repõe estoque", () => {
  it("o ML passa a dizer que a peça voltou: atualiza o texto, não o estoque", async () => {
    prismaMock.orderReturnPendency.findMany.mockResolvedValue([pendencia()]);
    vi.spyOn(MLApiService, "getOrderDetails").mockResolvedValue(
      PEDIDO_AINDA_DEVOLVIDO as any,
    );
    vi.spyOn(MLApiService, "getShipmentDetails").mockResolvedValue({
      status: "not_delivered",
      substatus: "returned",
      status_history: { date_returned: "2026-09-01T10:00:00.000-04:00" },
    } as any);

    const r = await OrderReturnPendencyReconcilerService.runOnce();

    // Reclassificou e reescreveu a pendência com o motivo novo...
    expect(openSpy).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "DEVOLVIDA_CONFIRMADA_ML" }),
    );
    // ...mas NÃO fechou nem repôs nada. Quem decide é gente.
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(r.fechadas).toBe(0);
  });

  it("desfecho igual ao que já estava: não reescreve a pendência", async () => {
    prismaMock.orderReturnPendency.findMany.mockResolvedValue([pendencia()]);
    vi.spyOn(MLApiService, "getOrderDetails").mockResolvedValue(
      PEDIDO_AINDA_DEVOLVIDO as any,
    );
    vi.spyOn(MLApiService, "getShipmentDetails").mockResolvedValue(
      ENVIO_ENTREGUE as any,
    );

    await OrderReturnPendencyReconcilerService.runOnce();
    expect(openSpy).not.toHaveBeenCalled();
  });
});

describe("backoff e escalada", () => {
  it("passada sem novidade avança attempts e adia a próxima", async () => {
    prismaMock.orderReturnPendency.findMany.mockResolvedValue([
      pendencia({ attempts: 2 }),
    ]);
    vi.spyOn(MLApiService, "getOrderDetails").mockResolvedValue(
      PEDIDO_AINDA_DEVOLVIDO as any,
    );
    vi.spyOn(MLApiService, "getShipmentDetails").mockResolvedValue(
      ENVIO_ENTREGUE as any,
    );

    await OrderReturnPendencyReconcilerService.runOnce();

    const arg = prismaMock.orderReturnPendency.update.mock.calls[0][0];
    expect(arg.where).toEqual({ id: "pend-1" });
    expect(arg.data.attempts).toBe(3);
    expect(arg.data.nextRetryAt).toBeInstanceOf(Date);
    // Ainda dentro do teto: continua na fila automática.
    expect(arg.data.status).toBeUndefined();
  });

  it("esgotou as tentativas → NEEDS_ACTION (sai da fila, NÃO da tela)", async () => {
    prismaMock.orderReturnPendency.findMany.mockResolvedValue([
      pendencia({ attempts: 7 }),
    ]);
    vi.spyOn(MLApiService, "getOrderDetails").mockResolvedValue(
      PEDIDO_AINDA_DEVOLVIDO as any,
    );
    vi.spyOn(MLApiService, "getShipmentDetails").mockResolvedValue(
      ENVIO_ENTREGUE as any,
    );

    await OrderReturnPendencyReconcilerService.runOnce();

    const arg = prismaMock.orderReturnPendency.update.mock.calls[0][0];
    expect(arg.data.status).toBe("NEEDS_ACTION");
  });

  it("erro na API não derruba o ciclo: conta a tentativa e segue", async () => {
    prismaMock.orderReturnPendency.findMany.mockResolvedValue([pendencia()]);
    vi.spyOn(MLApiService, "getOrderDetails").mockRejectedValue(
      new Error("ML 503"),
    );

    const r = await OrderReturnPendencyReconcilerService.runOnce();

    expect(r.processadas).toBe(1);
    expect(r.fechadas).toBe(0);
    expect(prismaMock.orderReturnPendency.update).toHaveBeenCalled();
  });
});

describe("guardas", () => {
  it("kill-switch ORDER_RETURN_RECONCILER_DISABLED=1 → no-op total", async () => {
    process.env.ORDER_RETURN_RECONCILER_DISABLED = "1";
    const r = await OrderReturnPendencyReconcilerService.runOnce();
    expect(r).toEqual({ processadas: 0, fechadas: 0 });
    expect(prismaMock.orderReturnPendency.findMany).not.toHaveBeenCalled();
    delete process.env.ORDER_RETURN_RECONCILER_DISABLED;
  });

  it("conta inativa não é consultada na API", async () => {
    prismaMock.orderReturnPendency.findMany.mockResolvedValue([
      pendencia({
        marketplaceAccount: { ...CONTA, status: "ERROR" },
      }),
    ]);
    const getOrder = vi.spyOn(MLApiService, "getOrderDetails");

    await OrderReturnPendencyReconcilerService.runOnce();
    expect(getOrder).not.toHaveBeenCalled();
  });

  it("Shopee/Magalu ficam esperando decisão humana — sem chamada de API", async () => {
    prismaMock.orderReturnPendency.findMany.mockResolvedValue([
      pendencia({
        marketplaceAccount: { ...CONTA, platform: "SHOPEE" },
      }),
    ]);
    const getOrder = vi.spyOn(MLApiService, "getOrderDetails");

    await OrderReturnPendencyReconcilerService.runOnce();
    expect(getOrder).not.toHaveBeenCalled();
    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it("⭐ a fila NÃO represa: varre só OPEN, só ML, e só o que venceu", async () => {
    // Sem estes dois filtros o reconciliador nunca esvazia. `NEEDS_ACTION`
    // voltaria a ser consultado 4x/dia para sempre, e toda pendência
    // Shopee/Magalu — que é no-op GARANTIDO — consumiria slot do lote de 25,
    // deslocando as pendências ML, que são as únicas com trabalho a fazer.
    // Com backoff de 6h o sistema saturaria em ~300 pendências e as novas
    // nunca seriam alcançadas.
    prismaMock.orderReturnPendency.findMany.mockResolvedValue([]);
    await OrderReturnPendencyReconcilerService.runOnce();
    expect(prismaMock.orderReturnPendency.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: "OPEN",
          platform: "MERCADO_LIVRE",
          nextRetryAt: { lte: expect.any(Date) },
        },
      }),
    );
  });

  it("a leitura tem seleção explícita — não carrega payload nem detail", async () => {
    // Regra de egress nº 1. São 1.200 leituras/dia; `include` puro traria a
    // evidência em JSON que este caminho nunca lê.
    prismaMock.orderReturnPendency.findMany.mockResolvedValue([]);
    await OrderReturnPendencyReconcilerService.runOnce();
    const arg = prismaMock.orderReturnPendency.findMany.mock.calls[0][0];
    expect(arg.select).toBeDefined();
    expect(arg.include).toBeUndefined();
    expect(arg.select.payload).toBeUndefined();
    expect(arg.select.detail).toBeUndefined();
  });
});
