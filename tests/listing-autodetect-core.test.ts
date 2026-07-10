import { describe, it, expect, vi, afterEach } from "vitest";
import { Platform } from "@prisma/client";

import prisma from "@/app/lib/prisma";
import { ListingRepository } from "@/app/marketplaces/repositories/listing.repository";
import { ProductUseCase } from "@/app/usecases/product.usercase";
import {
  ListingAutodetectUseCase,
  NormalizedMarketplaceItem,
} from "@/app/marketplaces/usecases/listing-autodetect.usercase";

const item = (
  over: Partial<NormalizedMarketplaceItem> = {},
): NormalizedMarketplaceItem => ({
  platform: Platform.MERCADO_LIVRE,
  account: { id: "acc1", userId: "u1" },
  externalListingId: "MLB123",
  rawSku: null,
  title: "Roda Liga Leve",
  price: 199.9,
  stock: 3,
  status: "active",
  permalink: "http://ml/MLB123",
  imageUrl: "http://img/1.jpg",
  createdAt: new Date("2026-06-18T00:00:00Z"),
  ...over,
});

describe("ListingAutodetectUseCase.upsertProductFromMarketplaceItem", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("(a) listing já existe → no-op: não cria produto nem listing", async () => {
    vi.spyOn(
      ListingRepository,
      "findProductIdByExternalListingId",
    ).mockResolvedValue({ productId: "p1" } as any);
    const create = vi.spyOn(ProductUseCase.prototype, "create");
    const upsert = vi.spyOn(ListingRepository, "upsertAutodetectedListing");

    const res = await ListingAutodetectUseCase.upsertProductFromMarketplaceItem(
      item({ rawSku: "ABC" }),
    );

    expect(res).toEqual({ action: "listing_exists", productId: "p1" });
    expect(create).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("(b) SKU casa com produto do dono (sem anúncio nesta conta) → só vincula", async () => {
    vi.spyOn(
      ListingRepository,
      "findProductIdByExternalListingId",
    ).mockResolvedValue(null);
    vi.spyOn(prisma.product, "findFirst").mockResolvedValue({
      id: "p-existing",
    } as any);
    // Produto casado NÃO tem anúncio nesta conta → agrupamento legítimo.
    vi.spyOn(
      ListingRepository,
      "productHasListingInAccount",
    ).mockResolvedValue(false);
    const create = vi.spyOn(ProductUseCase.prototype, "create");
    const upsert = vi
      .spyOn(ListingRepository, "upsertAutodetectedListing")
      .mockResolvedValue({ id: "l1", productId: "p-existing" } as any);

    const res = await ListingAutodetectUseCase.upsertProductFromMarketplaceItem(
      item({ rawSku: "ABC-1" }),
    );

    expect(res.action).toBe("linked_existing_product");
    expect(res.productId).toBe("p-existing");
    expect(create).not.toHaveBeenCalled();
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        productId: "p-existing",
        marketplaceAccountId: "acc1",
        externalListingId: "MLB123",
        externalSku: "ABC-1",
      }),
    );
  });

  it("(b2) SKU de caixa (produto casado na conta + título DIFERENTE) → NÃO agrupa, cria produto próprio com SKU sintético", async () => {
    vi.spyOn(
      ListingRepository,
      "findProductIdByExternalListingId",
    ).mockResolvedValue(null);
    vi.spyOn(prisma.product, "findFirst").mockResolvedValue({
      id: "p-box",
      name: "Mangueira Hidrovacuo Renault Kangoo 2010 2018 Usado",
    } as any);
    // Produto casado JÁ tem anúncio nesta conta → SKU reutilizado (rótulo).
    vi.spyOn(
      ListingRepository,
      "productHasListingInAccount",
    ).mockResolvedValue(true);
    const create = vi
      .spyOn(ProductUseCase.prototype, "create")
      .mockResolvedValue({ id: "p-split" } as any);
    const upsert = vi
      .spyOn(ListingRepository, "upsertAutodetectedListing")
      .mockResolvedValue({ id: "l1", productId: "p-split" } as any);

    const res = await ListingAutodetectUseCase.upsertProductFromMarketplaceItem(
      item({
        rawSku: "Caixa mangueiras",
        externalListingId: "MLB999",
        title: "Mangueira Combustivel Pajero Tr4 4x2 Flex 2010 2012",
      }),
    );

    expect(res.action).toBe("created_product");
    expect(res.productId).toBe("p-split");
    // SKU sintético único por anúncio (não o rótulo de caixa reutilizado).
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        sku: "VAAPT-MLB999",
        autoSku: false,
        createdFromMarketplace: true,
      }),
    );
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ productId: "p-split" }),
    );
  });

  it("(b3) SKU repetido na conta MAS título ~idêntico (mesmo produto reanunciado) → AGRUPA, não cria produto", async () => {
    vi.spyOn(
      ListingRepository,
      "findProductIdByExternalListingId",
    ).mockResolvedValue(null);
    vi.spyOn(prisma.product, "findFirst").mockResolvedValue({
      id: "p-dup",
      name: "Par Tela Autofalantes 12cm",
    } as any);
    vi.spyOn(
      ListingRepository,
      "productHasListingInAccount",
    ).mockResolvedValue(true);
    const create = vi.spyOn(ProductUseCase.prototype, "create");
    const upsert = vi
      .spyOn(ListingRepository, "upsertAutodetectedListing")
      .mockResolvedValue({ id: "l2", productId: "p-dup" } as any);

    const res = await ListingAutodetectUseCase.upsertProductFromMarketplaceItem(
      item({
        rawSku: "Prateleira pecas novas",
        externalListingId: "MLB888",
        title: "Par Tela Autofalantes 12cm",
      }),
    );

    expect(res.action).toBe("linked_existing_product");
    expect(res.productId).toBe("p-dup");
    expect(create).not.toHaveBeenCalled();
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ productId: "p-dup" }),
    );
  });

  it("(c) sem casamento → cria produto com flag de origem + listing", async () => {
    vi.spyOn(
      ListingRepository,
      "findProductIdByExternalListingId",
    ).mockResolvedValue(null);
    vi.spyOn(prisma.product, "findFirst").mockResolvedValue(null);
    const create = vi
      .spyOn(ProductUseCase.prototype, "create")
      .mockResolvedValue({ id: "p-new" } as any);
    const upsert = vi
      .spyOn(ListingRepository, "upsertAutodetectedListing")
      .mockResolvedValue({ id: "l1", productId: "p-new" } as any);

    const res = await ListingAutodetectUseCase.upsertProductFromMarketplaceItem(
      item({ platform: Platform.SHOPEE, rawSku: "NEW-1" }),
    );

    expect(res.action).toBe("created_product");
    expect(res.productId).toBe("p-new");
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        sku: "NEW-1",
        autoSku: false,
        createdFromMarketplace: true,
        originPlatform: Platform.SHOPEE,
      }),
    );
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ productId: "p-new" }),
    );
  });

  it("(c2) repassa a GALERIA (imageUrls) do anúncio ao criar o produto", async () => {
    vi.spyOn(
      ListingRepository,
      "findProductIdByExternalListingId",
    ).mockResolvedValue(null);
    vi.spyOn(prisma.product, "findFirst").mockResolvedValue(null);
    const create = vi
      .spyOn(ProductUseCase.prototype, "create")
      .mockResolvedValue({ id: "p-gal" } as any);
    vi.spyOn(ListingRepository, "upsertAutodetectedListing").mockResolvedValue({
      id: "l1",
      productId: "p-gal",
    } as any);

    await ListingAutodetectUseCase.upsertProductFromMarketplaceItem(
      item({
        rawSku: "GAL-1",
        imageUrl: "http://img/1.jpg",
        imageUrls: ["http://img/1.jpg", "http://img/2.jpg"],
      }),
    );

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        imageUrl: "http://img/1.jpg",
        imageUrls: ["http://img/1.jpg", "http://img/2.jpg"],
      }),
    );
  });

  it("(c3) item sem galeria → imageUrls vira [] (zero regressão)", async () => {
    vi.spyOn(
      ListingRepository,
      "findProductIdByExternalListingId",
    ).mockResolvedValue(null);
    vi.spyOn(prisma.product, "findFirst").mockResolvedValue(null);
    const create = vi
      .spyOn(ProductUseCase.prototype, "create")
      .mockResolvedValue({ id: "p-nogal" } as any);
    vi.spyOn(ListingRepository, "upsertAutodetectedListing").mockResolvedValue({
      id: "l1",
      productId: "p-nogal",
    } as any);

    await ListingAutodetectUseCase.upsertProductFromMarketplaceItem(
      item({ rawSku: "NOGAL-1" }),
    );

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ imageUrls: [] }),
    );
  });

  it("(d) sem SKU → cria com autoSku (sku vazio) e não busca por SKU", async () => {
    vi.spyOn(
      ListingRepository,
      "findProductIdByExternalListingId",
    ).mockResolvedValue(null);
    const findFirst = vi.spyOn(prisma.product, "findFirst");
    const create = vi
      .spyOn(ProductUseCase.prototype, "create")
      .mockResolvedValue({ id: "p-auto" } as any);
    vi.spyOn(ListingRepository, "upsertAutodetectedListing").mockResolvedValue({
      id: "l1",
      productId: "p-auto",
    } as any);

    const res = await ListingAutodetectUseCase.upsertProductFromMarketplaceItem(
      item({ rawSku: null }),
    );

    expect(res.action).toBe("created_product");
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        sku: "",
        autoSku: true,
        createdFromMarketplace: true,
      }),
    );
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("(e) corrida de SKU real: create lança 'já existe' → re-resolve e vincula (raced)", async () => {
    vi.spyOn(
      ListingRepository,
      "findProductIdByExternalListingId",
    ).mockResolvedValue(null);
    // passo 2: sem match → cria; pós-corrida: acha o produto criado por outro.
    vi.spyOn(prisma.product, "findFirst")
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "p-raced" } as any);
    vi.spyOn(ProductUseCase.prototype, "create").mockRejectedValue(
      new Error("Produto com esse sku já existe"),
    );
    const upsert = vi
      .spyOn(ListingRepository, "upsertAutodetectedListing")
      .mockResolvedValue({ id: "l1", productId: "p-raced" } as any);

    const res = await ListingAutodetectUseCase.upsertProductFromMarketplaceItem(
      item({ rawSku: "RACE-1" }),
    );

    expect(res.action).toBe("raced");
    expect(res.productId).toBe("p-raced");
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ productId: "p-raced" }),
    );
  });

  it("(f) corrida P2002 no listing (mesmo produto) → idempotente, sem lançar", async () => {
    vi.spyOn(
      ListingRepository,
      "findProductIdByExternalListingId",
    ).mockResolvedValue(null);
    vi.spyOn(prisma.product, "findFirst").mockResolvedValue(null);
    vi.spyOn(ProductUseCase.prototype, "create").mockResolvedValue({
      id: "p1",
    } as any);
    // P2002 tratado no repo: relê e devolve o listing vencedor (MESMO produto).
    const upsert = vi
      .spyOn(ListingRepository, "upsertAutodetectedListing")
      .mockResolvedValue({ id: "l-existing", productId: "p1" } as any);
    const del = vi.spyOn(prisma.product, "delete");

    const res = await ListingAutodetectUseCase.upsertProductFromMarketplaceItem(
      item({ rawSku: null }),
    );

    expect(res.action).toBe("created_product");
    expect(res.productId).toBe("p1");
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(del).not.toHaveBeenCalled();
  });

  it("(g) corrida sem SKU: listing vencedor aponta p/ OUTRO produto → apaga o órfão e devolve raced", async () => {
    vi.spyOn(
      ListingRepository,
      "findProductIdByExternalListingId",
    ).mockResolvedValue(null);
    vi.spyOn(prisma.product, "findFirst").mockResolvedValue(null);
    vi.spyOn(ProductUseCase.prototype, "create").mockResolvedValue({
      id: "p-orphan",
    } as any);
    // O upsert (após P2002) relê e o listing já aponta p/ o produto vencedor.
    vi.spyOn(ListingRepository, "upsertAutodetectedListing").mockResolvedValue({
      id: "l-win",
      productId: "p-winner",
    } as any);
    const del = vi
      .spyOn(prisma.product, "delete")
      .mockResolvedValue({ id: "p-orphan" } as any);

    const res = await ListingAutodetectUseCase.upsertProductFromMarketplaceItem(
      item({ rawSku: null }),
    );

    expect(res.action).toBe("raced");
    expect(res.productId).toBe("p-winner");
    expect(del).toHaveBeenCalledWith({ where: { id: "p-orphan" } });
  });
});
