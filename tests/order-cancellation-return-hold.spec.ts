import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

// ──────────────────────────────────────────────────────────────────────────
// Retenção do estorno quando a peça NÃO está no pátio (devolução, 01/09/2026).
//
// O bug: o ML usa UM único estado terminal (`status: "cancelled"`) para
// cancelamento antes do envio (peça no pátio — estorno certo) e para devolução
// depois da entrega (peça com o comprador — estorno cria estoque que não
// existe, reabre o anúncio e outra pessoa compra o que a loja não tem).
// Varredura de 68 cancelamentos reais de um tenant contra a API do ML: 51 (75%)
// eram do segundo tipo. 20 peças estavam à venda naquele instante, em 48
// anúncios, R$ 2.576,90 expostos.
//
// Prova (contrato §5):
//  1. Cancelamento PRÉ-ENVIO continua estornando e reabrindo — byte-idêntico.
//  2. Devolução PÓS-ENTREGA não estorna, não reabre, e abre pendência.
//  - A decisão é tomada DENTRO da tx, ANTES do restoreWithinTx: nunca
//    "estorna e depois desfaz" (o anúncio piscaria de volta ao ar).
//  - Kill-switch ORDER_RETURN_HOLD_DISABLED=1 ⇒ comportamento de hoje.
//  10. NÃO-INTERFERÊNCIA: sem o parâmetro `desfecho` — que é o caso de Magalu,
//     Shopee, PATCH manual e OLX/Facebook — absolutamente nada muda.
//
// Harness clonado de tests/order-cancellation.spec.ts (mockTx/spyServices),
// para as asserções serem comparáveis linha a linha com as de lá.
// ──────────────────────────────────────────────────────────────────────────

vi.mock("@/app/marketplaces/services/stock-sync-retry.service", () => ({
  StockSyncRetryService: { runOnce: vi.fn().mockResolvedValue(undefined) },
}));

import { OrderUseCase } from "@/app/marketplaces/usecases/order.usercase";
import prisma from "@/app/lib/prisma";
import { StockDeductionService } from "@/app/marketplaces/services/stock-deduction.service";
import { SystemLogService } from "@/app/services/system-log.service";
import { OrderReturnPendencyService } from "@/app/marketplaces/services/order-return-pendency.service";
import type { DesfechoPedido } from "@/app/marketplaces/services/order-outcome.service";

const ACCOUNT_ID = "acc-1";
const EXT_ID = "123";

const DESFECHO_RETEM: DesfechoPedido = {
  peca: "COM_COMPRADOR",
  reterEstorno: true,
  reason: "PECA_COM_COMPRADOR",
  detail: "A peça foi ENTREGUE ao comprador.",
  evidencia: { cancelGroup: "mediations", shipmentStatus: "delivered" },
};

const DESFECHO_NAO_RETEM: DesfechoPedido = {
  peca: "NO_PATIO",
  reterEstorno: false,
  reason: null,
  detail: null,
  evidencia: { cancelGroup: "buyer", shipmentStatus: "cancelled" },
};

function makeOrder(over: Partial<any> = {}) {
  return {
    id: "o-1",
    status: "PAID",
    items: [{ productId: "p-1", quantity: 2 }],
    marketplaceAccount: { userId: "u-1" },
    ...over,
  };
}

function mockTx({ updateManyCounts = [1], groupBy = [] as any[] } = {}) {
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
  const abrirPendencia = vi
    .spyOn(OrderReturnPendencyService, "open")
    .mockResolvedValue(undefined);
  vi.spyOn(SystemLogService, "logInfo").mockResolvedValue(undefined as any);
  vi.spyOn(SystemLogService, "logError").mockResolvedValue(undefined as any);
  return { restore, fire, abrirPendencia };
}

/** Baixa de 2 unidades registrada ⇒ o net manda estornar 2. */
const NET_COM_BAIXA = [{ productId: "p-1", _sum: { change: -2 } }];

