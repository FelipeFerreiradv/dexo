import "dotenv/config";

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import prisma from "../../app/lib/prisma";
import {
  canonicalManifestPhoto,
  isSaleLikeStockLogReason,
  normalizeManifestName,
  parseIdentitySeed,
  parseMergeManifest,
  type GalleryMemberProof,
} from "../merge-catalog-duplicates";

const [inputManifestPath, inputSeedPath, outputManifestPath, outputSeedPath] =
  process.argv.slice(2).map((value) => (value ? path.resolve(value) : value));
if (
  !inputManifestPath ||
  !inputSeedPath ||
  !outputManifestPath ||
  !outputSeedPath
) {
  throw new Error(
    "usage: finalize-live-manifest <evidence-manifest> <preliminary-seed> <final-manifest> <final-seed>",
  );
}

const manifestRaw = fs.readFileSync(inputManifestPath);
const seedRaw = fs.readFileSync(inputSeedPath);
const manifest = parseMergeManifest(JSON.parse(manifestRaw.toString("utf8")));
const preliminarySeed = parseIdentitySeed(
  JSON.parse(seedRaw.toString("utf8")),
  manifest,
);
const allIds = [
  ...new Set(
    manifest.groups.flatMap((group: any) => [
      group.ownerId,
      ...group.duplicateIds,
    ]),
  ),
];
const donorIds = [
  ...new Set(manifest.groups.flatMap((group: any) => group.duplicateIds)),
];

