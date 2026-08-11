import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import axios from "axios";

// ──────────────────────────────────────────────────────────
// BLOCO T-G — os buracos do import do Facebook que o spec irmão
// (sync-facebook-import.spec.ts, só caminho feliz) não cobre:
//
//   1. catálogo POR CONTA obrigatório (sem fallback para o .env global);
//   2. estoque REAL vindo de quantity_to_sell_on_facebook;
//   3. fallback de 1 unidade quando a Meta não devolve o campo;
//   4. galeria inteira (image_url + additional_image_urls, sem duplicar a capa);
//   5. fbCatalogItemId — o id numérico do item só existe no caminho de LEITURA;
//   6. paginação por cursor `after` dentro de listCatalogItems (o loop nunca
//      tinha sido exercitado com mais de uma página).
//
// axios é mockado para o caso 6 (que usa o FacebookApiService REAL); os demais
// casos espionam FacebookApiService.listCatalogItems e nunca chegam na rede.
// ──────────────────────────────────────────────────────────
vi.mock("axios");

// prisma: só as leituras que importFacebookItems faz. $queryRaw entra porque a
// repescagem por SKU sanitizado dispara sempre que algum SKU não casou — sem o
// dublê ela cai no catch e polui a saída com warn.
vi.mock("@/app/lib/prisma", () => ({
  default: {
    productListing: { findMany: vi.fn() },
    product: { findMany: vi.fn() },
    syncLog: { create: vi.fn() },
    $queryRaw: vi.fn(),
  },
}));

vi.mock("../../repositories/marketplace.repository", () => ({
  MarketplaceRepository: {
    findByIdAndUser: vi.fn(),
    findFirstActiveByUserAndPlatform: vi.fn(),
  },
}));

// Os DOIS métodos de escrita: o import usa updateListing, mas updateStatus é o
// que o ramo FACEBOOK de updateListingStatus usa — deixar um de fora faz o
// teste bater no Prisma real (localhost:5432) com erro confuso.
vi.mock("../../repositories/listing.repository", () => ({
  ListingRepository: { updateListing: vi.fn(), updateStatus: vi.fn() },
}));

import prisma from "@/app/lib/prisma";
import { FacebookApiService } from "../../services/facebook-api.service";
import { MarketplaceRepository } from "../../repositories/marketplace.repository";
import { ListingRepository } from "../../repositories/listing.repository";
import { ListingAutodetectUseCase } from "../listing-autodetect.usercase";
import { SyncUseCase } from "../sync.usercase";

const ACCOUNT = {
  id: "acc-fb",
  userId: "user-1",
  accessToken: "fb-token",
  fbCatalogId: "cat-tenant-A",
};

/** Dublê de listCatalogItems por caso (o caso de paginação NÃO chama isto). */
function mockCatalogItems(items: unknown[]) {
  return vi
    .spyOn(FacebookApiService, "listCatalogItems")
    .mockResolvedValue(items as never);
}

/** Argumento normalizado que chegou ao núcleo idempotente na n-ésima chamada. */
function normalizedArg(n = 0): any {
  return (
    ListingAutodetectUseCase.upsertProductFromMarketplaceItem as any
  ).mock.calls[n][0];
}

