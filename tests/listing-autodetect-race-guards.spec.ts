import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Platform } from "@prisma/client";

import prisma from "@/app/lib/prisma";
import { accountScopedAutodetectSku } from "@/app/marketplaces/lib/autodetect-synthetic-sku";
import { ListingRepository } from "@/app/marketplaces/repositories/listing.repository";
import { ProductUseCase } from "@/app/usecases/product.usercase";
import { UserRepositoryPrisma } from "@/app/repositories/user.repository";
import { CatalogIdentityService } from "@/app/marketplaces/services/catalog-identity.service";
import {
  ListingAutodetectUseCase,
  type AutodetectImportCache,
  type NormalizedMarketplaceItem,
} from "@/app/marketplaces/usecases/listing-autodetect.usercase";

const LEFT = "Amortecedor Tampa Porta Malas L/e Volkswagen Gol 2021";
const RIGHT = "Amortecedor Tampa Porta Malas L/d Volkswagen Gol 2021";
const DUPLICATE = new Error("Produto com esse sku já existe");
const VAAPT_MLB123 = accountScopedAutodetectSku("VAAPT", {
  platform: Platform.MERCADO_LIVRE,
  accountId: "acc-1",
  externalListingId: "MLB123",
});

function item(
  overrides: Partial<NormalizedMarketplaceItem> = {},
): NormalizedMarketplaceItem {
  return {
    platform: Platform.MERCADO_LIVRE,
    account: { id: "acc-1", userId: "owner-1" },
    externalListingId: "MLB123",
    rawSku: "7788",
    title: LEFT,
    price: 100,
    stock: 1,
    status: "active",
    permalink: null,
    imageUrl: null,
    createdAt: new Date("2026-09-17T12:00:00Z"),
    ...overrides,
  };
}

function cacheWithRight(): AutodetectImportCache {
  return {
    productsBySku: new Map([["7788", { id: "p-right", name: RIGHT }]]),
    productIdsWithListing: new Set(),
    knownExternalListingIds: new Set(),
  };
}

