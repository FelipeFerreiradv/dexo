// SINCRONIZAÇÃO DE DADOS DA SHOPEE (EDIÇÃO DE PRODUTO) COM ID PROVISÓRIO
//
// O QUE ESTAVA ERRADO
// `syncShopeeProductData` roda em TODA edição de produto (PUT /products/:id →
// syncProductListings → syncProductData). Ele chamava
// `getItemBaseInfo(..., parseInt(externalListingId))` e
// `updateItem({ item_id: parseInt(externalListingId) })` sem olhar se o id era
// o MARCADOR local `PENDING_SHP_<timestamp>` que a Dexo grava quando a criação
// do anúncio falha. `parseInt("PENDING_SHP_…")` é NaN ⇒ a requisição saía para
// a Shopee com `item_id_list=NaN`, voltava `strconv.ParseUint: parsing "NaN"`
// e gastava a cota da conta — a mesma cota dos anúncios de verdade (429).
//
// O Mercado Livre (`syncMLProductData`) já resolvia: marcador ⇒ SyncLog
// PRODUCT_SYNC WARNING, `success:false`, NENHUMA chamada. O sync de ESTOQUE da
// Shopee ganhou a mesma guarda na onda anterior
// (tests/shopee-stock-sync-placeholder.spec.ts). Este spec prova o mesmo no
// sync de DADOS, com o MESMO predicado, e que o anúncio com item_id numérico
// segue chamando a API EXATAMENTE como antes.
//
// O espião fica na fronteira HTTP (`makeAuthenticatedRequest`): "nenhuma
// chamada" aqui quer dizer nenhuma requisição saindo para a Shopee.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SyncStatus, SyncType } from "@prisma/client";

import prisma from "@/app/lib/prisma";
import {
  isShopeeListingPlaceholder,
  parseShopeeItemId,
} from "@/app/marketplaces/lib/shopee-listing-placeholder.logic";
import { ShopeeApiService } from "@/app/marketplaces/services/shopee-api.service";
import { SyncUseCase } from "@/app/marketplaces/usecases/sync.usercase";

const conta = {
  id: "acc-shp",
  platform: "SHOPEE",
  accessToken: "tok-shp",
  refreshToken: "ref-shp",
  shopId: 999,
};

const produto = (over: Record<string, any> = {}) => ({
  id: "prod-1",
  sku: "SKU-1",
  name: "Farol Dianteiro",
  description: "Farol original",
  price: 150,
  stock: 4,
  reservedStock: 0,
  compatibilities: [],
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
              item_name: "Farol antigo",
              description: "Farol original",
              has_model: false,
              price_info: [{ current_price: 100 }],
              stock_info_v2: { summary_info: { total_available_stock: 1 } },
            })),
          },
        };
      }
      if (apiPath === "/api/v2/product/update_item") {
        if (!Number.isFinite(body?.item_id)) {
          return {
            error: "error_param",
            message: 'strconv.ParseUint: parsing "NaN": invalid syntax',
          };
        }
        return { response: { item_id: body.item_id } };
      }
      if (apiPath === "/api/v2/product/update_price") {
        return { response: { result: [] } };
      }
      throw new Error(`chamada inesperada à Shopee: ${apiPath}`);
    });

// Espião do SyncLog tipado pelo próprio Prisma (`mock.calls[i][0].data`).
const espiarSyncLog = () =>
  vi.spyOn(prisma.syncLog, "create").mockResolvedValue({} as any);

const espiarApi = () => ({
  baseInfo: vi.spyOn(ShopeeApiService, "getItemBaseInfo"),
  updateItem: vi.spyOn(ShopeeApiService, "updateItem"),
  updatePrice: vi.spyOn(ShopeeApiService, "updatePrice"),
  uploadImage: vi
    .spyOn(ShopeeApiService, "uploadImage")
    .mockResolvedValue({ image_info: { image_id: "img-1" } } as any),
});

