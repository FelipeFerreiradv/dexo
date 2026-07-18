import { afterEach, describe, expect, it, vi } from "vitest";
import { Platform } from "@prisma/client";

import { ListingUseCase } from "../listing.usercase";
import { ListingRepository } from "../../repositories/listing.repository";
import { MLApiService } from "../../services/ml-api.service";
import { ShopeeApiService } from "../../services/shopee-api.service";
import { MagaluApiService } from "../../services/magalu-api.service";

const ML_USER_ID = "user-1";
const ML_LISTING_ID = "listing-ml-1";
const SHOPEE_LISTING_ID = "listing-shopee-1";
const MAGALU_LISTING_ID = "listing-magalu-1";

function baseMlListing(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: ML_LISTING_ID,
    externalListingId: "MLB123",
    productId: "prod-1",
    listingType: "gold_special",
    itemCondition: "new",
    hasWarranty: true,
    warrantyUnit: "dias",
    warrantyDuration: 90,
    shippingMode: "me2",
    freeShipping: false,
    localPickup: false,
    manufacturingTime: 5,
    product: { userId: ML_USER_ID },
    marketplaceAccount: {
      platform: Platform.MERCADO_LIVRE,
      accessToken: "tok",
    },
    ...overrides,
  } as any;
}

function baseShopeeListing(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: SHOPEE_LISTING_ID,
    externalListingId: "987654",
    productId: "prod-2",
    product: { userId: ML_USER_ID },
    marketplaceAccount: {
      platform: Platform.SHOPEE,
      accessToken: "tok",
      shopId: 42,
    },
    ...overrides,
  } as any;
}

function baseMagaluListing(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: MAGALU_LISTING_ID,
    externalListingId: "SKU-MG-1",
    externalSku: "SKU-MG-1",
    productId: "prod-3",
    product: { userId: ML_USER_ID, sku: "SKU-MG-1" },
    marketplaceAccount: {
      id: "acc-mg-1",
      platform: Platform.MAGALU,
      accessToken: "tok-mg",
      refreshToken: null,
      // expiresAt null ⇒ token considerado válido (sem refresh OAuth no teste)
      expiresAt: null,
    },
    ...overrides,
  } as any;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ListingUseCase.updateListingFields — ML defesa em profundidade", () => {
  it("não envia shipping/warranty/sale_terms quando settings batem com listing (caso preço-only)", async () => {
    const listing = baseMlListing();
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(listing);
    vi.spyOn(ListingRepository, "updateListing").mockResolvedValue(
      undefined as any,
    );
    const updateItem = vi
      .spyOn(MLApiService, "updateItem")
      .mockResolvedValue({} as any);

    const result = await ListingUseCase.updateListingFields(
      ML_LISTING_ID,
      ML_USER_ID,
      {
        // Usuário só mudou o preço — outros settings vêm iguais ao listing
        priceOverride: 199.9,
        listingType: listing.listingType,
        itemCondition: listing.itemCondition,
        hasWarranty: listing.hasWarranty,
        warrantyUnit: listing.warrantyUnit,
        warrantyDuration: listing.warrantyDuration,
        shippingMode: listing.shippingMode,
        freeShipping: listing.freeShipping,
        localPickup: listing.localPickup,
        manufacturingTime: listing.manufacturingTime,
      },
    );

    expect(result.success).toBe(true);
    expect(updateItem).toHaveBeenCalledTimes(1);
    const sent = updateItem.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(sent.price).toBe(199.9);
    expect(sent).not.toHaveProperty("shipping");
    expect(sent).not.toHaveProperty("warranty");
    expect(sent).not.toHaveProperty("sale_terms");
    expect(sent).not.toHaveProperty("condition");
  });

  it("envia shipping quando shippingMode realmente mudou", async () => {
    const listing = baseMlListing();
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(listing);
    vi.spyOn(ListingRepository, "updateListing").mockResolvedValue(
      undefined as any,
    );
    const updateItem = vi
      .spyOn(MLApiService, "updateItem")
      .mockResolvedValue({} as any);

    await ListingUseCase.updateListingFields(ML_LISTING_ID, ML_USER_ID, {
      shippingMode: "me1",
    });

    const sent = updateItem.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(sent.shipping).toEqual({ mode: "me1" });
  });

  it("retry remove shipping do payload quando ML rejeita com field_not_modifiable", async () => {
    const listing = baseMlListing({ shippingMode: "me1" });
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(listing);
    vi.spyOn(ListingRepository, "updateListing").mockResolvedValue(
      undefined as any,
    );
    vi.spyOn(console, "error").mockImplementation(() => {});

    const updateItem = vi
      .spyOn(MLApiService, "updateItem")
      .mockImplementationOnce(async () => {
        throw new Error("field_not_updatable: shipping is not modifiable");
      })
      .mockResolvedValueOnce({} as any);

    const result = await ListingUseCase.updateListingFields(
      ML_LISTING_ID,
      ML_USER_ID,
      {
        priceOverride: 99.9,
        shippingMode: "me2",
      },
    );

    expect(result.success).toBe(true);
    expect(updateItem).toHaveBeenCalledTimes(2);
    const firstCall = updateItem.mock.calls[0]?.[2] as Record<string, unknown>;
    const secondCall = updateItem.mock.calls[1]?.[2] as Record<string, unknown>;
    expect(firstCall).toHaveProperty("shipping");
    expect(secondCall).not.toHaveProperty("shipping");
    expect(secondCall.price).toBe(99.9);
  });
});

