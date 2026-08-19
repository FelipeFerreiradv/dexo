import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Platform } from "@prisma/client";

// Prisma é lido via dynamic import dentro de updateFacebookListingFields (relê o
// vínculo p/ trazer os overrides recém-gravados). Mocka o findUnique p/ devolver
// o próprio listing — sem isto o caso cairia no prisma real (localhost:5432).
vi.mock("@/app/lib/prisma", () => ({
  default: {
    productListing: { findUnique: vi.fn() },
  },
}));

import prisma from "@/app/lib/prisma";
import { ListingUseCase } from "../listing.usercase";
import { ListingRepository } from "../../repositories/listing.repository";
import { ProductRepositoryPrisma } from "@/app/repositories/product.repository";
import { FacebookApiService } from "../../services/facebook-api.service";

const USER_ID = "user-fb";
const FB_LISTING_ID = "listing-fb-1";
const RETAILER_ID = "SKU-FB-1"; // retailer_id = SKU do item no catálogo Meta

// Produto CHEIO devolvido pelo reload (updateFacebookListingFields recarrega via
// productRepository.findById; o listing.product do updateListingFields é lean).
function fullFbProduct(overrides: Record<string, unknown> = {}) {
  return {
    id: "prod-fb-1",
    userId: USER_ID,
    sku: RETAILER_ID,
    name: "Farol Direito Gol 2012",
    description: "Farol original em bom estado",
    price: 200,
    stock: 3,
    imageUrl: "https://img/1.jpg",
    ...overrides,
  } as any;
}

function baseFbListing(overrides: Record<string, unknown> = {}) {
  return {
    id: FB_LISTING_ID,
    externalListingId: RETAILER_ID,
    externalSku: RETAILER_ID,
    productId: "prod-fb-1",
    status: "active",
    // Lean product (só ownership+sku), como o findById({leanProduct}) devolve.
    product: { id: "prod-fb-1", userId: USER_ID, sku: RETAILER_ID },
    marketplaceAccount: {
      id: "acc-fb-1",
      platform: Platform.FACEBOOK,
      accessToken: "tok-fb",
      fbCatalogId: "catalog-da-conta",
      fbProductUrlBase: "https://facebook.com/loja-a",
    },
    ...overrides,
  } as any;
}

/**
 * Mocka os DOIS caminhos de escrita do ramo Facebook (updateListing p/ os
 * overrides de texto/categoria e updatePriceOverride p/ o preço). Esquecer um
 * deles faz o caso bater no prisma real e falhar de forma confusa.
 */
function mockWrites() {
  return {
    updateListing: vi
      .spyOn(ListingRepository, "updateListing")
      .mockResolvedValue(undefined as any),
    updatePriceOverride: vi
      .spyOn(ListingRepository, "updatePriceOverride")
      .mockResolvedValue(undefined as any),
  };
}