describe("SyncUseCase.importFacebookItems — catálogo por conta, estoque, galeria e paginação", () => {
  beforeEach(() => {
    (MarketplaceRepository.findByIdAndUser as any).mockResolvedValue(ACCOUNT);
    (prisma as any).syncLog.create.mockResolvedValue({});
    (prisma as any).productListing.findMany.mockResolvedValue([]);
    (prisma as any).product.findMany.mockResolvedValue([]);
    (prisma as any).$queryRaw.mockResolvedValue([]);
    (ListingRepository.updateListing as any).mockResolvedValue({});
    (ListingRepository.updateStatus as any).mockResolvedValue({});
    // Núcleo de upsert dublado; normalizeFacebookItem fica REAL — é ele que
    // este bloco está provando (estoque/galeria saem de lá).
    vi.spyOn(
      ListingAutodetectUseCase,
      "upsertProductFromMarketplaceItem",
    ).mockResolvedValue({
      action: "created_product",
      productId: "prod-new",
    } as never);
    (axios as any).isAxiosError = (e: any) => !!e && e.isAxiosError === true;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("conta sem fbCatalogId ⇒ lança e NÃO lê catálogo nenhum", async () => {
    const listSpy = mockCatalogItems([]);
    (MarketplaceRepository.findByIdAndUser as any).mockResolvedValue({
      ...ACCOUNT,
      fbCatalogId: null,
    });

    await expect(
      SyncUseCase.importFacebookItems("user-1", "acc-fb"),
    ).rejects.toThrow(/fbCatalogId ausente/i);

    // A assertiva que importa: sem catálogo da conta o import não pode cair no
    // FACEBOOK_CATALOG_ID do .env — em multi-tenant isso LERIA o catálogo de
    // outro cliente e criaria produtos a partir dele. Se a produção voltasse ao
    // fallback global, listCatalogItems seria chamado e este teste quebraria.
    expect(listSpy).not.toHaveBeenCalled();
  });

  it("quantity_to_sell_on_facebook = 12 ⇒ produto nasce com estoque 12 (não 1)", async () => {
    mockCatalogItems([
      {
        id: "9101",
        retailer_id: "SKU-Q12",
        name: "Farol",
        availability: "in stock",
        quantity_to_sell_on_facebook: 12,
      },
    ]);

    await SyncUseCase.importFacebookItems("user-1", "acc-fb");

    // Antes o import fixava stock = 1: todo item importado nascia com uma
    // unidade e o estoque real do catálogo era descartado.
    expect(normalizedArg().stock).toBe(12);
    expect(normalizedArg().externalListingId).toBe("SKU-Q12");
  });

  it("item sem quantity_to_sell_on_facebook ⇒ mantém o fallback de 1 unidade", async () => {
    mockCatalogItems([
      {
        id: "9102",
        retailer_id: "SKU-SEMQTD",
        name: "Lanterna",
        availability: "in stock",
      },
    ]);

    await SyncUseCase.importFacebookItems("user-1", "acc-fb");

    // A edge de leitura pode não devolver o campo (versão/permissão do app).
    // Inventar 0 zeraria o anúncio e inventar N seria pior ainda: o contrato é
    // preservar exatamente o comportamento anterior (1 unidade).
    expect(normalizedArg().stock).toBe(1);
  });

  it("additional_image_urls ⇒ galeria = capa + adicionais, sem duplicar a capa", async () => {
    mockCatalogItems([
      {
        id: "9103",
        retailer_id: "SKU-FOTOS",
        name: "Parachoque",
        availability: "in stock",
        image_url: "https://cdn/a.jpg",
        // A Meta repete a capa dentro dos adicionais com frequência; o "  " e a
        // string vazia cobrem o filtro de lixo.
        additional_image_urls: [
          "https://cdn/b.jpg",
          "https://cdn/a.jpg",
          "   ",
          "https://cdn/c.jpg",
        ],
      },
    ]);

    await SyncUseCase.importFacebookItems("user-1", "acc-fb");

    const arg = normalizedArg();
    expect(arg.imageUrl).toBe("https://cdn/a.jpg");
    // Ordem importa: a capa tem de ser a PRIMEIRA (é ela que vira image_url na
    // republicação). E a capa não pode aparecer duas vezes, senão a galeria
    // volta ao catálogo com a foto principal repetida.
    expect(arg.imageUrls).toEqual([
      "https://cdn/a.jpg",
      "https://cdn/b.jpg",
      "https://cdn/c.jpg",
    ]);
  });

  it("listing já vinculado ⇒ grava fbCatalogItemId a partir do `id` do item", async () => {
    mockCatalogItems([
      {
        id: "77001",
        retailer_id: "SKU-CAT",
        name: "Farol",
        availability: "in stock",
        url: "https://fb.com/cat",
      },
    ]);
    // Linha com a MESMA forma do select real de importFacebookItems (que não
    // traz fbCatalogItemId) — status e permalink já em dia.
    (prisma as any).productListing.findMany.mockImplementation(
      async (args: any) =>
        args?.where?.externalListingId
          ? [
              {
                id: "listing-cat",
                externalListingId: "SKU-CAT",
                externalSku: "SKU-CAT",
                status: "active",
                permalink: "https://fb.com/cat",
                productId: "prod-1",
              },
            ]
          : [],
    );

    await SyncUseCase.importFacebookItems("user-1", "acc-fb");

    // O id numérico do item de catálogo só aparece na LEITURA (o items_batch da
    // publicação devolve handles), então este é o único caminho capaz de
    // preencher a coluna. Os demais campos vêm undefined = write-on-change.
    expect(ListingRepository.updateListing).toHaveBeenCalledTimes(1);
    expect(ListingRepository.updateListing).toHaveBeenCalledWith("listing-cat", {
      externalListingId: undefined,
      status: undefined,
      permalink: undefined,
      fbCatalogItemId: "77001",
    });
    expect(
      ListingAutodetectUseCase.upsertProductFromMarketplaceItem,
    ).not.toHaveBeenCalled();
  });

  it("item sem `id` e listing em dia ⇒ nenhum write (o gatilho é o id, não o loop)", async () => {
    mockCatalogItems([
      {
        retailer_id: "SKU-SEMID",
        name: "Farol",
        availability: "in stock",
        url: "https://fb.com/semid",
      },
    ]);
    (prisma as any).productListing.findMany.mockImplementation(
      async (args: any) =>
        args?.where?.externalListingId
          ? [
              {
                id: "listing-semid",
                externalListingId: "SKU-SEMID",
                externalSku: "SKU-SEMID",
                status: "active",
                permalink: "https://fb.com/semid",
                productId: "prod-1",
              },
            ]
          : [],
    );

    await SyncUseCase.importFacebookItems("user-1", "acc-fb");

    // Prova que a gravação do caso anterior veio de `item.id` e não de um
    // update incondicional: sem id, nada mudou ⇒ nada é escrito.
    expect(ListingRepository.updateListing).not.toHaveBeenCalled();
  });

  it("listCatalogItems pagina pelo cursor `after` e soma as duas páginas", async () => {
    (axios as any).get = vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          data: [
            { id: "1", retailer_id: "S1" },
            { id: "2", retailer_id: "S2" },
          ],
          paging: { cursors: { after: "CURSOR-1" } },
        },
      })
      .mockResolvedValueOnce({
        data: { data: [{ id: "3", retailer_id: "S3" }], paging: {} },
      });

    const items = await FacebookApiService.listCatalogItems("tok", {
      catalogId: "cat-tenant-A",
    });

    // Sem o cursor o import enxergaria só os 100 primeiros itens do catálogo
    // (silenciosamente) e os demais nasceriam como "não encontrados".
    expect(items.map((i) => i.id)).toEqual(["1", "2", "3"]);
    expect((axios as any).get).toHaveBeenCalledTimes(2);

    const [url1] = (axios as any).get.mock.calls[0];
    const [url2] = (axios as any).get.mock.calls[1];
    expect(url1).toContain("/cat-tenant-A/products");
    expect(url1).not.toContain("after=");
    // A 2ª página TEM de carregar o cursor da 1ª; se o loop esquecesse de
    // propagar `after`, ele releria a página 1 para sempre (ou até maxPages).
    expect(url2).toContain("after=CURSOR-1");
    // Os campos novos precisam ser pedidos: sem eles a Meta simplesmente não
    // devolve estoque nem galeria, e a normalização volta a 1 unidade/1 foto.
    expect(url1).toContain("quantity_to_sell_on_facebook");
    expect(url1).toContain("additional_image_urls");
  });
});
