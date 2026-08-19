import { describe, it, expect, vi, afterEach } from "vitest";

// ──────────────────────────────────────────────────────────
// Preferência do tenant: reabrir anúncio quando a peça volta ao estoque por
// CANCELAMENTO — caminho do PEDIDO DE MARKETPLACE.
//
// A preferência é lida do MESMO findFirst do pedido (nenhuma query nova) e
// decide APENAS a presença da chave `reopenOnRefill` no firePostEffects.
//
// O teste que vale mais que todos os outros deste arquivo é o de
// "não-interferência": com a preferência DESLIGADA, `firePostEffects` continua
// sendo chamado. Uma implementação que envolvesse a chamada num
// `if (preferencia)` passaria em ligado/desligado/legado/alternância/isolamento
// e mesmo assim seria um desastre — mataria o StockSyncRetryService (estoque
// restaurado nunca chegaria aos marketplaces) e a reconciliação de sucata, que
// vivem no mesmo bloco.
//
// Harness clonado de tests/order-cancellation.spec.ts (spyOn no prisma real).
// ──────────────────────────────────────────────────────────

vi.mock("@/app/marketplaces/services/stock-sync-retry.service", () => ({
  StockSyncRetryService: { runOnce: vi.fn().mockResolvedValue(undefined) },
}));

import { OrderUseCase } from "@/app/marketplaces/usecases/order.usercase";
import prisma from "@/app/lib/prisma";
import { StockDeductionService } from "@/app/marketplaces/services/stock-deduction.service";
import { ScrapStatusReconcileService } from "@/app/marketplaces/services/scrap-status-reconcile.service";
import { SystemLogService } from "@/app/services/system-log.service";

const ACCOUNT_ID = "acc-1";
const EXT_ID = "123";

/**
 * `pref === undefined` monta a conta SEM a relação `user` — que é exatamente o
 * formato do fixture legado (tests/order-cancellation.spec.ts:37) e o caso do
 * usuário anterior à coluna.
 */
function makeOrder({
  userId = "u-1",
  pref,
  parentPref,
}: {
  userId?: string;
  pref?: boolean | null;
  parentPref?: boolean | null;
} = {}) {
  return {
    id: "o-1",
    status: "PAID",
    items: [{ productId: "p-1", quantity: 2 }],
    marketplaceAccount: {
      userId,
      ...(pref === undefined && parentPref === undefined
        ? {}
        : {
            user: {
              reopenListingsOnSaleCancel: pref ?? null,
              parent:
                parentPref === undefined
                  ? null
                  : { reopenListingsOnSaleCancel: parentPref },
            },
          }),
    },
  };
}

function mockTx({ updateManyCounts = [1], groupBy = [] as any[] } = {}) {
  const updateMany = vi.fn();
  for (const count of updateManyCounts)
    updateMany.mockResolvedValueOnce({ count });
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
  const scrap = vi
    .spyOn(ScrapStatusReconcileService, "reconcileForProducts")
    .mockImplementation(() => {});
  vi.spyOn(SystemLogService, "logInfo").mockResolvedValue(undefined as any);
  vi.spyOn(SystemLogService, "logError").mockResolvedValue(undefined as any);
  return { restore, fire, scrap };
}

/** Um cancelamento completo, devolvendo o argumento do firePostEffects. */
async function cancelar(order: any) {
  vi.spyOn(prisma.order, "findFirst").mockResolvedValue(order as any);
  mockTx({
    updateManyCounts: [1],
    groupBy: [{ productId: "p-1", _sum: { change: -2 } }],
  });
  const { restore, fire, scrap } = spyServices();
  const res = await OrderUseCase.processOrderCancellation({
    marketplaceAccountId: ACCOUNT_ID,
    externalOrderId: EXT_ID,
    platformLabel: "ML",
  });
  return { res, fire, restore, scrap, arg: fire.mock.calls[0]?.[0] as any };
}

