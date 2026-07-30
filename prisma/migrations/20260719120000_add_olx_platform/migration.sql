-- AlterEnum
-- Postgres ALTER TYPE ... ADD VALUE é NÃO-transacional: mantida isolada do resto.
ALTER TYPE "Platform" ADD VALUE 'OLX';

-- AlterTable
-- list_id real do anúncio na OLX (≠ externalListingId=SKU). Nullable, só OLX popula.
ALTER TABLE "ProductListing" ADD COLUMN "olxListId" TEXT;
