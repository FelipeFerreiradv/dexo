import { afterEach, describe, expect, it, vi } from "vitest";
import { Platform } from "@prisma/client";

import { ListingUseCase } from "../listing.usercase";
import { ListingRepository } from "../../repositories/listing.repository";
import { OlxApiService } from "../../services/olx-api.service";

const USER_ID = "user-1";
const OLX_LISTING_ID = "listing-olx-1";
const OLX_ID = "SKU-OLX-1";

/**
 * Reativação OLX — o caminho do CANCELAMENTO DE PEDIDO.
 *
 * Na OLX não existe pausa: pausar é excluir e reativar é RECRIAR o anúncio
 * inteiro. Logo a reativação carrega as mesmas invariantes da publicação
 * original, e cada uma delas é um caso aqui.
 */
function baseOlxListing(overrides: Record<string, unknown> = {}) {
  return {
    id: OLX_LISTING_ID,
    externalListingId: OLX_ID,
    // Status local "paused": é o estado após a peça ter sido vendida.
    status: "paused",
    product: {
      userId: USER_ID,
      sku: OLX_ID,
      name: "Farol Dianteiro Direito",
      description: "Farol em bom estado",
      price: 250,
      imageUrl: "https://cdn.exemplo/1.jpg",
      imageUrls: ["https://cdn.exemplo/1.jpg"],
      olxCategoryId: "2101",
    },
    marketplaceAccount: {
      id: "acc-olx-1",
      platform: Platform.OLX,
      accessToken: "tok-olx",
      olxSellerPhone: "11999998888",
      olxSellerZipcode: "01001000",
    },
    ...overrides,
  } as any;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ListingUseCase.updateListingStatus — OLX reativar", () => {
  it("republica com o MESMO id — id novo criaria anúncio duplicado na OLX", async () => {
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(
      baseOlxListing(),
    );
    vi.spyOn(ListingRepository, "updateListing").mockResolvedValue({} as any);
    const submitImport = vi
      .spyOn(OlxApiService, "submitImport")
      .mockResolvedValue({ statusCode: 0 } as any);

    const result = await ListingUseCase.updateListingStatus(
      OLX_LISTING_ID,
      USER_ID,
      "active",
    );

    expect(result.success).toBe(true);
    expect(submitImport).toHaveBeenCalledTimes(1);
    const [, ads] = submitImport.mock.calls[0] as [string, any[]];
    expect(ads[0].id).toBe(OLX_ID);
    expect(ads[0].operation).toBe("insert");
  });

  it("aplica os overrides do anúncio: volta com o preço e o título editados", async () => {
    // Cenário real: o operador definiu preço escalonado para esta conta e um
    // título próprio. A republicação não pode devolver o anúncio ao ar com os
    // valores base do produto.
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(
      baseOlxListing({
        priceOverride: 399,
        titleOverride: "Farol Dianteiro Direito — Original",
      }),
    );
    vi.spyOn(ListingRepository, "updateListing").mockResolvedValue({} as any);
    const submitImport = vi
      .spyOn(OlxApiService, "submitImport")
      .mockResolvedValue({ statusCode: 0 } as any);

    await ListingUseCase.updateListingStatus(OLX_LISTING_ID, USER_ID, "active");

    const [, ads] = submitImport.mock.calls[0] as [string, any[]];
    expect(ads[0].price).toBe(399);
    expect(ads[0].Subject).toContain("Original");
  });

  it("usa o olxCategoryOverride do anúncio em vez do de-para automático", async () => {
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(
      baseOlxListing({ olxCategoryOverride: "2103" }),
    );
    vi.spyOn(ListingRepository, "updateListing").mockResolvedValue({} as any);
    const submitImport = vi
      .spyOn(OlxApiService, "submitImport")
      .mockResolvedValue({ statusCode: 0 } as any);

    await ListingUseCase.updateListingStatus(OLX_LISTING_ID, USER_ID, "active");

    const [, ads] = submitImport.mock.calls[0] as [string, any[]];
    expect(ads[0].category).toBe(2103);
  });

  it("poll 'refused' ⇒ falha e NÃO grava 'active' (anúncio não voltou ao ar)", async () => {
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(
      baseOlxListing(),
    );
    const updateListing = vi
      .spyOn(ListingRepository, "updateListing")
      .mockResolvedValue({} as any);
    vi.spyOn(OlxApiService, "submitImport").mockResolvedValue({
      statusCode: 0,
      token: "tok-import",
    } as any);
    vi.spyOn(OlxApiService, "pollImportUntilDone").mockResolvedValue({
      ads: { [OLX_ID]: { status: "refused", message: ["REFUSED_SUSPECT_PRICE"] } },
    } as any);

    const result = await ListingUseCase.updateListingStatus(
      OLX_LISTING_ID,
      USER_ID,
      "active",
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/recusou/i);
    // O ponto do teste: sem o poll, o Dexo gravava "ativo" para um anúncio
    // que a OLX rejeitou, e o vendedor achava que tinha voltado ao ar.
    expect(updateListing).not.toHaveBeenCalled();
  });

  it("poll aceito ⇒ repopula olxListId e permalink reais", async () => {
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(
      baseOlxListing(),
    );
    const updateListing = vi
      .spyOn(ListingRepository, "updateListing")
      .mockResolvedValue({} as any);
    vi.spyOn(OlxApiService, "submitImport").mockResolvedValue({
      statusCode: 0,
      token: "tok-import",
    } as any);
    vi.spyOn(OlxApiService, "pollImportUntilDone").mockResolvedValue({
      ads: {
        [OLX_ID]: {
          status: "accepted",
          list_id: "9988776655",
          url: "https://olx.com.br/anuncio/9988776655",
        },
      },
    } as any);

    await ListingUseCase.updateListingStatus(OLX_LISTING_ID, USER_ID, "active");

    expect(updateListing).toHaveBeenCalledWith(
      OLX_LISTING_ID,
      expect.objectContaining({
        status: "active",
        olxListId: "9988776655",
        permalink: "https://olx.com.br/anuncio/9988776655",
      }),
    );
  });

  it("poll inconclusivo ⇒ não zera o olxListId já capturado", async () => {
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(
      baseOlxListing(),
    );
    const updateListing = vi
      .spyOn(ListingRepository, "updateListing")
      .mockResolvedValue({} as any);
    vi.spyOn(OlxApiService, "submitImport").mockResolvedValue({
      statusCode: 0,
      token: "tok-import",
    } as any);
    vi.spyOn(OlxApiService, "pollImportUntilDone").mockResolvedValue({
      ads: {},
    } as any);

    await ListingUseCase.updateListingStatus(OLX_LISTING_ID, USER_ID, "active");

    const [, data] = updateListing.mock.calls[0] as [string, any];
    expect(data.status).toBe("active");
    expect(data).not.toHaveProperty("olxListId");
    expect(data).not.toHaveProperty("permalink");
  });

  it("produto sem preço válido ⇒ aborta antes de chamar a OLX", async () => {
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(
      baseOlxListing({
        product: { ...baseOlxListing().product, price: 0 },
      }),
    );
    const updateListing = vi
      .spyOn(ListingRepository, "updateListing")
      .mockResolvedValue({} as any);
    const submitImport = vi
      .spyOn(OlxApiService, "submitImport")
      .mockResolvedValue({ statusCode: 0 } as any);

    const result = await ListingUseCase.updateListingStatus(
      OLX_LISTING_ID,
      USER_ID,
      "active",
    );

    expect(result.success).toBe(false);
    expect(submitImport).not.toHaveBeenCalled();
    expect(updateListing).not.toHaveBeenCalled();
  });

  it("produto sem imagem ⇒ aborta antes de chamar a OLX", async () => {
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(
      baseOlxListing({
        product: {
          ...baseOlxListing().product,
          imageUrl: null,
          imageUrls: [],
        },
      }),
    );
    const submitImport = vi
      .spyOn(OlxApiService, "submitImport")
      .mockResolvedValue({ statusCode: 0 } as any);

    const result = await ListingUseCase.updateListingStatus(
      OLX_LISTING_ID,
      USER_ID,
      "active",
    );

    expect(result.success).toBe(false);
    expect(submitImport).not.toHaveBeenCalled();
  });

  it("forceRemote republica mesmo com o status local já 'active'", async () => {
    // É exatamente o caso do cancelamento de pedido: o sync tirou o anúncio do
    // ar só REMOTAMENTE e o status local ficou stale em "active". Sem
    // forceRemote o fast-path de idempotência faria no-op e o anúncio ficaria
    // fora do ar para sempre.
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(
      baseOlxListing({ status: "active" }),
    );
    vi.spyOn(ListingRepository, "updateListing").mockResolvedValue({} as any);
    const submitImport = vi
      .spyOn(OlxApiService, "submitImport")
      .mockResolvedValue({ statusCode: 0 } as any);

    const semForce = await ListingUseCase.updateListingStatus(
      OLX_LISTING_ID,
      USER_ID,
      "active",
    );
    expect(semForce.alreadyInState).toBe(true);
    expect(submitImport).not.toHaveBeenCalled();

    const comForce = await ListingUseCase.updateListingStatus(
      OLX_LISTING_ID,
      USER_ID,
      "active",
      { forceRemote: true },
    );
    expect(comForce.success).toBe(true);
    expect(submitImport).toHaveBeenCalledTimes(1);
  });
});
