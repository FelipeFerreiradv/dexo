// SINCRONIZAÇÃO DE ESTOQUE DA SHOPEE COM ID PROVISÓRIO
//
// O QUE ESTAVA ERRADO
// Quando a criação de um anúncio na Shopee falha, a Dexo guarda um MARCADOR
// local no lugar do item_id: `PENDING_SHP_<timestamp>` (listing.usercase). O
// sync de estoque da Shopee convertia esse texto com parseInt ⇒ NaN e chamava
// get_item_base_info com `item_id_list=NaN`. A Shopee respondia
// `strconv.ParseUint: parsing "NaN"` e o SyncLog gravava FAILURE "Erro ao
// atualizar estoque: Erro ao buscar itens base: ...". Medido em produção: 423
// FAILURE em 10 dias, parte delas 429 "Too many requests" — as chamadas
// inúteis gastavam a cota da conta e atrapalhavam os anúncios de verdade.
//
// O Mercado Livre e a Magalu já resolviam isso: detectam o marcador, NÃO
// chamam a API e gravam SyncLog WARNING "Anúncio local (placeholder) — não
// existe no ...". Este spec prova que a Shopee passou a fazer o mesmo, e que
// o anúncio com item_id numérico segue chamando a API EXATAMENTE como antes.
//
// O espião fica na fronteira HTTP (`makeAuthenticatedRequest`): "nenhuma
// chamada" aqui quer dizer nenhuma requisição saindo para a Shopee.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Platform, SyncStatus, SyncType } from "@prisma/client";

import prisma from "@/app/lib/prisma";
import { ShopeeApiService } from "@/app/marketplaces/services/shopee-api.service";
import { MarketplaceRepository } from "@/app/marketplaces/repositories/marketplace.repository";
import { SyncUseCase } from "@/app/marketplaces/usecases/sync.usercase";

const conta = {
  id: "acc-shp",
  platform: "SHOPEE",
  accessToken: "tok-shp",
  refreshToken: "ref-shp",
  shopId: 999,
};

const anuncio = (externalListingId: string, over: Record<string, any> = {}) => ({
  id: `lst-${externalListingId}`,
  externalListingId,
  status: "active",
  marketplaceAccount: { ...conta },
  ...over,
});

const produto = (over: Record<string, any> = {}) => ({
  id: "prod-1",
  sku: "SKU-1",
  name: "Farol Dianteiro",
  stock: 4,
  ...over,
});

/**
 * Simula a Shopee na fronteira HTTP. `item_id_list` com NaN devolve o mesmo
 * erro que a Shopee devolve em produção — é o que tornava o defeito visível.
 */
const simularShopee = () =>
  vi
    .spyOn(ShopeeApiService as any, "makeAuthenticatedRequest")
    .mockImplementation(async (...args: any[]) => {
      const [, apiPath, , , body] = args;
      if (String(apiPath).startsWith("/api/v2/product/get_item_base_info")) {
        const ids: number[] = body?.item_id_list ?? [];
        if (ids.some((id) => !Number.isFinite(id))) {
          return {
            error: "error_param",
            message: 'strconv.ParseUint: parsing "NaN": invalid syntax',
          };
        }
        return {
          response: {
            item_list: ids.map((id) => ({
              item_id: id,
              item_status: "NORMAL",
              has_model: false,
              stock_info_v2: { summary_info: { total_available_stock: 1 } },
            })),
          },
        };
      }
      if (apiPath === "/api/v2/product/update_stock") {
        return { response: { result: [] } };
      }
      throw new Error(`chamada inesperada à Shopee: ${apiPath}`);
    });

// Espião do SyncLog tipado pelo próprio Prisma (`mock.calls[i][0].data`).
const espiarSyncLog = () =>
  vi.spyOn(prisma.syncLog, "create").mockResolvedValue({} as any);

const chamadasBaseInfo = (http: ReturnType<typeof simularShopee>): any[][] =>
  http.mock.calls.filter((c) =>
    String(c[1]).startsWith("/api/v2/product/get_item_base_info"),
  );

const chamadasUpdateStock = (http: ReturnType<typeof simularShopee>): any[][] =>
  http.mock.calls.filter((c) => c[1] === "/api/v2/product/update_stock");