async function cancelar(desfecho?: DesfechoPedido) {
  vi.spyOn(prisma.order, "findFirst").mockResolvedValue(makeOrder() as any);
  const { tx, txSpy } = mockTx({ groupBy: NET_COM_BAIXA });
  const spies = spyServices();
  const res = await OrderUseCase.processOrderCancellation({
    marketplaceAccountId: ACCOUNT_ID,
    externalOrderId: EXT_ID,
    platformLabel: "ML",
    ...(desfecho ? { desfecho } : {}),
  });
  return { res, tx, txSpy, ...spies };
}

beforeEach(() => {
  // Em produção o default é LIGADO; a suíte o desliga em vitest.config.ts para
  // os specs pré-existentes continuarem byte-idênticos. Este é o spec da
  // correção — ele reabilita explicitamente.
  delete process.env.ORDER_RETURN_HOLD_DISABLED;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.ORDER_CANCEL_RESTORE_DISABLED;
  process.env.ORDER_RETURN_HOLD_DISABLED = "1";
});

describe("§5.1 — cancelamento PRÉ-ENVIO continua estornando (não pode mudar)", () => {
  it("desfecho NO_PATIO: estorna, reabre e NÃO abre pendência", async () => {
    const { res, restore, fire, abrirPendencia } =
      await cancelar(DESFECHO_NAO_RETEM);

    expect(res.action).toBe("cancelled_restored");
    expect(res.restoredItems).toBe(1);
    expect(restore).toHaveBeenCalledTimes(1);
    expect(restore).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        items: [{ productId: "p-1", quantity: 2 }],
        reason: `Estorno venda ML #${EXT_ID}`,
      }),
    );
    expect(fire).toHaveBeenCalledWith(
      expect.objectContaining({
        reopenOnRefill: { userId: "u-1", force: true },
      }),
    );
    // Pedido nunca pausa anúncio — o veto é unidirecional.
    expect(fire.mock.calls[0][0].pauseOnZero).toBeUndefined();
    expect(abrirPendencia).not.toHaveBeenCalled();
  });

  it("desfecho INDETERMINADO (API fora do ar) também estorna — fail-safe", async () => {
    const { res, restore, abrirPendencia } = await cancelar({
      peca: "INDETERMINADO",
      reterEstorno: false,
      reason: null,
      detail: null,
      evidencia: {},
    });
    expect(res.action).toBe("cancelled_restored");
    expect(restore).toHaveBeenCalledTimes(1);
    expect(abrirPendencia).not.toHaveBeenCalled();
  });
});

