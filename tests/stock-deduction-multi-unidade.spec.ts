import { describe, it, expect, beforeEach, vi } from "vitest";

// ──────────────────────────────────────────────────────────
// Bloco E — o estoque é SEMPRE decremental.
//
// A suíte existente cobre bem o caso de peça única (1 → 0), que é o padrão de
// desmonte, e `tests/stock-deduction-service.spec.ts` exercita apenas
// `firePostEffects`. O que faltava — e é justamente o que o cliente reportou —
// é a aritmética MULTI-UNIDADE de `deductWithinTx`/`restoreWithinTx`, aqui
// testada de forma direta (sem mock do serviço), com um `tx` em memória.
//
// Contrato provado:
//   estoque 100, vendeu 1  → 99   (não zera)
//   estoque 10,  vendeu 3  → 7    (não 9, não 0)
//   estoque 1,   vendeu 1  → 0    (peça única segue zerando)
//   estoque 2,   vendeu 3  → 0    + alerta de oversell (clamp preservado)
//   dois itens do mesmo produto no mesmo pedido descontam os dois
//   restoreWithinTx devolve exatamente a quantidade, sem clamp
// ──────────────────────────────────────────────────────────

vi.mock("@/app/marketplaces/services/stock-sync-retry.service", () => ({
  StockSyncRetryService: { runOnce: vi.fn().mockResolvedValue(undefined) },
}));

const pauseListingsMock = vi.fn();
vi.mock("@/app/usecases/product.usercase", () => ({
  ProductUseCase: class {
    pauseListings = pauseListingsMock;
  },
}));

const logWarningMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@/app/services/system-log.service", () => ({
  SystemLogService: { logWarning: logWarningMock },
}));

import { StockDeductionService } from "@/app/marketplaces/services/stock-deduction.service";

