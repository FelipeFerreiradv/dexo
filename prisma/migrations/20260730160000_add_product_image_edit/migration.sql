-- Receita de edição do Editor de Imagem (PR 6 da remoção universal).
-- Idempotente (IF NOT EXISTS): aplicável manualmente em produção ANTES do
-- deploy do código; `migrate deploy` vira no-op lá e cria em ambientes novos.
CREATE TABLE IF NOT EXISTS "ProductImageEdit" (
  "id" TEXT NOT NULL,
  "fileName" TEXT NOT NULL,
  "sourceFileName" TEXT NOT NULL,
  "cutoutFileName" TEXT,
  "recipe" JSONB NOT NULL,
  "userId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProductImageEdit_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ProductImageEdit_fileName_key"
  ON "ProductImageEdit"("fileName");
CREATE INDEX IF NOT EXISTS "ProductImageEdit_userId_createdAt_idx"
  ON "ProductImageEdit"("userId", "createdAt");
