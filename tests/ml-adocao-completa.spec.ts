import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * ListingUseCase.completeAdoptedMLListing — o anúncio ADOTADO pela conferência
 * (o item já existia no ML depois de um timeout) não passou pelo pós-criação.
 * Fecha as duas lacunas que importam: compatibilidade veicular (vai depois do
 * POST, o item nunca a recebeu) e estoque (a quantidade dele é a do momento
 * da criação) — sem reativar nada nem empurrar estoque direto.
 */

const { findUnique } = vi.hoisted(() => ({ findUnique: vi.fn() }));
vi.mock("../app/lib/prisma", () => ({
  default: { product: { findUnique } },
}));

vi.mock("../app/marketplaces/repositories/listing.repository", () => ({
  ListingRepository: { updateCompatDiagnostics: vi.fn(async () => undefined) },
}));

vi.mock("../app/marketplaces/services/ml-api.service", () => ({
  MLApiService: { applyCompatibilitiesVerified: vi.fn() },
}));

vi.mock("../app/marketplaces/services/stock-reconciliation.service", () => ({
  StockReconciliationService: { enqueueListingStockSync: vi.fn(async () => undefined) },
}));

import { ListingUseCase } from "../app/marketplaces/usecases/listing.usercase";
import { ListingRepository } from "../app/marketplaces/repositories/listing.repository";
import { MLApiService } from "../app/marketplaces/services/ml-api.service";
import { StockReconciliationService } from "../app/marketplaces/services/stock-reconciliation.service";

const ARGS = {
  accessToken: "tok",
  itemId: "MLB77",
  listingId: "pl-1",
  productId: "prod-1",
};

const COMPAT_OK = {
  ok: true,
  strategy: "catalog_products",
  requested: 2,
  persisted: 14,
  verified: true,
  unresolved: [],
  errors: [],
  budgetExhausted: false,
  userProductId: null,
  catalogResolved: 14,
};

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.ML_ADOPT_COMPLETE_DISABLED;
  for (const m of ["log", "warn"] as const) vi.spyOn(console, m).mockImplementation(() => {});
  findUnique.mockResolvedValue({
    compatibilityPositions: ["Dianteira", "Esquerda"],
    compatibilities: [
      { brand: "Fiat", model: "Uno", yearFrom: 2010, yearTo: 2014 },
      { brand: "Fiat", model: "Palio", yearFrom: null, yearTo: null },
    ],
  });
  (MLApiService.applyCompatibilitiesVerified as any).mockResolvedValue(COMPAT_OK);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("completeAdoptedMLListing", () => {
  it("envia a compatibilidade do produto ao item adotado (com as posições) e grava o diagnóstico com origin 'adoption'", async () => {
    await ListingUseCase.completeAdoptedMLListing(ARGS);
    expect(MLApiService.applyCompatibilitiesVerified).toHaveBeenCalledWith(
      "tok",
      "MLB77",
      [
        { brand: "Fiat", model: "Uno", yearFrom: 2010, yearTo: 2014 },
        { brand: "Fiat", model: "Palio", yearFrom: null, yearTo: null },
      ],
      ["Dianteira", "Esquerda"],
    );
    const [id, diag] = (ListingRepository.updateCompatDiagnostics as any).mock.calls[0];
    expect(id).toBe("pl-1");
    expect(diag).toMatchObject({ origin: "adoption", persisted: 14, v: 2 });
  });

  it("enfileira o sync de estoque do anúncio pela fila durável (não empurra direto)", async () => {
    await ListingUseCase.completeAdoptedMLListing(ARGS);
    expect(StockReconciliationService.enqueueListingStockSync).toHaveBeenCalledWith(
      "pl-1",
      "prod-1",
    );
  });

  it("produto sem compatibilidade ⇒ não chama o ML (o estoque ainda é enfileirado)", async () => {
    findUnique.mockResolvedValue({ compatibilityPositions: null, compatibilities: [] });
    await ListingUseCase.completeAdoptedMLListing(ARGS);
    expect(MLApiService.applyCompatibilitiesVerified).not.toHaveBeenCalled();
    expect(StockReconciliationService.enqueueListingStockSync).toHaveBeenCalled();
  });

  it("sem posições ⇒ a escada vai sem elas (como na criação)", async () => {
    findUnique.mockResolvedValue({
      compatibilityPositions: [],
      compatibilities: [{ brand: "Fiat", model: "Uno", yearFrom: 2010, yearTo: 2010 }],
    });
    await ListingUseCase.completeAdoptedMLListing(ARGS);
    expect((MLApiService.applyCompatibilitiesVerified as any).mock.calls[0][3]).toBeUndefined();
  });

  it("ML_ADOPT_COMPLETE_DISABLED=1 ⇒ não faz nada", async () => {
    process.env.ML_ADOPT_COMPLETE_DISABLED = "1";
    await ListingUseCase.completeAdoptedMLListing(ARGS);
    expect(MLApiService.applyCompatibilitiesVerified).not.toHaveBeenCalled();
    expect(StockReconciliationService.enqueueListingStockSync).not.toHaveBeenCalled();
  });

  it("id ainda de placeholder ⇒ não faz nada", async () => {
    await ListingUseCase.completeAdoptedMLListing({ ...ARGS, itemId: "PENDING_1" });
    expect(MLApiService.applyCompatibilitiesVerified).not.toHaveBeenCalled();
    expect(StockReconciliationService.enqueueListingStockSync).not.toHaveBeenCalled();
  });

  it("falhas não derrubam nada (best-effort): ML fora do ar, banco, fila", async () => {
    (MLApiService.applyCompatibilitiesVerified as any).mockRejectedValue(new Error("503"));
    (StockReconciliationService.enqueueListingStockSync as any).mockRejectedValue(
      new Error("pool esgotado"),
    );
    await expect(ListingUseCase.completeAdoptedMLListing(ARGS)).resolves.toBeUndefined();
    findUnique.mockRejectedValue(new Error("banco"));
    await expect(ListingUseCase.completeAdoptedMLListing(ARGS)).resolves.toBeUndefined();
  });
});
