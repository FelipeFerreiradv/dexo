import { describe, it, expect, vi, afterEach } from "vitest";
import { Platform } from "@prisma/client";

import prisma from "@/app/lib/prisma";
import { SyncUseCase } from "@/app/marketplaces/usecases/sync.usercase";
import { MarketplaceRepository } from "@/app/marketplaces/repositories/marketplace.repository";
import { ShopeeApiService } from "@/app/marketplaces/services/shopee-api.service";
import { ListingAutodetectUseCase } from "@/app/marketplaces/usecases/listing-autodetect.usercase";

/**
 * Harness do `importShopeeItems` — espelha tests/import-ml-items.spec.ts, que
 * já cobria o import do ML. O que faltava cobertura aqui:
 *
 * - o TETO do preview: `result.items` vai inteiro para o JSONB do SyncLog,
 *   reescrito a cada flush de progresso e relido pelo polling do front. ML e
 *   Magalu já capavam; a Shopee empurrava direto no array;
 * - a garantia de que capar o PREVIEW não capa os CONTADORES (totalItems,
 *   linkedItems e createdProducts têm de refletir o lote inteiro);
 * - o roteamento pelo núcleo idempotente (anti-duplicação) e a identidade por
 *   VARIAÇÃO (`item_id:model_id`).
 */

const PREVIEW_LIMIT = 100; // SyncUseCase.IMPORT_ITEMS_PREVIEW_LIMIT (privado)

const account = {
  id: "acc-shopee",
  userId: "u1",
  accessToken: "token",
  refreshToken: "refresh",
  shopId: 4242,
} as never;

/** Item do get_item_list (o "snapshot" que alimenta o SKU de fallback). */
const listRow = (id: number) => ({
  item_id: id,
  item_sku: `SKU-${id}`,
  item_name: `Peça ${id}`,
  item_status: "NORMAL",
});

/** Item do get_item_base_info. */
const baseInfo = (id: number, over: Record<string, unknown> = {}) =>
  ({
    item_id: id,
    item_name: `Peça ${id}`,
    item_sku: `SKU-${id}`,
    status: "NORMAL",
    has_model: false,
    ...over,
  }) as never;

/** Liga os mocks para um lote de `count` itens sem variação. */
function arrange(count: number) {
  const ids = Array.from({ length: count }, (_, i) => i + 1);

  vi.spyOn(MarketplaceRepository, "findByIdAndUser").mockResolvedValue(account);

  // get_item_list pagina de 100 em 100.
  vi.spyOn(ShopeeApiService, "getItemList").mockImplementation(
    async (_accessToken, _shopId, params) => {
      const offset = params?.offset ?? 0;
      const pageSize = params?.page_size ?? 100;
      const slice = ids.slice(offset, offset + pageSize);
      const nextOffset = offset + slice.length;
      return {
        item: slice.map(listRow),
        has_next_page: nextOffset < ids.length,
        next_offset: nextOffset,
      } as never;
    },
  );

  vi.spyOn(ShopeeApiService, "getItemsBaseInfo").mockImplementation(
    async (_accessToken, _shopId, itemIds) =>
      itemIds.map((id) => baseInfo(id)) as never,
  );

  vi.spyOn(prisma.productListing, "findMany").mockResolvedValue([] as never);
  vi.spyOn(prisma.product, "findMany").mockResolvedValue([] as never);
  vi.spyOn(SyncUseCase as never as { logSync: () => unknown }, "logSync").mockResolvedValue(
    undefined as never,
  );

  const core = vi
    .spyOn(ListingAutodetectUseCase, "upsertProductFromMarketplaceItem")
    .mockImplementation(
      async (normalized) =>
        ({
          action: "created_product",
          productId: `p-${normalized.externalListingId}`,
        }) as never,
    );

  return { ids, core };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SyncUseCase.importShopeeItems — teto do preview de itens", () => {
  it("acima do teto: preview para em 100 e marca itemsPreviewTruncated", async () => {
    arrange(250);

    const result = await SyncUseCase.importShopeeItems("u1", "acc-shopee");

    expect(result.items).toHaveLength(PREVIEW_LIMIT);
    expect(result.itemsPreviewTruncated).toBe(true);
  });

  it("capar o PREVIEW não capa os CONTADORES (o lote inteiro é processado)", async () => {
    const { core } = arrange(250);

    const result = await SyncUseCase.importShopeeItems("u1", "acc-shopee");

    // Esta é a garantia que faz o teto ser seguro: nada que o operador lê como
    // número foi truncado — só a lista de amostra.
    expect(result.totalItems).toBe(250);
    expect(result.linkedItems).toBe(250);
    expect(result.createdProducts).toBe(250);
    expect(result.unlinkedItems).toBe(0);
    expect(core).toHaveBeenCalledTimes(250);
  });

  it("abaixo do teto: preview completo e sem marca de truncamento", async () => {
    arrange(10);

    const result = await SyncUseCase.importShopeeItems("u1", "acc-shopee");

    expect(result.items).toHaveLength(10);
    expect(result.itemsPreviewTruncated).toBeFalsy();
    expect(result.totalItems).toBe(10);
  });

  it("o payload de PROGRESSO (que vai ao JSONB do SyncLog) também fica limitado", async () => {
    arrange(250);
    const previews: number[] = [];

    await SyncUseCase.importShopeeItems("u1", "acc-shopee", {
      onProgress: (p) => {
        previews.push(p.itemsPreview?.length ?? 0);
      },
    });

    expect(previews.length).toBeGreaterThan(0);
    expect(Math.max(...previews)).toBeLessThanOrEqual(PREVIEW_LIMIT);
  });
});

