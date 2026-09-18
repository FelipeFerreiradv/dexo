import { describe, it, expect, vi, afterEach } from "vitest";
import { Platform } from "@prisma/client";

import prisma from "@/app/lib/prisma";
import { accountScopedAutodetectSku } from "@/app/marketplaces/lib/autodetect-synthetic-sku";
import { ListingRepository } from "@/app/marketplaces/repositories/listing.repository";
import { ProductUseCase } from "@/app/usecases/product.usercase";
import { UserRepositoryPrisma } from "@/app/repositories/user.repository";
import {
  ListingAutodetectUseCase,
  NormalizedMarketplaceItem,
  AutodetectImportCache,
} from "@/app/marketplaces/usecases/listing-autodetect.usercase";

const FLAG = "AUTODETECT_SKU_PREFIXADO";

/**
 * Caso real da MK2 Auto Peças (03/09/2026). Anúncio da Shopee SEM
 * `item_sku` criava produto por `autoSku`, que gera NÚMERO PURO — o mesmo
 * formato da etiqueta física do galpão. Resultado medido: 1.934 produtos com
 * SKU numérico criados em UM dia, e a peça cuja etiqueta na VAAPT é
 * `MK2-6036` aparecendo no sistema como `37156`.
 *
 * A trava não é cosmética: enquanto o SKU do anúncio é indistinguível de
 * etiqueta, ele OCUPA o número de outra peça e a peça real não pode usar o
 * próprio código.
 */
const ANUNCIO_SHOPEE = "58217400145";
const TITULO = "Mangueira Respiro Citroën Aircross 1.6 2014 V1153";

const item = (
  over: Partial<NormalizedMarketplaceItem> = {},
): NormalizedMarketplaceItem => ({
  platform: Platform.SHOPEE,
  account: { id: "conta-1", userId: "u1" },
  externalListingId: ANUNCIO_SHOPEE,
  rawSku: null,
  title: TITULO,
  price: 45,
  stock: 1,
  status: "NORMAL",
  permalink: `http://shopee/${ANUNCIO_SHOPEE}`,
  imageUrl: "http://img/1.jpg",
  createdAt: new Date("2026-09-03T12:00:00Z"),
  ...over,
});

const expectedSyntheticSku = (
  prefix: string,
  marketplaceItem: NormalizedMarketplaceItem,
) =>
  accountScopedAutodetectSku(prefix, {
    platform: marketplaceItem.platform,
    accountId: marketplaceItem.account.id,
    externalListingId: marketplaceItem.externalListingId,
  });

/**
 * `produtoCasado` só é consultado quando o anúncio TEM SKU: sem SKU o passo 2
 * não chega a consultar o banco, e é justamente esse o caminho sob teste.
 */
function mockBase(
  produtoCasado: { id: string; name: string } | null = null,
  temAnuncioNaConta = false,
) {
  vi.spyOn(
    ListingRepository,
    "findProductIdByExternalListingId",
  ).mockResolvedValue(null);
  vi.spyOn(prisma.product, "findFirst").mockResolvedValue(
    produtoCasado as never,
  );
  vi.spyOn(ListingRepository, "productHasListingInAccount").mockResolvedValue(
    temAnuncioNaConta as never,
  );
  // O caminho COM cache resolve o dono do lote (owner lazy, introduzido depois
  // que este spec nasceu) — sem o mock o teste bate no banco de verdade.
  vi.spyOn(UserRepositoryPrisma.prototype, "findById").mockResolvedValue({
    id: "u1",
  } as never);
  const create = vi
    .spyOn(ProductUseCase.prototype, "create")
    .mockResolvedValue({ id: "p-novo" } as never);
  const upsert = vi
    .spyOn(ListingRepository, "upsertAutodetectedListing")
    .mockImplementation((async (data: { productId: string }) => ({
      id: "l1",
      productId: data.productId,
    })) as never);
  return { create, upsert };
}

