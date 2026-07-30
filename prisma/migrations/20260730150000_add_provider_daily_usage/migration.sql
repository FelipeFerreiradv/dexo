-- Teto financeiro diário dos provedores externos de recorte (PR 5 da remoção
-- universal). Idempotente (IF NOT EXISTS): aplicável manualmente em produção
-- ANTES do deploy do código; `migrate deploy` vira no-op lá e cria em
-- ambientes novos.
CREATE TABLE IF NOT EXISTS "ProviderDailyUsage" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "day" TEXT NOT NULL,
  "count" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProviderDailyUsage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ProviderDailyUsage_provider_day_key"
  ON "ProviderDailyUsage"("provider", "day");
