import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import prisma from "@/app/lib/prisma";
import { MLApiService } from "@/app/marketplaces/services/ml-api.service";
import { ShopeeApiService } from "@/app/marketplaces/services/shopee-api.service";
import { ListingRepository } from "@/app/marketplaces/repositories/listing.repository";
import { SyncUseCase } from "@/app/marketplaces/usecases/sync.usercase";

const mlListing = (over: Record<string, any> = {}) => ({
  id: "lst-1",
  externalListingId: "MLB-1",
  status: "active",
  marketplaceAccount: {
    id: "acc-1",
    accessToken: "token-1",
  },
  ...over,
});

const shopeeListing = (over: Record<string, any> = {}) => ({
  id: "lst-s",
  externalListingId: "111",
  status: "active",
  marketplaceAccount: {
    id: "acc-s",
    accessToken: "tok-s",
    refreshToken: "ref-s",
    shopId: 999,
  },
  ...over,
});

describe("SyncUseCase — espelho de status nos stock-syncs", () => {
  beforeEach(() => {
    process.env.LISTING_STATUS_SYNC_DISABLED = "0";
    vi.spyOn(prisma.syncLog, "create").mockResolvedValue({} as any);
  });

  afterEach(() => {
    process.env.LISTING_STATUS_SYNC_DISABLED = "1"; // default da suíte
    vi.restoreAllMocks();
  });

  it("ML: remoto closed → grava closed local e mantém o retorno skipped inalterado", async () => {
    vi.spyOn(MLApiService, "getItemDetails").mockResolvedValue({
      id: "MLB-1",
      status: "closed",
      available_quantity: 0,
    } as any);
    const update = vi
      .spyOn(ListingRepository, "updateStatus")
      .mockResolvedValue({} as any);

    const result = await (SyncUseCase as any).syncMLProductStock(
      mlListing(),
      { id: "prod-1", name: "Produto 1", stock: 1 },
    );

    expect(update).toHaveBeenCalledWith("lst-1", "closed");
    expect(result).toMatchObject({
      success: true,
      skipped: true,
      skipReason: "ml_status_closed",
    });
  });

  it("ML: estoque 0 + remoto active → pausa remota pré-existente E status local final paused", async () => {
    vi.spyOn(MLApiService, "getItemDetails").mockResolvedValue({
      id: "MLB-1",
      status: "active",
      available_quantity: 1,
    } as any);
    const updateItem = vi
      .spyOn(MLApiService, "updateItem")
      .mockResolvedValue({ id: "MLB-1", status: "paused" } as any);
    const update = vi
      .spyOn(ListingRepository, "updateStatus")
      .mockResolvedValue({} as any);

    const result = await (SyncUseCase as any).syncMLProductStock(
      mlListing({ status: "active" }),
      { id: "prod-1", name: "Produto 1", stock: 0 },
    );

    expect(updateItem).toHaveBeenCalledWith("token-1", "MLB-1", {
      status: "paused",
    });
    // 1º mirror (remoto "active" == local "active") não escreve; o 2º, pós-
    // pausa remota, grava o valor novo.
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith("lst-1", "paused");
    expect(result).toMatchObject({ success: true, newStock: 0 });
  });

  it("ML: falha ao gravar status local não contamina o sync", async () => {
    vi.spyOn(MLApiService, "getItemDetails").mockResolvedValue({
      id: "MLB-1",
      status: "paused",
      available_quantity: 0,
    } as any);
    vi.spyOn(MLApiService, "updateItemStock").mockResolvedValue({} as any);
    vi.spyOn(ListingRepository, "updateStatus").mockRejectedValue(
      new Error("db down"),
    );

    const result = await (SyncUseCase as any).syncMLProductStock(
      mlListing(),
      { id: "prod-1", name: "Produto 1", stock: 3 },
    );

    expect(result.success).toBe(true);
  });

  it("ML: kill-switch ligado → zero writes de status", async () => {
    process.env.LISTING_STATUS_SYNC_DISABLED = "1";
    vi.spyOn(MLApiService, "getItemDetails").mockResolvedValue({
      id: "MLB-1",
      status: "closed",
      available_quantity: 0,
    } as any);
    const update = vi.spyOn(ListingRepository, "updateStatus");

    await (SyncUseCase as any).syncMLProductStock(mlListing(), {
      id: "prod-1",
      name: "Produto 1",
      stock: 1,
    });

    expect(update).not.toHaveBeenCalled();
  });

  it("ML: listing sem id (chamadores legados) → mirror vira no-op silencioso", async () => {
    vi.spyOn(MLApiService, "getItemDetails").mockResolvedValue({
      id: "MLB-1",
      status: "closed",
      available_quantity: 0,
    } as any);
    const update = vi.spyOn(ListingRepository, "updateStatus");

    const result = await (SyncUseCase as any).syncMLProductStock(
      mlListing({ id: undefined }),
      { id: "prod-1", name: "Produto 1", stock: 1 },
    );

    expect(update).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: true, skipped: true });
  });

  it("Shopee: item_status UNLIST → grava unlist e o sync de estoque segue", async () => {
    vi.spyOn(ShopeeApiService, "getItemBaseInfo").mockResolvedValue({
      item_id: 111,
      item_status: "UNLIST",
      has_model: false,
    } as any);
    const updateStock = vi
      .spyOn(ShopeeApiService, "updateItemStock")
      .mockResolvedValue({} as any);
    const update = vi
      .spyOn(ListingRepository, "updateStatus")
      .mockResolvedValue({} as any);

    const result = await (SyncUseCase as any).syncShopeeProductStock(
      shopeeListing(),
      { id: "prod-s", name: "Produto S", stock: 2 },
    );

    expect(update).toHaveBeenCalledWith("lst-s", "unlist");
    expect(updateStock).toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  it("Shopee: has_model sem model_id → mirror roda E o erro pré-existente se mantém", async () => {
    vi.spyOn(ShopeeApiService, "getItemBaseInfo").mockResolvedValue({
      item_id: 222,
      item_status: "BANNED",
      has_model: true,
    } as any);
    const update = vi
      .spyOn(ListingRepository, "updateStatus")
      .mockResolvedValue({} as any);

    const result = await (SyncUseCase as any).syncShopeeProductStock(
      shopeeListing({ externalListingId: "222" }),
      { id: "prod-s", name: "Produto S", stock: 2 },
    );

    expect(update).toHaveBeenCalledWith("lst-s", "banned");
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/variações/);
  });

  it("Shopee: NORMAL (== active local) → nenhum write", async () => {
    vi.spyOn(ShopeeApiService, "getItemBaseInfo").mockResolvedValue({
      item_id: 111,
      item_status: "NORMAL",
      has_model: false,
    } as any);
    vi.spyOn(ShopeeApiService, "updateItemStock").mockResolvedValue({} as any);
    const update = vi.spyOn(ListingRepository, "updateStatus");

    const result = await (SyncUseCase as any).syncShopeeProductStock(
      shopeeListing({ status: "active" }),
      { id: "prod-s", name: "Produto S", stock: 2 },
    );

    expect(update).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
  });
});