describe("autodetect · SKU prefixado para anúncio sem código de vendedor", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env[FLAG];
  });

  // ---------------------------------------------------------------- controle
  // Sem a flag, o comportamento tem de ser o de hoje BYTE A BYTE. É o controle
  // negativo: se este teste passasse com a flag ligada, ele não provaria nada.
  it("flag DESLIGADA → autoSku com SKU vazio, exatamente como hoje", async () => {
    const { create } = mockBase();

    const res =
      await ListingAutodetectUseCase.upsertProductFromMarketplaceItem(item());

    expect(res.action).toBe("created_product");
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        sku: "",
        autoSku: true,
        createdFromMarketplace: true,
      }),
    );
  });

  // ------------------------------------------------------------------ a trava
  it("flag LIGADA → SKU derivado do anúncio, e NÃO um número de etiqueta", async () => {
    process.env[FLAG] = "true";
    const { create, upsert } = mockBase();
    const marketplaceItem = item();

    const res =
      await ListingAutodetectUseCase.upsertProductFromMarketplaceItem(
        marketplaceItem,
      );

    expect(res.action).toBe("created_product");
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        sku: expectedSyntheticSku("SHP", marketplaceItem),
        autoSku: false,
        createdFromMarketplace: true,
        name: TITULO,
      }),
    );
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ productId: "p-novo" }),
    );

    // O ponto do chamado: o SKU não pode ser confundível com etiqueta física.
    const skuGerado = (create.mock.calls[0][0] as { sku: string }).sku;
    expect(skuGerado).not.toMatch(/^\d+$/);
  });

  it("flag LIGADA → o contador de autoSku não é consumido (autoSku: false)", async () => {
    process.env[FLAG] = "true";
    const { create } = mockBase();

    await ListingAutodetectUseCase.upsertProductFromMarketplaceItem(item());

    // `createWithAutoSku` avança `User.lastSkuSequential` SEMPRE. Enquanto o
    // anúncio sem SKU passava por lá, cada anúncio importado queimava um número
    // da sequência que o modal "Novo Produto" oferece ao lojista.
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ autoSku: false }),
    );
    expect(create).not.toHaveBeenCalledWith(
      expect.objectContaining({ autoSku: true }),
    );
  });

  it.each([
    [Platform.MERCADO_LIVRE, "MLB1833459695", "ML"],
    [Platform.SHOPEE, "58217400145", "SHP"],
    [Platform.MAGALU, "sku-magalu-9", "MGL"],
  ])(
    "flag LIGADA → prefixo por plataforma: %s",
    async (platform, id, prefix) => {
      process.env[FLAG] = "true";
      const { create } = mockBase();
      const marketplaceItem = item({ platform, externalListingId: id });

      await ListingAutodetectUseCase.upsertProductFromMarketplaceItem(
        marketplaceItem,
      );

      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          sku: expectedSyntheticSku(prefix, marketplaceItem),
          autoSku: false,
        }),
      );
    },
  );

  // ------------------------------------------------- o que NÃO pode mudar
  it("flag LIGADA + anúncio COM SKU → usa o SKU do vendedor (inalterado)", async () => {
    process.env[FLAG] = "true";
    const { create } = mockBase();

    await ListingAutodetectUseCase.upsertProductFromMarketplaceItem(
      item({ rawSku: "MK2-6036" }),
    );

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ sku: "MK2-6036", autoSku: false }),
    );
  });

  it("flag LIGADA + rótulo de caixa → segue no sintético VAAPT por conta e plataforma", async () => {
    process.env[FLAG] = "true";
    // Produto casado por SKU, JÁ com anúncio nesta conta e título alheio: é a
    // condição da guarda de rótulo de caixa, que tem precedência.
    const { create } = mockBase(
      { id: "p-alheio", name: "Suporte Coxim Traseiro Cruze 2018 1.4" },
      true,
    );

    const marketplaceItem = item({
      rawSku: "106",
      externalListingId: "MLB999",
      platform: Platform.MERCADO_LIVRE,
    });
    await ListingAutodetectUseCase.upsertProductFromMarketplaceItem(
      marketplaceItem,
    );

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        sku: expectedSyntheticSku("VAAPT", marketplaceItem),
        autoSku: false,
      }),
    );
  });

  it("flag LIGADA → não grava nada no cache do lote (não há SKU de vendedor)", async () => {
    process.env[FLAG] = "true";
    mockBase();

    const cache: AutodetectImportCache = {
      knownExternalListingIds: new Set<string>(),
      productsBySku: new Map(),
      productIdsWithListing: new Set<string>(),
    };

    await ListingAutodetectUseCase.upsertProductFromMarketplaceItem(
      item(),
      cache,
    );

    // Ninguém casa por um SKU derivado de anúncio, então registrá-lo só
    // enganaria os itens seguintes do lote.
    expect(cache.productsBySku.size).toBe(0);
  });

  // --------------------------------------------------- robustez de corrida
  // Efeito colateral da mudança, e o motivo de o SKU ser DETERMINÍSTICO:
  // reimportar o mesmo anúncio reencontra o mesmo produto em vez de estourar.
  it("flag LIGADA + SKU duplicado → re-resolve pelo prefixado e vincula (raced)", async () => {
    process.env[FLAG] = "true";
    mockBase();
    vi.spyOn(ProductUseCase.prototype, "create").mockRejectedValue(
      new Error("SKU já existe para este usuário"),
    );
    // O vencedor da corrida é achado pelo SKU prefixado (normalizado).
    vi.spyOn(prisma.product, "findFirst").mockResolvedValue({
      id: "p-vencedor",
      name: TITULO,
    } as never);

    const marketplaceItem = item();
    const res =
      await ListingAutodetectUseCase.upsertProductFromMarketplaceItem(
        marketplaceItem,
      );

    expect(res.productId).toBe("p-vencedor");
    expect(prisma.product.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          skuNormalized: expectedSyntheticSku(
            "SHP",
            marketplaceItem,
          ).toLowerCase(),
        }),
      }),
    );
  });

  it("flag DESLIGADA + SKU duplicado sem SKU de vendedor → relança (como hoje)", async () => {
    mockBase();
    vi.spyOn(ProductUseCase.prototype, "create").mockRejectedValue(
      new Error("SKU já existe para este usuário"),
    );

    // Sem flag não existe chave para re-resolver: `autoSku` gera um número que
    // não é derivável do anúncio. Comportamento preservado de propósito.
    await expect(
      ListingAutodetectUseCase.upsertProductFromMarketplaceItem(item()),
    ).rejects.toThrow(/já existe/i);
  });
});
