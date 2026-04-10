import "dotenv/config";
import { PrismaClient, Platform } from "@prisma/client";
import { normalizeSku } from "../app/lib/sku";

const prisma = new PrismaClient();

const PRODUCT_BATCH_SIZE = 500;
const LISTING_BATCH_SIZE = 500;
const APPLY = process.argv.includes("--apply");

type ProductRow = {
  id: string;
  userId: string | null;
  sku: string;
  skuNormalized: string | null;
};

type DuplicateGroup = {
  userId: string | null;
  skuNormalized: string;
  products: ProductRow[];
};

type RelinkCandidate = {
  listingId: string;
  externalListingId: string;
  externalSku: string;
  platform: Platform;
  userId: string;
  currentProductId: string;
  currentProductSku: string;
  suggestedProductId: string;
  suggestedProductSku: string;
};

function makeUserSkuKey(userId: string | null, sku: string) {
  return `${userId ?? "null"}::${sku}`;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function loadProducts(): Promise<ProductRow[]> {
  const products: ProductRow[] = [];
  let cursor: string | undefined;

  while (true) {
    const batch = await prisma.product.findMany({
      take: PRODUCT_BATCH_SIZE,
      skip: cursor ? 1 : 0,
      ...(cursor ? { cursor: { id: cursor } } : {}),
      orderBy: { id: "asc" },
      select: {
        id: true,
        userId: true,
        sku: true,
        skuNormalized: true,
      },
    });

    if (batch.length === 0) {
      break;
    }

    products.push(...batch);
    cursor = batch[batch.length - 1]?.id;
  }

  return products;
}

async function loadRelinkCandidates(
  productIndex: Map<string, ProductRow[]>,
): Promise<{
  relinkCandidates: RelinkCandidate[];
  ambiguousListings: RelinkCandidate[];
}> {
  const relinkCandidates: RelinkCandidate[] = [];
  const ambiguousListings: RelinkCandidate[] = [];
  let cursor: string | undefined;

  while (true) {
    const batch = await prisma.productListing.findMany({
      take: LISTING_BATCH_SIZE,
      skip: cursor ? 1 : 0,
      ...(cursor ? { cursor: { id: cursor } } : {}),
      orderBy: { id: "asc" },
      select: {
        id: true,
        productId: true,
        externalListingId: true,
        externalSku: true,
        product: {
          select: {
            id: true,
            sku: true,
          },
        },
        marketplaceAccount: {
          select: {
            userId: true,
            platform: true,
          },
        },
      },
    });

    if (batch.length === 0) {
      break;
    }

    for (const listing of batch) {
      const userId = listing.marketplaceAccount.userId;
      const normalizedExternalSku = normalizeSku(listing.externalSku);

      if (!userId || !normalizedExternalSku) {
        continue;
      }

      const matches =
        productIndex.get(makeUserSkuKey(userId, normalizedExternalSku)) ?? [];

      if (matches.length === 0) {
        continue;
      }

      const baseCandidate = {
        listingId: listing.id,
        externalListingId: listing.externalListingId,
        externalSku: listing.externalSku ?? "",
        platform: listing.marketplaceAccount.platform,
        userId,
        currentProductId: listing.productId,
        currentProductSku: listing.product.sku,
        suggestedProductId: matches[0].id,
        suggestedProductSku: matches[0].sku,
      };

      if (matches.length > 1) {
        ambiguousListings.push(baseCandidate);
        continue;
      }

      const match = matches[0];
      if (match.id === listing.productId) {
        continue;
      }

      relinkCandidates.push({
        ...baseCandidate,
        suggestedProductId: match.id,
        suggestedProductSku: match.sku,
      });
    }

    cursor = batch[batch.length - 1]?.id;
  }

  return { relinkCandidates, ambiguousListings };
}

function printPreview<T>(label: string, items: T[], limit = 10) {
  console.log(`${label}: ${items.length}`);

  if (items.length === 0) {
    return;
  }

  console.log(
    JSON.stringify(items.slice(0, limit), null, 2),
  );

  if (items.length > limit) {
    console.log(`... ${items.length - limit} more`);
  }
}

async function applySkuBackfill(productsToUpdate: ProductRow[]) {
  for (const batch of chunk(productsToUpdate, PRODUCT_BATCH_SIZE)) {
    await prisma.$transaction(
      batch.map((product) =>
        prisma.product.update({
          where: { id: product.id },
          data: { skuNormalized: normalizeSku(product.sku) },
        }),
      ),
    );
  }
}

async function applyRelinks(relinkCandidates: RelinkCandidate[]) {
  for (const batch of chunk(relinkCandidates, LISTING_BATCH_SIZE)) {
    await prisma.$transaction(
      batch.map((candidate) =>
        prisma.productListing.update({
          where: { id: candidate.listingId },
          data: { productId: candidate.suggestedProductId },
        }),
      ),
    );
  }
}

async function main() {
  console.log(
    `[normalize-product-skus] Starting in ${APPLY ? "apply" : "dry-run"} mode`,
  );

  const products = await loadProducts();
  const productIndex = new Map<string, ProductRow[]>();

  for (const product of products) {
    const normalizedSku = normalizeSku(product.sku);
    if (!normalizedSku) {
      continue;
    }

    const key = makeUserSkuKey(product.userId, normalizedSku);
    const current = productIndex.get(key) ?? [];
    current.push(product);
    productIndex.set(key, current);
  }

  const productsNeedingBackfill = products.filter(
    (product) => product.skuNormalized !== normalizeSku(product.sku),
  );

  const duplicateGroups: DuplicateGroup[] = Array.from(productIndex.entries())
    .map(([, groupedProducts]) => {
      const normalizedSku = normalizeSku(groupedProducts[0]?.sku);
      if (!normalizedSku) {
        return null;
      }

      const distinctSkus = new Set(groupedProducts.map((product) => product.sku));
      if (groupedProducts.length < 2 || distinctSkus.size < 2) {
        return null;
      }

      return {
        userId: groupedProducts[0]?.userId ?? null,
        skuNormalized: normalizedSku,
        products: groupedProducts,
      };
    })
    .filter((group): group is DuplicateGroup => Boolean(group));

  const { relinkCandidates, ambiguousListings } =
    await loadRelinkCandidates(productIndex);

  console.log(
    `[normalize-product-skus] Products loaded: ${products.length}; backfill needed: ${productsNeedingBackfill.length}`,
  );
  printPreview(
    "[normalize-product-skus] Duplicate products by userId + skuNormalized",
    duplicateGroups,
  );
  printPreview(
    "[normalize-product-skus] ProductListing relink candidates",
    relinkCandidates,
  );
  printPreview(
    "[normalize-product-skus] Ambiguous relink candidates skipped",
    ambiguousListings,
  );

  if (!APPLY) {
    console.log(
      "[normalize-product-skus] Dry-run complete. Re-run with --apply to persist skuNormalized updates and safe relinks.",
    );
    return;
  }

  await applySkuBackfill(productsNeedingBackfill);
  await applyRelinks(relinkCandidates);

  console.log(
    `[normalize-product-skus] Applied ${productsNeedingBackfill.length} skuNormalized updates and ${relinkCandidates.length} ProductListing relinks.`,
  );

  if (duplicateGroups.length > 0 || ambiguousListings.length > 0) {
    console.log(
      "[normalize-product-skus] Manual review still required for duplicate or ambiguous SKU collisions listed above.",
    );
  }
}

main()
  .catch((error) => {
    console.error("[normalize-product-skus] Failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