describe("Preferência de reabertura — cancelamento de pedido de marketplace", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ORDER_CANCEL_RESTORE_DISABLED;
  });

  it("LIGADA: reabre, com force (byte-idêntico ao comportamento de sempre)", async () => {
    const { res, arg } = await cancelar(makeOrder({ pref: true }));
    expect(res.success).toBe(true);
    expect(arg.reopenOnRefill).toEqual({ userId: "u-1", force: true });
  });

  it("DESLIGADA: a chave SOME — e só ela", async () => {
    const { res, arg, restore } = await cancelar(makeOrder({ pref: false }));
    expect(arg.reopenOnRefill).toBeUndefined();
    // O resto do cancelamento é idêntico: o estorno aconteceu.
    expect(res.success).toBe(true);
    expect(res.action).toBe("cancelled_restored");
    expect(restore).toHaveBeenCalledTimes(1);
    expect(arg.deductions).toHaveLength(1);
  });

  describe("LEGADO / fail-open — ausência de informação significa reabrir", () => {
    it("relação `user` ausente (fixture antigo, projeção sem a coluna)", async () => {
      const { arg } = await cancelar(makeOrder());
      expect(arg.reopenOnRefill).toEqual({ userId: "u-1", force: true });
    });

    it("coluna null (linha criada antes do DDL)", async () => {
      const { arg } = await cancelar(makeOrder({ pref: null }));
      expect(arg.reopenOnRefill).toEqual({ userId: "u-1", force: true });
    });
  });

  it("ALTERNÂNCIA: desligar e religar vale já no próximo cancelamento", async () => {
    // Cada cancelamento relê do banco; não há cache que segure valor antigo.
    const a = await cancelar(makeOrder({ pref: true }));
    expect(a.arg.reopenOnRefill).toBeDefined();
    vi.restoreAllMocks();

    const b = await cancelar(makeOrder({ pref: false }));
    expect(b.arg.reopenOnRefill).toBeUndefined();
    vi.restoreAllMocks();

    const c = await cancelar(makeOrder({ pref: true }));
    expect(c.arg.reopenOnRefill).toBeDefined();
  });

  it("ISOLAMENTO: a escolha de um tenant não vaza para o outro", async () => {
    const a = await cancelar(makeOrder({ userId: "tenant-A", pref: false }));
    expect(a.arg.reopenOnRefill).toBeUndefined();
    vi.restoreAllMocks();

    const b = await cancelar(makeOrder({ userId: "tenant-B", pref: true }));
    expect(b.arg.reopenOnRefill).toEqual({ userId: "tenant-B", force: true });
  });

  it("conta conectada por COLABORADOR obedece ao admin pai", async () => {
    // A preferência é do TENANT. Se o pai desligou, a conta segue o pai mesmo
    // que a linha de quem conectou diga o contrário.
    const { arg } = await cancelar(
      makeOrder({ pref: true, parentPref: false }),
    );
    expect(arg.reopenOnRefill).toBeUndefined();
  });

  describe("NÃO-INTERFERÊNCIA — o que a preferência NÃO pode tocar", () => {
    it("DESLIGADA: firePostEffects continua sendo CHAMADO", async () => {
      // ⭐ O teste central. `firePostEffects` também dispara o
      // StockSyncRetryService; pular a chamada faria o estoque restaurado nunca
      // chegar aos marketplaces — falha de dados, não de UX.
      const { fire, arg } = await cancelar(makeOrder({ pref: false }));
      expect(fire).toHaveBeenCalledTimes(1);
      expect(arg.deductions).toEqual([
        {
          productId: "p-1",
          productName: "Peça",
          previousStock: 0,
          newStock: 2,
          quantity: 2,
        },
      ]);
    });

    it("DESLIGADA: a reconciliação de sucata continua rodando", async () => {
      // Ela vive no MESMO bloco do firePostEffects. Sem isto, o lote ficaria
      // marcado "Esgotado" para sempre — o bug que já foi corrigido uma vez.
      const { scrap } = await cancelar(makeOrder({ pref: false }));
      expect(scrap).toHaveBeenCalledTimes(1);
      expect(scrap.mock.calls[0][0]).toMatchObject({
        productIds: ["p-1"],
        userId: "u-1",
      });
    });

    it("DESLIGADA: nunca liga pauseOnZero (o veto é unidirecional)", async () => {
      const { arg } = await cancelar(makeOrder({ pref: false }));
      expect(arg.pauseOnZero).toBeUndefined();
    });

    it("o kill-switch de cancelamento continua mandando mais que a preferência", async () => {
      process.env.ORDER_CANCEL_RESTORE_DISABLED = "1";
      const findFirst = vi.spyOn(prisma.order, "findFirst");
      const { fire } = spyServices();

      const res = await OrderUseCase.processOrderCancellation({
        marketplaceAccountId: ACCOUNT_ID,
        externalOrderId: EXT_ID,
        platformLabel: "ML",
      });

      expect(res.action).toBe("disabled");
      expect(findFirst).not.toHaveBeenCalled();
      expect(fire).not.toHaveBeenCalled();
    });
  });

  it("as 3 plataformas passam pelo mesmo caminho — não há ramo por marketplace", async () => {
    for (const plataforma of ["ML", "Shopee", "Magalu"] as const) {
      vi.spyOn(prisma.order, "findFirst").mockResolvedValue(
        makeOrder({ pref: false }) as any,
      );
      mockTx({
        updateManyCounts: [1],
        groupBy: [{ productId: "p-1", _sum: { change: -2 } }],
      });
      const { fire } = spyServices();

      await OrderUseCase.processOrderCancellation({
        marketplaceAccountId: ACCOUNT_ID,
        externalOrderId: EXT_ID,
        platformLabel: plataforma,
      });

      expect(fire.mock.calls[0][0].reopenOnRefill).toBeUndefined();
      vi.restoreAllMocks();
    }
  });
});
