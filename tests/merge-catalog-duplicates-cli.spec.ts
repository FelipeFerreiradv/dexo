import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import {
  assertProductionDatabaseHost,
  assertWorkersDrainedForApply,
  canonicalManifestPhoto,
  hasReviewedGalleryFallback,
  isSaleLikeStockLogReason,
  normalizeManifestName,
  parseIdentitySeed,
  parseMergeCliArgs,
  parseMergeManifest,
  reconcileCommitOutcome,
  validateGroupIdentityCoverage,
  type LiveListing,
  type MergeManifest,
} from "../scripts/merge-catalog-duplicates";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const REVIEWED_IMAGE_IDS = [
  "111111-mlb22222222222_012026",
  "333333-mlb44444444444_012026",
].sort();
const REVIEWED_GALLERY_KEY = `gallery:v1:${createHash("sha256")
  .update(JSON.stringify(REVIEWED_IMAGE_IDS))
  .digest("hex")}`;

function manifestInput(): Record<string, unknown> {
  return {
    version: 1,
    tenant: "tenant-slug",
    tenantId: "tenant-id",
    groups: [
      {
        ownerId: "owner",
        duplicateIds: ["donor"],
        name: "Cobertura Cínto L.E.",
        exactNormalizedTitle: true,
        exactFullGallery: true,
        sourceCode: "1001",
        externalSkus: ["abc"],
        expected: {
          ownerStockUnchanged: 1,
          donorStocksNotSummed: [{ productId: "donor", stock: 1 }],
          reservedTotal: 0,
          donorBlockingHistoryTotal: 0,
          donorStockLogsToReparent: 1,
          donorStockLogs: [
            {
              id: "stock-log-row",
              productId: "donor",
              change: 1,
              reason: "Restauração manual da migração",
              previousStock: 0,
              newStock: 1,
              createdAt: "2026-09-01T10:00:00.000Z",
            },
          ],
          stockSyncJobsTouched: [],
          listingIdsToMove: ["listing-row"],
        },
        evidence: {
          photoIds: [
            "ml:111111-mlb22222222222_012026",
            "ml:333333-mlb44444444444_012026",
          ],
          galleryIdentities: [
            {
              platform: "MERCADO_LIVRE",
              identityKey: REVIEWED_GALLERY_KEY,
              imageIds: REVIEWED_IMAGE_IDS,
            },
          ],
        },
      },
    ],
  };
}

function parsedManifest(): MergeManifest {
  return parseMergeManifest(manifestInput());
}

function identitySeedInput(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: 1,
    tenant: "tenant-slug",
    tenantId: "tenant-id",
    identities: [
      {
        platform: "MERCADO_LIVRE",
        identityKey: REVIEWED_GALLERY_KEY,
        productId: "owner",
        status: "CONFIRMED",
        sellerSkus: ["abc"],
      },
      {
        platform: "MERCADO_LIVRE",
        identityKey: "listing:account-id:MLB123",
        productId: "owner",
        status: "CONFIRMED",
        sellerSkus: ["abc"],
      },
    ],
    ...overrides,
  };
}

