import { afterEach, describe, expect, it, vi } from "vitest";
import { Platform } from "@prisma/client";
import prisma from "@/app/lib/prisma";
import {
  catalogGalleryKey,
  catalogIdentityEnabled,
  type CatalogIdentityItem,
} from "@/app/marketplaces/lib/catalog-gallery-identity";
import { CatalogIdentityService } from "@/app/marketplaces/services/catalog-identity.service";

const title = "Cobertura Acabamento Superior Cinto Caravan Chrysler 1996";
const item: CatalogIdentityItem = {
  platform: Platform.MERCADO_LIVRE,
  account: { id: "account-a", userId: "tenant-a" },
  externalListingId: "MLB123",
  rawSku: "10095",
  title,
  imageUrls: [
    "https://http2.mlstatic.com/D_619404-MLB75824100607_042024-O.jpg",
    "https://http2.mlstatic.com/D_682941-MLB75824100609_042024-O.jpg",
  ],
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("complete gallery identity", () => {
  it("normalizes size and order; title compatibility is checked after lookup", () => {
    const key = catalogGalleryKey(item);
    expect(key).toMatch(/^gallery:v1:[a-f0-9]{64}$/);
    expect(
      catalogGalleryKey({
        ...item,
        title: title.toUpperCase(),
        imageUrls: [...item.imageUrls!]
          .reverse()
          .map((url) => url.replace("-O.jpg", "-I.jpg")),
      }),
    ).toBe(key);
    expect(
      catalogGalleryKey({ ...item, title: title + " L/d Kit 10096" }),
    ).toBe(key);
  });
  it("refuses partial galleries, reused covers, external URLs and malformed images", () => {
    for (const images of [
      [],
      [item.imageUrls![0]],
      [item.imageUrls![0], item.imageUrls![0]],
      [item.imageUrls![0], "https://example.com/logo.jpg"],
      [
        item.imageUrls![0],
        "https://mlstatic.com.evil.invalid/D_682941-MLB75824100609_042024-O.jpg",
      ],
    ]) {
      expect(catalogGalleryKey({ ...item, imageUrls: images })).toBeNull();
    }
  });
  it("scopes activation exactly to tenant IDs", () => {
    vi.stubEnv("CATALOG_IDENTITY_TENANT_IDS", " tenant-a, tenant-b ");
    expect(catalogIdentityEnabled(item)).toBe(true);
    expect(
      catalogIdentityEnabled({
        ...item,
        account: { ...item.account, userId: "tenant" },
      }),
    ).toBe(false);
  });
  it("accepts two distinct Shopee gallery files", () => {
    expect(
      catalogGalleryKey({
        ...item,
        platform: Platform.SHOPEE,
        imageUrls: [
          "https://cf.shopee.com.br/file/br-11134207-one",
          "https://cf.shopee.com.br/file/br-11134207-two",
        ],
      }),
    ).toMatch(/^gallery:v1:/);
    expect(
      catalogGalleryKey({
        ...item,
        platform: Platform.SHOPEE,
        imageUrls: [
          "https://down-br.img.susercontent.com/file/br-11134207-one",
          "https://down-br.img.susercontent.com/file/br-11134207-two",
        ],
      }),
    ).toMatch(/^gallery:v1:/);
  });
});

function transaction(
  rows: any[],
  accountRows: Array<{ id: string }> = [{ id: item.account.id }],
  productRows: Array<{ id: string; name: string }> = [
    { id: "canonical", name: title },
  ],
) {
  const events: string[] = [];
  const writes: { sql: string; values: unknown[] }[] = [];
  const reads: { sql: string; values: unknown[] }[] = [];
  const tx = {
    $executeRaw: vi.fn(
      async (parts: TemplateStringsArray, ...values: unknown[]) => {
        const sql = parts.join("?");
        events.push("identity");
        writes.push({ sql, values });
        return 1;
      },
    ),
    $queryRaw: vi.fn(
      async (parts: TemplateStringsArray, ...values: unknown[]) => {
        const sql = parts.join("?");
        reads.push({ sql, values });
        if (sql.includes('FROM "MarketplaceAccount"')) {
          events.push("account");
          return accountRows;
        }
        if (sql.includes("advisory")) {
          events.push("lock");
          return [{ pg_advisory_xact_lock: null }];
        }
        if (sql.includes('FROM "Product"')) {
          events.push("product");
          return productRows;
        }
        events.push("lookup");
        return rows.map((row) => ({
          status: "CONFIRMED",
          productUserId: "tenant-a",
          ...row,
        }));
      },
    ),
  };
  vi.spyOn(prisma, "$transaction").mockImplementation(async (run: any) =>
    run(tx),
  );
  return { tx, events, reads, writes };
}
describe("durable canonical aliases", () => {
  it("refuses a caller-provided account that does not belong to the tenant", async () => {
    const { events, writes } = transaction([], []);
    await expect(
      CatalogIdentityService.serialized(item, async () => ({
        productId: null,
        action: "ignored_by_list",
      })),
    ).rejects.toThrow(/conta de marketplace fora do tenant/i);
    expect(events).toEqual(["account"]);
    expect(writes).toHaveLength(0);
  });
  it("locks before resolving and runs listing/product writes in the same transaction", async () => {
    const { tx, events, reads, writes } = transaction([
      {
        id: "canonical",
        name: title,
        identityKey: catalogGalleryKey(item),
        sellerSkus: ["10095"],
      },
    ]);
    const result = await CatalogIdentityService.serialized(
      item,
      async (client, canonical) => {
        expect(client).toBe(tx);
        expect(canonical?.id).toBe("canonical");
        events.push("listing");
        return { productId: "canonical", action: "linked_existing_product" };
      },
    );
    expect(result.productId).toBe("canonical");
    expect(events).toEqual([
      "account",
      "lock",
      "lookup",
      "listing",
      "product",
      "identity",
      "identity",
    ]);
    const accountRead = reads.find((read) =>
      read.sql.includes('FROM "MarketplaceAccount"'),
    );
    const productRead = reads.find((read) =>
      read.sql.includes('FROM "Product"'),
    );
    expect(accountRead?.sql).toMatch(/FOR SHARE/);
    expect(accountRead?.values).toEqual([
      item.account.id,
      item.account.userId,
      item.platform,
    ]);
    expect(productRead?.sql).toMatch(/FOR SHARE/);
    expect(productRead?.values).toEqual(["canonical", item.account.userId]);
    expect(writes[0].values).toContain("listing:account-a:MLB123");
    expect(writes[1].values).toContain("CONFIRMED");
    expect(writes.every((write) => write.values.includes("tenant-a"))).toBe(
      true,
    );
  });
  it("rolls back identity writes when the returned product leaves the tenant", async () => {
    const { events, writes } = transaction([], [{ id: item.account.id }], []);

    await expect(
      CatalogIdentityService.serialized(item, async () => ({
        productId: "canonical",
        action: "linked_existing_product",
      })),
    ).rejects.toThrow(/produto.*tenant/i);

    expect(events).toEqual(["account", "lock", "lookup", "product"]);
    expect(writes).toHaveLength(0);
  });
  it("does not use a gallery to override a different explicit physical-piece code", async () => {
    transaction([
      {
        id: "canonical",
        name: title,
        identityKey: catalogGalleryKey(item),
        sellerSkus: ["other-code"],
      },
    ]);
    await CatalogIdentityService.serialized(
      item,
      async (_, canonical, blockSkuMatch) => {
        expect(canonical).toBeNull();
        expect(blockSkuMatch).toBe(false);
        return { productId: null, action: "ignored_by_list" };
      },
    );
  });
  it("does not use even a reviewed gallery when the incoming listing has no SKU", async () => {
    transaction([
      {
        id: "canonical",
        name: title,
        identityKey: catalogGalleryKey(item),
        sellerSkus: ["10095"],
      },
    ]);
    await CatalogIdentityService.serialized(
      { ...item, rawSku: null },
      async (_, canonical) => {
        expect(canonical).toBeNull();
        return { productId: null, action: "ignored_by_list" };
      },
    );
  });
  it("uses an explicitly reviewed SKU-less gallery for a SKU-less item", async () => {
    transaction([
      {
        id: "canonical",
        name: title,
        identityKey: catalogGalleryKey(item),
        sellerSkus: [],
      },
    ]);
    await CatalogIdentityService.serialized(
      { ...item, rawSku: null },
      async (_, canonical) => {
        expect(canonical?.id).toBe("canonical");
        return { productId: null, action: "ignored_by_list" };
      },
    );
  });
  it("consumes an exact listing alias even when the gallery is unavailable", async () => {
    const { writes } = transaction([
      {
        id: "canonical",
        name: title,
        identityKey: "listing:account-a:MLB123",
        sellerSkus: [],
      },
    ]);
    await CatalogIdentityService.serialized(
      { ...item, rawSku: null, imageUrls: [] },
      async (_, canonical) => {
        expect(canonical?.id).toBe("canonical");
        return {
          productId: "canonical",
          action: "linked_existing_product",
        };
      },
    );
    expect(writes).toHaveLength(1);
    expect(writes[0].values).toContain("listing:account-a:MLB123");
  });
  it("refuses an identity that points to a product from another tenant", async () => {
    transaction([
      {
        id: "foreign",
        name: title,
        productUserId: "tenant-b",
        identityKey: "listing:account-a:MLB123",
        sellerSkus: ["10095"],
      },
    ]);
    await CatalogIdentityService.serialized(
      item,
      async (_, canonical, blockSkuMatch) => {
        expect(canonical).toBeNull();
        expect(blockSkuMatch).toBe(true);
        return { productId: null, action: "ignored_by_list" };
      },
    );
  });
  it("records an unseen gallery as observed instead of self-confirming it", async () => {
    const { writes } = transaction([]);
    await CatalogIdentityService.serialized(item, async () => ({
      productId: "canonical",
      action: "created_product",
    }));
    expect(writes[0].sql).toContain("'CONFIRMED'");
    expect(writes[1].values).toContain("OBSERVED");
  });
  it("uses a confirmed listing alias despite a changed seller SKU", async () => {
    transaction([
      {
        id: "canonical",
        name: title,
        identityKey: "listing:account-a:MLB123",
        sellerSkus: ["old-code"],
      },
    ]);
    await CatalogIdentityService.serialized(item, async (_, canonical) => {
      expect(canonical?.id).toBe("canonical");
      return { productId: null, action: "ignored_by_list" };
    });
  });
  it("never expands a confirmed gallery allowlist from a runtime listing", async () => {
    const skuBItem = { ...item, rawSku: "sku-b" };
    const galleryKey = catalogGalleryKey(skuBItem);
    const { writes } = transaction([
      {
        id: "canonical",
        name: title,
        identityKey: "listing:account-a:MLB123",
        sellerSkus: ["sku-a"],
      },
      {
        id: "canonical",
        name: title,
        identityKey: galleryKey,
        sellerSkus: ["sku-a"],
      },
    ]);
    await CatalogIdentityService.serialized(skuBItem, async (_, canonical) => {
      expect(canonical?.id).toBe("canonical");
      return {
        productId: "canonical",
        action: "linked_existing_product",
      };
    });

    expect(
      writes[1].values.some(
        (value) => Array.isArray(value) && value.includes("sku-b"),
      ),
    ).toBe(true);
    expect(writes[1].sql).toMatch(
      /status = 'CONFIRMED'[\s\S]+THEN "ProductIngestionIdentity"\."sellerSkus"/,
    );

    vi.restoreAllMocks();
    transaction([
      {
        id: "canonical",
        name: title,
        identityKey: galleryKey,
        sellerSkus: ["sku-a"],
      },
    ]);
    await CatalogIdentityService.serialized(
      { ...skuBItem, externalListingId: "MLB456" },
      async (_, canonical) => {
        expect(canonical).toBeNull();
        return { productId: null, action: "ignored_by_list" };
      },
    );
  });
  it("blocks legacy SKU matching when the reviewed gallery is ambiguous", async () => {
    transaction([
      {
        id: null,
        name: null,
        identityKey: catalogGalleryKey(item),
        sellerSkus: [],
        status: "AMBIGUOUS",
      },
    ]);
    await CatalogIdentityService.serialized(
      item,
      async (_, canonical, blockSkuMatch) => {
        expect(canonical).toBeNull();
        expect(blockSkuMatch).toBe(true);
        return { productId: null, action: "ignored_by_list" };
      },
    );
  });
  it("blocks legacy SKU matching when the exact listing alias is ambiguous", async () => {
    transaction([
      {
        id: null,
        name: null,
        identityKey: "listing:account-a:MLB123",
        sellerSkus: ["10095"],
        status: "AMBIGUOUS",
      },
    ]);
    await CatalogIdentityService.serialized(
      item,
      async (_, canonical, blockSkuMatch) => {
        expect(canonical).toBeNull();
        expect(blockSkuMatch).toBe(true);
        return { productId: null, action: "ignored_by_list" };
      },
    );
  });
  it("refuses conflicting canonical IDs and opposite-side pieces", async () => {
    transaction([
      {
        id: "one",
        name: title,
        identityKey: catalogGalleryKey(item),
        sellerSkus: ["10095"],
      },
      {
        id: "two",
        name: title,
        identityKey: "listing:account-a:MLB123",
        sellerSkus: [],
      },
    ]);
    await CatalogIdentityService.serialized(
      item,
      async (_, canonical, blockSkuMatch) => {
        expect(canonical).toBeNull();
        expect(blockSkuMatch).toBe(true);
        return { productId: null, action: "ignored_by_list" };
      },
    );
    vi.restoreAllMocks();
    transaction([
      {
        id: "right",
        name: title + " Direito",
        identityKey: "listing:account-a:MLB123",
        sellerSkus: [],
      },
    ]);
    await CatalogIdentityService.serialized(
      { ...item, title: title + " Esquerdo" },
      async (_, canonical, blockSkuMatch) => {
        expect(canonical).toBeNull();
        expect(blockSkuMatch).toBe(true);
        return { productId: null, action: "ignored_by_list" };
      },
    );
  });
  it("propagates write failure and does not learn aliases from a rolled-back listing", async () => {
    const { writes } = transaction([]);
    await expect(
      CatalogIdentityService.serialized(item, async () => {
        throw new Error("listing failed");
      }),
    ).rejects.toThrow("listing failed");
    expect(writes).toHaveLength(0);
  });
});
