-- Quarentena de pedido de marketplace que nao pode ser totalmente ingerido, e
-- marca de auditoria da baixa de estoque no Order.
--
-- Idempotente (IF NOT EXISTS em tudo) porque em producao a DDL pode ser
-- aplicada manualmente antes do `migrate deploy` — assim o deploy vira no-op
-- seguro la e cria em ambientes novos.
--
-- Aditiva: tabela nova + coluna nulavel. Nada existente muda de forma.

-- CreateTable
CREATE TABLE IF NOT EXISTS "OrderIngestionIssue" (
    "id" TEXT NOT NULL,
    "marketplaceAccountId" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "externalOrderId" TEXT NOT NULL,
    "payload" JSONB,
    "reason" TEXT NOT NULL,
    "detail" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextRetryAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedOrderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderIngestionIssue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Reentrega/re-poll ATUALIZA o registro em vez de duplicar.
CREATE UNIQUE INDEX IF NOT EXISTS "OrderIngestionIssue_marketplaceAccountId_externalOrderId_key" ON "OrderIngestionIssue"("marketplaceAccountId", "externalOrderId");

-- CreateIndex
-- Serve a varredura do OrderIngestionReconcilerService (status + nextRetryAt).
CREATE INDEX IF NOT EXISTS "OrderIngestionIssue_status_nextRetryAt_idx" ON "OrderIngestionIssue"("status", "nextRetryAt");

-- CreateIndex
-- Serve a listagem por tenant na tela /pedidos.
CREATE INDEX IF NOT EXISTS "OrderIngestionIssue_marketplaceAccountId_status_idx" ON "OrderIngestionIssue"("marketplaceAccountId", "status");

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'OrderIngestionIssue_marketplaceAccountId_fkey'
  ) THEN
    ALTER TABLE "OrderIngestionIssue"
      ADD CONSTRAINT "OrderIngestionIssue_marketplaceAccountId_fkey"
      FOREIGN KEY ("marketplaceAccountId") REFERENCES "MarketplaceAccount"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AlterTable
-- Marca de auditoria da baixa, gravada na mesma transacao da baixa. NAO e a
-- fonte de verdade da idempotencia (essa continua sendo o net do StockLog).
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "stockDeductedAt" TIMESTAMP(3);