describe("merge-catalog-duplicates CLI safety parsing", () => {
  const base = [
    "--manifest=plan.json",
    "--identity-seed=identity.json",
    "--user-email=Tenant@Example.com",
  ];

  it("defaults to dry-run and normalizes the e-mail", () => {
    expect(parseMergeCliArgs(base)).toMatchObject({
      apply: false,
      confirmar: false,
      allowAnyHost: false,
      userEmail: "tenant@example.com",
    });
  });

  it.each(["../escape", "tenant/child", "tenant\\child", ".tenant"])(
    "rejects an unsafe tenant slug used in artifact filenames: %s",
    (tenant) => {
      const input = manifestInput();
      input.tenant = tenant;
      expect(() => parseMergeManifest(input)).toThrow(/slug seguro/i);
    },
  );

  it("requires two exact hashes and both apply switches", () => {
    expect(() =>
      parseMergeCliArgs([
        ...base,
        "--apply",
        "--confirmar",
        `--sha256=${HASH_A}`,
      ]),
    ).toThrow(/identity-sha256/i);
    expect(
      parseMergeCliArgs([
        ...base,
        "--apply",
        "--confirmar",
        `--sha256=${HASH_A}`,
        `--identity-sha256=${HASH_B}`,
      ]),
    ).toMatchObject({
      apply: true,
      confirmar: true,
      sha256: HASH_A,
      identitySha256: HASH_B,
    });
  });

  it.each(["positional.json", "--unknown", "--manifest", "--apply=true"])(
    "rejects unknown or malformed argument %s",
    (argument) => {
      expect(() => parseMergeCliArgs([...base, argument])).toThrow();
    },
  );

  it("does not accept confirmation or either hash in dry-run", () => {
    expect(() => parseMergeCliArgs([...base, "--confirmar"])).toThrow(
      /junto com --apply/i,
    );
    expect(() =>
      parseMergeCliArgs([...base, `--identity-sha256=${HASH_B}`]),
    ).toThrow(/junto com --apply/i);
  });

  it("requires an attested drained API/sync worker state only for apply", () => {
    expect(() => assertWorkersDrainedForApply(false, {})).not.toThrow();
    expect(() => assertWorkersDrainedForApply(true, {})).toThrow(
      /workers parados\/drenados/i,
    );
    expect(() =>
      assertWorkersDrainedForApply(true, {
        CATALOG_MERGE_WORKERS_DRAINED: "1",
      }),
    ).not.toThrow();
  });

  it("requires a sa-east-1 host unless the explicit test override is present", () => {
    expect(
      assertProductionDatabaseHost(
        "postgresql://postgres.projectref123:p@aws-0-sa-east-1.pooler.supabase.com:6543/db",
        false,
        "projectref123",
      ),
    ).toBe("aws-0-sa-east-1.pooler.supabase.com");
    expect(() =>
      assertProductionDatabaseHost("postgresql://u:p@localhost:5432/db", false),
    ).toThrow(/allow-any-host/i);
    expect(
      assertProductionDatabaseHost("postgresql://u:p@localhost:5432/db", true),
    ).toBe("localhost");
    expect(() =>
      assertProductionDatabaseHost(
        "postgresql://postgres.projectref123:p@aws-0-sa-east-1.pooler.supabase.com.evil.invalid:6543/db",
        false,
        "projectref123",
      ),
    ).toThrow(/allow-any-host/i);
    expect(() =>
      assertProductionDatabaseHost(
        "postgresql://postgres.otherproject123:p@aws-0-sa-east-1.pooler.supabase.com:6543/db",
        false,
        "projectref123",
      ),
    ).toThrow(/project-ref/i);
  });

  it.each([
    "Venda balcão",
    "ESTORNO_VENDA",
    "Cancelação de pedido",
    "baixa marketplace",
    "Pedido ML",
    "sincronização Mercado Livre",
    "baixa Shopee",
    "saldo Magalu",
  ])("classifies commercial StockLog reason %s as blocking", (reason) => {
    expect(isSaleLikeStockLogReason(reason)).toBe(true);
  });

  it("allows a non-commercial manual restore StockLog", () => {
    expect(isSaleLikeStockLogReason("Restauração manual de migração")).toBe(
      false,
    );
  });
});

