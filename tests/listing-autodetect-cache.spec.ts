import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Platform } from "@prisma/client";

import prisma from "@/app/lib/prisma";
import { ListingRepository } from "@/app/marketplaces/repositories/listing.repository";
import { ProductUseCase } from "@/app/usecases/product.usercase";
import { UserRepositoryPrisma } from "@/app/repositories/user.repository";
import {
  ListingAutodetectUseCase,
  type AutodetectImportCache,
  type NormalizedMarketplaceItem,
} from "@/app/marketplaces/usecases/listing-autodetect.usercase";

/**
 * Cache write-through do "Importar anúncios" (perf/egress): com o cache, os
 * passos 1-3 do núcleo saem dos preloads do lote em vez de 2-3 queries por
 * item — e o write-through garante a MESMA semântica de dedup da query
 * fresca (item seguinte com o mesmo SKU enxerga o produto criado). O
 * caminho SEM cache (webhook/pollings) segue coberto por
 * listing-autodetect-core.test.ts, byte-idêntico.
 */
const item = (
  over: Partial<NormalizedMarketplaceItem> = {},
): NormalizedMarketplaceItem => ({
  platform: Platform.MERCADO_LIVRE,
  account: { id: "acc1", userId: "u1" },
  externalListingId: "MLB123",
  rawSku: null,
  title: "Roda Liga Leve Aro 15",
  price: 199.9,
  stock: 3,
  status: "active",
  permalink: "http://ml/MLB123",
  imageUrl: "http://img/1.jpg",
  createdAt: new Date("2026-06-18T00:00:00Z"),
  ...over,
});

const emptyCache = (): AutodetectImportCache => ({
  productsBySku: new Map(),
  productIdsWithListing: new Set(),
  knownExternalListingIds: new Set(),
});

