-- AlterEnum
-- Postgres ALTER TYPE ... ADD VALUE é NÃO-transacional: mantida isolada do resto.
ALTER TYPE "Platform" ADD VALUE 'FACEBOOK';

-- AlterTable
-- id numérico do item no catálogo Meta (≠ externalListingId=SKU/retailer_id).
-- Nullable, só FACEBOOK popula.
ALTER TABLE "ProductListing" ADD COLUMN "fbCatalogItemId" TEXT;
