-- AlterTable
ALTER TABLE "ProductListing" ADD COLUMN     "freeShipping" BOOLEAN,
ADD COLUMN     "hasWarranty" BOOLEAN,
ADD COLUMN     "itemCondition" TEXT,
ADD COLUMN     "listingType" TEXT,
ADD COLUMN     "localPickup" BOOLEAN,
ADD COLUMN     "manufacturingTime" INTEGER,
ADD COLUMN     "shippingMode" TEXT,
ADD COLUMN     "warrantyDuration" INTEGER,
ADD COLUMN     "warrantyUnit" TEXT;
