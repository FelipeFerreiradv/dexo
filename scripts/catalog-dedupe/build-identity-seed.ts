import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Platform } from "@prisma/client";
import { catalogGalleryKey } from "../../app/marketplaces/lib/catalog-gallery-identity";
import {
  areTitlesSimilar,
  isOppositeSideOrAxis,
} from "../../app/lib/title-similarity";
import {
  canonicalManifestPhoto,
  parseIdentitySeed,
  parseMergeManifest,
  type GalleryMemberProof,
} from "../merge-catalog-duplicates";

const ROOT = path.resolve(process.argv[2] || process.cwd());
const TENANTS = ["tijuco", "mk2"] as const;
const normalizedSku = (value: unknown) => {
  const result = typeof value === "string" ? value.trim().toLowerCase() : "";
  return result || null;
};
const attributeText = (value: any) =>
  value && typeof value === "object"
    ? String(value.value_name ?? "").trim()
    : String(value ?? "").trim();
const sourceCode = (product: any) =>
  attributeText(
    product?.attributes?.codPeca || product?.attributes?.legacyPecaCode,
  );
const sha256 = (value: string | Buffer) =>
  crypto.createHash("sha256").update(value).digest("hex");

type ProofDescriptor =
  | { type: "PRODUCT_GALLERY" }
  | {
      type: "ACCOUNT_LISTING";
      marketplaceAccountId: string;
      externalListingId: string;
    }
  | {
      type: "LEGACY_ML_ORIGIN";
      externalListingId: string;
      sourceCode: string;
    };

const galleryImageIds = (platform: Platform, urls: string[]) =>
  [
    ...new Set(
      urls.flatMap((url) => {
        const photo = canonicalManifestPhoto(url);
        if (platform === Platform.MERCADO_LIVRE && photo?.startsWith("ml:")) {
          return [photo.slice(3).toLowerCase()];
        }
        if (
          platform === Platform.SHOPEE &&
          photo?.startsWith("shopee:/file/")
        ) {
          return [
            photo
              .slice("shopee:/file/".length)
              .replace(/_tn$/i, "")
              .toLowerCase(),
          ];
        }
        return [];
      }),
    ),
  ].sort();

type Observation = {
  originalProductId: string;
  canonicalProductId: string;
  sellerSku: string | null;
  sourceCode: string | null;
  source: string;
  memberProof: GalleryMemberProof;
};
type Seed = {
  platform: string;
  identityKey: string;
  productId: string | null;
  status: "OBSERVED" | "CONFIRMED" | "AMBIGUOUS";
  sellerSkus: string[];
  evidence: {
    observations: number;
    originalProductIds: string[];
    sources: string[];
  };
};

