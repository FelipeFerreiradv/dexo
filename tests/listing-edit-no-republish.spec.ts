import { afterEach, describe, expect, it, vi } from "vitest";
import { Platform } from "@prisma/client";

import { ListingUseCase } from "../app/marketplaces/usecases/listing.usercase";
import { ListingRepository } from "../app/marketplaces/repositories/listing.repository";
import { MLApiService } from "../app/marketplaces/services/ml-api.service";
import { SyncUseCase } from "../app/marketplaces/usecases/sync.usercase";

/**
 * EDITAR ANÚNCIO NÃO PODE VIRAR ANÚNCIO NOVO.
 *
 * Já aconteceu em produção: salvar o preço de um produto republicava o item UP
 * no ML (fechava um, criava outro, e o painel somava o estoque dos dois). O
 * gatilho era uma comparação de título que nunca batia. Hoje a republicação só
 * existe atrás de uma rejeição explícita do ML — mas o modal de edição passou a
 * expor mais campos, então vale travar por teste que o caminho normal não
 * encosta em criação.
 *
 * Trava também o que o `PUT /listings/:id` aceita mas o ML recusa depois de
 * publicado: categoria e os atributos de `IMMUTABLE_ATTRS` (OEM à frente).
 * Esses são persistidos localmente e NÃO viajam no `PUT /items` — se um dia
 * viajarem, o ML devolve `BODY_INVALID_FIELDS` e a edição inteira falha.
 */

const USER = "user-1";
const LISTING = "listing-ml-1";

function mlListing(overrides: Record<string, unknown> = {}) {
  return {
    id: LISTING,
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
    product: { userId: USER },
    marketplaceAccount: {
      id: "acc-1",
      userId: USER,
      platform: Platform.MERCADO_LIVRE,
      accessToken: "tok",
    },
    ...overrides,
  } as any;
}

/** Settings iguais aos do listing: só o campo em teste muda. */
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
  const listing = mlListing();
  vi.spyOn(ListingRepository, "findById").mockResolvedValue(listing);
  const persist = vi
    .spyOn(ListingRepository, "updateListing")
    .mockResolvedValue(undefined as any);
  const updateItem = vi
    .spyOn(MLApiService, "updateItem")
    .mockResolvedValue({} as any);
  const republish = vi
    .spyOn(SyncUseCase, "republishUpListing")
    .mockResolvedValue({ republished: false } as any);
  return { listing, persist, updateItem, republish };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("editar anúncio ML não republica nem duplica", () => {
  it("edição de preço não chama republicação nem cria item", async () => {
    const { updateItem, republish } = armar();

    const r = await ListingUseCase.updateListingFields(LISTING, USER, {
      priceOverride: 199.9,
      ...SETTINGS_INALTERADOS,
    });

    expect(r.success).toBe(true);
    expect(republish).not.toHaveBeenCalled();
    // Um único PUT, no MESMO item.
    expect(updateItem).toHaveBeenCalledTimes(1);
    expect(updateItem.mock.calls[0]?.[1]).toBe("MLB123");
  });

  it("trocar a categoria do anúncio NÃO republica e NÃO manda category_id ao ML", async () => {
    const { updateItem, republish, persist } = armar();

    const r = await ListingUseCase.updateListingFields(LISTING, USER, {
      mlCategoryOverride: "MLB1747",
      priceOverride: 199.9,
      ...SETTINGS_INALTERADOS,
    });

    expect(r.success).toBe(true);
    expect(republish).not.toHaveBeenCalled();
    const enviado = updateItem.mock.calls[0]?.[2] as Record<string, unknown>;
    // Trocar categoria de item publicado não existe por esta rota: o override
    // fica local. Mandar `category_id` aqui devolveria BODY_INVALID_FIELDS e
    // derrubaria o preço junto.
    expect(enviado).not.toHaveProperty("category_id");
    expect(enviado).not.toHaveProperty("category");
    // Mas é persistido — o Dexo guarda a intenção.
    const gravado = persist.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(gravado.mlCategoryOverride).toBe("MLB1747");
  });

  it("OEM e os demais IMMUTABLE_ATTRS não vão no PUT, o resto da ficha vai", async () => {
    const { updateItem, persist } = armar();

    const attrs = {
      OEM: { value_name: "51234567" },
      PART_NUMBER: { value_name: "51234567" },
      BRAND: { value_name: "Fiat" },
      MODEL: { value_name: "Uno" },
      YEAR: { value_name: "1996" },
      VEHICLE_YEAR: { value_name: "1996" },
      MPN: { value_name: "X" },
      SELLER_SKU: { value_name: "33600" },
      POSITION: { value_id: "1", value_name: "Dianteira" },
    };

    const r = await ListingUseCase.updateListingFields(LISTING, USER, {
      attributesOverride: attrs as any,
      ...SETTINGS_INALTERADOS,
    });

    expect(r.success).toBe(true);
    const enviado = updateItem.mock.calls[0]?.[2] as {
      attributes?: Array<{ id: string }>;
    };
    const ids = (enviado.attributes ?? []).map((a) => a.id);
    expect(ids).toEqual(["POSITION"]);
    for (const imutavel of [
      "OEM",
      "PART_NUMBER",
      "BRAND",
      "MODEL",
      "YEAR",
      "VEHICLE_YEAR",
      "MPN",
      "SELLER_SKU",
    ]) {
      expect(ids).not.toContain(imutavel);
    }
    // A ficha inteira continua sendo persistida como override.
    const gravado = persist.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(gravado.attributesOverride).toEqual(attrs);
  });

  it("partNumberOverride é persistido, mas não viaja ao ML", async () => {
    const { updateItem, persist } = armar();

    const r = await ListingUseCase.updateListingFields(LISTING, USER, {
      partNumberOverride: "99999",
      priceOverride: 199.9,
      ...SETTINGS_INALTERADOS,
    });

    expect(r.success).toBe(true);
    const enviado = updateItem.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(enviado).not.toHaveProperty("part_number");
    expect(enviado).not.toHaveProperty("partNumber");
    const gravado = persist.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(gravado.partNumberOverride).toBe("99999");
  });

  it("anúncio ainda não publicado (PENDING_) não vira chamada ao ML", async () => {
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(
      mlListing({ externalListingId: "PENDING_abc" }),
    );
    const updateItem = vi
      .spyOn(MLApiService, "updateItem")
      .mockResolvedValue({} as any);
    const republish = vi
      .spyOn(SyncUseCase, "republishUpListing")
      .mockResolvedValue({ republished: false } as any);

    const r = await ListingUseCase.updateListingFields(LISTING, USER, {
      priceOverride: 199.9,
    });

    expect(r.success).toBe(false);
    expect(updateItem).not.toHaveBeenCalled();
    expect(republish).not.toHaveBeenCalled();
  });

  it("só edição de categoria/OEM (sem campo que o ML aceite) não bate no ML nenhuma vez", async () => {
    const { updateItem, republish, persist } = armar();

    const r = await ListingUseCase.updateListingFields(LISTING, USER, {
      mlCategoryOverride: "MLB1747",
      partNumberOverride: "99999",
      qualityOverride: "NOVO",
      sourceVehicleOverride: "Uno 1996",
      ...SETTINGS_INALTERADOS,
    });

    expect(r.success).toBe(true);
    // Nada que o ML aceite mudou ⇒ zero HTTP, e mesmo assim persiste local.
    expect(updateItem).not.toHaveBeenCalled();
    expect(republish).not.toHaveBeenCalled();
    expect(persist).toHaveBeenCalledTimes(1);
  });
});
