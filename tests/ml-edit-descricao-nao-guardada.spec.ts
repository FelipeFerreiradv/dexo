import { afterEach, describe, expect, it, vi } from "vitest";
import { Platform } from "@prisma/client";

import { ListingUseCase } from "../app/marketplaces/usecases/listing.usercase";
import { ListingRepository } from "../app/marketplaces/repositories/listing.repository";
import { MLApiService } from "../app/marketplaces/services/ml-api.service";
import { SyncUseCase } from "../app/marketplaces/usecases/sync.usercase";
import { MLDescriptionNotSavedError } from "../app/marketplaces/lib/ml-description-text";

/**
 * Editar anúncio ML quando o ML NÃO guarda a descrição (caractere que ele não
 * aceita — 23/09/2026, SKU 7167). O PUT /items com preço/título já foi aplicado
 * no ML antes da descrição: a edição tem de SALVAR o resto e avisar, não
 * devolver falha e deixar a Dexo com o preço velho. Qualquer outro erro da
 * descrição segue falhando como antes.
 */

const USER = "user-1";
const LISTING = "listing-ml-1";

const SETTINGS_INALTERADOS = {
  listingType: "gold_special",
  itemCondition: "new",
  hasWarranty: true,
  warrantyUnit: "dias",
  warrantyDuration: 90,
  shippingMode: "me2",
  freeShipping: false,
  localPickup: false,
  manufacturingTime: 5,
};

function armar() {
  vi.spyOn(ListingRepository, "findById").mockResolvedValue({
    id: LISTING,
    externalListingId: "MLB123",
    productId: "prod-1",
    ...SETTINGS_INALTERADOS,
    product: { userId: USER },
    marketplaceAccount: {
      id: "acc-1",
      userId: USER,
      platform: Platform.MERCADO_LIVRE,
      accessToken: "tok",
    },
  } as any);
  const persist = vi
    .spyOn(ListingRepository, "updateListing")
    .mockResolvedValue(undefined as any);
  const updateItem = vi.spyOn(MLApiService, "updateItem").mockResolvedValue({} as any);
  vi.spyOn(SyncUseCase, "republishUpListing").mockResolvedValue({ republished: false } as any);
  const upsert = vi.spyOn(MLApiService, "upsertDescription");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  return { persist, updateItem, upsert };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("edição de anúncio ML com descrição que o ML não guarda", () => {
  it("ML não guardou o texto ⇒ salva preço e descrição na Dexo e avisa (sucesso)", async () => {
    const { persist, updateItem, upsert } = armar();
    upsert.mockRejectedValue(new MLDescriptionNotSavedError("MLB123", "empty_after_write"));

    const r = await ListingUseCase.updateListingFields(LISTING, USER, {
      priceOverride: 199.9,
      descriptionOverride: "⚠️ ATENÇÃO: só hidráulica",
      ...SETTINGS_INALTERADOS,
    });

    expect(updateItem).toHaveBeenCalledTimes(1);
    expect(r.success).toBe(true);
    expect(r.error).toMatch(/descrição/);
    expect(persist).toHaveBeenCalledTimes(1);
    const gravado = persist.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(gravado.priceOverride).toBe(199.9);
    expect(gravado.descriptionOverride).toBe("⚠️ ATENÇÃO: só hidráulica");
  });

  it("outro erro da descrição (ex.: token) segue falhando como antes", async () => {
    const { persist, upsert } = armar();
    upsert.mockRejectedValue(new Error("Erro ao atualizar descrição (PUT): invalid_token"));

    const r = await ListingUseCase.updateListingFields(LISTING, USER, {
      priceOverride: 199.9,
      descriptionOverride: "Texto comum",
      ...SETTINGS_INALTERADOS,
    });

    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Falha ao atualizar descrição/);
    expect(persist).not.toHaveBeenCalled();
  });
});
