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

  // ──────────────────────────────────────────────────────────────────────
  // A EDIÇÃO NÃO PODE DESFAZER A RESERVA QUE A PUBLICAÇÃO RESPEITOU.
  //
  // O create do Facebook aplica `withAvailableStock` (BLOCO G) e publica peça
  // já vendida com quantity 0. A edição recarregava o produto CRU e mandava
  // `stock` puro — então bastava mexer no título, no preço, ou o próprio
  // override de "Valor do Anúncio" rodar depois do create, para o item voltar
  // ao catálogo com quantity 1. Peça única de desmanche não tem reposição:
  // seria venda dupla.
  //
  // A edição da OLX já fazia certo; era só o Facebook fora do padrão.
  it("peça reservada continua indisponível depois da edição (não volta a quantity 1)", async () => {
    process.env.STOCK_RESERVATION_ENABLED = "1";
    const listing = baseFbListing();
    // stock 1 e reservedStock 1 = vendida, venda em aberto ⇒ disponível 0.
    vi.spyOn(ProductRepositoryPrisma.prototype, "findById").mockResolvedValue(
      fullFbProduct({ stock: 1, reservedStock: 1 }),
    );
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(listing);
    (prisma as any).productListing.findUnique.mockResolvedValue(listing);
    mockWrites();
    const upsert = vi
      .spyOn(FacebookApiService, "updateItem")
      .mockResolvedValue({ handles: [] } as any);

    await ListingUseCase.updateListingFields(FB_LISTING_ID, USER_ID, {
      titleOverride: "Farol Direito Gol 2012 — original",
    });

    expect(upsert).toHaveBeenCalled();
    const itemData = (upsert.mock.calls[0] as any[])[2];
    expect(itemData.quantity_to_sell_on_facebook).toBe(0);
  });

  it("sem reserva, a quantidade enviada continua sendo o estoque cheio", async () => {
    // Controle negativo: se `withAvailableStock` tivesse virado "sempre zero",
    // ou se eu tivesse trocado o campo errado, este caso pega.
    process.env.STOCK_RESERVATION_ENABLED = "1";
    const listing = baseFbListing();
    vi.spyOn(ProductRepositoryPrisma.prototype, "findById").mockResolvedValue(
      fullFbProduct({ stock: 4, reservedStock: 0 }),
    );
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(listing);
    (prisma as any).productListing.findUnique.mockResolvedValue(listing);
    mockWrites();
    const upsert = vi
      .spyOn(FacebookApiService, "updateItem")
      .mockResolvedValue({ handles: [] } as any);

    await ListingUseCase.updateListingFields(FB_LISTING_ID, USER_ID, {
      titleOverride: "Farol Direito Gol 2012 — original",
    });

    const itemData = (upsert.mock.calls[0] as any[])[2];
    expect(itemData.quantity_to_sell_on_facebook).toBe(4);
  });
});

/**
 * Kill-switch na EDIÇÃO de anúncio.
 *
 * `updateListingStatus` (pausar/reativar) já tinha a guarda; `updateListingFields`
 * não. Salvar um override não é operação local: na OLX "editar" é um insert com o
 * mesmo id — o anúncio volta para a fila de revisão e SAI DO AR até a OLX
 * reprocessar; no Facebook é um UPDATE no item do catálogo. Com a integração
 * pausada — que é a postura recomendada de rollout — o operador lia "pausada" na
 * tela e mesmo assim escrevia no canal.
 */
describe("ListingUseCase.updateListingFields — kill-switch", () => {
  afterEach(() => {
    delete process.env.OLX_INTEGRATION_DISABLED;
    delete process.env.FACEBOOK_INTEGRATION_DISABLED;
  });

  it("Facebook pausado: não chama a Meta e não grava override nenhum", async () => {
    process.env.FACEBOOK_INTEGRATION_DISABLED = "1";
    const listing = baseFbListing();
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(listing);
    const writes = mockWrites();
    const upsert = vi
      .spyOn(FacebookApiService, "updateItem")
      .mockResolvedValue({ handles: [] } as any);

    const r = await ListingUseCase.updateListingFields(
      FB_LISTING_ID,
      USER_ID,
      { titleOverride: "novo título" },
    );

    expect(r.success).toBe(false);
    expect(r.error).toMatch(/kill-switch/i);
    expect(upsert).not.toHaveBeenCalled();
    // Barrar DEPOIS da gravação deixaria o banco dizendo uma coisa e o canal
    // outra — o override ficaria salvo sem nunca ter sido enviado.
    expect(writes.updateListing).not.toHaveBeenCalled();
    expect(writes.updatePriceOverride).not.toHaveBeenCalled();
  });

  it("com a flag desligada, a edição do Facebook segue normalmente", async () => {
    process.env.FACEBOOK_INTEGRATION_DISABLED = "0";
    const listing = baseFbListing();
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(listing);
    (prisma as any).productListing.findUnique.mockResolvedValue(listing);
    mockWrites();
    const upsert = vi
      .spyOn(FacebookApiService, "updateItem")
      .mockResolvedValue({ handles: [] } as any);

    await ListingUseCase.updateListingFields(FB_LISTING_ID, USER_ID, {
      titleOverride: "novo título",
    });

    expect(upsert).toHaveBeenCalled();
  });

  it("a guarda NÃO alcança Mercado Livre, Shopee nem Magalu", async () => {
    // `isPlatformDisabled` só conhece OLX e FACEBOOK. Se alguém a generalizasse,
    // ligar o kill-switch da OLX passaria a travar a edição dos três canais que
    // já estavam em produção — regressão silenciosa e larga.
    process.env.OLX_INTEGRATION_DISABLED = "1";
    process.env.FACEBOOK_INTEGRATION_DISABLED = "1";
    const listing = baseFbListing({
      marketplaceAccount: {
        id: "acc-ml-1",
        platform: Platform.MERCADO_LIVRE,
        accessToken: "tok-ml",
      },
    });
    vi.spyOn(ListingRepository, "findById").mockResolvedValue(listing);
    mockWrites();
    // Sela o caminho do ML: sem isto o caso sai para a rede de verdade (a API do
    // ML devolve 400 num id falso) — lento e frágil. O que interessa aqui é se a
    // guarda deixou passar, e isso se prova pela chamada ao colaborador.
    const ml = vi
      .spyOn(ListingUseCase as any, "updateMLListingFields")
      .mockResolvedValue({ success: true });

    const r = await ListingUseCase.updateListingFields(
      FB_LISTING_ID,
      USER_ID,
      { titleOverride: "novo título" },
    );

    expect(ml).toHaveBeenCalled();
    expect(r.success).toBe(true);
    expect(r.error ?? "").not.toMatch(/kill-switch/i);
  });
});