describe("ListingAutodetectUseCase — cache do import em lote", () => {
  beforeEach(() => {
    // Perf/egress: o import resolve o dono do lote UMA vez (cache.owner) via
    // findById e injeta no ProductUseCase. Devolve um usuário fake para o
    // createProductFromItem prosseguir sem tocar o banco.
    vi.spyOn(UserRepositoryPrisma.prototype, "findById").mockResolvedValue({
      id: "u1",
    } as never);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("GUARDRAIL anti-duplicação: dois itens NOVOS com o MESMO SKU no lote criam UM produto", async () => {
    const freshListingLookup = vi.spyOn(
      ListingRepository,
      "findProductIdByExternalListingId",
    );
    const freshSkuLookup = vi.spyOn(prisma.product, "findFirst");
    const freshBoxGuard = vi.spyOn(
      ListingRepository,
      "productHasListingInAccount",
    );
    const create = vi
      .spyOn(ProductUseCase.prototype, "create")
      .mockResolvedValue({ id: "p-novo", name: "Roda Liga Leve Aro 15" } as never);
    const upsert = vi
      .spyOn(ListingRepository, "upsertAutodetectedListing")
      .mockImplementation(async (input: { productId: string }) => ({
        id: "l-x",
        productId: input.productId,
      }) as never);

    const cache = emptyCache();

    // Item 1: SKU novo → cria o produto e registra no cache (write-through).
    const r1 = await ListingAutodetectUseCase.upsertProductFromMarketplaceItem(
      item({ externalListingId: "MLB1", rawSku: "NOVO-1" }),
      cache,
    );
    expect(r1.action).toBe("created_product");
    expect(cache.productsBySku.get("novo-1")?.id).toBe("p-novo");
    expect(cache.productIdsWithListing.has("p-novo")).toBe(true);
    expect(cache.knownExternalListingIds.has("MLB1")).toBe(true);

    // Item 2: MESMO SKU, outro anúncio, título parecido → agrupa no produto
    // do item 1 (a query fresca garantia isso; o cache tem de garantir igual).
    const r2 = await ListingAutodetectUseCase.upsertProductFromMarketplaceItem(
      item({ externalListingId: "MLB2", rawSku: "NOVO-1" }),
      cache,
    );
    expect(r2.action).toBe("linked_existing_product");
    expect(r2.productId).toBe("p-novo");

    // UM único produto criado; ZERO queries frescas (tudo saiu do cache).
    expect(create).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledTimes(2);
    expect(freshListingLookup).not.toHaveBeenCalled();
    expect(freshSkuLookup).not.toHaveBeenCalled();
    expect(freshBoxGuard).not.toHaveBeenCalled();
  });

  it("PERF: resolve o dono do lote UMA vez (cache.owner) mesmo criando varios produtos", async () => {
    const create = vi
      .spyOn(ProductUseCase.prototype, "create")
      .mockImplementation(
        async (data: { sku?: string; name: string }) =>
          ({ id: `p-${data.sku}`, name: data.name }) as never,
      );
    vi.spyOn(ListingRepository, "upsertAutodetectedListing").mockImplementation(
      async (input: { productId: string }) =>
        ({ id: "l-x", productId: input.productId }) as never,
    );

    const cache = emptyCache();
    // 2 itens NOVOS com SKUs distintos → 2 produtos criados.
    await ListingAutodetectUseCase.upsertProductFromMarketplaceItem(
      item({ externalListingId: "MLB1", rawSku: "SKU-A" }),
      cache,
    );
    await ListingAutodetectUseCase.upsertProductFromMarketplaceItem(
      item({ externalListingId: "MLB2", rawSku: "SKU-B" }),
      cache,
    );

    // O dono foi resolvido 1x (memoizado em cache.owner) apesar de 2 creates —
    // evita N findById(userId) na importação.
    expect(create).toHaveBeenCalledTimes(2);
    expect(
      vi.mocked(UserRepositoryPrisma.prototype.findById),
    ).toHaveBeenCalledTimes(1);
    expect(cache.owner).toEqual({ id: "u1" });
  });

  it("box-label no lote: título CLARAMENTE diferente cria produto sintético e o SKU do cache continua apontando para o original", async () => {
    vi.spyOn(ProductUseCase.prototype, "create").mockImplementation(
      async (data: { sku?: string; name: string }) =>
        ({ id: `p-${data.sku}`, name: data.name }) as never,
    );
    vi.spyOn(ListingRepository, "upsertAutodetectedListing").mockImplementation(
      async (input: { productId: string }) =>
        ({ id: "l-x", productId: input.productId }) as never,
    );

    const cache: AutodetectImportCache = {
      productsBySku: new Map([
        ["caixa-9", { id: "p-original", name: "Roda Liga Leve Aro 15" }],
      ]),
      // Produto original JÁ tem anúncio nesta conta → guarda de box-label arma.
      productIdsWithListing: new Set(["p-original"]),
      knownExternalListingIds: new Set(),
    };

    const res = await ListingAutodetectUseCase.upsertProductFromMarketplaceItem(
      item({
        externalListingId: "MLB77",
        rawSku: "CAIXA-9",
        title: "Parachoque Dianteiro Gol G5 Original",
      }),
      cache,
    );

    // SKU de caixa: produto próprio com SKU sintético (não re-agrupa).
    expect(res.action).toBe("created_product");
    expect(res.productId).toBe("p-VAAPT-MLB77");
    // O cache NÃO foi sobrescrito pelo sintético: o SKU segue no original.
    expect(cache.productsBySku.get("caixa-9")?.id).toBe("p-original");
  });

  it("externalListingId presente no preload confere FRESCO (listing_exists)", async () => {
    const freshListingLookup = vi
      .spyOn(ListingRepository, "findProductIdByExternalListingId")
      .mockResolvedValue({ productId: "p-ja-vinculado" } as never);
    const create = vi.spyOn(ProductUseCase.prototype, "create");

    const cache = emptyCache();
    cache.knownExternalListingIds.add("MLB123");

    const res = await ListingAutodetectUseCase.upsertProductFromMarketplaceItem(
      item({ rawSku: "QUALQUER" }),
      cache,
    );

    expect(freshListingLookup).toHaveBeenCalledTimes(1);
    expect(res).toEqual({
      action: "listing_exists",
      productId: "p-ja-vinculado",
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("corrida de listing (webhook venceu no meio do lote): órfão removido e cache aponta o VENCEDOR", async () => {
    vi.spyOn(ProductUseCase.prototype, "create").mockResolvedValue({
      id: "p-orfao",
      name: "Roda Liga Leve Aro 15",
    } as never);
    // O upsert devolve o listing do produto VENCEDOR (outro processo criou).
    vi.spyOn(ListingRepository, "upsertAutodetectedListing").mockResolvedValue({
      id: "l-vencedor",
      productId: "p-vencedor",
    } as never);
    const del = vi
      .spyOn(prisma.product, "delete")
      .mockResolvedValue({} as never);

    const cache = emptyCache();
    const res = await ListingAutodetectUseCase.upsertProductFromMarketplaceItem(
      item({ externalListingId: "MLB9", rawSku: "RACE-1" }),
      cache,
    );

    expect(res).toEqual({ action: "raced", productId: "p-vencedor" });
    expect(del).toHaveBeenCalledWith({ where: { id: "p-orfao" } });
    // Write-through registra o vencedor, nunca o órfão removido.
    expect(cache.productsBySku.get("race-1")?.id).toBe("p-vencedor");
    expect(cache.productIdsWithListing.has("p-vencedor")).toBe(true);
  });
});
