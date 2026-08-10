import { afterEach, describe, expect, it, vi } from "vitest";
import { Platform } from "@prisma/client";

// ──────────────────────────────────────────────────────────
// CASO OBRIGATÓRIO — cancelamento de compra ⇒ anúncio volta ao ar.
//
// O elo que este spec cobre é o DECISIVO e o único que não tinha teste:
//
//   processOrderCancellation
//     → firePostEffects({ reopenOnRefill: { force: true } })
//     → ProductUseCase.pauseListings(id, user, "active", { forceRemote: true })
//     → ListingUseCase.updateListingStatus  ← daqui pra baixo é o que se prova
//         ├─ OLX      : republica (insert com o MESMO id)
//         └─ FACEBOOK : setAvailability("in stock")
//
// tests/order-cancellation.spec.ts cobre a parte de cima (claim, net do
// StockLog, reopenOnRefill) mockando firePostEffects — ou seja, para exatamente
// onde este começa.
// ──────────────────────────────────────────────────────────

import { ProductUseCase } from "@/app/usecases/product.usercase";
import { ListingUseCase } from "@/app/marketplaces/usecases/listing.usercase";
import { ListingRepository } from "@/app/marketplaces/repositories/listing.repository";
import { OlxApiService } from "@/app/marketplaces/services/olx-api.service";
import { FacebookApiService } from "@/app/marketplaces/services/facebook-api.service";
import { MLApiService } from "@/app/marketplaces/services/ml-api.service";

const USER_ID = "user-1";
const PRODUCT_ID = "prod-1";
const SKU = "FAROL-001";

const useCase = new ProductUseCase();

const listingOlx = {
  id: "l-olx",
  externalListingId: SKU,
  status: "paused",
  marketplaceAccount: { platform: Platform.OLX },
};
const listingFb = {
  id: "l-fb",
  externalListingId: SKU,
  status: "paused",
  marketplaceAccount: { platform: Platform.FACEBOOK },
};
const listingMl = {
  id: "l-ml",
  externalListingId: "MLB123",
  status: "paused",
  marketplaceAccount: { platform: Platform.MERCADO_LIVRE },
};

