-- AlterTable
ALTER TABLE "Product" ADD COLUMN "mlCatalogProductId" TEXT;
ALTER TABLE "Product" ADD COLUMN "mlCatalogSnapshot" JSONB;

-- CreateIndex
CREATE INDEX "Product_mlCatalogProductId_idx" ON "Product"("mlCatalogProductId");
