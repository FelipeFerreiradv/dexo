import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import prisma from "@/app/lib/prisma";
import { MLApiService } from "@/app/marketplaces/services/ml-api.service";
import { SyncUseCase } from "@/app/marketplaces/usecases/sync.usercase";

describe("SyncUseCase ML stock sync by listing status", () => {
  beforeEach(() => {
    vi.spyOn(prisma.syncLog, "create").mockResolvedValue({} as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("pausa anuncio ativo no ML quando o estoque local chega a zero", async () => {
    const getItemSpy = vi.spyOn(MLApiService, "getItemDetails").mockResolvedValue({
      id: "MLB-1",
      status: "active",
      available_quantity: 1,
    } as any);
    const updateItemSpy = vi.spyOn(MLApiService, "updateItem").mockResolvedValue({
      id: "MLB-1",
      status: "paused",
      available_quantity: 1,
    } as any);
    const updateStockSpy = vi.spyOn(MLApiService, "updateItemStock");

    const result = await (SyncUseCase as any).syncMLProductStock(
      {
        externalListingId: "MLB-1",
        marketplaceAccount: {
          id: "acc-1",
          accessToken: "token-1",
        },
      },
      {
        id: "prod-1",
        name: "Produto 1",
        stock: 0,
      },
    );

    expect(getItemSpy).toHaveBeenCalledWith("token-1", "MLB-1");
    expect(updateItemSpy).toHaveBeenCalledWith("token-1", "MLB-1", {
      status: "paused",
    });
    expect(updateStockSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: true,
      productId: "prod-1",
      externalListingId: "MLB-1",
      previousStock: 1,
      newStock: 0,
    });
    expect(prisma.syncLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          marketplaceAccountId: "acc-1",
          status: "SUCCESS",
        }),
      }),
    );
  });

  it("trata anuncio pausado com estoque local zero como no-op bem-sucedido", async () => {
    vi.spyOn(MLApiService, "getItemDetails").mockResolvedValue({
      id: "MLB-2",
      status: "paused",
      available_quantity: 1,
    } as any);
    const updateItemSpy = vi.spyOn(MLApiService, "updateItem");
    const updateStockSpy = vi.spyOn(MLApiService, "updateItemStock");

    const result = await (SyncUseCase as any).syncMLProductStock(
      {
        externalListingId: "MLB-2",
        marketplaceAccount: {
          id: "acc-2",
          accessToken: "token-2",
        },
      },
      {
        id: "prod-2",
        name: "Produto 2",
        stock: 0,
      },
    );

    expect(updateItemSpy).not.toHaveBeenCalled();
    expect(updateStockSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: true,
      productId: "prod-2",
      externalListingId: "MLB-2",
      previousStock: 1,
      newStock: 1,
    });
    expect(prisma.syncLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          marketplaceAccountId: "acc-2",
          status: "WARNING",
          message: expect.stringContaining("já está paused"),
        }),
      }),
    );
  });

  it("ignora anuncio fechado no ML sem contaminar o sync como falha", async () => {
    vi.spyOn(MLApiService, "getItemDetails").mockResolvedValue({
      id: "MLB-3",
      status: "closed",
      available_quantity: 0,
    } as any);
    const updateItemSpy = vi.spyOn(MLApiService, "updateItem");
    const updateStockSpy = vi.spyOn(MLApiService, "updateItemStock");

    const result = await (SyncUseCase as any).syncMLProductStock(
      {
        externalListingId: "MLB-3",
        marketplaceAccount: {
          id: "acc-3",
          accessToken: "token-3",
        },
      },
      {
        id: "prod-3",
        name: "Produto 3",
        stock: 1,
      },
    );

    expect(updateItemSpy).not.toHaveBeenCalled();
    expect(updateStockSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: true,
      productId: "prod-3",
      externalListingId: "MLB-3",
      previousStock: 0,
      newStock: 0,
    });
    expect(prisma.syncLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          marketplaceAccountId: "acc-3",
          status: "WARNING",
          message: expect.stringContaining("está fechado"),
        }),
      }),
    );
  });
});