/** Linha completa que updateListingStatus lê via ListingRepository.findById. */
function fullRow(listingId: string) {
  if (listingId === "l-olx") {
    return {
      id: "l-olx",
      externalListingId: SKU,
      status: "paused",
      product: {
        userId: USER_ID,
        sku: SKU,
        name: "Farol Dianteiro Direito",
        description: "Farol em bom estado",
        price: 250,
        imageUrl: "https://cdn.exemplo/1.jpg",
        imageUrls: ["https://cdn.exemplo/1.jpg"],
        stock: 1,
        olxCategoryId: "2101",
      },
      marketplaceAccount: {
        id: "acc-olx",
        platform: Platform.OLX,
        accessToken: "tok-olx",
        olxSellerPhone: "11999998888",
        olxSellerZipcode: "01001000",
      },
    };
  }
  return {
    id: "l-fb",
    externalListingId: SKU,
    status: "paused",
    product: { userId: USER_ID, sku: SKU, name: "Farol", stock: 1, price: 250 },
    marketplaceAccount: {
      id: "acc-fb",
      platform: Platform.FACEBOOK,
      accessToken: "tok-fb",
      fbCatalogId: "cat-do-tenant",
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("cancelamento → anúncio volta ao ar (OLX + Facebook)", () => {
  it("reabre OLX e Facebook do mesmo produto numa única passada", async () => {
    vi.spyOn((useCase as any).productRepository, "findById").mockResolvedValue({
      id: PRODUCT_ID,
    });
    vi.spyOn(useCase as any, "getProductListings").mockResolvedValue([
      listingOlx,
      listingFb,
    ]);
    vi.spyOn(ListingRepository, "findById").mockImplementation(
      async (id: string) => fullRow(id) as any,
    );
    vi.spyOn(ListingRepository, "updateListing").mockResolvedValue({} as any);
    vi.spyOn(ListingRepository, "updateStatus").mockResolvedValue({} as any);

    const submitImport = vi
      .spyOn(OlxApiService, "submitImport")
      .mockResolvedValue({ statusCode: 0 } as any);
    const setAvailability = vi
      .spyOn(FacebookApiService, "setAvailability")
      .mockResolvedValue({} as any);

    const result = await useCase.pauseListings(PRODUCT_ID, USER_ID, "active", {
      forceRemote: true,
    });

    expect(result.success).toBe(true);

    // OLX: re-insere com o MESMO id. Id novo = anúncio DUPLICADO na OLX.
    expect(submitImport).toHaveBeenCalledTimes(1);
    const [, ads] = submitImport.mock.calls[0] as [string, any[]];
    expect(ads[0].id).toBe(SKU);

    // Facebook: volta a "in stock" no catálogo DA CONTA, com a quantidade real.
    expect(setAvailability).toHaveBeenCalledTimes(1);
    const fbArgs = setAvailability.mock.calls[0] as any[];
    expect(fbArgs[2]).toBe("in stock");
    expect(fbArgs[3]).toEqual(
      expect.objectContaining({ catalogId: "cat-do-tenant", quantity: 1 }),
    );
  });

  it("a falha de uma plataforma não impede a outra de voltar ao ar", async () => {
    vi.spyOn((useCase as any).productRepository, "findById").mockResolvedValue({
      id: PRODUCT_ID,
    });
    vi.spyOn(useCase as any, "getProductListings").mockResolvedValue([
      listingOlx,
      listingFb,
    ]);
    vi.spyOn(ListingRepository, "findById").mockImplementation(
      async (id: string) => fullRow(id) as any,
    );
    vi.spyOn(ListingRepository, "updateListing").mockResolvedValue({} as any);
    vi.spyOn(ListingRepository, "updateStatus").mockResolvedValue({} as any);

    // A OLX recusa; o Facebook tem que reabrir mesmo assim.
    vi.spyOn(OlxApiService, "submitImport").mockResolvedValue({
      statusCode: -4,
      statusMessage: "REFUSED_SUSPECT_PRICE",
    } as any);
    const setAvailability = vi
      .spyOn(FacebookApiService, "setAvailability")
      .mockResolvedValue({} as any);

    const result = await useCase.pauseListings(PRODUCT_ID, USER_ID, "active", {
      forceRemote: true,
    });

    expect(setAvailability).toHaveBeenCalledTimes(1);
    const olxRes = result.listingResults.find(
      (r) => r.platform === Platform.OLX,
    );
    const fbRes = result.listingResults.find(
      (r) => r.platform === Platform.FACEBOOK,
    );
    expect(olxRes?.paused).toBe(false);
    expect(fbRes?.paused).toBe(true);
  });

  it("SEM forceRemote e com status local já 'active' ⇒ NENHUMA chamada externa", async () => {
    // Cenário do fast-path de idempotência: é o que deve acontecer quando o
    // produto não ficou zerado e não há nada a reabrir.
    vi.spyOn((useCase as any).productRepository, "findById").mockResolvedValue({
      id: PRODUCT_ID,
    });
    vi.spyOn(useCase as any, "getProductListings").mockResolvedValue([
      { ...listingOlx, status: "active" },
      { ...listingFb, status: "active" },
    ]);
    vi.spyOn(ListingRepository, "findById").mockImplementation(
      async (id: string) => ({ ...fullRow(id), status: "active" }) as any,
    );
    const updateListing = vi
      .spyOn(ListingRepository, "updateListing")
      .mockResolvedValue({} as any);
    const updateStatus = vi
      .spyOn(ListingRepository, "updateStatus")
      .mockResolvedValue({} as any);
    const submitImport = vi
      .spyOn(OlxApiService, "submitImport")
      .mockResolvedValue({ statusCode: 0 } as any);
    const setAvailability = vi
      .spyOn(FacebookApiService, "setAvailability")
      .mockResolvedValue({} as any);

    const result = await useCase.pauseListings(PRODUCT_ID, USER_ID, "active");

    expect(submitImport).not.toHaveBeenCalled();
    expect(setAvailability).not.toHaveBeenCalled();
    expect(updateListing).not.toHaveBeenCalled();
    expect(updateStatus).not.toHaveBeenCalled();
    expect(result.listingResults.every((r) => r.alreadyInState)).toBe(true);
  });

  it("não vaza token: reabrir OLX/Facebook nunca chama a API do Mercado Livre", async () => {
    vi.spyOn((useCase as any).productRepository, "findById").mockResolvedValue({
      id: PRODUCT_ID,
    });
    vi.spyOn(useCase as any, "getProductListings").mockResolvedValue([
      listingOlx,
      listingFb,
    ]);
    vi.spyOn(ListingRepository, "findById").mockImplementation(
      async (id: string) => fullRow(id) as any,
    );
    vi.spyOn(ListingRepository, "updateListing").mockResolvedValue({} as any);
    vi.spyOn(ListingRepository, "updateStatus").mockResolvedValue({} as any);
    vi.spyOn(OlxApiService, "submitImport").mockResolvedValue({
      statusCode: 0,
    } as any);
    vi.spyOn(FacebookApiService, "setAvailability").mockResolvedValue(
      {} as any,
    );
    const mlUpdate = vi
      .spyOn(MLApiService, "updateItem")
      .mockResolvedValue({} as any);

    await useCase.pauseListings(PRODUCT_ID, USER_ID, "active", {
      forceRemote: true,
    });

    expect(mlUpdate).not.toHaveBeenCalled();
  });

  it("o ML continua sendo reaberto pelo mesmo caminho (zero regressão)", async () => {
    vi.spyOn((useCase as any).productRepository, "findById").mockResolvedValue({
      id: PRODUCT_ID,
    });
    vi.spyOn(useCase as any, "getProductListings").mockResolvedValue([
      listingMl,
    ]);
    const updateStatus = vi
      .spyOn(ListingUseCase, "updateListingStatus")
      .mockResolvedValue({ success: true } as any);

    await useCase.pauseListings(PRODUCT_ID, USER_ID, "active", {
      forceRemote: true,
    });

    expect(updateStatus).toHaveBeenCalledWith("l-ml", USER_ID, "active", {
      forceRemote: true,
    });
  });
});