describe("Shopee — sync de estoque com anúncio de id provisório (PENDING_SHP_)", () => {
  let syncLog: ReturnType<typeof espiarSyncLog>;

  beforeEach(() => {
    syncLog = espiarSyncLog();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("marcador PENDING_SHP_ ⇒ nenhuma requisição à Shopee e SyncLog WARNING equivalente ao do ML", async () => {
    const http = simularShopee();
    const baseInfo = vi.spyOn(ShopeeApiService, "getItemBaseInfo");
    const updateStock = vi.spyOn(ShopeeApiService, "updateItemStock");

    const result = await (SyncUseCase as any).syncShopeeProductStock(
      anuncio("PENDING_SHP_1727000000000"),
      produto(),
    );

    expect(http).not.toHaveBeenCalled();
    expect(baseInfo).not.toHaveBeenCalled();
    expect(updateStock).not.toHaveBeenCalled();

    expect(syncLog).toHaveBeenCalledTimes(1);
    expect(syncLog).toHaveBeenCalledWith({
      data: {
        marketplaceAccountId: "acc-shp",
        type: SyncType.STOCK_UPDATE,
        status: SyncStatus.WARNING,
        message:
          "Anúncio local (placeholder) — não existe na Shopee: PENDING_SHP_1727000000000",
        payload: {
          productId: "prod-1",
          externalListingId: "PENDING_SHP_1727000000000",
        },
      },
    });

    // Mesmo contrato do ML: não é sucesso (nada foi sincronizado), mas também
    // não é FAILURE no SyncLog.
    expect(result).toEqual({
      success: false,
      productId: "prod-1",
      externalListingId: "PENDING_SHP_1727000000000",
      error:
        "Anúncio local (placeholder) — não existe na Shopee. Sincronização ignorada.",
    });
  });

  it("marcador ⇒ nenhum SyncLog FAILURE (era o que inflava o relatório de erros)", async () => {
    simularShopee();

    await (SyncUseCase as any).syncShopeeProductStock(
      anuncio("PENDING_SHP_1727000000001"),
      produto(),
    );

    const status = syncLog.mock.calls.map((c: any[]) => c[0]?.data?.status);
    expect(status).not.toContain(SyncStatus.FAILURE);
  });

  it("falha ao gravar o WARNING não derruba o sync (mesma tolerância do ML)", async () => {
    const http = simularShopee();
    syncLog.mockRejectedValueOnce(new Error("db fora"));

    const result = await (SyncUseCase as any).syncShopeeProductStock(
      anuncio("PENDING_SHP_1727000000002"),
      produto(),
    );

    expect(http).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toContain("não existe na Shopee");
  });

  it("id que não vira item_id numérico (texto qualquer) também não sai para a Shopee", async () => {
    const http = simularShopee();

    const result = await (SyncUseCase as any).syncShopeeProductStock(
      anuncio("sem-id"),
      produto(),
    );

    expect(http).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(syncLog.mock.calls[0][0].data.status).toBe(SyncStatus.WARNING);
  });

  it("conta sem token continua respondendo como antes, mesmo com marcador (a checagem de token vem primeiro, como no ML)", async () => {
    const http = simularShopee();

    const result = await (SyncUseCase as any).syncShopeeProductStock(
      anuncio("PENDING_SHP_1727000000003", {
        marketplaceAccount: { ...conta, accessToken: null },
      }),
      produto(),
    );

    expect(http).not.toHaveBeenCalled();
    expect(syncLog).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: false,
      productId: "prod-1",
      externalListingId: "PENDING_SHP_1727000000003",
      error: "Conta sem token de acesso ou shopId",
    });
  });
});