describe("ListingUseCase.updateListingFields — Shopee", () => {
  it("rejeita priceOverride não-numérico ou não-positivo", async () => {
    const listing = baseShopeeListing();
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(listing);
    const updateItem = vi
      .spyOn(ShopeeApiService, "updateItem")
      .mockResolvedValue({ item_id: 1 } as any);

    const r1 = await ListingUseCase.updateListingFields(
      SHOPEE_LISTING_ID,
      ML_USER_ID,
      { priceOverride: Number.NaN },
    );
    expect(r1.success).toBe(false);
    expect(r1.error).toMatch(/Preço inválido/);
    expect(updateItem).not.toHaveBeenCalled();

    const r2 = await ListingUseCase.updateListingFields(
      SHOPEE_LISTING_ID,
      ML_USER_ID,
      { priceOverride: -10 },
    );
    expect(r2.success).toBe(false);
    expect(r2.error).toMatch(/Preço inválido/);
    expect(updateItem).not.toHaveBeenCalled();
  });

  it("envia preço via updatePrice (endpoint dedicado), NÃO via updateItem", async () => {
    const listing = baseShopeeListing();
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(listing);
    vi.spyOn(ListingRepository, "updateListing").mockResolvedValue(
      undefined as any,
    );
    // getItemBaseInfo: anúncio sem variações (has_model=false)
    vi.spyOn(ShopeeApiService, "getItemBaseInfo").mockResolvedValue({
      has_model: false,
      status: "NORMAL",
      price_info: [{ current_price: 30 }],
    } as any);
    const updateItem = vi
      .spyOn(ShopeeApiService, "updateItem")
      .mockResolvedValue({ item_id: 1 } as any);
    const updatePrice = vi
      .spyOn(ShopeeApiService, "updatePrice")
      .mockResolvedValue(undefined as any);

    const result = await ListingUseCase.updateListingFields(
      SHOPEE_LISTING_ID,
      ML_USER_ID,
      { priceOverride: 49.5 },
    );

    expect(result.success).toBe(true);
    // Sem outros campos, updateItem NÃO deve ser chamado.
    expect(updateItem).not.toHaveBeenCalled();
    // updatePrice deve receber price_list com original_price 49.5.
    expect(updatePrice).toHaveBeenCalledTimes(1);
    const [, , itemId, priceList] = updatePrice.mock.calls[0] ?? [];
    expect(itemId).toBe(987654);
    expect(priceList).toEqual([{ original_price: 49.5 }]);
  });

  it("anúncio com variações (has_model): price_list carrega uma entrada por model_id", async () => {
    const listing = baseShopeeListing();
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(listing);
    vi.spyOn(ListingRepository, "updateListing").mockResolvedValue(
      undefined as any,
    );
    vi.spyOn(ShopeeApiService, "getItemBaseInfo").mockResolvedValue({
      has_model: true,
      status: "NORMAL",
      model_list: [{ model_id: 11 }, { model_id: 22 }],
    } as any);
    const updatePrice = vi
      .spyOn(ShopeeApiService, "updatePrice")
      .mockResolvedValue(undefined as any);

    const result = await ListingUseCase.updateListingFields(
      SHOPEE_LISTING_ID,
      ML_USER_ID,
      { priceOverride: 77.7 },
    );

    expect(result.success).toBe(true);
    expect(updatePrice).toHaveBeenCalledTimes(1);
    const [, , , priceList] = updatePrice.mock.calls[0] ?? [];
    expect(priceList).toEqual([
      { model_id: 11, original_price: 77.7 },
      { model_id: 22, original_price: 77.7 },
    ]);
  });
});