describe("merge manifest validation", () => {
  it("parses the reviewed shape and canonicalizes its evidence", () => {
    const manifest = parsedManifest();
    expect(manifest.groups[0]).toMatchObject({
      ownerId: "owner",
      duplicateIds: ["donor"],
      sourceCode: "1001",
      externalSkus: ["ABC"],
    });
    expect(normalizeManifestName(" Cobertura Cínto -- L.E. ")).toBe(
      "cobertura cinto l e",
    );
    expect(
      canonicalManifestPhoto(
        "https://http2.mlstatic.com/D_111111-MLB22222222222_012026-O.jpg",
      ),
    ).toBe("ml:111111-mlb22222222222_012026");
    expect(
      canonicalManifestPhoto(
        "https://cf.shopee.com.br/file/shopee-image-123_tn",
      ),
    ).toBe("shopee:/file/shopee-image-123");
    expect(
      canonicalManifestPhoto(
        "https://evil.example/D_111111-MLB22222222222_012026-O.jpg",
      ),
    ).toBeNull();
    expect(
      canonicalManifestPhoto(
        "https://img.susercontent.com.evil/file/shopee-image-123",
      ),
    ).toBeNull();
  });

  it("rejects non-canonical photo evidence instead of silently discarding it", () => {
    const raw = manifestInput();
    (raw.groups as any[])[0].evidence.photoIds.push(
      "https://evil.example/D_555555-MLB66666666666_012026-O.jpg",
    );
    expect(() => parseMergeManifest(raw)).toThrow(/origens canônicas/i);
  });

  it("rejects overlapping products across groups", () => {
    const raw = manifestInput();
    raw.groups = [
      ...(raw.groups as unknown[]),
      {
        ...(raw.groups as Record<string, unknown>[])[0],
        ownerId: "second-owner",
      },
    ];
    expect(() => parseMergeManifest(raw)).toThrow(/mais de um grupo/i);
  });

  it("requires expected stock for every donor and zero blockers", () => {
    const missingStock = manifestInput();
    (missingStock.groups as any[])[0].expected.donorStocksNotSummed = [];
    expect(() => parseMergeManifest(missingStock)).toThrow(
      /estoques esperados/i,
    );

    const blocked = manifestInput();
    (blocked.groups as any[])[0].expected.donorBlockingHistoryTotal = 1;
    expect(() => parseMergeManifest(blocked)).toThrow(/histórico impeditivo/i);
  });

  it("requires a single external alias when the source code is absent", () => {
    const raw = manifestInput();
    (raw.groups as any[])[0].sourceCode = null;
    (raw.groups as any[])[0].externalSkus = [];
    expect(() => parseMergeManifest(raw)).toThrow(/exatamente um SKU externo/i);
  });

  it("rejects a gallery key that does not hash its signed image IDs", () => {
    const raw = manifestInput();
    (raw.groups as any[])[0].evidence.galleryIdentities[0].identityKey =
      `gallery:v1:${HASH_A}`;
    expect(() => parseMergeManifest(raw)).toThrow(/galeria completa assinada/i);
  });

  it("rejects a valid subset hash when the signed gallery has another image", () => {
    const raw = manifestInput();
    (raw.groups as any[])[0].evidence.photoIds.push(
      "ml:555555-mlb66666666666_012026",
    );
    expect(() => parseMergeManifest(raw)).toThrow(/galeria completa assinada/i);
  });
});

describe("ambiguous COMMIT reconciliation", () => {
  const expected = {
    auditId: "audit-1",
    tenantId: "tenant-id",
    manifestSha256: "a".repeat(64),
    identitySeedSha256: "b".repeat(64),
  };
  const committedRow = {
    id: expected.auditId,
    userId: expected.tenantId,
    action: "CATALOG_DUPLICATE_MERGE_COMMITTED",
    resource: "CatalogMergeManifest",
    resourceId: expected.manifestSha256,
    details: {
      manifestSha256: expected.manifestSha256,
      identitySeedSha256: expected.identitySeedSha256,
    },
  };

  it("proves a committed merge from the audit row after a lost ACK", async () => {
    let attempts = 0;
    const outcome = await reconcileCommitOutcome(
      expected,
      async () => {
        attempts++;
        if (attempts === 1) throw new Error("connection reset");
        return [committedRow];
      },
      async () => undefined,
    );
    expect(outcome).toBe("committed");
    expect(attempts).toBe(2);
  });

  it("only calls the transaction rolled back after three absent lookups", async () => {
    let attempts = 0;
    const pauses: number[] = [];
    await expect(
      reconcileCommitOutcome(
        expected,
        async () => {
          attempts++;
          return [];
        },
        async (milliseconds) => {
          pauses.push(milliseconds);
        },
      ),
    ).resolves.toBe("rolled-back");
    expect(attempts).toBe(3);
    expect(pauses).toEqual([250, 500]);
  });

  it("observes a commit that becomes visible after an initially absent lookup", async () => {
    let attempts = 0;
    await expect(
      reconcileCommitOutcome(
        expected,
        async () => {
          attempts++;
          return attempts === 1 ? [] : [committedRow];
        },
        async () => undefined,
      ),
    ).resolves.toBe("committed");
    expect(attempts).toBe(2);
  });

  it("keeps the outcome unknown when lookup fails or the audit does not match", async () => {
    await expect(
      reconcileCommitOutcome(
        expected,
        async () => {
          throw new Error("database unavailable");
        },
        async () => undefined,
      ),
    ).resolves.toBe("unknown");
    await expect(
      reconcileCommitOutcome(
        expected,
        async () => [
          {
            ...committedRow,
            details: { ...committedRow.details, identitySeedSha256: "wrong" },
          },
        ],
        async () => undefined,
      ),
    ).resolves.toBe("unknown");
  });
});

