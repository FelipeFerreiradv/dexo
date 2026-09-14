/**
 * O CASO A, reproduzido: a mesma peca vendida em dois canais.
 *
 * Tenant cmn5yc4rn0000vsasmwv9m8nc, SKU 33996, "Circuito lanterna traseira
 * direita Fiat Strada 2015". UMA unidade, cinco anuncios: tres na Shopee e
 * dois no Mercado Livre, em contas diferentes.
 *
 *   01/08 23:02 BRT  venda na Shopee, StockLog -1, estoque 1 -> 0
 *   02/08 02:02:04   Shopee 58213873527  SUCCESS  estoque -> 0
 *   02/08 02:02:07   Shopee 58213877761  SUCCESS  estoque -> 0
 *   02/08 02:02:10   Shopee 22299560451  SUCCESS  estoque -> 0
 *   02/08 02:02:02   ML MLB4862117235    WARNING  under_review, qtd remota 1
 *   02/08 02:02:07   ML MLB4862135565    WARNING  under_review, qtd remota 1
 *   10/09 15:27      MLB4862117235 VENDE a peca que nao existia mais
 *
 * As tres Shopee foram zeradas em segundos. Os dois do ML foram pulados com
 * `success: true, skipped: true`, o StockSyncJob foi apagado como se tivesse
 * dado certo, e o mesmo WARNING se repetiu a cada 15 min por 39 dias.
 *
 * O invariante que este teste trava: quando o disponivel chega a zero, NENHUM
 * canal continua com quantidade vendavel — nem o canal cujo anuncio esta fora
 * do ar, que era exatamente o buraco.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Platform } from "@prisma/client";

vi.mock("@/app/lib/prisma", () => ({
  default: {
    product: { findUnique: vi.fn() },
    productListing: { findUnique: vi.fn().mockResolvedValue(null) },
    syncLog: { create: vi.fn().mockResolvedValue({}) },
    systemLog: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn() },
  },
}));

vi.mock("@/app/marketplaces/services/ml-api.service", () => ({
  MLApiService: {
    getItemDetails: vi.fn(),
    updateItem: vi.fn().mockResolvedValue({}),
    updateItemStock: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock("@/app/marketplaces/services/shopee-api.service", () => ({
  ShopeeApiService: {
    getItemDetails: vi.fn().mockResolvedValue({ item_status: "NORMAL" }),
    updateItemStock: vi.fn().mockResolvedValue({}),
  },
}));

import prisma from "@/app/lib/prisma";
import { MLApiService } from "@/app/marketplaces/services/ml-api.service";

import { SyncUseCase } from "@/app/marketplaces/usecases/sync.usercase";

/** A peca do caso real: 1 unidade, 5 anuncios em 5 contas. */
function produtoSku33996(stock: number) {
  return {
    id: "cmrb9wd4m001018gb7aj5yb68",
    name: "Circuito lanterna traseira direita Fiat Strada 2015",
    sku: "33996",
    stock,
    reservedStock: 0,
    price: 49,
    listings: [
      {
        id: "lst-ml-1",
        externalListingId: "MLB4862117235",
        status: "active",
        marketplaceAccount: {
          id: "acc-ml-1",
          platform: Platform.MERCADO_LIVRE,
          accessToken: "tok-ml-1",
          status: "ACTIVE",
        },
      },
      {
        id: "lst-ml-2",
        externalListingId: "MLB4862135565",
        status: "active",
        marketplaceAccount: {
          id: "acc-ml-2",
          platform: Platform.MERCADO_LIVRE,
          accessToken: "tok-ml-2",
          status: "ACTIVE",
        },
      },
    ],
  };
}