describe("Shopee — anúncio com item_id numérico segue EXATAMENTE como antes", () => {
  let syncLog: ReturnType<typeof espiarSyncLog>;

  beforeEach(() => {
    syncLog = espiarSyncLog();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("id numérico ⇒ get_item_base_info + update_stock com os MESMOS argumentos de hoje", async () => {
    const http = simularShopee();
    const baseInfo = vi.spyOn(ShopeeApiService, "getItemBaseInfo");
    const updateStock = vi.spyOn(ShopeeApiService, "updateItemStock");

    const result = await (SyncUseCase as any).syncShopeeProductStock(
      anuncio("22840012345"),
      produto({ stock: 4 }),
    );

    expect(baseInfo).toHaveBeenCalledTimes(1);
    expect(baseInfo).toHaveBeenCalledWith("tok-shp", 999, 22840012345);

    const [get] = chamadasBaseInfo(http);
    expect(get[0]).toBe("GET");
    expect(get[1]).toContain("item_id_list=22840012345");
    expect(get[2]).toBe("tok-shp");
    expect(get[3]).toBe(999);
    expect(get[4]).toMatchObject({ item_id_list: [22840012345] });

    expect(updateStock).toHaveBeenCalledWith(
      "tok-shp",
      999,
      22840012345,
      4,
      undefined,
    );
    const [post] = chamadasUpdateStock(http);
    expect(post[4]).toEqual({
      item_id: 22840012345,
      stock_list: [{ seller_stock: [{ stock: 4 }] }],
    });

    expect(result).toMatchObject({
      success: true,
      externalListingId: "22840012345",
      previousStock: 1,
      newStock: 4,
    });
    expect(syncLog.mock.calls[0][0].data.status).toBe(SyncStatus.SUCCESS);
  });

  it("id `item:model` ⇒ item e model extraídos como antes", async () => {
    simularShopee();
    const baseInfo = vi.spyOn(ShopeeApiService, "getItemBaseInfo");
    const updateStock = vi.spyOn(ShopeeApiService, "updateItemStock");

    await (SyncUseCase as any).syncShopeeProductStock(
      anuncio("22840012345:777"),
      produto({ stock: 2 }),
    );

    expect(baseInfo).toHaveBeenCalledWith("tok-shp", 999, 22840012345);
    expect(updateStock).toHaveBeenCalledWith(
      "tok-shp",
      999,
      22840012345,
      2,
      777,
    );
  });

  it("id numérico com espaço em volta ⇒ parseInt tolera como antes e a chamada sai igual", async () => {
    simularShopee();
    const baseInfo = vi.spyOn(ShopeeApiService, "getItemBaseInfo");

    const result = await (SyncUseCase as any).syncShopeeProductStock(
      anuncio(" 22840012345 "),
      produto(),
    );

    expect(baseInfo).toHaveBeenCalledWith("tok-shp", 999, 22840012345);
    expect(result.success).toBe(true);
  });

  it("erro da Shopee em id numérico continua virando FAILURE (o WARNING é só para marcador)", async () => {
    vi.spyOn(ShopeeApiService as any, "makeAuthenticatedRequest").mockResolvedValue(
      { error: "error_server", message: "Too many requests" },
    );

    const result = await (SyncUseCase as any).syncShopeeProductStock(
      anuncio("22840012345"),
      produto(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("Erro ao buscar itens base: Too many requests");
    expect(syncLog.mock.calls[0][0].data.status).toBe(SyncStatus.FAILURE);
  });
});

describe("Shopee — lote misto: só os anúncios com item_id válido chamam a API", () => {
  let syncLog: ReturnType<typeof espiarSyncLog>;

  beforeEach(() => {
    syncLog = espiarSyncLog();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("syncAllStock (botão 'Sincronizar Estoque') com marcadores e ids reais", async () => {
    const http = simularShopee();
    vi.spyOn(MarketplaceRepository, "findAllByUserIdAndPlatform").mockResolvedValue(
      [conta] as any,
    );
    const listagem = [
      { ...anuncio("PENDING_SHP_1"), product: produto({ id: "p-1" }) },
      { ...anuncio("111"), product: produto({ id: "p-2", stock: 3 }) },
      { ...anuncio("PENDING_SHP_2"), product: produto({ id: "p-3" }) },
      { ...anuncio("222:9"), product: produto({ id: "p-4", stock: 0 }) },
    ];
    vi.spyOn(prisma.productListing, "findMany").mockResolvedValue(
      listagem as any,
    );

    const result = await SyncUseCase.syncAllStock("user-1", Platform.SHOPEE);

    const idsConsultados = chamadasBaseInfo(http).map(
      (c) => c[4].item_id_list,
    );
    expect(idsConsultados).toEqual(expect.arrayContaining([[111], [222]]));
    expect(idsConsultados).toHaveLength(2);
    expect(chamadasUpdateStock(http)).toHaveLength(2);

    const avisos = syncLog.mock.calls
      .map((c: any[]) => c[0].data)
      .filter((d: any) => d.status === SyncStatus.WARNING && d.payload?.productId);
    expect(avisos.map((d: any) => d.payload.externalListingId).sort()).toEqual([
      "PENDING_SHP_1",
      "PENDING_SHP_2",
    ]);
    const falhas = syncLog.mock.calls
      .map((c: any[]) => c[0].data)
      .filter((d: any) => d.status === SyncStatus.FAILURE);
    expect(falhas).toHaveLength(0);

    expect(result.total).toBe(4);
    expect(result.successful).toBe(2);
    // Mesmo contrato do ML: marcador conta como não-sincronizado.
    expect(result.failed).toBe(2);
  });

  it("syncProductStock (baixa por venda / fila de retry) com marcador e id real no mesmo produto", async () => {
    const http = simularShopee();
    vi.spyOn(prisma.product, "findUnique").mockResolvedValue({
      ...produto({ id: "p-9", stock: 5 }),
      reservedStock: 0,
      listings: [anuncio("PENDING_SHP_9"), anuncio("333")],
    } as any);

    const results = await SyncUseCase.syncProductStock("p-9");

    expect(chamadasBaseInfo(http).map((c) => c[4].item_id_list)).toEqual([
      [333],
    ]);
    expect(results).toHaveLength(2);
    const porId = Object.fromEntries(
      results.map((r) => [r.externalListingId, r]),
    );
    expect(porId["PENDING_SHP_9"]).toMatchObject({
      success: false,
      listingId: "lst-PENDING_SHP_9",
      platform: "SHOPEE",
    });
    expect(porId["PENDING_SHP_9"].error).toContain("não existe na Shopee");
    expect(porId["333"]).toMatchObject({ success: true, newStock: 5 });
  });
});