describe("identity seed validation", () => {
  it("accepts reviewed listing, gallery, observed and ambiguous invariants", () => {
    const raw = identitySeedInput();
    raw.identities = [
      ...(raw.identities as unknown[]),
      {
        platform: "SHOPEE",
        identityKey: `gallery:v1:${HASH_B}`,
        productId: "owner",
        status: "OBSERVED",
        sellerSkus: [],
      },
      {
        platform: "SHOPEE",
        identityKey: `gallery:v1:${"c".repeat(64)}`,
        productId: null,
        status: "AMBIGUOUS",
        sellerSkus: ["sku-a", "sku-b"],
      },
    ];
    const seed = parseIdentitySeed(raw, parsedManifest());
    expect(seed.identities).toHaveLength(4);
    expect(seed.identities[0].sellerSkus).toEqual(["abc"]);
  });

  it.each([
    {
      identityKey: `gallery:v1:${HASH_A}`,
      productId: "donor",
      status: "CONFIRMED",
      reason: /owner canônico/i,
    },
    {
      identityKey: `gallery:v1:${HASH_A}`,
      productId: "donor",
      status: "OBSERVED",
      reason: /owner canônico/i,
    },
    {
      identityKey: `gallery:v1:${HASH_A}`,
      productId: "owner",
      status: "AMBIGUOUS",
      reason: /owner canônico/i,
    },
    {
      identityKey: "gallery:v1:not-a-hash",
      productId: "owner",
      status: "CONFIRMED",
      reason: /gallery:v1/i,
    },
    {
      identityKey: "listing:missing-account",
      productId: "owner",
      status: "CONFIRMED",
      reason: /listing:<conta>/i,
    },
    {
      identityKey: "listing:account:external",
      productId: null,
      status: "AMBIGUOUS",
      reason: /deve ser CONFIRMED/i,
    },
  ])(
    "rejects an unsafe identity row: $identityKey/$status",
    ({ reason, ...identity }) => {
      const raw = identitySeedInput({
        identities: [
          { platform: "MERCADO_LIVRE", sellerSkus: [], ...identity },
        ],
      });
      expect(() => parseIdentitySeed(raw, parsedManifest())).toThrow(reason);
    },
  );

  it("refuses a seed for another tenant and duplicate scoped identities", () => {
    expect(() =>
      parseIdentitySeed(
        identitySeedInput({ tenantId: "other" }),
        parsedManifest(),
      ),
    ).toThrow(/tenants diferentes/i);
    const duplicate = identitySeedInput();
    duplicate.identities = [
      (duplicate.identities as any[])[0],
      (duplicate.identities as any[])[0],
    ];
    expect(() => parseIdentitySeed(duplicate, parsedManifest())).toThrow(
      /repetida/i,
    );
  });

  it("refuses an extra confirmed gallery outside the signed whitelist", () => {
    const poisoned = identitySeedInput();
    (poisoned.identities as any[]).push({
      platform: "MERCADO_LIVRE",
      identityKey: `gallery:v1:${HASH_B}`,
      productId: "owner",
      status: "CONFIRMED",
      sellerSkus: ["abc"],
    });
    expect(() => parseIdentitySeed(poisoned, parsedManifest())).toThrow(
      /whitelist assinada/i,
    );
  });
});