describe("ListingUseCase.updateListingFields — Magalu (priceOverride)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("persiste priceOverride e empurra via setPrice (canal do env)", async () => {
    vi.stubEnv("MAGALU_DEFAULT_CHANNEL_ID", "chan-1");
    const listing = baseMagaluListing();
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(listing);
    const persist = vi
      .spyOn(ListingRepository, "updateListing")
      .mockResolvedValue(undefined as any);
    const patchSku = vi
      .spyOn(MagaluApiService, "patchSku")
      .mockResolvedValue(undefined as any);
    const setPrice = vi
      .spyOn(MagaluApiService, "setPrice")
      .mockResolvedValue(undefined as any);

    const result = await ListingUseCase.updateListingFields(
      MAGALU_LISTING_ID,
      ML_USER_ID,
      { priceOverride: 110 },
    );

    expect(result.success).toBe(true);
    // Persistência cirúrgica ANTES do push (self-healing via sync se o push falhar).
    expect(persist).toHaveBeenCalledWith(MAGALU_LISTING_ID, {
      priceOverride: 110,
    });
    expect(setPrice).toHaveBeenCalledTimes(1);
    expect(setPrice).toHaveBeenCalledWith("tok-mg", "SKU-MG-1", 110, "chan-1");
    // Sem title/description, o PATCH de SKU não é chamado.
    expect(patchSku).not.toHaveBeenCalled();
  });

  it("rejeita priceOverride não-numérico ou não-positivo sem nenhum efeito colateral", async () => {
    const listing = baseMagaluListing();
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(listing);
    const persist = vi
      .spyOn(ListingRepository, "updateListing")
      .mockResolvedValue(undefined as any);
    const setPrice = vi
      .spyOn(MagaluApiService, "setPrice")
      .mockResolvedValue(undefined as any);
    const patchSku = vi
      .spyOn(MagaluApiService, "patchSku")
      .mockResolvedValue(undefined as any);

    for (const bad of [Number.NaN, 0, -10]) {
      const r = await ListingUseCase.updateListingFields(
        MAGALU_LISTING_ID,
        ML_USER_ID,
        { priceOverride: bad },
      );
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/Preço inválido/);
    }
    expect(persist).not.toHaveBeenCalled();
    expect(setPrice).not.toHaveBeenCalled();
    expect(patchSku).not.toHaveBeenCalled();
  });

  it("sem canal resolvível ⇒ erro claro; persistiu antes (sync reaplica) mas NÃO chama setPrice", async () => {
    vi.stubEnv("MAGALU_DEFAULT_CHANNEL_ID", "");
    const listing = baseMagaluListing();
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(listing);
    const persist = vi
      .spyOn(ListingRepository, "updateListing")
      .mockResolvedValue(undefined as any);
    vi.spyOn(MagaluApiService, "getChannels").mockResolvedValue([]);
    const setPrice = vi
      .spyOn(MagaluApiService, "setPrice")
      .mockResolvedValue(undefined as any);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await ListingUseCase.updateListingFields(
      MAGALU_LISTING_ID,
      ML_USER_ID,
      { priceOverride: 110 },
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/canal|MAGALU_DEFAULT_CHANNEL_ID/i);
    expect(persist).toHaveBeenCalledWith(MAGALU_LISTING_ID, {
      priceOverride: 110,
    });
    expect(setPrice).not.toHaveBeenCalled();
  });

  it("sem priceOverride ⇒ comportamento atual intacto (só patchSku de título)", async () => {
    const listing = baseMagaluListing();
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(listing);
    const persist = vi
      .spyOn(ListingRepository, "updateListing")
      .mockResolvedValue(undefined as any);
    const patchSku = vi
      .spyOn(MagaluApiService, "patchSku")
      .mockResolvedValue(undefined as any);
    const setPrice = vi
      .spyOn(MagaluApiService, "setPrice")
      .mockResolvedValue(undefined as any);

    const result = await ListingUseCase.updateListingFields(
      MAGALU_LISTING_ID,
      ML_USER_ID,
      { titleOverride: "Novo título" },
    );

    expect(result.success).toBe(true);
    expect(patchSku).toHaveBeenCalledWith("tok-mg", "SKU-MG-1", {
      title: "Novo título",
    });
    expect(persist).not.toHaveBeenCalled();
    expect(setPrice).not.toHaveBeenCalled();
  });
});