const sincronizar = (externalListingId: string, over: Record<string, any> = {}, account: any = conta) =>
  (SyncUseCase as any).syncShopeeProductData(
    produto(over),
    externalListingId,
    { ...account },
  );

const MENSAGEM_ERRO =
  "Anúncio local (placeholder) — não existe na Shopee. Sincronização ignorada.";

describe("Shopee — sync de DADOS com anúncio de id provisório (PENDING_SHP_)", () => {
  let syncLog: ReturnType<typeof espiarSyncLog>;

  beforeEach(() => {
    syncLog = espiarSyncLog();
    vi.stubEnv("PRODUCT_SYNC_FULL_FIELDS_ENABLED", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("marcador PENDING_SHP_ ⇒ nenhuma requisição à Shopee e SyncLog PRODUCT_SYNC WARNING equivalente ao do ML", async () => {
    const http = simularShopee();
    const api = espiarApi();

    const result = await sincronizar("PENDING_SHP_1727000000000");

    expect(http).not.toHaveBeenCalled();
    expect(api.baseInfo).not.toHaveBeenCalled();
    expect(api.updateItem).not.toHaveBeenCalled();
    expect(api.updatePrice).not.toHaveBeenCalled();

    expect(syncLog).toHaveBeenCalledTimes(1);
    expect(syncLog).toHaveBeenCalledWith({
      data: {
        marketplaceAccountId: "acc-shp",
        type: SyncType.PRODUCT_SYNC,
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
      error: MENSAGEM_ERRO,
    });
  });

  it.each([
    "PENDING_SHP_1",
    "PENDING_REPUBLISH_22840012345_1727000000000",
    "sem-id",
    "",
  ])("id %j que não vira item_id ⇒ nenhuma requisição e WARNING (nunca FAILURE)", async (id) => {
    const http = simularShopee();

    const result = await sincronizar(id);

    expect(http).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false, error: MENSAGEM_ERRO });
    const status = syncLog.mock.calls.map((c: any[]) => c[0]?.data?.status);
    expect(status).toEqual([SyncStatus.WARNING]);
    expect(syncLog.mock.calls[0][0].data.type).toBe(SyncType.PRODUCT_SYNC);
  });

  it("com PRODUCT_SYNC_FULL_FIELDS_ENABLED ligado, o marcador também não sobe foto nem ficha técnica", async () => {
    vi.stubEnv("PRODUCT_SYNC_FULL_FIELDS_ENABLED", "true");
    const http = simularShopee();
    const api = espiarApi();

    const result = await sincronizar("PENDING_SHP_1727000000004", {
      imageUrls: ["https://cdn.exemplo/foto-1.jpg"],
      attributes: { Marca: { value_name: "Bosch" } },
    });

    expect(http).not.toHaveBeenCalled();
    expect(api.uploadImage).not.toHaveBeenCalled();
    expect(api.updateItem).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
  });

  it("falha ao gravar o WARNING não derruba o sync (mesma tolerância do ML)", async () => {
    const http = simularShopee();
    syncLog.mockRejectedValueOnce(new Error("db fora"));

    const result = await sincronizar("PENDING_SHP_1727000000002");

    expect(http).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: false,
      productId: "prod-1",
      externalListingId: "PENDING_SHP_1727000000002",
      error: MENSAGEM_ERRO,
    });
  });

  it("conta sem shopId continua respondendo como antes, mesmo com marcador (a checagem da conta vem primeiro)", async () => {
    const http = simularShopee();

    const result = await sincronizar("PENDING_SHP_1727000000003", {}, {
      ...conta,
      shopId: null,
    });

    expect(http).not.toHaveBeenCalled();
    expect(syncLog).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toContain("encontrado para conta Shopee");
    expect(result.error).not.toContain("placeholder");
  });
});