describe("Caso A — a mesma unidade vendida em dois canais", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ML_ZERO_REMOTE_QTY_ON_EMPTY_DISABLED;
    (prisma as any).syncLog.create.mockResolvedValue({});
    (prisma as any).systemLog.findFirst.mockResolvedValue(null);
    (MLApiService.updateItem as any).mockResolvedValue({});
    (MLApiService.updateItemStock as any).mockResolvedValue({});
  });

  it("zera a quantidade dos DOIS anuncios do ML mesmo estando under_review", async () => {
    // O estado exato de 02/08: os dois itens em revisao, com 1 disponivel cada.
    (MLApiService.getItemDetails as any).mockImplementation(
      async (_tok: string, id: string) => ({
        id,
        status: "under_review",
        available_quantity: 1,
      }),
    );
    (prisma as any).product.findUnique.mockResolvedValue(produtoSku33996(0));

    const results = await SyncUseCase.syncProductStock(
      "cmrb9wd4m001018gb7aj5yb68",
    );

    // Antes da correcao: 0 chamadas, dois WARNING e a quantidade intacta.
    expect(MLApiService.updateItemStock).toHaveBeenCalledTimes(2);
    expect(MLApiService.updateItemStock).toHaveBeenCalledWith(
      "tok-ml-1",
      "MLB4862117235",
      0,
    );
    expect(MLApiService.updateItemStock).toHaveBeenCalledWith(
      "tok-ml-2",
      "MLB4862135565",
      0,
    );
    expect(results.every((r) => r.success)).toBe(true);

    // INVARIANTE: nenhum canal ficou com quantidade vendavel.
    for (const r of results) {
      expect(r.newStock ?? 0).toBe(0);
    }
  });

  it("a peca de UMA unidade nao pode sobrar vendavel em canal nenhum", async () => {
    // Um anuncio por estado terminalmente "fora do ar" que o ML preserva.
    const estados = ["paused", "inactive", "under_review"];
    const produto = produtoSku33996(0) as any;
    produto.listings = estados.map((_, i) => ({
      id: "lst-" + i,
      externalListingId: "MLB-" + i,
      status: "active",
      marketplaceAccount: {
        id: "acc-" + i,
        platform: Platform.MERCADO_LIVRE,
        accessToken: "tok-" + i,
        status: "ACTIVE",
      },
    }));
    (MLApiService.getItemDetails as any).mockImplementation(
      async (_tok: string, id: string) => ({
        id,
        status: estados[Number(id.split("-")[1])],
        available_quantity: 1,
      }),
    );
    (prisma as any).product.findUnique.mockResolvedValue(produto);

    await SyncUseCase.syncProductStock("cmrb9wd4m001018gb7aj5yb68");

    // Os tres estados que o ML preserva recebem a zeragem — nenhum escapa.
    expect(MLApiService.updateItemStock).toHaveBeenCalledTimes(3);
    for (let i = 0; i < 3; i++) {
      expect(MLApiService.updateItemStock).toHaveBeenCalledWith(
        "tok-" + i,
        "MLB-" + i,
        0,
      );
    }
  });

  it("nao mexe em anuncio closed: e terminal e o ML recusa a escrita", async () => {
    (MLApiService.getItemDetails as any).mockResolvedValue({
      id: "MLB4862117235",
      status: "closed",
      available_quantity: 1,
    });
    const produto = produtoSku33996(0) as any;
    produto.listings = [produto.listings[0]];
    (prisma as any).product.findUnique.mockResolvedValue(produto);

    await SyncUseCase.syncProductStock("cmrb9wd4m001018gb7aj5yb68");

    expect(MLApiService.updateItemStock).not.toHaveBeenCalled();
    expect(MLApiService.updateItem).not.toHaveBeenCalled();
  });

  it("com estoque disponivel, propaga a quantidade normalmente (nao regride)", async () => {
    (MLApiService.getItemDetails as any).mockResolvedValue({
      id: "MLB4862117235",
      status: "active",
      available_quantity: 0,
    });
    const produto = produtoSku33996(3) as any;
    produto.listings = [produto.listings[0]];
    (prisma as any).product.findUnique.mockResolvedValue(produto);

    await SyncUseCase.syncProductStock("cmrb9wd4m001018gb7aj5yb68");

    // Caminho normal intacto: empurra o estoque, nao pausa nada.
    expect(MLApiService.updateItemStock).toHaveBeenCalledWith(
      "tok-ml-1",
      "MLB4862117235",
      3,
    );
    expect(MLApiService.updateItem).not.toHaveBeenCalled();
  });

  // O ML RECUSA alterar available_quantity em boa parte dos anuncios fora do
  // ar — medido no SyncLog de producao (60d): 2.922 recusas em 241 anuncios
  // inactive, 1.408 em 557 under_review, 97 em 8 paused. Tratar isso como falha
  // trocaria um problema por outro: 800+ anuncios em retry a cada ciclo,
  // inflando fila e log sem nunca conseguir gravar.
  it("degrada para o comportamento anterior quando o ML recusa a quantidade", async () => {
    (MLApiService.getItemDetails as any).mockResolvedValue({
      id: "MLB4862135565",
      status: "inactive",
      available_quantity: 1,
    });
    (MLApiService.updateItemStock as any).mockRejectedValue(
      new Error(
        "Erro ao atualizar item: Cannot update item MLB4862135565 [status:inactive, has_bids:false] (validation_error | field_not_updatable: available_quantity is not modifiable.)",
      ),
    );
    const produto = produtoSku33996(0) as any;
    produto.listings = [produto.listings[1]];
    (prisma as any).product.findUnique.mockResolvedValue(produto);

    const results = await SyncUseCase.syncProductStock(
      "cmrb9wd4m001018gb7aj5yb68",
    );

    // Tentou — e, diante do NAO definitivo do ML, voltou ao WARNING de sempre
    // em vez de virar FAILURE e entrar em retry eterno.
    expect(MLApiService.updateItemStock).toHaveBeenCalledWith(
      "tok-ml-2",
      "MLB4862135565",
      0,
    );
    expect(results[0].success).toBe(true);
    expect((results[0] as any).skipped).toBe(true);
    expect((results[0] as any).skipReason).toBe("ml_status_inactive");
  });

  it("erro que NAO e recusa de quantidade continua sendo falha e retry", async () => {
    (MLApiService.getItemDetails as any).mockResolvedValue({
      id: "MLB4862135565",
      status: "paused",
      available_quantity: 1,
    });
    (MLApiService.updateItemStock as any).mockRejectedValue(
      new Error("socket hang up"),
    );
    const produto = produtoSku33996(0) as any;
    produto.listings = [produto.listings[1]];
    (prisma as any).product.findUnique.mockResolvedValue(produto);

    const results = await SyncUseCase.syncProductStock(
      "cmrb9wd4m001018gb7aj5yb68",
    );

    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain("socket hang up");
  });

  // A Shopee NAO e coberta aqui de proposito. Ela ja funcionava no caso real
  // (as tres foram zeradas em segundos em 02/08) e esta correcao nao toca no
  // caminho dela. Exercitar `syncShopeeProductStock` exigiria mockar a cadeia
  // de assinatura/shopId da API, e o teste resultante provaria sobre o mock,
  // nao sobre a correcao. A cobertura da Shopee fica nos specs dedicados
  // (stock-deduction-*, order-usecase-shopee-multi).
});
