import { describe, it, expect, beforeEach, vi } from "vitest";

// ──────────────────────────────────────────────────────────
// Fase 7 — pauseOnZero no StockDeductionService.firePostEffects.
//
// Prova:
//  - SEM pauseOnZero (caminho Order): só dispara runOnce, NÃO toca o
//    ProductUseCase. Preserva o comportamento atual de Order.
//  - COM pauseOnZero (caminho venda balcão): dispara runOnce E pausa cada
//    produto cujo `newStock === 0` via ProductUseCase.pauseListings.
//  - Best-effort: erro em uma pausa não impede a próxima (tolerante a
//    falha parcial por marketplace).
// ──────────────────────────────────────────────────────────

// Stub do StockSyncRetryService — o setImmediate(runOnce) interno faz
// dynamic import desse módulo. vi.mock intercepta pelo path resolvido.
vi.mock("@/app/marketplaces/services/stock-sync-retry.service", () => ({
  StockSyncRetryService: { runOnce: vi.fn().mockResolvedValue(undefined) },
}));

// Stub do ProductUseCase — usado pelo pauseOnZero. Mantemos uma referência
// estável a `pauseListingsMock` em escopo de módulo para que possamos
// asseverar/configurar entre testes (instâncias diferentes do
// ProductUseCase compartilham o mesmo mock).
const pauseListingsMock = vi.fn();
vi.mock("@/app/usecases/product.usercase", () => ({
  ProductUseCase: class {
    pauseListings = pauseListingsMock;
  },
}));

import { StockDeductionService } from "@/app/marketplaces/services/stock-deduction.service";
import { StockSyncRetryService } from "@/app/marketplaces/services/stock-sync-retry.service";

