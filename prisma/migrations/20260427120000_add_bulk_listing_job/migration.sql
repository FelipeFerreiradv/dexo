-- Migration: cria o modelo BulkListingJob para rastrear criacao em massa de
-- anuncios em ML/Shopee. O job vive no servidor e o cliente faz polling
-- por /listings/bulk/:jobId. Resultados sao acumulados em "results" como
-- JSONB de { productId, platform, accountId, success, error, listingId }.

CREATE TYPE "BulkJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED_PARTIAL', 'FAILED');

CREATE TABLE "BulkListingJob" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "BulkJobStatus" NOT NULL DEFAULT 'QUEUED',
    "totalItems" INTEGER NOT NULL,
    "doneItems" INTEGER NOT NULL DEFAULT 0,
    "successItems" INTEGER NOT NULL DEFAULT 0,
    "failedItems" INTEGER NOT NULL DEFAULT 0,
    "productIds" TEXT[],
    "requests" JSONB NOT NULL,
    "overrideTemplate" JSONB,
    "results" JSONB NOT NULL DEFAULT '[]',
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BulkListingJob_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BulkListingJob_userId_createdAt_idx" ON "BulkListingJob"("userId", "createdAt");
CREATE INDEX "BulkListingJob_status_updatedAt_idx" ON "BulkListingJob"("status", "updatedAt");

ALTER TABLE "BulkListingJob"
  ADD CONSTRAINT "BulkListingJob_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