beforeEach(() => {
  // Reload do produto cheio: sem isto o build reenviaria nome/preço/imagens
  // vazios do lean product e mutilaria o item vivo no catálogo.
  vi.spyOn(ProductRepositoryPrisma.prototype, "findById").mockResolvedValue(
    fullFbProduct(),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  (prisma as any).productListing.findUnique.mockReset();
});

describe("ListingUseCase.updateListingFields — Facebook (items_batch real)", () => {
  it("edição dispara UPDATE no items_batch com o MESMO retailer_id (nunca CREATE nem DELETE)", async () => {
    const listing = baseFbListing();
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(listing);
    mockWrites();
    (prisma as any).productListing.findUnique.mockResolvedValue(listing);

    // Spia o método de transporte (e não updateItem): é ele que carrega o VERBO
    // do batch. Um upsertItem/deleteItem acidental também passaria por aqui, então
    // o verbo asserido abaixo discrimina de verdade.
    const submitItemsBatch = vi
      .spyOn(FacebookApiService, "submitItemsBatch")
      .mockResolvedValue({ handles: ["h1"] } as any);
    vi.spyOn(FacebookApiService, "pollBatchUntilDone").mockResolvedValue({
      handle: "h1",
      status: "finished",
      errors: [],
    } as any);

    const result = await ListingUseCase.updateListingFields(
      FB_LISTING_ID,
      USER_ID,
      { titleOverride: "Farol Direito Gol 2012 — revisado" },
    );

    expect(result.success).toBe(true);
    expect(submitItemsBatch).toHaveBeenCalledTimes(1);

    const [token, requests, opts] = submitItemsBatch.mock.calls[0] ?? [];
    expect(token).toBe("tok-fb");
    // UM item, endereçado ao MESMO retailer_id: é isto que impede "editar"
    // virar "duplicar no catálogo" (CREATE) ou "sumir o anúncio" (DELETE).
    expect((requests as any[]).length).toBe(1);
    expect((requests as any[])[0].method).toBe("UPDATE");
    // O identificador vive em `data.id` — a Meta recusa `retailer_id` no nível
    // do request com "Can not find required field id", e como ela responde
    // HTTP 200 mesmo assim, a falha não estourava em lugar nenhum.
    expect((requests as any[])[0].data?.id).toBe(RETAILER_ID);
    expect((requests as any[])[0].retailer_id).toBeUndefined();
    expect((requests as any[]).some((r) => r.method === "CREATE")).toBe(false);
    expect((requests as any[]).some((r) => r.method === "DELETE")).toBe(false);
    // upsertItem liga allow_upsert=true; o UPDATE puro não deve ligar — se ligasse,
    // um retailer_id errado criaria item novo em vez de falhar.
    expect((opts as any)?.allowUpsert).toBeUndefined();
    // E sempre no catálogo DA CONTA (multi-tenant compartilha o mesmo SKU).
    expect((opts as any)?.catalogId).toBe("catalog-da-conta");
  });

  it("rejeição da Meta no poll do batch propaga falha — não reporta sucesso", async () => {
    const listing = baseFbListing();
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(listing);
    mockWrites();
    (prisma as any).productListing.findUnique.mockResolvedValue(listing);

    // A Meta devolve 200 + handles mesmo rejeitando: o veredito só aparece no poll.
    vi.spyOn(FacebookApiService, "submitItemsBatch").mockResolvedValue({
      handles: ["h1"],
    } as any);
    const poll = vi
      .spyOn(FacebookApiService, "pollBatchUntilDone")
      .mockResolvedValue({
        handle: "h1",
        status: "error",
        errors: [{ message: "invalid_image_url" }],
      } as any);
    const updateStatus = vi
      .spyOn(ListingRepository, "updateStatus")
      .mockResolvedValue({} as any);

    const result = await ListingUseCase.updateListingFields(
      FB_LISTING_ID,
      USER_ID,
      { titleOverride: "Título novo" },
    );

    // Sem o poll o 200 do items_batch viraria "atualizado com sucesso" e o
    // usuário nunca saberia que a Meta descartou a edição.
    expect(poll).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Facebook recusou a edição/);
    expect(result.error).toContain("invalid_image_url");
    // O detalhe do erro não pode virar gravação de estado no vínculo.
    expect(updateStatus).not.toHaveBeenCalled();
  });

  it("honra priceOverride do bulk (persiste + rebuild com o novo preço)", async () => {
    const listing = baseFbListing();
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(listing);
    const { updatePriceOverride } = mockWrites();
    // Relê o vínculo já com o priceOverride gravado (self-healing pós-persist).
    (prisma as any).productListing.findUnique.mockResolvedValue({
      ...listing,
      priceOverride: 349.9,
    });

    const submitItemsBatch = vi
      .spyOn(FacebookApiService, "submitItemsBatch")
      .mockResolvedValue({ handles: [] } as any);

    const result = await ListingUseCase.updateListingFields(
      FB_LISTING_ID,
      USER_ID,
      { priceOverride: 349.9 },
    );

    expect(result.success).toBe(true);
    expect(updatePriceOverride).toHaveBeenCalledWith(FB_LISTING_ID, 349.9);

    const [, requests] = submitItemsBatch.mock.calls[0] ?? [];
    const data = (requests as any[])[0].data;
    // O preço enviado reflete o override, não o preço base do produto (200) —
    // persistir sem reconstruir deixaria o catálogo com o preço velho.
    expect(data.price).toBe("349.90 BRL");
    expect(data.price).not.toContain("200.00");
  });

  it("reconstrói a partir do produto CHEIO (reload), não do lean product", async () => {
    // O listing carrega SÓ {id,userId,sku} em product — se o build usasse ele,
    // name sairia "" e price "0.00 BRL", apagando o anúncio vivo com um
    // "atualizado com sucesso" na cara do usuário (foi bug real na OLX).
    const listing = baseFbListing();
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(listing);
    mockWrites();
    (prisma as any).productListing.findUnique.mockResolvedValue(listing);

    const submitItemsBatch = vi
      .spyOn(FacebookApiService, "submitItemsBatch")
      .mockResolvedValue({ handles: [] } as any);

    const result = await ListingUseCase.updateListingFields(
      FB_LISTING_ID,
      USER_ID,
      {},
    );

    expect(result.success).toBe(true);
    const [, requests] = submitItemsBatch.mock.calls[0] ?? [];
    const data = (requests as any[])[0].data;
    expect(data.name).toBe("Farol Direito Gol 2012");
    expect(data.price).toBe("200.00 BRL");
    expect(data.description).toBe("Farol original em bom estado");
    // Imagem e estoque também só existem no produto cheio.
    expect(data.image_url).toBe("https://img/1.jpg");
    expect(data.quantity_to_sell_on_facebook).toBe(3);
  });

  it("conta sem fbCatalogId é bloqueada — não cai no catálogo global do .env", async () => {
    const catalogoGlobalOriginal = process.env.FACEBOOK_CATALOG_ID;
    // Catálogo global PRESENTE de propósito: se o guard sumisse, o
    // FacebookApiService.catalogId() cairia nele e a edição (retailer_id = SKU)
    // sobrescreveria o item de OUTRO tenant com o mesmo SKU.
    process.env.FACEBOOK_CATALOG_ID = "catalog-global-do-env";
    try {
      const listing = baseFbListing({
        marketplaceAccount: {
          id: "acc-fb-1",
          platform: Platform.FACEBOOK,
          accessToken: "tok-fb",
          fbCatalogId: null,
          fbProductUrlBase: "https://facebook.com/loja-a",
        },
      });
      vi.spyOn(ListingRepository, "findById").mockResolvedValue(listing);
      mockWrites();
      (prisma as any).productListing.findUnique.mockResolvedValue(listing);

      const submitItemsBatch = vi
        .spyOn(FacebookApiService, "submitItemsBatch")
        .mockResolvedValue({ handles: [] } as any);

      const result = await ListingUseCase.updateListingFields(
        FB_LISTING_ID,
        USER_ID,
        { titleOverride: "Título novo" },
      );

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Catálogo Meta não configurado/);
      // Nenhuma chamada sai: bloqueio duro, sem fallback silencioso.
      expect(submitItemsBatch).not.toHaveBeenCalled();
    } finally {
      if (catalogoGlobalOriginal === undefined)
        delete process.env.FACEBOOK_CATALOG_ID;
      else process.env.FACEBOOK_CATALOG_ID = catalogoGlobalOriginal;
    }
  });
});
