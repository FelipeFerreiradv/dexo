import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ──────────────────────────────────────────────────────────
// `keepPausedOnRefill` — o ESPELHO de `reopenOnRefill`.
//
// POR QUE ESTE ARQUIVO EXISTE
// A preferência `User.reopenListingsOnSaleCancel` já era lida corretamente e já
// suprimia o `updateItem({status:"active"})`. Só que esse nunca foi o mecanismo
// que reabria o anúncio no caminho de cancelamento: quem reabre é o empurrão de
// QUANTIDADE, que acontece sempre (o `runOnce()` é incondicional, e tem de ser).
// O Mercado Livre remove sozinho o `sub_status: out_of_stock` quando a
// quantidade sobe — medido em produção em 28/08, em 5 anúncios de uma conta com
// a preferência DESLIGADA desde 19/08, com o `last_updated` do item no ML
// batendo com a nossa própria chamada de estoque.
//
// Por isso "não reabrir" precisa ser uma AÇÃO — pausar depois do empurrão — e
// não a ausência de uma.
//
// O teste que mais importa aqui é o de ORDEM. Uma implementação que dispare os
// dois em paralelo passa em tudo que só pergunta "foi chamado?" e mesmo assim
// falha em produção, porque a pausa pode chegar antes do empurrão que reabre.
// ──────────────────────────────────────────────────────────

const runOnceMock = vi.fn();
vi.mock("@/app/marketplaces/services/stock-sync-retry.service", () => ({
  StockSyncRetryService: { runOnce: runOnceMock },
}));

const pauseListingsMock = vi.fn();
vi.mock("@/app/usecases/product.usercase", () => ({
  ProductUseCase: class {
    pauseListings = pauseListingsMock;
  },
}));

import { StockDeductionService } from "@/app/marketplaces/services/stock-deduction.service";
import { OrderUseCase } from "@/app/marketplaces/usecases/order.usercase";
import prisma from "@/app/lib/prisma";
import { ScrapStatusReconcileService } from "@/app/marketplaces/services/scrap-status-reconcile.service";
import { SystemLogService } from "@/app/services/system-log.service";
import { PLATAFORMAS_QUE_SAEM_DO_AR_POR_ESTOQUE } from "@/app/marketplaces/services/stock-deduction.service";
import { Platform } from "@prisma/client";

