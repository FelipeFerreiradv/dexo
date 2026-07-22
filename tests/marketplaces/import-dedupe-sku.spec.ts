import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Platform } from "@prisma/client";

import prisma from "@/app/lib/prisma";
import { ListingRepository } from "@/app/marketplaces/repositories/listing.repository";
import { ProductUseCase } from "@/app/usecases/product.usercase";
import { UserRepositoryPrisma } from "@/app/repositories/user.repository";
import {
  ListingAutodetectUseCase,
  type NormalizedMarketplaceItem,
} from "@/app/marketplaces/usecases/listing-autodetect.usercase";

// ──────────────────────────────────────────────────────────────────────────
// Anti-duplicação de produto na auto-detecção (cenários pedidos no incidente).
// Caminho SEM cache = webhook/polling, que é onde o anúncio "criado direto no
// marketplace" entra. O caso real: produto SKU mk2-204 existia pela Shopee e o
// anúncio novo do ML criou um SEGUNDO produto.
// ──────────────────────────────────────────────────────────────────────────

const item = (
  over: Partial<NormalizedMarketplaceItem> = {},
): NormalizedMarketplaceItem => ({
  platform: Platform.MERCADO_LIVRE,
  account: { id: "acc-ml", userId: "u1" },
  externalListingId: "MLB999",
  rawSku: "100",
  title: "Acabamento Moldura Churrasqueira Esquerda",
  price: 50,
  stock: 1,
  status: "active",
  permalink: "http://ml/MLB999",
  imageUrl: null,
  createdAt: new Date("2026-07-22T00:00:00Z"),
  ...over,
});

let created: any;
let upserted: any;

beforeEach(() => {
  vi.spyOn(UserRepositoryPrisma.prototype, "findById").mockResolvedValue({
    id: "u1",
  } as never);
  created = vi
    .spyOn(ProductUseCase.prototype, "create")
    .mockResolvedValue({ id: "p-novo", name: "produto novo" } as never);
  upserted = vi
    .spyOn(ListingRepository, "upsertAutodetectedListing")
    .mockImplementation(
      async (input: { productId: string }) =>
        ({ id: "l-1", productId: input.productId }) as never,
    );
  vi.spyOn(ListingRepository, "productHasListingInAccount").mockResolvedValue(
    false as never,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("cenários de duplicação de produto", () => {
  it("1) produto inexistente → cria Produto + ProductListing", async () => {
    vi.spyOn(
      ListingRepository,
      "findProductIdByExternalListingId",
    ).mockResolvedValue(null as never);
    vi.spyOn(prisma.product, "findFirst").mockResolvedValue(null as never);

    const out = await ListingAutodetectUseCase.upsertProductFromMarketplaceItem(
      item(),
    );

    expect(out.action).toBe("created_product");
    expect(created).toHaveBeenCalledTimes(1);
    expect(upserted).toHaveBeenCalledTimes(1);
  });

  it("2) produto já existe em OUTRA plataforma → NÃO cria produto, só o listing", async () => {
    vi.spyOn(
      ListingRepository,
      "findProductIdByExternalListingId",
    ).mockResolvedValue(null as never);
    // Produto criado antes pela Shopee, mesmo SKU normalizado.
    vi.spyOn(prisma.product, "findFirst").mockResolvedValue({
      id: "p-da-shopee",
      name: "Acabamento Moldura Churrasqueira Esquerda",
    } as never);

    const out = await ListingAutodetectUseCase.upsertProductFromMarketplaceItem(
      item(),
    );

    expect(out.action).toBe("linked_existing_product");
    expect(out.productId).toBe("p-da-shopee");
    expect(created).not.toHaveBeenCalled();
    expect(upserted).toHaveBeenCalledWith(
      expect.objectContaining({
        productId: "p-da-shopee",
        marketplaceAccountId: "acc-ml",
      }),
    );
  });

  it("3) produto já existe E já tem esse anúncio → no-op, sem duplicar nada", async () => {
    vi.spyOn(
      ListingRepository,
      "findProductIdByExternalListingId",
    ).mockResolvedValue({ productId: "p-ja-linkado" } as never);

    const out = await ListingAutodetectUseCase.upsertProductFromMarketplaceItem(
      item(),
    );

    expect(out.action).toBe("listing_exists");
    expect(out.productId).toBe("p-ja-linkado");
    expect(created).not.toHaveBeenCalled();
    expect(upserted).not.toHaveBeenCalled();
  });

  it("4) O CASO REAL: variação de caixa (Mk2-204 × mk2-204) vincula, não duplica", async () => {
    vi.spyOn(
      ListingRepository,
      "findProductIdByExternalListingId",
    ).mockResolvedValue(null as never);
    const lookup = vi
      .spyOn(prisma.product, "findFirst")
      .mockResolvedValue({ id: "p-shopee", name: "Acabamento Moldura" } as never);

    const out = await ListingAutodetectUseCase.upsertProductFromMarketplaceItem(
      item({ rawSku: "Mk2-204" }),
    );

    // A busca é feita pelo SKU NORMALIZADO (minúsculo) — é isso que faz o
    // anúncio do ML reconhecer o produto que a Shopee criou como "mk2-204".
    expect(lookup).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "u1", skuNormalized: "mk2-204" },
      }),
    );
    expect(out.action).toBe("linked_existing_product");
    expect(created).not.toHaveBeenCalled();
  });

  it("5) o índice do banco vira vínculo, não duplicata (P2002 do skuNormalized)", async () => {
    vi.spyOn(
      ListingRepository,
      "findProductIdByExternalListingId",
    ).mockResolvedValue(null as never);
    // 1ª busca: não achou (cache/leitura anterior à corrida). 2ª: o vencedor.
    vi.spyOn(prisma.product, "findFirst")
      .mockResolvedValueOnce(null as never)
      .mockResolvedValueOnce({ id: "p-vencedor", name: "x" } as never);
    // O banco rejeita pelo índice único parcial de (userId, skuNormalized).
    created.mockRejectedValueOnce(
      new Error(
        "Unique constraint failed on the fields: (`userId`,`skuNormalized`)",
      ),
    );

    const out = await ListingAutodetectUseCase.upsertProductFromMarketplaceItem(
      item({ rawSku: "Mk2-204" }),
    );

    expect(out.action).toBe("raced");
    expect(out.productId).toBe("p-vencedor");
    expect(upserted).toHaveBeenCalledWith(
      expect.objectContaining({ productId: "p-vencedor" }),
    );
  });

  it("REGRESSÃO: SKU de caixa na MESMA conta com título diferente segue separando", async () => {
    vi.spyOn(
      ListingRepository,
      "findProductIdByExternalListingId",
    ).mockResolvedValue(null as never);
    vi.spyOn(prisma.product, "findFirst").mockResolvedValue({
      id: "p-outra-peca",
      name: "Console Central Freio De Mão Peugeot",
    } as never);
    // Produto casado JÁ tem anúncio nesta conta → etiqueta de caixa reusada.
    vi.spyOn(ListingRepository, "productHasListingInAccount").mockResolvedValue(
      true as never,
    );

    const out = await ListingAutodetectUseCase.upsertProductFromMarketplaceItem(
      item({ rawSku: "caixote 1", title: "Soleira Dianteira Direita Citroën" }),
    );

    expect(out.action).toBe("created_product");
    // SKU sintético por anúncio: não re-agrupa nem colide com o produto casado.
    expect(created).toHaveBeenCalledWith(
      expect.objectContaining({ sku: "VAAPT-MLB999", autoSku: false }),
    );
  });
});