async function main() {
  const live = await prisma.$transaction(
    async (tx) => {
      const [
        products,
        listings,
        stockLogs,
        orderItems,
        receivableItems,
        budgetItems,
        nfeItems,
        activeBulkJobs,
      ] = await Promise.all([
        tx.product.findMany({
          where: { id: { in: allIds } },
          select: {
            id: true,
            userId: true,
            name: true,
            stock: true,
            reservedStock: true,
            autoCreatedFromSale: true,
            scrapId: true,
            attributes: true,
            imageUrl: true,
            imageUrls: true,
          },
        }),
        tx.productListing.findMany({
          where: { productId: { in: allIds } },
          select: {
            id: true,
            productId: true,
            marketplaceAccountId: true,
            externalListingId: true,
            externalSku: true,
            marketplaceAccount: { select: { platform: true, userId: true } },
          },
        }),
        tx.stockLog.findMany({
          where: { productId: { in: donorIds } },
          select: {
            id: true,
            productId: true,
            change: true,
            reason: true,
            previousStock: true,
            newStock: true,
            createdAt: true,
          },
        }),
        tx.orderItem.findMany({
          where: { productId: { in: donorIds } },
          select: { id: true, productId: true },
        }),
        tx.receivableItem.findMany({
          where: { productId: { in: donorIds } },
          select: { id: true, productId: true },
        }),
        tx.budgetItem.findMany({
          where: { productId: { in: donorIds } },
          select: { id: true, productId: true },
        }),
        tx.nfeItem.findMany({
          where: { productId: { in: donorIds } },
          select: { id: true, productId: true },
        }),
        tx.bulkListingJob.findMany({
          where: { status: { in: ["QUEUED", "RUNNING"] } },
          select: { id: true, status: true },
        }),
      ]);
      const listingIds = listings.map((listing) => listing.id);
      const stockSyncJobs = await tx.stockSyncJob.findMany({
        where: {
          OR: [
            { productId: { in: donorIds } },
            { status: "PENDING", listingId: { in: listingIds } },
          ],
        },
        select: {
          id: true,
          productId: true,
          listingId: true,
          platform: true,
          targetStock: true,
          attempts: true,
          nextRunAt: true,
          status: true,
          lastError: true,
          orderId: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      return {
        products,
        listings,
        stockLogs,
        stockSyncJobs,
        orderItems,
        receivableItems,
        budgetItems,
        nfeItems,
        activeBulkJobs,
      };
    },
    {
      maxWait: 30_000,
      timeout: 180_000,
      isolationLevel: "RepeatableRead",
    },
  );

  if (
    live.activeBulkJobs.length &&
    process.env.ALLOW_ACTIVE_BULK_PREVIEW !== "1"
  ) {
    throw new Error(
      `active BulkListingJob queue must be drained first (${live.activeBulkJobs.length})`,
    );
  }

  const productById = new Map(live.products.map((row) => [row.id, row]));
  const listingById = new Map(live.listings.map((row) => [row.id, row]));
  const byProduct = <T extends { productId: string | null }>(rows: T[]) => {
    const result = new Map<string, T[]>();
    for (const row of rows) {
      if (!row.productId) continue;
      const bucket = result.get(row.productId) ?? [];
      bucket.push(row);
      result.set(row.productId, bucket);
    }
    return result;
  };
  const listingsByProduct = byProduct(live.listings);
  const logsByProduct = byProduct(live.stockLogs);
  const blockingHistory = [
    byProduct(live.orderItems),
    byProduct(live.receivableItems),
    byProduct(live.budgetItems),
    byProduct(live.nfeItems),
  ];
  const attributeText = (value: any) =>
    value && typeof value === "object"
      ? String(value.value_name ?? "").trim()
      : String(value ?? "").trim();
  const sourceCode = (product: any) =>
    attributeText(
      product?.attributes?.codPeca || product?.attributes?.legacyPecaCode,
    );
  const sortedUnique = (values: string[]) => [...new Set(values)].sort();
  const arrayEqual = (left: string[], right: string[]) =>
    left.length === right.length &&
    left.every((value, index) => value === right[index]);
  const normalizedSku = (value: unknown) => {
    const result = String(value ?? "")
      .trim()
      .toLowerCase();
    return result || null;
  };
  const liveGalleryImageIds = (product: any, platform: string) =>
    sortedUnique(
      [product.imageUrl, ...(product.imageUrls ?? [])].flatMap((url) => {
        const photo = canonicalManifestPhoto(url);
        if (platform === "MERCADO_LIVRE" && photo?.startsWith("ml:")) {
          return [photo.slice(3).toLowerCase()];
        }
        if (platform === "SHOPEE" && photo?.startsWith("shopee:/file/")) {
          return [
            photo
              .slice("shopee:/file/".length)
              .replace(/_tn$/i, "")
              .toLowerCase(),
          ];
        }
        return [];
      }),
    );

  const preliminaryByKey = new Map(
    preliminarySeed.identities.map((row: any) => [
      `${row.platform}\u0000${row.identityKey}`,
      row,
    ]),
  );
  const blocked: Array<{ ownerId: string; name: string; reasons: string[] }> =
    [];
  const finalGroups: any[] = [];
  const finalIdentityByKey = new Map<string, any>();
  const identityOwners = new Map<string, string>();

  const putIdentity = (identity: any, ownerId?: string) => {
    const key = `${identity.platform}\u0000${identity.identityKey}`;
    const previousOwner = identityOwners.get(key);
    if (ownerId && previousOwner && previousOwner !== ownerId) {
      throw new Error(
        `identity collision between ${previousOwner} and ${ownerId}`,
      );
    }
    if (ownerId) identityOwners.set(key, ownerId);
    finalIdentityByKey.set(key, identity);
  };

  for (const row of preliminarySeed.identities) {
    if (row.status === "AMBIGUOUS") putIdentity(row);
  }

  for (const group of manifest.groups) {
    const reasons: string[] = [];
    const memberIds = [group.ownerId, ...group.duplicateIds];
    const members = memberIds
      .map((id: string) => productById.get(id))
      .filter(Boolean) as any[];
    if (members.length !== memberIds.length) reasons.push("missing_product");
    if (members.some((row) => row.userId !== manifest.tenantId))
      reasons.push("tenant_mismatch");
    if (
      members.some(
        (row) =>
          normalizeManifestName(row.name) !== normalizeManifestName(group.name),
      )
    )
      reasons.push("name_drift");
    if (members.some((row) => row.reservedStock !== 0))
      reasons.push("reserved_stock");
    if (members.some((row) => row.autoCreatedFromSale))
      reasons.push("auto_created_from_sale");
    if (new Set(members.map((row) => row.scrapId ?? null)).size > 1)
      reasons.push("scrap_mismatch");
    const codes = sortedUnique(members.map(sourceCode).filter(Boolean));
    if (
      group.sourceCode === null
        ? codes.length !== 0
        : codes.length !== 1 || codes[0] !== group.sourceCode
    )
      reasons.push("source_code_drift");
    if (
      blockingHistory.some((history) =>
        group.duplicateIds.some(
          (id: string) => (history.get(id) ?? []).length > 0,
        ),
      )
    )
      reasons.push("blocking_history");

    const groupListings = memberIds.flatMap(
      (id: string) => listingsByProduct.get(id) ?? [],
    );
    if (
      groupListings.some(
        (listing) => listing.marketplaceAccount.userId !== manifest.tenantId,
      )
    )
      reasons.push("listing_tenant_mismatch");
    const donorListingIds = sortedUnique(
      group.duplicateIds.flatMap((id: string) =>
        (listingsByProduct.get(id) ?? []).map((row) => row.id),
      ),
    );
    const donorLogs = group.duplicateIds.flatMap(
      (id: string) => logsByProduct.get(id) ?? [],
    );
    if (donorLogs.some((row) => isSaleLikeStockLogReason(row.reason)))
      reasons.push("sale_like_stock_log");

    const groupJobs = live.stockSyncJobs.filter((job) => {
      if (group.duplicateIds.includes(job.productId)) return true;
      const listing = listingById.get(job.listingId);
      return (
        job.status === "PENDING" &&
        Boolean(listing && memberIds.includes(listing.productId))
      );
    });
    if (
      groupJobs.some((job) => {
        const listing = listingById.get(job.listingId);
        return (
          !listing ||
          listing.productId !== job.productId ||
          listing.marketplaceAccount.platform !== job.platform ||
          listing.marketplaceAccount.userId !== manifest.tenantId
        );
      })
    )
      reasons.push("inconsistent_stock_sync_job");

    const galleryRows = group.evidence.galleryIdentities.map(
      (identity: any) => {
        const preliminary = preliminaryByKey.get(
          `${identity.platform}\u0000${identity.identityKey}`,
        ) as any;
        if (
          !preliminary ||
          preliminary.status !== "CONFIRMED" ||
          preliminary.productId !== group.ownerId
        ) {
          reasons.push("missing_confirmed_gallery_seed");
          return null;
        }
        for (const proof of identity.memberProofs as GalleryMemberProof[]) {
          const proofProduct = productById.get(proof.productId) as any;
          if (!proofProduct || proofProduct.userId !== manifest.tenantId) {
            reasons.push("member_proof_product_stale");
            continue;
          }
          if (proof.type === "PRODUCT_GALLERY") {
            if (
              !arrayEqual(
                liveGalleryImageIds(proofProduct, proof.platform),
                proof.imageIds,
              )
            ) {
              reasons.push("product_gallery_proof_stale");
            }
            continue;
          }
          if (proof.type === "ACCOUNT_LISTING") {
            const proofListings = groupListings.filter(
              (listing) =>
                listing.productId === proof.productId &&
                String(listing.marketplaceAccount.platform) ===
                  proof.platform &&
                listing.marketplaceAccount.userId === manifest.tenantId &&
                listing.marketplaceAccountId === proof.marketplaceAccountId &&
                listing.externalListingId === proof.externalListingId,
            );
            const alias = preliminaryByKey.get(
              `${proof.platform}\u0000listing:${proof.marketplaceAccountId}:${proof.externalListingId}`,
            ) as any;
            if (
              proofListings.length !== 1 ||
              !alias ||
              alias.status !== "CONFIRMED" ||
              alias.productId !== group.ownerId
            ) {
              reasons.push("account_listing_proof_stale");
            }
            continue;
          }
          if (
            proof.platform !== "MERCADO_LIVRE" ||
            !group.sourceCode ||
            proof.sourceCode !== group.sourceCode ||
            sourceCode(proofProduct) !== proof.sourceCode ||
            attributeText(proofProduct.attributes?.mlb) !==
              proof.externalListingId
          ) {
            reasons.push("legacy_ml_origin_proof_stale");
          }
        }
        const sellerSkus = sortedUnique(
          groupListings
            .filter(
              (listing) =>
                String(listing.marketplaceAccount.platform) ===
                identity.platform,
            )
            .map((listing) => normalizedSku(listing.externalSku))
            .filter(Boolean) as string[],
        );
        return { ...preliminary, sellerSkus };
      },
    );

    if (reasons.length) {
      blocked.push({
        ownerId: group.ownerId,
        name: group.name,
        reasons: sortedUnique(reasons),
      });
      continue;
    }

    const owner = productById.get(group.ownerId)!;
    const donorStocksNotSummed = group.duplicateIds.map((id: string) => ({
      productId: id,
      stock: productById.get(id)!.stock,
    }));
    const donorStockLogs = donorLogs
      .map((row) => ({
        id: row.id,
        productId: row.productId,
        change: row.change,
        reason: row.reason,
        previousStock: row.previousStock,
        newStock: row.newStock,
        createdAt: row.createdAt.toISOString(),
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
    const stockSyncJobsTouched = groupJobs
      .map((row) => ({
        id: row.id,
        productId: row.productId,
        listingId: row.listingId,
        platform: String(row.platform),
        targetStock: row.targetStock,
        attempts: row.attempts,
        nextRunAt: row.nextRunAt.toISOString(),
        status: row.status,
        lastError: row.lastError,
        orderId: row.orderId,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
    finalGroups.push({
      ...group,
      expected: {
        ...group.expected,
        ownerStockUnchanged: owner.stock,
        donorStocksNotSummed,
        reservedTotal: 0,
        donorBlockingHistoryTotal: 0,
        donorStockLogsToReparent: donorStockLogs.length,
        donorStockLogs,
        stockSyncJobsTouched,
        listingIdsToMove: donorListingIds,
      },
    });

    for (const listing of groupListings) {
      const platform = String(listing.marketplaceAccount.platform);
      putIdentity(
        {
          platform,
          identityKey: `listing:${listing.marketplaceAccountId}:${listing.externalListingId}`,
          productId: group.ownerId,
          status: "CONFIRMED",
          sellerSkus: [normalizedSku(listing.externalSku)].filter(Boolean),
          evidence: {
            observations: 1,
            originalProductIds: [listing.productId],
            sources: [
              `listing:${platform}:${listing.marketplaceAccountId}:${listing.externalListingId}:${listing.productId}`,
            ],
          },
        },
        group.ownerId,
      );
    }
    for (const row of galleryRows) putIdentity(row, group.ownerId);
  }

  const finalManifest = {
    ...manifest,
    generatedAt: new Date().toISOString(),
    liveFinalizedAt: new Date().toISOString(),
    sourceSha256: {
      evidenceManifest: crypto
        .createHash("sha256")
        .update(manifestRaw)
        .digest("hex"),
      preliminarySeed: crypto
        .createHash("sha256")
        .update(seedRaw)
        .digest("hex"),
    },
    totals: {
      groups: finalGroups.length,
      donors: finalGroups.reduce(
        (total, group) => total + group.duplicateIds.length,
        0,
      ),
      listingsToMove: finalGroups.reduce(
        (total, group) => total + group.expected.listingIdsToMove.length,
        0,
      ),
    },
    groups: finalGroups,
    liveFinalization: {
      activeBulkJobsObserved: live.activeBulkJobs.length,
      blockedGroups: blocked.length,
      blocked,
    },
  };
  const finalSeed = {
    ...preliminarySeed,
    generatedAt: new Date().toISOString(),
    liveFinalizedAt: new Date().toISOString(),
    identities: [...finalIdentityByKey.values()].sort(
      (left, right) =>
        left.platform.localeCompare(right.platform) ||
        left.identityKey.localeCompare(right.identityKey),
    ),
  };

  const parsedManifest = parseMergeManifest(finalManifest);
  parseIdentitySeed(finalSeed, parsedManifest);
  const serializedManifest = `${JSON.stringify(finalManifest, null, 2)}\n`;
  const serializedSeed = `${JSON.stringify(finalSeed, null, 2)}\n`;
  fs.writeFileSync(outputManifestPath, serializedManifest);
  fs.writeFileSync(outputSeedPath, serializedSeed);
  console.log(
    JSON.stringify({
      tenant: manifest.tenant,
      groups: finalGroups.length,
      donors: finalManifest.totals.donors,
      listingsToMove: finalManifest.totals.listingsToMove,
      blockedGroups: blocked.length,
      identities: finalSeed.identities.length,
      manifestSha256: crypto
        .createHash("sha256")
        .update(serializedManifest)
        .digest("hex"),
      identitySeedSha256: crypto
        .createHash("sha256")
        .update(serializedSeed)
        .digest("hex"),
      outputManifestPath,
      outputSeedPath,
    }),
  );
  await prisma.$disconnect();
}

main().catch(async (error) => {
  await prisma.$disconnect();
  throw error;
});