for (const tenant of TENANTS) {
  const snapshotPath = path.join(ROOT, `${tenant}-snapshot.json`);
  const manifestPath = path.join(ROOT, `${tenant}-merge-ready-manifest.json`);
  const mlCachePath = path.join(ROOT, `${tenant}-ml-cache.json`);
  const snapshotRaw = fs.readFileSync(snapshotPath);
  const manifestRaw = fs.readFileSync(manifestPath);
  const mlRaw = fs.readFileSync(mlCachePath);
  const snapshot = JSON.parse(snapshotRaw.toString("utf8"));
  const manifest = JSON.parse(manifestRaw.toString("utf8"));
  const mlCache: any[] = JSON.parse(mlRaw.toString("utf8"));
  const shopeePath = path.join(ROOT, `${tenant}-shopee-cache.json`);
  const shopeeCache: Record<string, any> = fs.existsSync(shopeePath)
    ? JSON.parse(fs.readFileSync(shopeePath, "utf8"))
    : {};
  const mlById = new Map(mlCache.map((row) => [String(row.id), row]));
  const productById = new Map(
    snapshot.products.map((row: any) => [row.id, row]),
  );
  const accountById = new Map(
    snapshot.accounts.map((row: any) => [row.id, row]),
  );
  const ownerByProduct = new Map<string, string>();
  const membersByOwner = new Map<string, Set<string>>();
  const groupByOwner = new Map<string, any>();
  for (const group of manifest.groups) {
    const members = new Set<string>([group.ownerId, ...group.duplicateIds]);
    membersByOwner.set(group.ownerId, members);
    groupByOwner.set(group.ownerId, group);
    for (const id of members) ownerByProduct.set(id, group.ownerId);
  }

  const observations = new Map<string, Observation[]>();
  const addGallery = (input: {
    product: any;
    platform: Platform;
    title: string;
    urls: string[];
    sellerSku?: unknown;
    source: string;
    proof: ProofDescriptor;
  }) => {
    if (
      !input.title ||
      isOppositeSideOrAxis(input.title, input.product.name) ||
      !areTitlesSimilar(input.title, input.product.name, 0.9)
    )
      return;
    const identityKey = catalogGalleryKey({
      platform: input.platform,
      account: { id: "seed", userId: snapshot.tenantId },
      externalListingId: "seed",
      rawSku: normalizedSku(input.sellerSku),
      title: input.title,
      imageUrls: input.urls,
    });
    if (!identityKey) return;
    const imageIds = galleryImageIds(input.platform, input.urls);
    if (
      imageIds.length < 2 ||
      `gallery:v1:${sha256(JSON.stringify(imageIds))}` !== identityKey
    )
      return;
    const commonProof = {
      productId: input.product.id,
      platform: String(input.platform),
      imageIds,
    };
    const memberProof =
      input.proof.type === "PRODUCT_GALLERY"
        ? { ...commonProof, type: input.proof.type }
        : input.proof.type === "ACCOUNT_LISTING"
          ? { ...commonProof, ...input.proof }
          : {
              ...commonProof,
              ...input.proof,
              platform: Platform.MERCADO_LIVRE,
            };
    const mapKey = `${input.platform}|${identityKey}`;
    if (!observations.has(mapKey)) observations.set(mapKey, []);
    observations.get(mapKey)!.push({
      originalProductId: input.product.id,
      canonicalProductId:
        ownerByProduct.get(input.product.id) ?? input.product.id,
      sellerSku: normalizedSku(input.sellerSku),
      sourceCode: sourceCode(input.product) || null,
      source: input.source,
      memberProof: memberProof as GalleryMemberProof,
    });
  };

  const aliases = new Map<string, Seed>();
  for (const product of snapshot.products as any[]) {
    const isReadyMember = ownerByProduct.has(product.id);
    for (const listing of product.listings ?? []) {
      const account: any = accountById.get(listing.marketplaceAccountId);
      if (!account) continue;
      const platform = account.platform as Platform;
      const ml =
        platform === Platform.MERCADO_LIVRE
          ? mlById.get(String(listing.externalListingId))
          : null;
      const shopee =
        platform === Platform.SHOPEE
          ? shopeeCache[String(listing.externalListingId)]
          : null;
      const sellerSku =
        listing.externalSku || ml?.sellerSku || shopee?.item_sku;
      if (isReadyMember) {
        const identityKey = `listing:${listing.marketplaceAccountId}:${listing.externalListingId}`;
        const mapKey = `${platform}|${identityKey}`;
        const productId = ownerByProduct.get(product.id)!;
        const prior = aliases.get(mapKey);
        const skus = [normalizedSku(sellerSku)].filter(Boolean) as string[];
        if (prior && prior.productId !== productId) {
          prior.productId = null;
          prior.status = "AMBIGUOUS";
          prior.sellerSkus = [
            ...new Set([...prior.sellerSkus, ...skus]),
          ].sort();
        } else if (!prior) {
          aliases.set(mapKey, {
            platform,
            identityKey,
            productId,
            status: "CONFIRMED",
            sellerSkus: skus,
            evidence: {
              observations: 1,
              originalProductIds: [product.id],
              sources: ["listing"],
            },
          });
        }
      }
      if (ml?.fotos?.length) {
        addGallery({
          product,
          platform: Platform.MERCADO_LIVRE,
          title: ml.titulo,
          urls: ml.fotos.map(
            (id: string) => `https://http2.mlstatic.com/D_${id}-O.jpg`,
          ),
          sellerSku,
          source: `listing:${platform}:${listing.marketplaceAccountId}:${listing.externalListingId}:${product.id}`,
          proof: {
            type: "ACCOUNT_LISTING",
            marketplaceAccountId: listing.marketplaceAccountId,
            externalListingId: String(listing.externalListingId),
          },
        });
      } else if (platform === Platform.MERCADO_LIVRE) {
        addGallery({
          product,
          platform,
          title: product.name,
          urls: [product.imageUrl, ...(product.imageUrls ?? [])].filter(
            Boolean,
          ),
          sellerSku,
          source: "product-images",
          proof: { type: "PRODUCT_GALLERY" },
        });
      }
      if (platform === Platform.SHOPEE) {
        addGallery({
          product,
          platform,
          title: shopee?.item_name || product.name,
          urls: [product.imageUrl, ...(product.imageUrls ?? [])].filter(
            Boolean,
          ),
          sellerSku,
          source: "product-images:shopee",
          proof: { type: "PRODUCT_GALLERY" },
        });
      }
    }
    const productImages = [
      product.imageUrl,
      ...(product.imageUrls ?? []),
    ].filter(
      (value: unknown): value is string =>
        typeof value === "string" && value.length > 0,
    );
    const mlImages = productImages.filter((url: string) => {
      try {
        return /(^|\.)mlstatic\.com$/i.test(new URL(url).hostname);
      } catch {
        return false;
      }
    });
    const shopeeImages = productImages.filter((url: string) => {
      try {
        const host = new URL(url).hostname;
        return (
          /(^|\.)shopee\.(?:com\.br|com|sg)$/i.test(host) ||
          /(^|\.)img\.susercontent\.com$/i.test(host)
        );
      } catch {
        return false;
      }
    });
    addGallery({
      product,
      platform: Platform.MERCADO_LIVRE,
      title: product.name,
      urls: mlImages,
      source: "product-images:ml",
      proof: { type: "PRODUCT_GALLERY" },
    });
    addGallery({
      product,
      platform: Platform.SHOPEE,
      title: product.name,
      urls: shopeeImages,
      source: "product-images:shopee",
      proof: { type: "PRODUCT_GALLERY" },
    });
    const originalMlb = attributeText(product.attributes?.mlb);
    const cached = originalMlb ? mlById.get(originalMlb) : null;
    const originalSourceCode = sourceCode(product);
    if (cached?.fotos?.length && originalSourceCode) {
      addGallery({
        product,
        platform: Platform.MERCADO_LIVRE,
        title: cached.titulo,
        urls: cached.fotos.map(
          (id: string) => `https://http2.mlstatic.com/D_${id}-O.jpg`,
        ),
        sellerSku: cached.sellerSku,
        source: `origin:${originalMlb}`,
        proof: {
          type: "LEGACY_ML_ORIGIN",
          externalListingId: originalMlb,
          sourceCode: originalSourceCode,
        },
      });
    }
  }

  for (const [mapKey, rows] of observations) {
    const [platform, identityKey] = mapKey.split("|", 2);
    const canonicalIds = [
      ...new Set(rows.map((row) => row.canonicalProductId)),
    ];
    const originalIds = [...new Set(rows.map((row) => row.originalProductId))];
    const sellerSkus = [
      ...new Set(rows.map((row) => row.sellerSku).filter(Boolean)),
    ].sort() as string[];
    const sources = [...new Set(rows.map((row) => row.source))].sort();
    const touchesReady = rows.some((row) =>
      ownerByProduct.has(row.originalProductId),
    );
    if (!touchesReady && canonicalIds.length === 1) continue;
    let status: Seed["status"] = "AMBIGUOUS";
    let productId: string | null = null;
    if (canonicalIds.length === 1) {
      productId = canonicalIds[0];
      status = "OBSERVED";
      const group = groupByOwner.get(productId);
      const groupMembers = membersByOwner.get(productId);
      const observedReadyMembers = groupMembers
        ? new Set(originalIds.filter((id) => groupMembers.has(id)))
        : new Set<string>();
      const sourceBacked = Boolean(group?.sourceCode);
      const aliasBacked =
        !sourceBacked &&
        group?.externalSkus?.length === 1 &&
        sellerSkus.length === 1 &&
        sellerSkus[0] === normalizedSku(group.externalSkus[0]);
      if (
        group &&
        observedReadyMembers.size >= 2 &&
        (sourceBacked || aliasBacked)
      ) {
        status = "CONFIRMED";
      }
    }
    aliases.set(mapKey, {
      platform,
      identityKey,
      productId,
      status,
      sellerSkus,
      evidence: {
        observations: rows.length,
        originalProductIds: originalIds.sort(),
        sources,
      },
    });
  }

  const allIdentities = [...aliases.values()].sort(
    (a, b) =>
      a.platform.localeCompare(b.platform) ||
      a.identityKey.localeCompare(b.identityKey),
  );
  const identitiesByKey = new Map(
    allIdentities.map((row) => [
      `${row.platform}\u0000${row.identityKey}`,
      row,
    ]),
  );
  const evidenceGroups = manifest.groups.flatMap((group: any) => {
    const canonicalPhotos = (group.evidence?.photoIds ?? []).map(
      canonicalManifestPhoto,
    );
    if (
      canonicalPhotos.length < 2 ||
      canonicalPhotos.some((photo: string | null) => photo === null)
    ) {
      return [];
    }
    const photoIds = [...new Set(canonicalPhotos as string[])].sort();
    const galleryIdentities = [
      {
        platform: Platform.MERCADO_LIVRE,
        imageIds: photoIds
          .filter((photo) => photo.startsWith("ml:"))
          .map((photo) => photo.slice(3)),
      },
      {
        platform: Platform.SHOPEE,
        imageIds: photoIds
          .filter((photo) => photo.startsWith("shopee:/file/"))
          .map((photo) =>
            photo.slice("shopee:/file/".length).replace(/_tn$/i, ""),
          ),
      },
    ].flatMap(({ platform, imageIds }) => {
      const normalizedIds = [
        ...new Set(imageIds.map((id) => id.toLowerCase())),
      ].sort();
      if (normalizedIds.length < 2) return [];
      const identityKey = `gallery:v1:${sha256(JSON.stringify(normalizedIds))}`;
      const seed = identitiesByKey.get(`${platform}\u0000${identityKey}`);
      if (seed?.status !== "CONFIRMED" || seed.productId !== group.ownerId)
        return [];
      const members = [group.ownerId, ...group.duplicateIds] as string[];
      const proofRank: Record<GalleryMemberProof["type"], number> = {
        PRODUCT_GALLERY: 0,
        ACCOUNT_LISTING: 1,
        LEGACY_ML_ORIGIN: 2,
      };
      const memberProofs = members.flatMap((productId) => {
        const candidates = (
          observations.get(`${platform}|${identityKey}`) ?? []
        )
          .filter(
            (row) =>
              row.originalProductId === productId &&
              row.canonicalProductId === group.ownerId &&
              JSON.stringify(row.memberProof.imageIds) ===
                JSON.stringify(normalizedIds),
          )
          .map((row) => row.memberProof)
          .sort(
            (left, right) =>
              proofRank[left.type] - proofRank[right.type] ||
              JSON.stringify(left).localeCompare(JSON.stringify(right)),
          );
        return candidates.length ? [candidates[0]] : [];
      });
      const covered = new Set(memberProofs.map((proof) => proof.productId));
      const legacyIsIndependentlyConfirmed = memberProofs.every(
        (proof) =>
          proof.type !== "LEGACY_ML_ORIGIN" ||
          memberProofs.some(
            (candidate) =>
              candidate.type !== "LEGACY_ML_ORIGIN" &&
              candidate.productId !== proof.productId,
          ),
      );
      return covered.size === members.length && legacyIsIndependentlyConfirmed
        ? [{ platform, identityKey, imageIds: normalizedIds, memberProofs }]
        : [];
    });
    if (!galleryIdentities.length) return [];
    return [
      {
        ...group,
        expected: {
          ...group.expected,
          donorStockLogsToReparent: 0,
          donorStockLogs: [],
          stockSyncJobsTouched: [],
        },
        evidence: {
          ...group.evidence,
          photoIds,
          galleryIdentities,
        },
      },
    ];
  });
  const finalOwners = new Set<string>(
    evidenceGroups.map((group: any) => group.ownerId),
  );
  const reviewedGalleries = new Map<string, string>(
    evidenceGroups.flatMap((group: any) =>
      group.evidence.galleryIdentities.map((identity: any) => [
        `${identity.platform}\u0000${identity.identityKey}`,
        group.ownerId,
      ]),
    ),
  );
  const identities = allIdentities.filter((row) => {
    if (row.status === "AMBIGUOUS") return true;
    if (!row.productId || !finalOwners.has(row.productId)) return false;
    if (!row.identityKey.startsWith("gallery:")) return true;
    if (row.status !== "CONFIRMED") return true;
    return (
      reviewedGalleries.get(`${row.platform}\u0000${row.identityKey}`) ===
      row.productId
    );
  });
  const evidenceManifest = {
    ...manifest,
    generatedAt: new Date().toISOString(),
    preliminaryIdentityEvidence: true,
    totals: {
      groups: evidenceGroups.length,
      donors: evidenceGroups.reduce(
        (total: number, group: any) => total + group.duplicateIds.length,
        0,
      ),
      listingsToMove: evidenceGroups.reduce(
        (total: number, group: any) =>
          total + group.expected.listingIdsToMove.length,
        0,
      ),
    },
    groups: evidenceGroups,
  };
  const output = {
    version: 1,
    tenant,
    tenantId: snapshot.tenantId,
    generatedAt: new Date().toISOString(),
    inputSha256: {
      snapshot: sha256(snapshotRaw),
      manifest: sha256(manifestRaw),
      marketplaceCache: sha256(mlRaw),
    },
    policy: {
      listing: "account-scoped current listing aliases are confirmed",
      gallery:
        "confirmed only when at least two reviewed merge members expose the same complete gallery; collisions become ambiguous",
      noSku:
        "runtime never selects a canonical product from gallery alone when seller SKU is absent",
    },
    totals: {
      identities: identities.length,
      confirmed: identities.filter((row) => row.status === "CONFIRMED").length,
      observed: identities.filter((row) => row.status === "OBSERVED").length,
      ambiguous: identities.filter((row) => row.status === "AMBIGUOUS").length,
      listingAliases: identities.filter((row) =>
        row.identityKey.startsWith("listing:"),
      ).length,
      galleryAliases: identities.filter((row) =>
        row.identityKey.startsWith("gallery:"),
      ).length,
    },
    identities,
  };
  const parsedEvidenceManifest = parseMergeManifest(evidenceManifest);
  parseIdentitySeed(output, parsedEvidenceManifest);
  const serialized = JSON.stringify(output, null, 2) + "\n";
  const outputPath = path.join(ROOT, `${tenant}-identity-seed-manifest.json`);
  fs.writeFileSync(outputPath, serialized);
  const evidenceManifestPath = path.join(
    ROOT,
    `${tenant}-merge-evidence-manifest.json`,
  );
  fs.writeFileSync(
    evidenceManifestPath,
    `${JSON.stringify(evidenceManifest, null, 2)}\n`,
  );
  console.log(
    JSON.stringify({
      tenant,
      outputPath,
      evidenceManifestPath,
      sha256: sha256(serialized),
      totals: output.totals,
      evidenceGroups: evidenceGroups.length,
    }),
  );
}