async function flushSetImmediates(cycles = 10) {
  for (let i = 0; i < cycles; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/**
 * `tx` em memória com a superfície exata que o serviço usa. Guarda o estado
 * do produto para que updates sucessivos dentro da mesma chamada componham —
 * é o que prova o caso de dois itens do mesmo produto no mesmo pedido.
 */
function makeTx(
  products: Record<string, { id: string; name: string; stock: number }>,
  listings: Array<{ id: string; productId: string; platform: string }> = [],
) {
  const stockLogs: any[] = [];
  const syncJobs: any[] = [];
  const tx = {
    // $queryRaw é template tag: (strings, ...values). O único uso no serviço é
    // o SELECT ... FOR UPDATE, cujo primeiro valor interpolado é o productId.
    $queryRaw: async (_strings: TemplateStringsArray, ...values: any[]) => {
      const p = products[values[0]];
      return p ? [{ id: p.id, name: p.name, stock: p.stock }] : [];
    },
    $executeRaw: async () => 1,
    product: {
      update: async ({ where, data }: any) => {
        products[where.id].stock = data.stock;
        return products[where.id];
      },
    },
    stockLog: {
      create: async ({ data }: any) => {
        stockLogs.push(data);
        return data;
      },
    },
    productListing: {
      findMany: async ({ where }: any) =>
        listings
          .filter((l) => l.productId === where.productId)
          .map((l) => ({
            id: l.id,
            marketplaceAccount: { platform: l.platform },
          })),
    },
    stockSyncJob: {
      upsert: async (args: any) => {
        syncJobs.push(args);
        return args;
      },
    },
  } as any;
  return { tx, stockLogs, syncJobs };
}

beforeEach(() => {
  vi.clearAllMocks();
  pauseListingsMock.mockResolvedValue({ success: true, listingResults: [] });
  logWarningMock.mockResolvedValue(undefined);
});

describe("deductWithinTx — multi-unidade", () => {
  it("estoque 100, vende 1 → 99 (o caso reportado pelo cliente)", async () => {
    const { tx, stockLogs } = makeTx({
      "p-1": { id: "p-1", name: "Farol", stock: 100 },
    });

    const { deductions, oversellAlerts } =
      await StockDeductionService.deductWithinTx(tx, {
        items: [{ productId: "p-1", quantity: 1 }],
        reason: "Venda ML #123",
      });

    expect(deductions).toEqual([
      {
        productId: "p-1",
        productName: "Farol",
        previousStock: 100,
        newStock: 99,
        quantity: 1,
      },
    ]);
    expect(oversellAlerts).toEqual([]);
    expect(stockLogs[0]).toMatchObject({
      change: -1,
      previousStock: 100,
      newStock: 99,
      reason: "Venda ML #123",
    });
  });

  it("estoque 10, vende 3 → 7 (não 9, não 0)", async () => {
    const { tx, stockLogs } = makeTx({
      "p-1": { id: "p-1", name: "Bico", stock: 10 },
    });

    const { deductions } = await StockDeductionService.deductWithinTx(tx, {
      items: [{ productId: "p-1", quantity: 3 }],
      reason: "Venda Shopee #abc",
    });

    expect(deductions[0].newStock).toBe(7);
    expect(stockLogs[0].change).toBe(-3);
  });

  it("estoque 1, vende 1 → 0 (peça única continua zerando)", async () => {
    const { tx, stockLogs } = makeTx({
      "p-1": { id: "p-1", name: "Retrovisor", stock: 1 },
    });

    const { deductions, oversellAlerts } =
      await StockDeductionService.deductWithinTx(tx, {
        items: [{ productId: "p-1", quantity: 1 }],
        reason: "Venda ML #999",
      });

    expect(deductions[0].newStock).toBe(0);
    expect(oversellAlerts).toEqual([]);
    expect(stockLogs[0]).toMatchObject({ change: -1, newStock: 0 });
  });

  it("estoque 2, vende 3 → clampa em 0 e alerta oversell", async () => {
    const { tx, stockLogs } = makeTx({
      "p-1": { id: "p-1", name: "Lanterna", stock: 2 },
    });

    const { deductions, oversellAlerts } =
      await StockDeductionService.deductWithinTx(tx, {
        items: [{ productId: "p-1", quantity: 3 }],
        reason: "Venda Magalu #7",
      });

    expect(deductions[0].newStock).toBe(0);
    // O StockLog grava o valor CLAMPADO — é ele que o estorno usa.
    expect(stockLogs[0].change).toBe(-2);
    expect(oversellAlerts).toEqual([
      {
        productId: "p-1",
        productName: "Lanterna",
        requested: 3,
        available: 2,
      },
    ]);
  });

  it("dois itens do mesmo produto no mesmo pedido descontam os dois", async () => {
    const { tx, stockLogs } = makeTx({
      "p-1": { id: "p-1", name: "Parafuso", stock: 10 },
    });

    const { deductions } = await StockDeductionService.deductWithinTx(tx, {
      items: [
        { productId: "p-1", quantity: 2 },
        { productId: "p-1", quantity: 3 },
      ],
      reason: "Venda ML #dup",
    });

    expect(deductions.map((d) => d.newStock)).toEqual([8, 5]);
    expect(stockLogs.map((l) => l.change)).toEqual([-2, -3]);
  });

  it("produto inexistente é ignorado sem quebrar os demais", async () => {
    const { tx, stockLogs } = makeTx({
      "p-2": { id: "p-2", name: "Capô", stock: 4 },
    });

    const { deductions } = await StockDeductionService.deductWithinTx(tx, {
      items: [
        { productId: "p-inexistente", quantity: 1 },
        { productId: "p-2", quantity: 1 },
      ],
      reason: "Venda ML #mix",
    });

    expect(deductions).toHaveLength(1);
    expect(deductions[0]).toMatchObject({ productId: "p-2", newStock: 3 });
    expect(stockLogs).toHaveLength(1);
  });

  it("enfileira StockSyncJob com o estoque NOVO para cada anúncio", async () => {
    const { tx, syncJobs } = makeTx(
      { "p-1": { id: "p-1", name: "Porta", stock: 100 } },
      [
        { id: "l-ml", productId: "p-1", platform: "MERCADO_LIVRE" },
        { id: "l-sh", productId: "p-1", platform: "SHOPEE" },
        { id: "l-mg", productId: "p-1", platform: "MAGALU" },
      ],
    );

    await StockDeductionService.deductWithinTx(tx, {
      items: [{ productId: "p-1", quantity: 1 }],
      reason: "Venda ML #prop",
    });

    expect(syncJobs).toHaveLength(3);
    for (const job of syncJobs) {
      expect(job.create.targetStock).toBe(99);
      expect(job.update.targetStock).toBe(99);
    }
  });
});

describe("restoreWithinTx — multi-unidade", () => {
  it("estoque 7, estorna 3 → 10, com change positivo e sem clamp", async () => {
    const { tx, stockLogs } = makeTx({
      "p-1": { id: "p-1", name: "Bico", stock: 7 },
    });

    const { deductions } = await StockDeductionService.restoreWithinTx(tx, {
      items: [{ productId: "p-1", quantity: 3 }],
      reason: "Estorno venda ML #123",
    });

    expect(deductions[0]).toMatchObject({ previousStock: 7, newStock: 10 });
    expect(stockLogs[0]).toMatchObject({
      change: 3,
      previousStock: 7,
      newStock: 10,
    });
  });

  it("estoque 0, estorna 1 → 1 (caminho de reabertura de anúncio)", async () => {
    const { tx } = makeTx({ "p-1": { id: "p-1", name: "Farol", stock: 0 } });

    const { deductions } = await StockDeductionService.restoreWithinTx(tx, {
      items: [{ productId: "p-1", quantity: 1 }],
      reason: "Estorno venda ML #1",
    });

    expect(deductions[0]).toMatchObject({ previousStock: 0, newStock: 1 });
  });
});

describe("alarme stock.zeroed_in_one_move", () => {
  it("dispara quando produto multi-unidade vai a zero num movimento", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { tx } = makeTx({ "p-1": { id: "p-1", name: "Motor", stock: 50 } });

    await StockDeductionService.deductWithinTx(tx, {
      items: [{ productId: "p-1", quantity: 50 }],
      reason: "Venda balcão (inferida) — anúncios ML inativos",
    });

    const evento = warnSpy.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes("stock.zeroed_in_one_move"));
    expect(evento).toBeTruthy();
    expect(JSON.parse(evento as string)).toMatchObject({
      event: "stock.zeroed_in_one_move",
      productId: "p-1",
      previousStock: 50,
      quantity: 50,
    });
    warnSpy.mockRestore();
  });

  it("NÃO dispara para peça única (1 → 0), que é o caso normal do desmonte", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { tx } = makeTx({ "p-1": { id: "p-1", name: "Farol", stock: 1 } });

    await StockDeductionService.deductWithinTx(tx, {
      items: [{ productId: "p-1", quantity: 1 }],
      reason: "Venda ML #1",
    });

    const evento = warnSpy.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes("stock.zeroed_in_one_move"));
    expect(evento).toBeUndefined();
    warnSpy.mockRestore();
  });

  it("grava SystemLog pós-commit para a zeragem anômala", async () => {
    StockDeductionService.firePostEffects({
      deductions: [
        {
          productId: "p-1",
          productName: "Motor",
          previousStock: 50,
          newStock: 0,
          quantity: 50,
        },
      ],
      logPrefix: "[Test]",
      reason: "Venda balcão (inferida) — anúncios ML inativos",
    });
    await flushSetImmediates();

    expect(logWarningMock).toHaveBeenCalledTimes(1);
    const [action, message, options] = logWarningMock.mock.calls[0];
    expect(action).toBe("STOCK_ZEROED_IN_ONE_MOVE");
    expect(message).toContain("50");
    expect(options.resourceId).toBe("p-1");
    expect(options.details).toMatchObject({
      previousStock: 50,
      newStock: 0,
      quantity: 50,
    });
  });

  it("não grava SystemLog quando a queda é de peça única", async () => {
    StockDeductionService.firePostEffects({
      deductions: [
        {
          productId: "p-1",
          productName: "Farol",
          previousStock: 1,
          newStock: 0,
          quantity: 1,
        },
      ],
      logPrefix: "[Test]",
    });
    await flushSetImmediates();

    expect(logWarningMock).not.toHaveBeenCalled();
  });

  it("venda balcão de 1 unidade num produto de 100 NÃO pausa anúncio", async () => {
    // pauseOnZero é opt-in do caminho balcão. O filtro é estritamente
    // `newStock === 0` — vender 1 de 100 deixa 99 e o anúncio segue ativo.
    StockDeductionService.firePostEffects({
      deductions: [
        {
          productId: "p-1",
          productName: "Parafuso",
          previousStock: 100,
          newStock: 99,
          quantity: 1,
        },
      ],
      logPrefix: "[Test]",
      pauseOnZero: { userId: "u-1" },
    });
    await flushSetImmediates();

    expect(pauseListingsMock).not.toHaveBeenCalled();
    expect(logWarningMock).not.toHaveBeenCalled();
  });

  it("venda balcão que zera peça única continua pausando o anúncio", async () => {
    StockDeductionService.firePostEffects({
      deductions: [
        {
          productId: "p-1",
          productName: "Farol",
          previousStock: 1,
          newStock: 0,
          quantity: 1,
        },
      ],
      logPrefix: "[Test]",
      pauseOnZero: { userId: "u-1" },
    });
    await flushSetImmediates();

    expect(pauseListingsMock).toHaveBeenCalledWith("p-1", "u-1", "paused");
  });

  it("estorno nunca dispara o alarme (restore só aumenta estoque)", async () => {
    StockDeductionService.firePostEffects({
      deductions: [
        {
          productId: "p-1",
          productName: "Farol",
          previousStock: 0,
          newStock: 5,
          quantity: 5,
        },
      ],
      logPrefix: "[Test]",
      reopenOnRefill: { userId: "u-1" },
    });
    await flushSetImmediates();

    expect(logWarningMock).not.toHaveBeenCalled();
  });
});