describe("§5.2 — devolução PÓS-ENTREGA não estorna e não reabre", () => {
  it("retém o estorno, marca o pedido CANCELLED e abre a pendência", async () => {
    const { res, tx, restore, fire, abrirPendencia } =
      await cancelar(DESFECHO_RETEM);

    expect(res.action).toBe("cancelled_return_pending");
    expect(res.restoredItems).toBe(0);

    // O pedido FOI cancelado: o claim rodou. O que não aconteceu foi o +1.
    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: {
        id: "o-1",
        status: { in: ["PENDING", "PAID", "SHIPPED", "DELIVERED"] },
      },
      data: { status: "CANCELLED" },
    });

    expect(restore).not.toHaveBeenCalled();
    // Sem estorno não há `restorations` ⇒ o bloco de pós-efeitos inteiro não
    // roda. É assim que o anúncio NÃO reabre, sem tocar em firePostEffects.
    expect(fire).not.toHaveBeenCalled();

    expect(abrirPendencia).toHaveBeenCalledWith(
      expect.objectContaining({
        marketplaceAccountId: ACCOUNT_ID,
        platform: "MERCADO_LIVRE",
        externalOrderId: EXT_ID,
        reason: "PECA_COM_COMPRADOR",
      }),
    );
  });

  it("⭐ a decisão é tomada ANTES do restore — nunca estorna e desfaz", async () => {
    // Se fosse "estorna e depois desfaz", o anúncio piscaria de volta ao ar e
    // nesse intervalo alguém compra. `restoreWithinTx` não pode ter sido
    // chamado nem uma vez.
    const { restore } = await cancelar(DESFECHO_RETEM);
    expect(restore).not.toHaveBeenCalled();
  });

  it("a pendência leva a evidência e o que TERIA sido estornado", async () => {
    const { abrirPendencia } = await cancelar(DESFECHO_RETEM);
    const arg = abrirPendencia.mock.calls[0][0];
    expect(arg.evidencia).toMatchObject({
      cancelGroup: "mediations",
      shipmentStatus: "delivered",
      desfecho: "COM_COMPRADOR",
      itensRetidos: [{ productId: "p-1", quantity: 2 }],
    });
  });

  it("pedido SEM baixa (net 0) não vira pendência — nada seria estornado", async () => {
    // Abrir pendência aqui seria pedir uma decisão sobre nada e poluir a tela.
    vi.spyOn(prisma.order, "findFirst").mockResolvedValue(makeOrder() as any);
    mockTx({ groupBy: [] });
    const { abrirPendencia } = spyServices();

    const res = await OrderUseCase.processOrderCancellation({
      marketplaceAccountId: ACCOUNT_ID,
      externalOrderId: EXT_ID,
      platformLabel: "ML",
      desfecho: DESFECHO_RETEM,
    });

    expect(res.action).toBe("cancelled_no_restore");
    expect(abrirPendencia).not.toHaveBeenCalled();
  });

  it("corrida perdida (já cancelado por outro processo) não abre pendência", async () => {
    vi.spyOn(prisma.order, "findFirst").mockResolvedValue(makeOrder() as any);
    mockTx({ updateManyCounts: [0], groupBy: NET_COM_BAIXA });
    const { abrirPendencia, restore } = spyServices();

    const res = await OrderUseCase.processOrderCancellation({
      marketplaceAccountId: ACCOUNT_ID,
      externalOrderId: EXT_ID,
      platformLabel: "ML",
      desfecho: DESFECHO_RETEM,
    });

    expect(res.action).toBe("already_cancelled");
    expect(restore).not.toHaveBeenCalled();
    expect(abrirPendencia).not.toHaveBeenCalled();
  });
});

describe("⭐ o un-cancel enxerga a reposição por DEVOLUÇÃO", () => {
  // A sequência que faltava fechar: cancelamento retido → operador confirma
  // "a peça voltou" (+1 com reason de devolução) → alguém reativa o pedido
  // pelo PATCH manual. Se o net do un-cancel não somasse a reason da
  // devolução, esse `+1` NUNCA seria re-baixado: peça vendida, estoque 1.
  it("o net soma as TRÊS reasons, incluindo a da devolução", async () => {
    vi.spyOn(prisma.order, "findFirst").mockResolvedValue(
      makeOrder({ status: "CANCELLED" }) as any,
    );
    const { tx } = mockTx({
      groupBy: [{ productId: "p-1", _sum: { change: 2 } }],
    });
    vi.spyOn(StockDeductionService, "deductWithinTx").mockResolvedValue({
      deductions: [],
      oversellAlerts: [],
    });
    vi.spyOn(SystemLogService, "logInfo").mockResolvedValue(undefined as any);

    await OrderUseCase.processOrderUncancellation({
      marketplaceAccountId: ACCOUNT_ID,
      externalOrderId: EXT_ID,
      platformLabel: "ML",
      targetStatus: "PAID",
    });

    expect(tx.stockLog.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          reason: {
            in: [
              `Estorno venda ML #${EXT_ID}`,
              `Reativação venda ML #${EXT_ID}`,
              `Devolução recebida ML #${EXT_ID}`,
            ],
          },
        }),
      }),
    );
  });

  it("kill-switch restaura as DUAS reasons de sempre (contrato congelado)", async () => {
    process.env.ORDER_RETURN_HOLD_DISABLED = "1";
    vi.spyOn(prisma.order, "findFirst").mockResolvedValue(
      makeOrder({ status: "CANCELLED" }) as any,
    );
    const { tx } = mockTx({ groupBy: [] });
    vi.spyOn(StockDeductionService, "deductWithinTx").mockResolvedValue({
      deductions: [],
      oversellAlerts: [],
    });
    vi.spyOn(SystemLogService, "logInfo").mockResolvedValue(undefined as any);

    await OrderUseCase.processOrderUncancellation({
      marketplaceAccountId: ACCOUNT_ID,
      externalOrderId: EXT_ID,
      platformLabel: "ML",
      targetStatus: "PAID",
    });

    expect(tx.stockLog.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          reason: {
            in: [
              `Estorno venda ML #${EXT_ID}`,
              `Reativação venda ML #${EXT_ID}`,
            ],
          },
        }),
      }),
    );
  });
});

