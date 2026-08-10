import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Platform } from "@prisma/client";

// Prisma é lido via dynamic import dentro de updateOlxListingFields (relê o
// vínculo p/ trazer os overrides recém-gravados). Mocka o findUnique p/ devolver
// o próprio listing (sem override extra) — o caminho de erro cai no listing base.
vi.mock("@/app/lib/prisma", () => ({
  default: {
    productListing: { findUnique: vi.fn() },
  },
}));

import prisma from "@/app/lib/prisma";
import { ListingUseCase } from "../listing.usercase";
import { ListingRepository } from "../../repositories/listing.repository";
import { ProductRepositoryPrisma } from "@/app/repositories/product.repository";
import { OlxApiService } from "../../services/olx-api.service";

const USER_ID = "user-1";
const OLX_LISTING_ID = "listing-olx-1";

// Produto CHEIO devolvido pelo reload (updateOlxListingFields recarrega via
// productRepository.findById; o listing.product do updateListingFields é lean).
function fullOlxProduct(overrides: Record<string, unknown> = {}) {
  return {
    id: "prod-olx-1",
    userId: USER_ID,
    sku: "SKU-OLX-1",
    name: "Farol Direito Gol 2012",
    description: "desc",
    price: 200,
    stock: 3,
    imageUrl: "https://img/1.jpg",
    olxCategoryId: "2101",
    ...overrides,
  } as any;
}

