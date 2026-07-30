-- Job durável do recorte assíncrono (PR 4 da remoção universal).
-- Idempotente (IF NOT EXISTS): aplicável manualmente em produção ANTES do
-- deploy do código; `migrate deploy` vira no-op lá e cria em ambientes novos.
CREATE TABLE IF NOT EXISTS "ImageBgJob" (
  "id" TEXT NOT NULL,
  "uploadUuid" TEXT NOT NULL,
  "origFileName" TEXT NOT NULL,
  "webpFileName" TEXT NOT NULL,
  "addShadow" BOOLEAN NOT NULL DEFAULT false,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseExpiresAt" TIMESTAMP(3),
  "resultFileName" TEXT,
  "swapSweepsLeft" INTEGER NOT NULL DEFAULT 2,
  "nextSweepAt" TIMESTAMP(3),
  "lastError" TEXT,
  "userId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ImageBgJob_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ImageBgJob_uploadUuid_key"
  ON "ImageBgJob"("uploadUuid");
CREATE INDEX IF NOT EXISTS "ImageBgJob_status_nextRunAt_idx"
  ON "ImageBgJob"("status", "nextRunAt");
CREATE INDEX IF NOT EXISTS "ImageBgJob_userId_createdAt_idx"
  ON "ImageBgJob"("userId", "createdAt");