beforeEach(() => {
  vi.spyOn(UserRepositoryPrisma.prototype, "findById").mockResolvedValue({
    id: "owner-1",
  } as never);
  vi.spyOn(
    ListingRepository,
    "findProductIdByExternalListingId",
  ).mockResolvedValue(null);
  vi.spyOn(ListingRepository, "productHasListingInAccount").mockResolvedValue(
    false,
  );
  vi.spyOn(ListingRepository, "upsertAutodetectedListing").mockImplementation(
    async (data) => ({ id: "listing-1", productId: data.productId }) as never,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("autodetect: galeria ambígua", () => {
  it("não volta a casar pelo SKU mesmo quando o título é idêntico", async () => {
    vi.stubEnv("CATALOG_IDENTITY_TENANT_IDS", "owner-1");
    vi.spyOn(CatalogIdentityService, "serialized").mockImplementation(
      async (_item, run) => run(undefined as never, null, true),
    );
    vi.spyOn(prisma.product, "findFirst").mockResolvedValue({
      id: "wrong-physical-piece",
      name: LEFT,
    } as never);
    const create = vi
      .spyOn(ProductUseCase.prototype, "create")
      .mockResolvedValue({
        id: "isolated-piece",
      } as never);

    const result =
      await ListingAutodetectUseCase.upsertProductFromMarketplaceItem(
        item({
          imageUrls: [
            "https://http2.mlstatic.com/D_619404-MLB75824100607_042024-O.jpg",
            "https://http2.mlstatic.com/D_682941-MLB75824100609_042024-O.jpg",
          ],
        }),
      );

    expect(result).toEqual({
      action: "created_product",
      productId: "isolated-piece",
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        sku: VAAPT_MLB123,
        autoSku: false,
      }),
    );
  });
});

describe("autodetect: sintético não substitui o SKU real no cache", () => {
  it("peça esquerda sintética preserva o produto direito para o próximo anúncio", async () => {
    const create = vi
      .spyOn(ProductUseCase.prototype, "create")
      .mockResolvedValue({ id: "p-left-synthetic" } as never);
    const cache = cacheWithRight();

    await ListingAutodetectUseCase.upsertProductFromMarketplaceItem(
      item(),
      cache,
    );
    expect(cache.productsBySku.get("7788")).toEqual({
      id: "p-right",
      name: RIGHT,
    });

    const next =
      await ListingAutodetectUseCase.upsertProductFromMarketplaceItem(
        item({ externalListingId: "MLB456", title: RIGHT }),
        cache,
      );
    expect(next).toEqual({
      action: "linked_existing_product",
      productId: "p-right",
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ sku: VAAPT_MLB123, userId: "owner-1" }),
    );
  });

  it("vencedor de corrida do listing espelhado também preserva o SKU original", async () => {
    vi.spyOn(ProductUseCase.prototype, "create").mockResolvedValue({
      id: "p-orphan",
    } as never);
    vi.mocked(ListingRepository.upsertAutodetectedListing).mockResolvedValue({
      id: "listing-winner",
      productId: "p-left-winner",
    } as never);
    const remove = vi
      .spyOn(prisma.product, "delete")
      .mockResolvedValue({} as never);
    const cache = cacheWithRight();

    const result =
      await ListingAutodetectUseCase.upsertProductFromMarketplaceItem(
        item(),
        cache,
      );
    expect(result).toEqual({ action: "raced", productId: "p-left-winner" });
    expect(remove).toHaveBeenCalledWith({ where: { id: "p-orphan" } });
    expect(cache.productsBySku.get("7788")?.id).toBe("p-right");
  });
});

describe("autodetect: guardas após corrida de SKU", () => {
  it.each([
    ["lado", RIGHT],
    ["eixo", "Amortecedor Traseiro Esquerdo Volkswagen Gol 2021"],
  ])(
    "vencedor de %s oposto cria sintético em vez de ligar a peça errada",
    async (_, winnerTitle) => {
      const input = item({
        title: "Amortecedor Dianteiro Esquerdo Volkswagen Gol 2021",
      });
      const lookup = vi
        .spyOn(prisma.product, "findFirst")
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: "p-opposite",
          name: winnerTitle,
        } as never);
      const create = vi
        .spyOn(ProductUseCase.prototype, "create")
        .mockRejectedValueOnce(DUPLICATE)
        .mockResolvedValueOnce({ id: "p-synthetic" } as never);

      const result =
        await ListingAutodetectUseCase.upsertProductFromMarketplaceItem(input);
      expect(result).toEqual({
        action: "created_product",
        productId: "p-synthetic",
      });
      expect(create).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ sku: VAAPT_MLB123, autoSku: false }),
      );
      expect(lookup).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          where: { userId: "owner-1", skuNormalized: "7788" },
        }),
      );
      expect(ListingRepository.upsertAutodetectedListing).toHaveBeenCalledWith(
        expect.objectContaining({ productId: "p-synthetic" }),
      );
    },
  );

  it("SKU de caixa surgido na corrida usa presença fresca do listing, sem poluir cache", async () => {
    vi.spyOn(prisma.product, "findFirst").mockResolvedValue({
      id: "p-box-winner",
      name: "Mangueira Combustível Pajero Tr4",
    } as never);
    vi.mocked(ListingRepository.productHasListingInAccount).mockResolvedValue(
      true,
    );
    const create = vi
      .spyOn(ProductUseCase.prototype, "create")
      .mockRejectedValueOnce(DUPLICATE)
      .mockResolvedValueOnce({ id: "p-synthetic" } as never);
    const cache: AutodetectImportCache = {
      productsBySku: new Map(),
      productIdsWithListing: new Set(),
      knownExternalListingIds: new Set(),
    };

    const result =
      await ListingAutodetectUseCase.upsertProductFromMarketplaceItem(
        item(),
        cache,
      );
    expect(result.productId).toBe("p-synthetic");
    expect(create).toHaveBeenCalledTimes(2);
    // O título incompatível basta para não fundir entre contas; não depende de
    // uma leitura adicional da presença de listing na conta atual.
    expect(ListingRepository.productHasListingInAccount).not.toHaveBeenCalled();
    expect(cache.productsBySku.has("7788")).toBe(false);
  });

  it("vencedor compatível continua vinculado sem segunda criação", async () => {
    vi.spyOn(prisma.product, "findFirst")
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "p-compatible", name: LEFT } as never);
    const create = vi
      .spyOn(ProductUseCase.prototype, "create")
      .mockRejectedValue(DUPLICATE);

    const result =
      await ListingAutodetectUseCase.upsertProductFromMarketplaceItem(item());
    expect(result).toEqual({ action: "raced", productId: "p-compatible" });
    expect(create).toHaveBeenCalledTimes(1);
    expect(ListingRepository.productHasListingInAccount).not.toHaveBeenCalled();
  });

  it("colisão na segunda tentativa relê o sintético compatível e termina", async () => {
    const lookup = vi
      .spyOn(prisma.product, "findFirst")
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "p-opposite", name: RIGHT } as never)
      .mockResolvedValueOnce({ id: "p-synthetic-winner", name: LEFT } as never);
    const create = vi
      .spyOn(ProductUseCase.prototype, "create")
      .mockRejectedValue(DUPLICATE);

    const result =
      await ListingAutodetectUseCase.upsertProductFromMarketplaceItem(item());
    expect(result).toEqual({
      action: "raced",
      productId: "p-synthetic-winner",
    });
    expect(create).toHaveBeenCalledTimes(2);
    expect(lookup).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        where: {
          userId: "owner-1",
          skuNormalized: VAAPT_MLB123.toLowerCase(),
        },
      }),
    );
  });

  it("sintético incompatível não é vinculado e não causa recursão infinita", async () => {
    vi.spyOn(prisma.product, "findFirst")
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "p-opposite", name: RIGHT } as never)
      .mockResolvedValueOnce({ id: "p-wrong-synthetic", name: RIGHT } as never);
    const create = vi
      .spyOn(ProductUseCase.prototype, "create")
      .mockRejectedValue(DUPLICATE);

    await expect(
      ListingAutodetectUseCase.upsertProductFromMarketplaceItem(item()),
    ).rejects.toThrow("Produto com esse sku já existe");
    expect(create).toHaveBeenCalledTimes(2);
    expect(ListingRepository.upsertAutodetectedListing).not.toHaveBeenCalled();
  });
});