describe("reviewed gallery fallback", () => {
  it("accepts signed legacy evidence only when every cited listing alias is live", () => {
    const manifest = parsedManifest();
    manifest.groups[0].exactFullGallery = false;
    const group = manifest.groups[0];
    const gallery = REVIEWED_GALLERY_KEY;
    const seed = parseIdentitySeed(
      identitySeedInput({
        identities: [
          {
            platform: "MERCADO_LIVRE",
            identityKey: gallery,
            productId: "owner",
            status: "CONFIRMED",
            sellerSkus: [],
            evidence: {
              observations: 2,
              originalProductIds: ["owner", "donor"],
              sources: [
                "listing:MERCADO_LIVRE:account-id:MLB123:owner",
                "listing:MERCADO_LIVRE:donor-account:MLB456:donor",
                "product-images:ml",
              ],
            },
          },
          {
            platform: "MERCADO_LIVRE",
            identityKey: "listing:account-id:MLB123",
            productId: "owner",
            status: "CONFIRMED",
            sellerSkus: [],
            evidence: {
              observations: 1,
              originalProductIds: ["owner"],
              sources: ["listing"],
            },
          },
          {
            platform: "SHOPEE",
            identityKey: "listing:shopee-account:MLB123",
            productId: "owner",
            status: "CONFIRMED",
            sellerSkus: [],
          },
          {
            platform: "MERCADO_LIVRE",
            identityKey: "listing:donor-account:MLB456",
            productId: "owner",
            status: "CONFIRMED",
            sellerSkus: [],
          },
        ],
      }),
      manifest,
    );
    const listing: LiveListing = {
      id: "listing-row",
      productId: "owner",
      marketplaceAccountId: "account-id",
      externalListingId: "MLB123",
      externalSku: null,
      platform: "MERCADO_LIVRE",
      accountDataOwnerId: "tenant-id",
    };
    const donorListing: LiveListing = {
      ...listing,
      id: "donor-listing-row",
      productId: "donor",
      marketplaceAccountId: "donor-account",
      externalListingId: "MLB456",
    };

    expect(
      hasReviewedGalleryFallback(group, seed, [listing, donorListing]),
    ).toBe(true);
    expect(
      hasReviewedGalleryFallback(group, seed, [
        { ...listing, marketplaceAccountId: "other-account" },
        donorListing,
      ]),
    ).toBe(false);
    expect(
      hasReviewedGalleryFallback(group, seed, [
        {
          ...listing,
          platform: "SHOPEE",
          marketplaceAccountId: "shopee-account",
        },
        donorListing,
      ]),
    ).toBe(false);
    expect(
      hasReviewedGalleryFallback(group, seed, [
        { ...listing, productId: "donor" },
        donorListing,
      ]),
    ).toBe(false);
  });

  it("refuses fallback without source code or exact member coverage", () => {
    const manifest = parsedManifest();
    manifest.groups[0].exactFullGallery = false;
    const seed = parseIdentitySeed(
      identitySeedInput({
        identities: [
          {
            platform: "MERCADO_LIVRE",
            identityKey: REVIEWED_GALLERY_KEY,
            productId: "owner",
            status: "CONFIRMED",
            sellerSkus: [],
            evidence: {
              observations: 2,
              originalProductIds: ["owner"],
              sources: ["listing:MERCADO_LIVRE:account-id:MLB123:owner"],
            },
          },
          {
            platform: "MERCADO_LIVRE",
            identityKey: "listing:account-id:MLB123",
            productId: "owner",
            status: "CONFIRMED",
            sellerSkus: [],
          },
        ],
      }),
      manifest,
    );
    const listing: LiveListing = {
      id: "listing-row",
      productId: "owner",
      marketplaceAccountId: "account-id",
      externalListingId: "MLB123",
      externalSku: null,
      platform: "MERCADO_LIVRE",
      accountDataOwnerId: "tenant-id",
    };

    expect(
      hasReviewedGalleryFallback(manifest.groups[0], seed, [listing]),
    ).toBe(false);
    manifest.groups[0].sourceCode = null;
    expect(
      hasReviewedGalleryFallback(manifest.groups[0], seed, [listing]),
    ).toBe(false);
  });
});