describe("SyncUseCase.importShopeeItems — roteamento e identidade", () => {
  it("pagina o get_item_list até has_next_page terminar", async () => {
    arrange(250);

    await SyncUseCase.importShopeeItems("u1", "acc-shopee");

    // 100 + 100 + 50 → 3 páginas.
    expect(ShopeeApiService.getItemList).toHaveBeenCalledTimes(3);
  });

  it("todo item passa pelo núcleo idempotente com o payload normalizado", async () => {
    const { core } = arrange(1);

    await SyncUseCase.importShopeeItems("u1", "acc-shopee");

    expect(core).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: Platform.SHOPEE,
        externalListingId: "1",
        rawSku: "SKU-1",
        account: expect.objectContaining({ id: "acc-shopee", userId: "u1" }),
      }),
      // Cache write-through do lote (mesmo desenho do import ML).
      expect.objectContaining({
        productsBySku: expect.any(Map),
        productIdsWithListing: expect.any(Set),
        knownExternalListingIds: expect.any(Set),
      }),
    );
  });

  it("item COM variações vira um anúncio por modelo (externalId item:model)", async () => {
    vi.spyOn(MarketplaceRepository, "findByIdAndUser").mockResolvedValue(account);
    vi.spyOn(ShopeeApiService, "getItemList").mockResolvedValue({
      item: [listRow(7)],
      has_next_page: false,
      next_offset: 1,
    } as never);
    vi.spyOn(ShopeeApiService, "getItemsBaseInfo").mockResolvedValue([
      baseInfo(7, {
        has_model: true,
        model_list: [
          { model_id: 11, model_name: "Azul", model_sku: "SKU-7-A" },
          { model_id: 22, model_name: "Verde", model_sku: "SKU-7-B" },
        ],
      }),
    ] as never);
    vi.spyOn(prisma.productListing, "findMany").mockResolvedValue([] as never);
    vi.spyOn(prisma.product, "findMany").mockResolvedValue([] as never);
    vi.spyOn(SyncUseCase as never as { logSync: () => unknown }, "logSync").mockResolvedValue(
      undefined as never,
    );
    const core = vi
      .spyOn(ListingAutodetectUseCase, "upsertProductFromMarketplaceItem")
      .mockResolvedValue({ action: "created_product", productId: "p-x" } as never);

    const result = await SyncUseCase.importShopeeItems("u1", "acc-shopee");

    expect(result.totalItems).toBe(2);
    const ids = core.mock.calls.map(
      (c) => (c[0] as { externalListingId: string }).externalListingId,
    );
    expect(ids.sort()).toEqual(["7:11", "7:22"]);
  });

  it("loja sem itens sai limpo, sem tocar o núcleo", async () => {
    vi.spyOn(MarketplaceRepository, "findByIdAndUser").mockResolvedValue(account);
    vi.spyOn(ShopeeApiService, "getItemList").mockResolvedValue({
      item: [],
      has_next_page: false,
    } as never);
    const core = vi.spyOn(
      ListingAutodetectUseCase,
      "upsertProductFromMarketplaceItem",
    );

    const result = await SyncUseCase.importShopeeItems("u1", "acc-shopee");

    expect(result.totalItems).toBe(0);
    expect(result.items).toHaveLength(0);
    expect(core).not.toHaveBeenCalled();
  });
});
