-- Biblioteca de imagens reutilizáveis do Editor (PR 7 — veículos p/ anúncio).
-- Idempotente (IF NOT EXISTS): aplicável manualmente em produção ANTES do
-- deploy do código; `migrate deploy` vira no-op lá e cria em ambientes novos.
CREATE TABLE IF NOT EXISTS "EditorAsset" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "fileName" TEXT NOT NULL,
  "label" TEXT,
  "kind" TEXT NOT NULL DEFAULT 'vehicle',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EditorAsset_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "EditorAsset_userId_kind_createdAt_idx"
  ON "EditorAsset"("userId", "kind", "createdAt");