describe("Shopee — sync de DADOS com item_id numérico segue EXATAMENTE como antes", () => {
  let syncLog: ReturnType<typeof espiarSyncLog>;

  beforeEach(() => {
    syncLog = espiarSyncLog();
    vi.stubEnv("PRODUCT_SYNC_FULL_FIELDS_ENABLED", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("id numérico ⇒ get_item_base_info + update_item + update_price com os MESMOS argumentos de hoje", async () => {
    const http = simularShopee();
    const api = espiarApi();

    const result = await sincronizar("22840012345");

    expect(api.baseInfo).toHaveBeenCalledTimes(1);
    expect(api.baseInfo).toHaveBeenCalledWith("tok-shp", 999, 22840012345);
    expect(api.updateItem).toHaveBeenCalledTimes(1);
    expect(api.updateItem).toHaveBeenCalledWith("tok-shp", 999, {
      item_id: 22840012345,
      stock: 4,
      item_name: "Farol Dianteiro",
    });
    expect(api.updatePrice).toHaveBeenCalledTimes(1);
    expect(api.updatePrice).toHaveBeenCalledWith("tok-shp", 999, 22840012345, [
      { original_price: 150 },
    ]);

    // Ordem e corpo das requisições que saem para a Shopee.
    expect(http.mock.calls.map((c: any[]) => [c[0], String(c[1]).split("?")[0]])).toEqual([
      ["GET", "/api/v2/product/get_item_base_info"],
      ["POST", "/api/v2/product/update_item"],
      ["POST", "/api/v2/product/update_price"],
    ]);
    expect(http.mock.calls[0][1]).toContain("item_id_list=22840012345");
    expect(http.mock.calls[0][4]).toMatchObject({ item_id_list: [22840012345] });
    expect(http.mock.calls[2][4]).toEqual({
      item_id: 22840012345,
      price_list: [{ original_price: 150 }],
    });

    expect(result).toEqual({
      success: true,
      productId: "prod-1",
      externalListingId: "22840012345",
      previousStock: 1,
      newStock: 4,
      previousPrice: 100,
      newPrice: 150,
    });
    expect(syncLog).toHaveBeenCalledTimes(1);
    expect(syncLog.mock.calls[0][0].data).toMatchObject({
      marketplaceAccountId: "acc-shp",
      type: SyncType.PRODUCT_SYNC,
      status: SyncStatus.SUCCESS,
      payload: { productId: "prod-1", externalListingId: "22840012345" },
    });
  });

  it.each([
    ["22840012345:777", 22840012345],
    [" 22840012345 ", 22840012345],
    ["12abc", 12],
  ])("id %j ⇒ parseInt tolera como antes e a chamada sai com %d", async (id, itemId) => {
    simularShopee();
    const api = espiarApi();

    const result = await sincronizar(id);

    expect(api.baseInfo).toHaveBeenCalledWith("tok-shp", 999, itemId);
    expect(api.updateItem.mock.calls[0][2]).toMatchObject({ item_id: itemId });
    expect(api.updatePrice.mock.calls[0][2]).toBe(itemId);
    expect(result.success).toBe(true);
  });

  it("erro da Shopee em id numérico continua como antes: result.error e nenhum WARNING", async () => {
    vi.spyOn(ShopeeApiService as any, "makeAuthenticatedRequest").mockResolvedValue(
      { error: "error_server", message: "Too many requests" },
    );

    const result = await sincronizar("22840012345");

    expect(result).toEqual({
      success: false,
      productId: "prod-1",
      externalListingId: "22840012345",
      error: "Erro ao buscar itens base: Too many requests",
    });
    expect(syncLog).not.toHaveBeenCalled();
  });

  it("⭐ o predicado nunca separa do parse REAL do sync de dados: ou não chama, ou chama com item_id positivo", async () => {
    const amostra = [
      "22840012345",
      "22840012345:777",
      " 22840012345 ",
      "12abc",
      "+5",
      "PENDING_SHP_1",
      "PENDING_REPUBLISH_22840012345_1",
      "sem-id",
      "",
      "0",
      "-5",
      "0:7",
      ":123",
      "0x1A",
    ];
    for (const id of amostra) {
      vi.restoreAllMocks();
      espiarSyncLog();
      simularShopee();
      const api = espiarApi();

      await sincronizar(id);

      const marcador = isShopeeListingPlaceholder(id);
      if (marcador) {
        expect(api.baseInfo, id).not.toHaveBeenCalled();
        expect(api.updateItem, id).not.toHaveBeenCalled();
        expect(api.updatePrice, id).not.toHaveBeenCalled();
        continue;
      }
      const itemIds = [
        api.baseInfo.mock.calls[0]?.[2],
        api.updateItem.mock.calls[0]?.[2]?.item_id,
        api.updatePrice.mock.calls[0]?.[2],
      ];
      for (const itemId of itemIds) {
        expect(Number.isFinite(itemId) && itemId > 0, id).toBe(true);
        expect(itemId, id).toBe(parseShopeeItemId(id));
      }
    }
  });
});

describe("Shopee — entrada pública syncProductData (edição de produto)", () => {
  let syncLog: ReturnType<typeof espiarSyncLog>;

  beforeEach(() => {
    syncLog = espiarSyncLog();
    vi.stubEnv("PRODUCT_SYNC_FULL_FIELDS_ENABLED", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const montarBanco = (externalListingId: string) => ({
    product: vi
      .spyOn(prisma.product, "findUnique")
      .mockResolvedValue(produto({ compatibilities: undefined }) as any),
    account: vi
      .spyOn(prisma.marketplaceAccount, "findUnique")
      .mockResolvedValue({ ...conta } as any),
    listing: vi.spyOn(prisma.productListing, "findUnique").mockResolvedValue({
      id: `lst-${externalListingId}`,
      externalListingId,
      status: "active",
    } as any),
    compat: vi
      .spyOn((prisma as any).productCompatibility, "findMany")
      .mockResolvedValue([] as any),
  });

  it("marcador ⇒ nenhuma requisição, WARNING PRODUCT_SYNC e as MESMAS leituras de banco do id numérico", async () => {
    const http = simularShopee();
    const bancoMarcador = montarBanco("PENDING_SHP_1727000000005");

    const r1 = await SyncUseCase.syncProductData(
      "prod-1",
      "PENDING_SHP_1727000000005",
      "acc-shp",
    );

    expect(http).not.toHaveBeenCalled();
    expect(r1).toEqual({
      success: false,
      productId: "prod-1",
      externalListingId: "PENDING_SHP_1727000000005",
      error: MENSAGEM_ERRO,
    });
    expect(syncLog.mock.calls.map((c: any[]) => c[0].data.status)).toEqual([
      SyncStatus.WARNING,
    ]);
    expect(syncLog.mock.calls[0][0].data.type).toBe(SyncType.PRODUCT_SYNC);
    const leiturasMarcador = [
      bancoMarcador.product.mock.calls.length,
      bancoMarcador.account.mock.calls.length,
      bancoMarcador.listing.mock.calls.length,
      bancoMarcador.compat.mock.calls.length,
    ];

    vi.restoreAllMocks();
    espiarSyncLog();
    simularShopee();
    const api = espiarApi();
    const bancoNumerico = montarBanco("22840012345");

    const r2 = await SyncUseCase.syncProductData(
      "prod-1",
      "22840012345",
      "acc-shp",
    );

    expect(r2.success).toBe(true);
    expect(api.baseInfo).toHaveBeenCalledWith("tok-shp", 999, 22840012345);
    // Nenhuma consulta nova: a guarda decide só pelo id que já veio.
    expect(leiturasMarcador).toEqual([
      bancoNumerico.product.mock.calls.length,
      bancoNumerico.account.mock.calls.length,
      bancoNumerico.listing.mock.calls.length,
      bancoNumerico.compat.mock.calls.length,
    ]);
    expect(leiturasMarcador).toEqual([1, 1, 1, 1]);
  });
});
