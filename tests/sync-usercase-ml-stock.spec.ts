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

  it("zera a quantidade remota E pausa o anuncio ativo quando o estoque local chega a zero", async () => {
    const getItemSpy = vi.spyOn(MLApiService, "getItemDetails").mockResolvedValue({
      id: "MLB-1",
      status: "active",
      available_quantity: 1,
    } as any);
    const updateItemSpy = vi.spyOn(MLApiService, "updateItem").mockResolvedValue({
      id: "MLB-1",
      status: "paused",
      available_quantity: 0,
    } as any);
    const updateStockSpy = vi
      .spyOn(MLApiService, "updateItemStock")
      .mockResolvedValue({
        id: "MLB-1",
        status: "paused",
        available_quantity: 0,
      } as any);

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
    // A ordem importa: zerar ANTES de pausar. Se a pausa falhar, a peca ja nao
    // esta vendavel; e o `status: paused` converte o `out_of_stock` que o ML
    // poe sozinho (e desfaz) em `paused_by_seller`, que ele nao toca.
    expect(updateStockSpy).toHaveBeenCalledWith("token-1", "MLB-1", 0);
    expect(updateItemSpy).toHaveBeenCalledWith("token-1", "MLB-1", {
      status: "paused",
    });
    expect(updateStockSpy.mock.invocationCallOrder[0]).toBeLessThan(
      updateItemSpy.mock.invocationCallOrder[0],
    );
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

  // O ML PRESERVA `available_quantity` enquanto o anuncio esta fora do ar.
  // Deixar a quantidade intacta foi o que permitiu que o SKU 33996 (1 unidade)
  // vendesse na Shopee em 01/08 e de novo no ML em 10/09: os dois anuncios
  // estavam `under_review` com quantidade remota 1 e o sync os pulou
  // retornando SUCESSO, apagando o StockSyncJob.
  it.each(["paused", "inactive", "under_review"])(
    "zera a quantidade remota de anuncio %s que mantinha quantidade > 0",
    async (remoteStatus) => {
      vi.spyOn(MLApiService, "getItemDetails").mockResolvedValue({
        id: "MLB-2",
        status: remoteStatus,
        available_quantity: 1,
      } as any);
      const updateItemSpy = vi.spyOn(MLApiService, "updateItem");
      const updateStockSpy = vi
        .spyOn(MLApiService, "updateItemStock")
        .mockResolvedValue({
          id: "MLB-2",
          status: remoteStatus,
          available_quantity: 0,
        } as any);

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

      expect(updateStockSpy).toHaveBeenCalledWith("token-2", "MLB-2", 0);
      // Nao reativa nem mexe no status: so a quantidade.
      expect(updateItemSpy).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        success: true,
        productId: "prod-2",
        externalListingId: "MLB-2",
        previousStock: 1,
        newStock: 0,
      });
      expect(prisma.syncLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            marketplaceAccountId: "acc-2",
            status: "SUCCESS",
            message: expect.stringContaining("Quantidade zerada"),
          }),
        }),
      );
    },
  );

  // Skip legitimo: sem quantidade remota nao ha o que zerar, e uma escrita a
  // toa custaria uma chamada de API por anuncio a cada tick de 15 min.
  it("nao chama a API quando o anuncio fora do ar ja esta com quantidade zero", async () => {
    vi.spyOn(MLApiService, "getItemDetails").mockResolvedValue({
      id: "MLB-4",
      status: "paused",
      available_quantity: 0,
    } as any);
    const updateItemSpy = vi.spyOn(MLApiService, "updateItem");
    const updateStockSpy = vi.spyOn(MLApiService, "updateItemStock");

    const result = await (SyncUseCase as any).syncMLProductStock(
      {
        externalListingId: "MLB-4",
        marketplaceAccount: { id: "acc-4", accessToken: "token-4" },
      },
      { id: "prod-4", name: "Produto 4", stock: 0 },
    );

    expect(updateStockSpy).not.toHaveBeenCalled();
    expect(updateItemSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: true, skipped: true });
  });

  it("kill-switch ML_ZERO_REMOTE_QTY_ON_EMPTY_DISABLED=1 restaura o comportamento anterior", async () => {
    const anterior = process.env.ML_ZERO_REMOTE_QTY_ON_EMPTY_DISABLED;
    process.env.ML_ZERO_REMOTE_QTY_ON_EMPTY_DISABLED = "1";

    try {
      vi.spyOn(MLApiService, "getItemDetails").mockResolvedValue({
        id: "MLB-5",
        status: "paused",
        available_quantity: 1,
      } as any);
      const updateItemSpy = vi.spyOn(MLApiService, "updateItem");
      const updateStockSpy = vi.spyOn(MLApiService, "updateItemStock");

      const result = await (SyncUseCase as any).syncMLProductStock(
        {
          externalListingId: "MLB-5",
          marketplaceAccount: { id: "acc-5", accessToken: "token-5" },
        },
        { id: "prod-5", name: "Produto 5", stock: 0 },
      );

      // Exatamente o contrato antigo: nenhuma escrita, no-op "bem-sucedido"
      // com a quantidade remota preservada e o WARNING de risco.
      expect(updateItemSpy).not.toHaveBeenCalled();
      expect(updateStockSpy).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        success: true,
        previousStock: 1,
        newStock: 1,
      });
      expect(prisma.syncLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: "WARNING",
            message: expect.stringContaining("paused com quantidade remota"),
          }),
        }),
      );
    } finally {
      if (anterior === undefined) {
        delete process.env.ML_ZERO_REMOTE_QTY_ON_EMPTY_DISABLED;
      } else {
        process.env.ML_ZERO_REMOTE_QTY_ON_EMPTY_DISABLED = anterior;
      }
    }
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
