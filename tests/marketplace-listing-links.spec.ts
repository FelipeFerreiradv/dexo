import { describe, expect, it } from "vitest";

import {
  buildHref,
  disabledReason,
  isOpenable,
  pickPreferredListingForPlatform,
  pickPreferredListingsByPlatform,
  resolveMarketplaceListingLinkState,
  type MarketplaceListingLinkInput,
} from "../app/lib/marketplace-listing-links";

describe("marketplace-listing-links", () => {
  it("uses Mercado Livre permalink when available", () => {
    const listing: MarketplaceListingLinkInput = {
      platform: "MERCADO_LIVRE",
      externalListingId: "MLB123",
      permalink: "https://produto.mercadolivre.com.br/MLB123",
    };

    expect(buildHref(listing)).toBe(
      "https://produto.mercadolivre.com.br/MLB123",
    );
    expect(isOpenable(listing)).toBe(true);
    expect(disabledReason(listing)).toBeNull();
  });

  it("falls back to Mercado Livre item URL when only externalListingId exists", () => {
    expect(
      buildHref({
        platform: "MERCADO_LIVRE",
        externalListingId: "MLB987654321",
      }),
    ).toBe("https://produto.mercadolivre.com.br/MLB987654321");
  });

  it("uses Shopee permalink when available", () => {
    const listing: MarketplaceListingLinkInput = {
      platform: "SHOPEE",
      externalListingId: "44556677",
      permalink: "https://shopee.com.br/produto-pronto",
      shopId: 991122,
    };

    expect(buildHref(listing)).toBe("https://shopee.com.br/produto-pronto");
    expect(isOpenable(listing)).toBe(true);
  });

  it("falls back to Shopee product URL using shopId and itemId", () => {
    expect(
      buildHref({
        platform: "SHOPEE",
        externalListingId: "44556677:889900",
        shopId: 332211,
      }),
    ).toBe("https://shopee.com.br/product/332211/44556677");
  });

  it("keeps placeholders disabled even when a local listing exists", () => {
    const listing: MarketplaceListingLinkInput = {
      platform: "SHOPEE",
      externalListingId: "PENDING_SHP_12345",
      shopId: 332211,
      status: "pending",
    };

    expect(buildHref(listing)).toBeNull();
    expect(isOpenable(listing)).toBe(false);
    expect(disabledReason(listing)).toBe(
      "Anuncio do Shopee ainda esta pendente de publicacao.",
    );
  });

  it("resolves href/openable/disabled state in a single call", () => {
    expect(
      resolveMarketplaceListingLinkState({
        platform: "SHOPEE",
        externalListingId: "44556677:889900",
        shopId: 332211,
      }),
    ).toEqual({
      href: "https://shopee.com.br/product/332211/44556677",
      isOpenable: true,
      disabledReason: null,
    });
  });

  it("prefers an openable active listing and then the most recently updated one", () => {
    const preferred = pickPreferredListingForPlatform(
      [
        {
          platform: "SHOPEE" as const,
          marketplaceAccountId: "acc-z",
          externalListingId: "100",
          status: "active",
          updatedAt: "2026-04-08T10:00:00.000Z",
        },
        {
          platform: "SHOPEE" as const,
          marketplaceAccountId: "acc-b",
          externalListingId: "200",
          status: "paused",
          permalink: "https://shopee.com.br/product/1/200",
          updatedAt: "2026-04-09T10:00:00.000Z",
        },
        {
          platform: "SHOPEE" as const,
          marketplaceAccountId: "acc-a",
          externalListingId: "300",
          permalink: "https://shopee.com.br/product/1/300",
          status: "active",
          updatedAt: "2026-04-10T10:00:00.000Z",
        },
      ],
      "SHOPEE",
    );

    expect(preferred?.externalListingId).toBe("300");
  });

  it("breaks ties deterministically after applying the ranking rules", () => {
    const preferred = pickPreferredListingForPlatform(
      [
        {
          platform: "MERCADO_LIVRE" as const,
          marketplaceAccountId: "acc-b",
          externalListingId: "MLB2",
          permalink: "https://produto.mercadolivre.com.br/MLB2",
          status: "active",
          updatedAt: "2026-04-08T10:00:00.000Z",
        },
        {
          platform: "MERCADO_LIVRE" as const,
          marketplaceAccountId: "acc-a",
          externalListingId: "MLB1",
          permalink: "https://produto.mercadolivre.com.br/MLB1",
          status: "active",
          updatedAt: "2026-04-08T10:00:00.000Z",
        },
      ],
      "MERCADO_LIVRE",
    );

    expect(preferred?.marketplaceAccountId).toBe("acc-a");
    expect(preferred?.externalListingId).toBe("MLB1");
  });

  it("selects the preferred listing for each platform in a single pass", () => {
    const preferred = pickPreferredListingsByPlatform([
      {
        platform: "MERCADO_LIVRE" as const,
        marketplaceAccountId: "acc-ml",
        externalListingId: "MLB1",
        permalink: "https://produto.mercadolivre.com.br/MLB1",
        status: "active",
      },
      {
        platform: "SHOPEE" as const,
        marketplaceAccountId: "acc-shp-b",
        externalListingId: "PENDING_SHP_1",
        status: "pending",
      },
      {
        platform: "SHOPEE" as const,
        marketplaceAccountId: "acc-shp-a",
        externalListingId: "44556677:889900",
        shopId: 332211,
        status: "active",
      },
    ]);

    expect(preferred).toHaveLength(2);
    expect(preferred[0]).toMatchObject({
      platform: "MERCADO_LIVRE",
      listing: { externalListingId: "MLB1" },
      linkState: {
        href: "https://produto.mercadolivre.com.br/MLB1",
        isOpenable: true,
      },
    });
    expect(preferred[1]).toMatchObject({
      platform: "SHOPEE",
      listing: { externalListingId: "44556677:889900" },
      linkState: {
        href: "https://shopee.com.br/product/332211/44556677",
        isOpenable: true,
      },
    });
  });
});
