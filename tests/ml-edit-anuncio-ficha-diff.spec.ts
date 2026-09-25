import { afterEach, describe, expect, it, vi } from "vitest";
import { Platform } from "@prisma/client";

import { ListingUseCase } from "../app/marketplaces/usecases/listing.usercase";
import { ListingRepository } from "../app/marketplaces/repositories/listing.repository";
import { MLApiService } from "../app/marketplaces/services/ml-api.service";
import { SyncUseCase } from "../app/marketplaces/usecases/sync.usercase";

/**
 * "Editar anúncio" com a ficha que agora abre COMPLETA (25/09/2026). Antes o
 * formulário abria vazio e o PUT /items levava só o campo digitado. Mandar a
 * ficha inteira faria um valor inválido gravado (INMETRO com texto de busca,
 * QR "1") ser recusado pelo ML, o retry tiraria o bloco `attributes` inteiro e
 * o campo alterado não chegaria ao anúncio. Vai só o que MUDOU em relação à
 * ficha que o anúncio já usava; o override gravado é a ficha inteira.
 */

const USER = "user-1";
const LISTING = "listing-ml-1";
const SETTINGS = {
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
const FICHA_PRODUTO = {
  INMETRO_CERTIFICATION_REGISTRATION_NUMBER: { value_name: "circuito soquete lanterna traseira bmw" },
  REGULATORY_INFORMATION_QR_CODE: { value_name: "1" },
  COLOR: { value_id: "52049", value_name: "Preto" },
};

function armar(opts: { override?: unknown; produto?: unknown; produtoFalha?: boolean } = {}) {
  vi.spyOn(ListingRepository, "findById").mockResolvedValue({
    id: LISTING,
    externalListingId: "MLB123",
    productId: "prod-1",
    attributesOverride: opts.override ?? null,
    ...SETTINGS,
    product: { userId: USER },
    marketplaceAccount: {
      id: "acc-1",
      userId: USER,
      platform: Platform.MERCADO_LIVRE,
      accessToken: "tok",
    },
  } as any);
  vi.spyOn(ListingRepository, "updateListing").mockResolvedValue(undefined as any);
  const updateItem = vi.spyOn(MLApiService, "updateItem").mockResolvedValue({} as any);
  vi.spyOn(SyncUseCase, "republishUpListing").mockResolvedValue({ republished: false } as any);
  const repo = (ListingUseCase as any).productRepository;
  const findProduto = vi.spyOn(repo, "findById");
  if (opts.produtoFalha) findProduto.mockRejectedValue(new Error("banco fora"));
  else findProduto.mockResolvedValue({ id: "prod-1", attributes: opts.produto ?? FICHA_PRODUTO });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  return { updateItem };
}

const enviados = (updateItem: ReturnType<typeof armar>["updateItem"]) =>
  ((updateItem.mock.calls[0]?.[2] as { attributes?: Array<{ id: string }> })?.attributes ?? []).map(
    (a) => a.id,
  );

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Editar anúncio — só o que mudou vai ao ML", () => {
  it("anúncio sem override: mudou só a Cor ⇒ o PUT leva só a Cor (não o INMETRO nem o QR gravados)", async () => {
    const { updateItem } = armar();
    const r = await ListingUseCase.updateListingFields(LISTING, USER, {
      ...SETTINGS,
      priceOverride: 150,
      attributesOverride: { ...FICHA_PRODUTO, COLOR: { value_id: "52055", value_name: "Branco" } },
    });
    expect(r.success).toBe(true);
    expect(enviados(updateItem)).toEqual(["COLOR"]);
  });

  it("anúncio COM override: compara com o override (campo novo e alterado vão; igual não)", async () => {
    const { updateItem } = armar({ override: { COLOR: { value_id: "52049", value_name: "Preto" } } });
    await ListingUseCase.updateListingFields(LISTING, USER, {
      ...SETTINGS,
      priceOverride: 150,
      attributesOverride: {
        COLOR: { value_id: "52049", value_name: "Preto" },
        POSITION: { value_name: "Traseira" },
      },
    });
    expect(enviados(updateItem)).toEqual(["POSITION"]);
  });

  it("sem conseguir ler a ficha anterior ⇒ manda tudo (não perde a edição)", async () => {
    const { updateItem } = armar({ produtoFalha: true });
    await ListingUseCase.updateListingFields(LISTING, USER, {
      ...SETTINGS,
      priceOverride: 150,
      attributesOverride: { COLOR: { value_name: "Branco" }, POSITION: { value_name: "Traseira" } },
    });
    expect(enviados(updateItem).sort()).toEqual(["COLOR", "POSITION"]);
  });
});