function baseOlxListing(overrides: Record<string, unknown> = {}) {
  return {
    id: OLX_LISTING_ID,
    externalListingId: "SKU-OLX-1",
    externalSku: "SKU-OLX-1",
    productId: "prod-olx-1",
    status: "active",
    // Lean product (só ownership+sku), como o findById(leanProduct) devolve.
    product: { id: "prod-olx-1", userId: USER_ID, sku: "SKU-OLX-1" },
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

beforeEach(() => {
  // Reload do produto cheio (C2): sem isto o build reenviaria título/preço/
  // imagens vazios do lean product e apagaria o anúncio vivo.
  vi.spyOn(ProductRepositoryPrisma.prototype, "findById").mockResolvedValue(
    fullOlxProduct(),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  (prisma as any).productListing.findUnique.mockReset();
});

describe("ListingUseCase.updateListingFields — OLX (update remoto real)", () => {
  it("chama submitImport com o MESMO id (edição) e grava sucesso quando statusCode=0", async () => {
    const listing = baseOlxListing();
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(listing);
    vi.spyOn(ListingRepository, "updateListing").mockResolvedValue(
      undefined as any,
    );
    (prisma as any).productListing.findUnique.mockResolvedValue(listing);

    const submitImport = vi
      .spyOn(OlxApiService, "submitImport")
      .mockResolvedValue({ statusCode: 0, token: "tok" } as any);

    const result = await ListingUseCase.updateListingFields(
      OLX_LISTING_ID,
      USER_ID,
      { titleOverride: "Novo título" },
    );

    expect(result.success).toBe(true);
    // Prova que a API foi chamada: antes era no-op que reportava sucesso.
    expect(submitImport).toHaveBeenCalledTimes(1);
    const [token, adList] = submitImport.mock.calls[0] ?? [];
    expect(token).toBe("tok-olx");
    // Edição = insert com o MESMO id do anúncio já publicado.
    expect(Array.isArray(adList)).toBe(true);
    expect((adList as any)[0].id).toBe("SKU-OLX-1");
  });

  it("propaga falha quando a OLX recusa (statusCode != 0) — não reporta sucesso", async () => {
    const listing = baseOlxListing();
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(listing);
    vi.spyOn(ListingRepository, "updateListing").mockResolvedValue(
      undefined as any,
    );
    (prisma as any).productListing.findUnique.mockResolvedValue(listing);

    const submitImport = vi
      .spyOn(OlxApiService, "submitImport")
      .mockResolvedValue({
        statusCode: -4,
        statusMessage: "validação falhou",
      } as any);

    const result = await ListingUseCase.updateListingFields(
      OLX_LISTING_ID,
      USER_ID,
      { titleOverride: "Novo título" },
    );

    expect(submitImport).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/OLX recusou/);
  });

  it("honra priceOverride do bulk (persiste + rebuild com o novo preço)", async () => {
    const listing = baseOlxListing();
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(listing);
    vi.spyOn(ListingRepository, "updateListing").mockResolvedValue(
      undefined as any,
    );
    const persistPrice = vi
      .spyOn(ListingRepository, "updatePriceOverride")
      .mockResolvedValue(undefined as any);
    // Relê o vínculo já com o priceOverride aplicado (self-healing).
    (prisma as any).productListing.findUnique.mockResolvedValue({
      ...listing,
      priceOverride: 349.9,
    });

    const submitImport = vi
      .spyOn(OlxApiService, "submitImport")
      .mockResolvedValue({ statusCode: 0, token: "tok" } as any);

    const result = await ListingUseCase.updateListingFields(
      OLX_LISTING_ID,
      USER_ID,
      { priceOverride: 349.9 },
    );

    expect(result.success).toBe(true);
    expect(persistPrice).toHaveBeenCalledWith(OLX_LISTING_ID, 349.9);
    expect(submitImport).toHaveBeenCalledTimes(1);
    const [, adList] = submitImport.mock.calls[0] ?? [];
    // O preço do ad reconstruído reflete o override (não o preço base 200).
    // toIntPrice arredonda 349.9 → 350; o que importa é != 200 (preço base).
    const sentPrice = Number((adList as any)[0].price);
    expect(sentPrice).toBe(350);
    expect(sentPrice).not.toBe(200);
  });

  it("C2: reconstrói o anúncio a partir do produto CHEIO (reload), não do lean product", async () => {
    const listing = baseOlxListing(); // product é lean (sem name/price/imagem)
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(listing);
    vi.spyOn(ListingRepository, "updateListing").mockResolvedValue(
      undefined as any,
    );
    (prisma as any).productListing.findUnique.mockResolvedValue(listing);
    const submitImport = vi
      .spyOn(OlxApiService, "submitImport")
      .mockResolvedValue({ statusCode: 0, token: "tok" } as any);

    const result = await ListingUseCase.updateListingFields(
      OLX_LISTING_ID,
      USER_ID,
      { titleOverride: undefined as any },
    );

    expect(result.success).toBe(true);
    const [, adList] = submitImport.mock.calls[0] ?? [];
    const ad = (adList as any)[0];
    // Título/preço vêm do produto recarregado — NÃO ficam vazios/zerados (que
    // era o bug: apagava o anúncio vivo com "atualizado com sucesso").
    expect(ad.Subject).toBe("Farol Direito Gol 2012");
    expect(Number(ad.price)).toBe(200);
  });

  it("C5: persiste olxCategoryOverride e usa no rebuild (antes não tinha caminho de escrita)", async () => {
    const listing = baseOlxListing();
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(listing);
    const updateListing = vi
      .spyOn(ListingRepository, "updateListing")
      .mockResolvedValue(undefined as any);
    // Relê o vínculo já com a categoria gravada (self-healing pós-persist).
    (prisma as any).productListing.findUnique.mockResolvedValue({
      ...listing,
      olxCategoryOverride: "2103",
    });
    const submitImport = vi
      .spyOn(OlxApiService, "submitImport")
      .mockResolvedValue({ statusCode: 0, token: "tok" } as any);

    const result = await ListingUseCase.updateListingFields(
      OLX_LISTING_ID,
      USER_ID,
      { olxCategoryOverride: "2103" },
    );

    expect(result.success).toBe(true);
    // Persistiu a categoria escolhida no vínculo.
    expect(updateListing).toHaveBeenCalledWith(
      OLX_LISTING_ID,
      expect.objectContaining({ olxCategoryOverride: "2103" }),
    );
    // E o rebuild usou a categoria override (2103 motos), não a default.
    const [, adList] = submitImport.mock.calls[0] ?? [];
    expect(Number((adList as any)[0].category)).toBe(2103);
  });

  it("rejeita priceOverride não-positivo sem chamar a API", async () => {
    const listing = baseOlxListing();
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(listing);
    const submitImport = vi
      .spyOn(OlxApiService, "submitImport")
      .mockResolvedValue({ statusCode: 0 } as any);

    const result = await ListingUseCase.updateListingFields(
      OLX_LISTING_ID,
      USER_ID,
      { priceOverride: 0 },
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Preço inválido/);
    expect(submitImport).not.toHaveBeenCalled();
  });
});