describe("identity coverage required by a merge group", () => {
  function coveredPlan() {
    const manifest = parsedManifest();
    const gallery = manifest.groups[0].evidence.galleryIdentities[0];
    const seed = parseIdentitySeed(
      identitySeedInput({
        identities: [
          {
            ...gallery,
            productId: "owner",
            status: "CONFIRMED",
            sellerSkus: ["abc"],
          },
          {
            platform: "MERCADO_LIVRE",
            identityKey: "listing:account-id:MLB123",
            productId: "owner",
            status: "CONFIRMED",
            sellerSkus: ["abc"],
          },
        ],
      }),
      manifest,
    );
    const listing: LiveListing = {
      id: "listing-row",
      productId: "donor",
      marketplaceAccountId: "account-id",
      externalListingId: "MLB123",
      externalSku: "ABC",
      platform: "MERCADO_LIVRE",
      accountDataOwnerId: "tenant-id",
    };
    return { manifest, seed, listing };
  }

  it("requires confirmed gallery and exact listing aliases with seller SKU coverage", () => {
    const { manifest, seed, listing } = coveredPlan();
    expect(
      validateGroupIdentityCoverage(
        manifest.groups[0],
        seed,
        [listing],
        manifest.tenantId,
      ),
    ).toEqual([]);
  });

  it("rejects cross-tenant accounts and missing seller-SKU coverage", () => {
    const { manifest, seed, listing } = coveredPlan();
    seed.identities.forEach((row) => {
      row.sellerSkus = [];
    });
    const errors = validateGroupIdentityCoverage(
      manifest.groups[0],
      seed,
      [{ ...listing, accountDataOwnerId: "other-tenant" }],
      manifest.tenantId,
    );
    expect(errors.map((entry) => entry.code)).toEqual(
      expect.arrayContaining([
        "LISTING_ACCOUNT_TENANT_MISMATCH",
        "LIVE_LISTING_IDENTITY_NOT_CONFIRMED",
        "REVIEWED_GALLERY_IDENTITY_NOT_CONFIRMED",
      ]),
    );
  });

  it("requires an empty gallery allowlist when the reviewed group has no SKU", () => {
    const { manifest, seed, listing } = coveredPlan();
    manifest.groups[0].externalSkus = [];
    listing.externalSku = null;
    seed.identities.find((row) =>
      row.identityKey.startsWith("gallery:"),
    )!.sellerSkus = ["stale-unreviewed-sku"];

    expect(
      validateGroupIdentityCoverage(
        manifest.groups[0],
        seed,
        [listing],
        manifest.tenantId,
      ).map((entry) => entry.code),
    ).toContain("REVIEWED_GALLERY_IDENTITY_NOT_CONFIRMED");
  });

  it("does not authorize a SKU from another platform in an ML gallery", () => {
    const { manifest, seed, listing } = coveredPlan();
    const gallery = seed.identities.find((row) =>
      row.identityKey.startsWith("gallery:"),
    )!;
    gallery.sellerSkus = ["abc", "shopee-only"];
    seed.identities.push({
      platform: "SHOPEE",
      identityKey: "listing:shopee-account:987654",
      productId: "owner",
      status: "CONFIRMED",
      sellerSkus: ["shopee-only"],
    });
    const shopeeListing = {
      ...listing,
      id: "shopee-listing",
      marketplaceAccountId: "shopee-account",
      externalListingId: "987654",
      externalSku: "SHOPEE-ONLY",
      platform: "SHOPEE",
    };

    expect(
      validateGroupIdentityCoverage(
        manifest.groups[0],
        seed,
        [listing, shopeeListing],
        manifest.tenantId,
      ).map((entry) => entry.code),
    ).toContain("REVIEWED_GALLERY_IDENTITY_NOT_CONFIRMED");
  });
});
