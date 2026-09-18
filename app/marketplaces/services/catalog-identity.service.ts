import type { Prisma } from "@prisma/client";
import prisma from "@/app/lib/prisma";
import {
  areTitlesSimilar,
  isOppositeSideOrAxis,
} from "@/app/lib/title-similarity";
import {
  catalogGalleryKey,
  normalizedIdentitySku,
  type CatalogIdentityItem,
} from "../lib/catalog-gallery-identity";

type CanonicalProduct = { id: string; name: string };
type IdentityResult = { productId: string | null; action: string };

/** A confirmed alias survives new listing IDs and is scoped to one tenant. */
export class CatalogIdentityService {
  static async serialized<T extends IdentityResult>(
    item: CatalogIdentityItem,
    run: (
      tx: Prisma.TransactionClient,
      canonical: CanonicalProduct | null,
      blockSkuMatch: boolean,
    ) => Promise<T>,
  ): Promise<T> {
    const galleryKey = catalogGalleryKey(item);
    const listingKey = `listing:${item.account.id}:${item.externalListingId}`;
    const sellerSku = normalizedIdentitySku(item.rawSku);
    return prisma.$transaction(
      async (tx) => {
        // Do not trust the caller-provided account shape. ProductListing has
        // independent FKs, so an incoherent account/tenant pair could otherwise
        // create an identity in one tenant and a listing in another account.
        const accountRows = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id
            FROM "MarketplaceAccount"
           WHERE id = ${item.account.id}
             AND "userId" = ${item.account.userId}
             AND platform = ${item.platform}::"Platform"
           FOR SHARE
        `;
        if (accountRows.length !== 1) {
          throw new Error("Conta de marketplace fora do tenant da identidade");
        }
        // Serialize across API, poll and batch import before creating Product.
        // The insert, listing and learned identity commit or roll back together.
        const lockKey = `${item.account.userId}:${item.platform}:${galleryKey ?? listingKey}`;
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;

        const rows = await tx.$queryRaw<
          Array<{
            id: string | null;
            name: string | null;
            identityKey: string;
            sellerSkus: string[];
            status: string;
            productUserId: string | null;
          }>
        >`
        SELECT p.id, p.name, p."userId" AS "productUserId",
               i."identityKey", i."sellerSkus", i.status
          FROM "ProductIngestionIdentity" i
          LEFT JOIN "Product" p ON p.id = i."productId"
         WHERE i."userId" = ${item.account.userId}
           AND i.platform = ${item.platform}
           AND (
             i."identityKey" = ${listingKey}
             OR (${galleryKey}::text IS NOT NULL AND i."identityKey" = ${galleryKey})
           )
      `;
        const candidates = rows.filter((row) => {
          if (row.status !== "CONFIRMED" || !row.id || !row.name) return false;
          if (row.productUserId !== item.account.userId) return false;
          if (
            isOppositeSideOrAxis(item.title, row.name) ||
            !areTitlesSimilar(item.title, row.name, 0.9)
          )
            return false;
          // A listing alias is exact and does not depend on gallery quality.
          // A reviewed gallery with explicit seller codes accepts only those
          // codes. A reviewed SKU-less gallery may identify SKU-less imports.
          return (
            row.identityKey === listingKey ||
            Boolean(
              row.identityKey === galleryKey &&
              (sellerSku
                ? row.sellerSkus.includes(sellerSku)
                : row.sellerSkus.length === 0),
            )
          );
        });
        const ids = new Set(candidates.map((row) => row.id as string));
        const canonical =
          ids.size === 1
            ? {
                id: candidates[0].id as string,
                name: candidates[0].name as string,
              }
            : null;
        const exactIdentityAmbiguous = rows.some(
          (row) =>
            row.status === "AMBIGUOUS" &&
            (row.identityKey === listingKey || row.identityKey === galleryKey),
        );
        const incompatibleConfirmedListing = rows.some(
          (row) =>
            row.identityKey === listingKey &&
            row.status === "CONFIRMED" &&
            (!row.id ||
              !row.name ||
              row.productUserId !== item.account.userId ||
              isOppositeSideOrAxis(item.title, row.name) ||
              !areTitlesSimilar(item.title, row.name, 0.9)),
        );
        const identityConflict = ids.size > 1;
        const result = await run(
          tx,
          canonical,
          !canonical &&
            (exactIdentityAmbiguous ||
              identityConflict ||
              incompatibleConfirmedListing),
        );

        if (result.productId && result.action !== "ignored_by_list") {
          // Keep the product in this tenant until every listing/identity write in
          // the callback transaction commits. ProductListing has independent FKs,
          // so checking without a row lock would leave an ownership-change race.
          const productRows = await tx.$queryRaw<
            Array<{ id: string; name: string }>
          >`
            SELECT id, name
              FROM "Product"
             WHERE id = ${result.productId}
               AND "userId" = ${item.account.userId}
             FOR SHARE
          `;
          if (productRows.length !== 1) {
            throw new Error("Produto fora do tenant da identidade");
          }
          const [product] = productRows;
          if (
            !isOppositeSideOrAxis(item.title, product.name) &&
            areTitlesSimilar(item.title, product.name, 0.9)
          ) {
            const skus = sellerSku ? [sellerSku] : [];
            // The exact account/listing identity is safe to learn automatically.
            await tx.$executeRaw`
            INSERT INTO "ProductIngestionIdentity"
              ("userId", platform, "identityKey", "productId", status, "sellerSkus", "updatedAt")
            VALUES (${item.account.userId}, ${item.platform}, ${listingKey}, ${product.id}, 'CONFIRMED', ${skus}::text[], NOW())
            ON CONFLICT ("userId", platform, "identityKey") DO UPDATE SET
              "productId" = CASE
                WHEN "ProductIngestionIdentity".status = 'AMBIGUOUS' THEN NULL
                WHEN "ProductIngestionIdentity"."productId" = EXCLUDED."productId" THEN EXCLUDED."productId"
                ELSE NULL END,
              status = CASE
                WHEN "ProductIngestionIdentity".status = 'AMBIGUOUS' THEN 'AMBIGUOUS'
                WHEN "ProductIngestionIdentity"."productId" = EXCLUDED."productId" THEN 'CONFIRMED'
                ELSE 'AMBIGUOUS' END,
              "sellerSkus" = CASE
                WHEN "ProductIngestionIdentity".status = 'CONFIRMED'
                  THEN "ProductIngestionIdentity"."sellerSkus"
                WHEN "ProductIngestionIdentity".status = 'OBSERVED'
                     AND "ProductIngestionIdentity"."productId" = EXCLUDED."productId"
                  THEN ARRAY(SELECT DISTINCT unnest("ProductIngestionIdentity"."sellerSkus" || EXCLUDED."sellerSkus"))
                ELSE "ProductIngestionIdentity"."sellerSkus" END,
              "updatedAt" = NOW()
          `;

            if (galleryKey) {
              // An unseen gallery is only OBSERVED. Promotion to CONFIRMED is an
              // explicit, reviewed seed operation; runtime may only preserve an
              // already-confirmed mapping for the same product and seller code.
              const galleryWasConfirmed = candidates.some(
                (row) =>
                  row.identityKey === galleryKey && row.id === product.id,
              );
              const galleryStatus = galleryWasConfirmed
                ? "CONFIRMED"
                : "OBSERVED";
              await tx.$executeRaw`
            INSERT INTO "ProductIngestionIdentity"
              ("userId", platform, "identityKey", "productId", status, "sellerSkus", "updatedAt")
            VALUES (${item.account.userId}, ${item.platform}, ${galleryKey}, ${product.id}, ${galleryStatus}, ${skus}::text[], NOW())
            ON CONFLICT ("userId", platform, "identityKey") DO UPDATE SET
              "productId" = CASE
                WHEN "ProductIngestionIdentity".status = 'AMBIGUOUS' THEN NULL
                WHEN "ProductIngestionIdentity"."productId" = EXCLUDED."productId" THEN EXCLUDED."productId"
                ELSE NULL END,
              status = CASE
                WHEN "ProductIngestionIdentity".status = 'AMBIGUOUS' THEN 'AMBIGUOUS'
                WHEN "ProductIngestionIdentity"."productId" <> EXCLUDED."productId" THEN 'AMBIGUOUS'
                WHEN "ProductIngestionIdentity".status = 'CONFIRMED' THEN 'CONFIRMED'
                WHEN EXCLUDED.status = 'CONFIRMED' THEN 'CONFIRMED'
                ELSE 'OBSERVED' END,
              "sellerSkus" = CASE
                WHEN "ProductIngestionIdentity".status = 'CONFIRMED'
                  THEN "ProductIngestionIdentity"."sellerSkus"
                WHEN "ProductIngestionIdentity".status = 'OBSERVED'
                     AND "ProductIngestionIdentity"."productId" = EXCLUDED."productId"
                  THEN ARRAY(SELECT DISTINCT unnest("ProductIngestionIdentity"."sellerSkus" || EXCLUDED."sellerSkus"))
                ELSE "ProductIngestionIdentity"."sellerSkus" END,
              "updatedAt" = NOW()
          `;
            }
          }
        }
        return result;
      },
      { maxWait: 10000, timeout: 30000 },
    );
  }
}