/** firePostEffects usa setImmediate + dynamic import + cadeia de `.then()`. */
async function flushSetImmediates(cycles = 10) {
  for (let i = 0; i < cycles; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

const deduction = (overrides: Partial<any> = {}) => ({
  productId: "p-1",
  productName: "Produto",
  previousStock: 0,
  newStock: 1,
  quantity: 1,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  runOnceMock.mockResolvedValue(undefined);
  pauseListingsMock.mockResolvedValue({
    success: true,
    message: "ok",
    listingResults: [],
  });
});

describe("StockDeductionService.firePostEffects — keepPausedOnRefill", () => {
  it("pausa só o que SAIU DE ZERO, com forceRemote", async () => {
    StockDeductionService.firePostEffects({
      deductions: [
        // saiu de zero → o anúncio estava fora do ar e voltaria: pausa.
        deduction({ productId: "p-refilled", previousStock: 0, newStock: 5 }),
        // tinha estoque → nunca esteve pausado por falta de peça: não toca.
        deduction({ productId: "p-normal", previousStock: 3, newStock: 6 }),
        // continua zerado → nada a fazer.
        deduction({ productId: "p-zero", previousStock: 0, newStock: 0 }),
      ],
      logPrefix: "[OrderUseCase]",
      keepPausedOnRefill: { userId: "tenant-1" },
    });
    await flushSetImmediates();

    expect(pauseListingsMock).toHaveBeenCalledTimes(1);
    expect(pauseListingsMock).toHaveBeenCalledWith(
      "p-refilled",
      "tenant-1",
      "paused",
      { forceRemote: true },
    );
  });

  it("repassa a lista de plataformas quando o chamador manda uma", async () => {
    StockDeductionService.firePostEffects({
      deductions: [deduction()],
      logPrefix: "[OrderUseCase]",
      keepPausedOnRefill: {
        userId: "tenant-1",
        platforms: PLATAFORMAS_QUE_SAEM_DO_AR_POR_ESTOQUE,
      },
    });
    await flushSetImmediates();

    expect(pauseListingsMock).toHaveBeenCalledWith("p-1", "tenant-1", "paused", {
      forceRemote: true,
      platforms: [Platform.MERCADO_LIVRE, Platform.OLX, Platform.FACEBOOK],
    });
  });

  it("SEM lista: pausa em todos os canais — é o caso do estorno de balcão", async () => {
    // No balcão o `markPaid` passou `pauseOnZero`, então os cinco canais
    // saíram do ar de verdade e o estorno pode devolver todos.
    StockDeductionService.firePostEffects({
      deductions: [deduction()],
      logPrefix: "[FinanceUseCase]",
      keepPausedOnRefill: { userId: "tenant-1" },
    });
    await flushSetImmediates();

    expect(pauseListingsMock).toHaveBeenCalledWith("p-1", "tenant-1", "paused", {
      forceRemote: true,
    });
  });

  it("⭐ ORDEM: a pausa acontece DEPOIS do empurrão de estoque", async () => {
    // É o empurrão de quantidade que reabre o anúncio. Pausar antes dele seria
    // pausar e ser reaberto — exatamente o bug que esta correção elimina.
    const ordem: string[] = [];
    runOnceMock.mockImplementation(async () => {
      ordem.push("runOnce:inicio");
      // Alguns ticks de espera DENTRO do runOnce, na mesma fila que o flush
      // percorre — um `setTimeout` real passaria despercebido pelo laço de
      // `setImmediate` e o teste falharia por artefato do harness.
      for (let i = 0; i < 3; i++) {
        await new Promise<void>((r) => setImmediate(r));
      }
      ordem.push("runOnce:fim");
    });
    pauseListingsMock.mockImplementation(async () => {
      ordem.push("pause");
      return { success: true, message: "ok", listingResults: [] };
    });

    StockDeductionService.firePostEffects({
      deductions: [deduction()],
      logPrefix: "[OrderUseCase]",
      keepPausedOnRefill: { userId: "tenant-1" },
    });
    await flushSetImmediates(30);

    expect(ordem).toEqual(["runOnce:inicio", "runOnce:fim", "pause"]);
  });

  it("o empurrão de estoque continua acontecendo (não virou um `if`)", async () => {
    StockDeductionService.firePostEffects({
      deductions: [deduction()],
      logPrefix: "[OrderUseCase]",
      keepPausedOnRefill: { userId: "tenant-1" },
    });
    await flushSetImmediates();
    expect(runOnceMock).toHaveBeenCalledTimes(1);
  });

  it("runOnce falhando não cancela a pausa — e nada é lançado", async () => {
    // Se o sync falhou o anúncio provavelmente nem reabriu; pausar mesmo assim
    // é idempotente, e é o estado que o lojista pediu.
    runOnceMock.mockRejectedValue(new Error("rede"));
    StockDeductionService.firePostEffects({
      deductions: [deduction()],
      logPrefix: "[OrderUseCase]",
      keepPausedOnRefill: { userId: "tenant-1" },
    });
    await flushSetImmediates();
    expect(pauseListingsMock).toHaveBeenCalledTimes(1);
  });

  it("best-effort: falha ao pausar um produto não impede o próximo", async () => {
    pauseListingsMock
      .mockRejectedValueOnce(new Error("ML 503"))
      .mockResolvedValueOnce({
        success: true,
        message: "ok",
        listingResults: [],
      });

    StockDeductionService.firePostEffects({
      deductions: [
        deduction({ productId: "p-a" }),
        deduction({ productId: "p-b" }),
      ],
      logPrefix: "[OrderUseCase]",
      keepPausedOnRefill: { userId: "tenant-1" },
    });
    await flushSetImmediates();
    expect(pauseListingsMock).toHaveBeenCalledTimes(2);
  });

  it("SEM a chave: nada muda para quem tem a preferência LIGADA", async () => {
    StockDeductionService.firePostEffects({
      deductions: [deduction()],
      logPrefix: "[OrderUseCase]",
      reopenOnRefill: { userId: "tenant-1", force: true },
    });
    await flushSetImmediates();

    expect(pauseListingsMock).toHaveBeenCalledTimes(1);
    expect(pauseListingsMock).toHaveBeenCalledWith("p-1", "tenant-1", "active", {
      forceRemote: true,
    });
  });

  it("nenhuma das duas chaves: ninguém toca em anúncio", async () => {
    StockDeductionService.firePostEffects({
      deductions: [deduction()],
      logPrefix: "[OrderUseCase]",
    });
    await flushSetImmediates();
    expect(runOnceMock).toHaveBeenCalledTimes(1);
    expect(pauseListingsMock).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────
// Fiação: o cancelamento de PEDIDO escolhe uma chave OU a outra — nunca as
// duas, nunca nenhuma.
// ──────────────────────────────────────────────────────────

const ACCOUNT_ID = "acc-1";
const EXT_ID = "123";

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

function armarCancelamento(order: any) {
  vi.spyOn(prisma.order, "findFirst").mockResolvedValue(order as any);
  const tx = {
    order: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    stockLog: {
      groupBy: vi
        .fn()
        .mockResolvedValue([{ productId: "p-1", _sum: { change: -2 } }]),
    },
    $queryRaw: vi.fn().mockResolvedValue([{ id: "p-1" }]),
  };
  vi.spyOn(prisma, "$transaction").mockImplementation(
    async (cb: any) => cb(tx) as any,
  );
  vi.spyOn(StockDeductionService, "restoreWithinTx").mockResolvedValue({
    deductions: [deduction({ previousStock: 0, newStock: 2, quantity: 2 })],
  } as any);
  const fire = vi
    .spyOn(StockDeductionService, "firePostEffects")
    .mockImplementation(() => {});
  vi.spyOn(
    ScrapStatusReconcileService,
    "reconcileForProducts",
  ).mockImplementation(() => {});
  vi.spyOn(SystemLogService, "logInfo").mockResolvedValue(undefined as any);
  vi.spyOn(SystemLogService, "logError").mockResolvedValue(undefined as any);
  return fire;
}

async function cancelar(order: any, platformLabel: "ML" | "Shopee" | "Magalu" = "ML") {
  const fire = armarCancelamento(order);
  const res = await OrderUseCase.processOrderCancellation({
    marketplaceAccountId: ACCOUNT_ID,
    externalOrderId: EXT_ID,
    platformLabel,
  });
  return { res, fire, arg: fire.mock.calls[0]?.[0] as any };
}

describe("Cancelamento de pedido — a preferência escolhe a chave", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("DESLIGADA: keepPausedOnRefill presente, reopenOnRefill ausente", async () => {
    const { res, arg } = await cancelar(makeOrder({ pref: false }));
    expect(res.action).toBe("cancelled_restored");
    expect(arg.keepPausedOnRefill).toEqual({
      userId: "u-1",
      platforms: [Platform.MERCADO_LIVRE, Platform.OLX, Platform.FACEBOOK],
    });
    expect(arg.reopenOnRefill).toBeUndefined();
  });

  it("⚠️ o pedido NUNCA manda pausar Shopee nem Magalu", async () => {
    // O caminho de pedido não passa `pauseOnZero`: nesses dois canais o
    // anúncio seguiu PUBLICADO com quantidade 0. Despublicá-lo agora seria
    // uma ação nova, mais forte que "manter pausado", e nenhuma rotina
    // automática a desfaz — só o botão manual.
    const { arg } = await cancelar(makeOrder({ pref: false }));
    expect(arg.keepPausedOnRefill.platforms).not.toContain(Platform.SHOPEE);
    expect(arg.keepPausedOnRefill.platforms).not.toContain(Platform.MAGALU);
  });

  it("LIGADA: reopenOnRefill presente, keepPausedOnRefill ausente", async () => {
    const { arg } = await cancelar(makeOrder({ pref: true }));
    expect(arg.reopenOnRefill).toEqual({ userId: "u-1", force: true });
    expect(arg.keepPausedOnRefill).toBeUndefined();
  });

  describe("LEGADO / fail-open — ausência de informação significa REABRIR", () => {
    it("relação `user` ausente (fixture antigo, projeção sem a coluna)", async () => {
      const { arg } = await cancelar(makeOrder());
      expect(arg.reopenOnRefill).toBeDefined();
      expect(arg.keepPausedOnRefill).toBeUndefined();
    });

    it("coluna null", async () => {
      const { arg } = await cancelar(makeOrder({ pref: null }));
      expect(arg.reopenOnRefill).toBeDefined();
      expect(arg.keepPausedOnRefill).toBeUndefined();
    });
  });

  it("conta conectada por COLABORADOR obedece ao admin pai", async () => {
    const { arg } = await cancelar(makeOrder({ pref: true, parentPref: false }));
    expect(arg.keepPausedOnRefill).toMatchObject({ userId: "u-1" });
    expect(arg.reopenOnRefill).toBeUndefined();
  });

  it("ISOLAMENTO: a escolha de um tenant não vaza para o outro", async () => {
    const a = await cancelar(makeOrder({ userId: "tenant-A", pref: false }));
    expect(a.arg.keepPausedOnRefill).toMatchObject({ userId: "tenant-A" });
    vi.restoreAllMocks();

    const b = await cancelar(makeOrder({ userId: "tenant-B", pref: true }));
    expect(b.arg.keepPausedOnRefill).toBeUndefined();
    expect(b.arg.reopenOnRefill).toEqual({ userId: "tenant-B", force: true });
  });

  it("NÃO-INTERFERÊNCIA: com a preferência OFF nada mais do bloco muda", async () => {
    const { fire, arg } = await cancelar(makeOrder({ pref: false }));
    expect(fire).toHaveBeenCalledTimes(1);
    expect(arg.deductions).toHaveLength(1);
    expect(arg.pauseOnZero).toBeUndefined();
  });

  it("as 3 plataformas passam pelo mesmo caminho", async () => {
    for (const plataforma of ["ML", "Shopee", "Magalu"] as const) {
      const { arg } = await cancelar(makeOrder({ pref: false }), plataforma);
      expect(arg.keepPausedOnRefill).toMatchObject({ userId: "u-1" });
      vi.restoreAllMocks();
    }
  });
});
