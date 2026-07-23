import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Autoria em anúncios (ProductListing.createdByUserId):
 * - ListingRepository.createListing grava o autor quando informado; NULL sem.
 * - upsertListing só grava no branch `create` (autoria = primeira criação;
 *   retries/updates NUNCA sobrescrevem o autor original).
 * - ListingDispatcher repassa o actorId (já existente no input) aos
 *   createXListing — single (runOne) e batch (runOneWithResult).
 */

const { mockListingCreate, mockListingUpsert } = vi.hoisted(() => ({
  mockListingCreate: vi.fn(),
  mockListingUpsert: vi.fn(),
}));

vi.mock("../app/lib/prisma", () => ({
  default: {
    productListing: { create: mockListingCreate, upsert: mockListingUpsert },
  },
}));

const { mockCreateML, mockCreateShopee, mockCreateMagalu } = vi.hoisted(() => ({
  mockCreateML: vi.fn(),
  mockCreateShopee: vi.fn(),
  mockCreateMagalu: vi.fn(),
}));

vi.mock("../app/marketplaces/usecases/listing.usercase", () => ({
  ListingUseCase: {
    createMLListing: mockCreateML,
    createShopeeListing: mockCreateShopee,
    createMagaluListing: mockCreateMagalu,
    updateListingFields: vi.fn(),
  },
}));

vi.mock("../app/services/system-log.service", () => ({
  SystemLogService: {
    log: vi.fn(),
    logError: vi.fn(),
    logListingCreate: vi.fn(),
  },
}));

import { ListingRepository } from "../app/marketplaces/repositories/listing.repository";
import { ListingDispatcher } from "../app/marketplaces/services/listing-dispatcher.service";

beforeEach(() => {
  vi.clearAllMocks();
  mockListingCreate.mockResolvedValue({ id: "l-1" });
  mockListingUpsert.mockResolvedValue({ id: "l-1" });
  mockCreateML.mockResolvedValue({ success: true, listingId: "l-1" });
  mockCreateShopee.mockResolvedValue({ success: true, listingId: "l-2" });
  mockCreateMagalu.mockResolvedValue({ success: true, listingId: "l-3" });
});

describe("ListingRepository — createdByUserId", () => {
  const baseCreate = {
    productId: "prod-1",
    marketplaceAccountId: "acc-1",
    externalListingId: "PENDING_1",
    status: "pending",
  };

  it("createListing grava o autor quando informado", async () => {
    await ListingRepository.createListing({
      ...baseCreate,
      createdByUserId: "collab-1",
    });

    expect(mockListingCreate.mock.calls[0][0].data.createdByUserId).toBe(
      "collab-1",
    );
  });

  it("createListing sem autor: NULL (fluxo de sistema idêntico ao atual)", async () => {
    await ListingRepository.createListing({ ...baseCreate });

    expect(mockListingCreate.mock.calls[0][0].data.createdByUserId).toBeNull();
  });

  it("upsertListing: autor SÓ no branch create — update nunca sobrescreve", async () => {
    await ListingRepository.upsertListing({
      productId: "prod-1",
      marketplaceAccountId: "acc-1",
      externalListingId: "SKU-1",
      status: "active",
      createdByUserId: "collab-1",
    });

    const arg = mockListingUpsert.mock.calls[0][0];
    expect(arg.create.createdByUserId).toBe("collab-1");
    // Autoria = primeira criação: retry de sistema que cai no update não pode
    // apagar nem trocar o autor original.
    expect("createdByUserId" in arg.update).toBe(false);
  });
});

describe("ListingDispatcher — threading do actorId até os createXListing", () => {
  const dispatchWith = (
    platform: "MERCADO_LIVRE" | "SHOPEE" | "MAGALU",
    actorId?: string,
  ) =>
    ListingDispatcher.dispatch({
      userId: "owner-1",
      productId: "prod-1",
      requests: [{ platform, accountId: "acc-1", categoryId: "CAT-1" }],
      actorId,
    });

  it("ML: actorId chega como 7º argumento (após titleOverride)", async () => {
    dispatchWith("MERCADO_LIVRE", "collab-1");

    await vi.waitFor(() => expect(mockCreateML).toHaveBeenCalled());
    expect(mockCreateML).toHaveBeenCalledWith(
      "owner-1",
      "prod-1",
      "CAT-1",
      "acc-1",
      undefined, // mlSettings
      undefined, // titleOverride
      "collab-1",
    );
  });

  it("Shopee: actorId chega como 5º argumento", async () => {
    dispatchWith("SHOPEE", "collab-1");

    await vi.waitFor(() => expect(mockCreateShopee).toHaveBeenCalled());
    expect(mockCreateShopee).toHaveBeenCalledWith(
      "owner-1",
      "prod-1",
      "CAT-1",
      "acc-1",
      "collab-1",
    );
  });

  it("Magalu: actorId chega como 5º argumento", async () => {
    dispatchWith("MAGALU", "collab-1");

    await vi.waitFor(() => expect(mockCreateMagalu).toHaveBeenCalled());
    expect(mockCreateMagalu).toHaveBeenCalledWith(
      "owner-1",
      "prod-1",
      "CAT-1",
      "acc-1",
      "collab-1",
    );
  });

  it("sem ator (fluxo de sistema): repassa undefined — autor fica NULL lá embaixo", async () => {
    dispatchWith("MERCADO_LIVRE", undefined);

    await vi.waitFor(() => expect(mockCreateML).toHaveBeenCalled());
    expect(mockCreateML.mock.calls[0][6]).toBeUndefined();
  });

  it("batch (runOneWithResult): actorId flui igual ao single", async () => {
    await ListingDispatcher.runOneWithResult(
      "owner-1",
      "prod-1",
      { platform: "MERCADO_LIVRE", accountId: "acc-1", categoryId: "CAT-1" },
      null,
      undefined,
      "collab-1",
    );

    expect(mockCreateML).toHaveBeenCalledWith(
      "owner-1",
      "prod-1",
      "CAT-1",
      "acc-1",
      undefined,
      undefined,
      "collab-1",
    );
  });
});