describe("NÃO-INTERFERÊNCIA — o que a correção não pode tocar", () => {
  it("§5.9/§5.10 sem `desfecho` (Magalu, Shopee, PATCH, OLX/FB): estorna como sempre", async () => {
    const { res, restore, fire, abrirPendencia } = await cancelar(undefined);
    expect(res.action).toBe("cancelled_restored");
    expect(restore).toHaveBeenCalledTimes(1);
    expect(fire).toHaveBeenCalledWith(
      expect.objectContaining({ reopenOnRefill: { userId: "u-1", force: true } }),
    );
    expect(abrirPendencia).not.toHaveBeenCalled();
  });

  it("kill-switch ORDER_RETURN_HOLD_DISABLED=1 ignora o desfecho e estorna", async () => {
    process.env.ORDER_RETURN_HOLD_DISABLED = "1";
    const { res, restore, abrirPendencia } = await cancelar(DESFECHO_RETEM);
    expect(res.action).toBe("cancelled_restored");
    expect(restore).toHaveBeenCalledTimes(1);
    expect(abrirPendencia).not.toHaveBeenCalled();
  });

  it("o kill-switch de cancelamento continua mandando mais que tudo", async () => {
    process.env.ORDER_CANCEL_RESTORE_DISABLED = "1";
    const findFirst = vi.spyOn(prisma.order, "findFirst");
    const { abrirPendencia } = spyServices();

    const res = await OrderUseCase.processOrderCancellation({
      marketplaceAccountId: ACCOUNT_ID,
      externalOrderId: EXT_ID,
      platformLabel: "ML",
      desfecho: DESFECHO_RETEM,
    });

    expect(res.action).toBe("disabled");
    expect(findFirst).not.toHaveBeenCalled();
    expect(abrirPendencia).not.toHaveBeenCalled();
  });

  it("a transação continua com os mesmos opts (timeout/maxWait)", async () => {
    const { txSpy } = await cancelar(DESFECHO_RETEM);
    expect(txSpy).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 60_000,
      maxWait: 20_000,
    });
  });

  it("o net continua somando exatamente as TRÊS reasons de sempre", async () => {
    // Envenenar este groupBy com uma quarta reason quebraria a idempotência
    // que tests/order-cancellation.spec.ts congela.
    const { tx } = await cancelar(DESFECHO_RETEM);
    expect(tx.stockLog.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          reason: {
            in: [
              `Venda ML #${EXT_ID}`,
              `Estorno venda ML #${EXT_ID}`,
              `Reativação venda ML #${EXT_ID}`,
            ],
          },
        }),
      }),
    );
  });

  it("falha ao abrir a pendência não derruba o cancelamento já commitado", async () => {
    vi.spyOn(prisma.order, "findFirst").mockResolvedValue(makeOrder() as any);
    mockTx({ groupBy: NET_COM_BAIXA });
    spyServices();
    vi.spyOn(OrderReturnPendencyService, "open").mockRejectedValue(
      new Error("banco fora"),
    );

    const res = await OrderUseCase.processOrderCancellation({
      marketplaceAccountId: ACCOUNT_ID,
      externalOrderId: EXT_ID,
      platformLabel: "ML",
      desfecho: DESFECHO_RETEM,
    });

    // O catch externo devolve `error`, sem lançar: o caller é fire-and-forget.
    // O que importa é que NÃO estornou e não explodiu.
    expect(res.success).toBe(false);
    expect(res.action).toBe("error");
    expect(res.restoredItems).toBe(0);
  });
});