// firePostEffects usa setImmediate + dynamic import + .then() + for-await.
// Múltiplos ticks de setImmediate + microtasks são necessários para que
// todas as chamadas tenham completado antes das nossas asserções.
async function flushSetImmediates(cycles = 10) {
  for (let i = 0; i < cycles; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

const deduction = (overrides: Partial<any> = {}) => ({
  productId: "p-1",
  productName: "Produto",
  previousStock: 5,
  newStock: 4,
  quantity: 1,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  pauseListingsMock.mockResolvedValue({
    success: true,
    message: "ok",
    listingResults: [],
  });
});

describe("StockDeductionService.firePostEffects", () => {
  it("deductions vazias: não dispara runOnce nem pausa", async () => {
    StockDeductionService.firePostEffects({
      deductions: [],
      logPrefix: "[Test]",
      pauseOnZero: { userId: "u-1" },
    });
    await flushSetImmediates();
    expect(StockSyncRetryService.runOnce).not.toHaveBeenCalled();
    expect(pauseListingsMock).not.toHaveBeenCalled();
  });

  it("SEM pauseOnZero (caminho Order): só dispara runOnce, nunca pausa", async () => {
    StockDeductionService.firePostEffects({
      deductions: [
        deduction({ productId: "p-1", newStock: 0 }), // zerou, mas Order não pausa
        deduction({ productId: "p-2", newStock: 3 }),
      ],
      logPrefix: "[OrderUseCase]",
      // pauseOnZero ausente — preserva comportamento de Order.
    });
    await flushSetImmediates();
    expect(StockSyncRetryService.runOnce).toHaveBeenCalledTimes(1);
    expect(pauseListingsMock).not.toHaveBeenCalled();
  });

  it("COM pauseOnZero (caminho balcão): pausa cada produto com newStock===0", async () => {
    StockDeductionService.firePostEffects({
      deductions: [
        deduction({ productId: "p-1", newStock: 0, previousStock: 2 }),
        deduction({ productId: "p-2", newStock: 4 }), // não zerou
        deduction({ productId: "p-3", newStock: 0, previousStock: 1 }),
      ],
      logPrefix: "[FinanceUseCase]",
      pauseOnZero: { userId: "user-owner" },
    });
    await flushSetImmediates();

    expect(StockSyncRetryService.runOnce).toHaveBeenCalledTimes(1);
    // Pausa SÓ os produtos zerados (p-1 e p-3), na ordem das deduções.
    expect(pauseListingsMock).toHaveBeenCalledTimes(2);
    expect(pauseListingsMock).toHaveBeenNthCalledWith(
      1,
      "p-1",
      "user-owner",
      "paused",
    );
    expect(pauseListingsMock).toHaveBeenNthCalledWith(
      2,
      "p-3",
      "user-owner",
      "paused",
    );
  });

  it("COM pauseOnZero mas nenhum produto zerado: não pausa", async () => {
    StockDeductionService.firePostEffects({
      deductions: [
        deduction({ productId: "p-1", newStock: 3 }),
        deduction({ productId: "p-2", newStock: 1 }),
      ],
      logPrefix: "[FinanceUseCase]",
      pauseOnZero: { userId: "u-1" },
    });
    await flushSetImmediates();
    expect(StockSyncRetryService.runOnce).toHaveBeenCalledTimes(1);
    expect(pauseListingsMock).not.toHaveBeenCalled();
  });

  // ── Fase 9 — reopenOnRefill ─────────────────────────────────────────
  it("SEM reopenOnRefill: não reabre, mesmo com produto saindo de zero", async () => {
    StockDeductionService.firePostEffects({
      deductions: [
        deduction({ productId: "p-1", previousStock: 0, newStock: 3 }),
      ],
      logPrefix: "[FinanceUseCase]",
      // reopenOnRefill ausente — pauseListings NUNCA chamado.
    });
    await flushSetImmediates();
    expect(StockSyncRetryService.runOnce).toHaveBeenCalledTimes(1);
    expect(pauseListingsMock).not.toHaveBeenCalled();
  });

  it("COM reopenOnRefill: reabre apenas produtos que saíram de zero (previousStock===0 && newStock>0)", async () => {
    StockDeductionService.firePostEffects({
      deductions: [
        // SAIU de zero → reabre.
        deduction({ productId: "p-refilled", previousStock: 0, newStock: 5 }),
        // estava com estoque, voltou maior → NÃO reabre (não estava pausado).
        deduction({ productId: "p-normal", previousStock: 3, newStock: 6 }),
        // ainda zerado (impossível em restore, mas defensivo) → NÃO reabre.
        deduction({ productId: "p-stayed-zero", previousStock: 0, newStock: 0 }),
      ],
      logPrefix: "[FinanceUseCase]",
      reopenOnRefill: { userId: "user-owner" },
    });
    await flushSetImmediates();

    expect(StockSyncRetryService.runOnce).toHaveBeenCalledTimes(1);
    // Reabre SÓ o que saiu de zero, com status "active".
    expect(pauseListingsMock).toHaveBeenCalledTimes(1);
    expect(pauseListingsMock).toHaveBeenCalledWith(
      "p-refilled",
      "user-owner",
      "active",
    );
  });

  it("pauseOnZero e reopenOnRefill independentes (Order não usa nenhum)", async () => {
    StockDeductionService.firePostEffects({
      deductions: [
        deduction({ productId: "p-1", previousStock: 5, newStock: 0 }),
        deduction({ productId: "p-2", previousStock: 0, newStock: 3 }),
      ],
      logPrefix: "[OrderUseCase]",
      // Nenhum dos dois flags — caminho Order.
    });
    await flushSetImmediates();
    expect(StockSyncRetryService.runOnce).toHaveBeenCalledTimes(1);
    expect(pauseListingsMock).not.toHaveBeenCalled();
  });

  it("best-effort: falha ao pausar UM produto não impede os outros", async () => {
    pauseListingsMock
      .mockRejectedValueOnce(new Error("ML 503"))
      .mockResolvedValueOnce({
        success: true,
        message: "ok",
        listingResults: [],
      });

    StockDeductionService.firePostEffects({
      deductions: [
        deduction({ productId: "p-1", newStock: 0, previousStock: 2 }),
        deduction({ productId: "p-2", newStock: 0, previousStock: 1 }),
      ],
      logPrefix: "[FinanceUseCase]",
      pauseOnZero: { userId: "u-1" },
    });
    await flushSetImmediates();

    // Ambos foram tentados; a falha do p-1 não impediu o p-2.
    expect(pauseListingsMock).toHaveBeenCalledTimes(2);
    expect(pauseListingsMock).toHaveBeenCalledWith("p-1", "u-1", "paused");
    expect(pauseListingsMock).toHaveBeenCalledWith("p-2", "u-1", "paused");
  });
});
