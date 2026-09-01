-- Pendencia de DEVOLUCAO: o marketplace encerrou o pedido, mas a peca NAO esta
-- no patio. O estoque so volta quando uma pessoa confirmar que a peca chegou.
--
-- Por que existe (medido em producao 01/09/2026): varredura de 68 cancelamentos
-- de um tenant real contra a API do ML mostrou que 51 (75%) eram devolucao
-- depois da entrega, e nao cancelamento antes do envio. O estorno automatico
-- recriou estoque inexistente e reabriu anuncio: 20 pecas estavam a venda
-- naquele instante, em 48 anuncios, R$ 2.576,90 expostos.
--
-- Idempotente (IF NOT EXISTS em tudo) porque em producao a DDL pode ser
-- aplicada manualmente antes do `migrate deploy` — assim o deploy vira no-op
-- seguro la e cria em ambientes novos.
--
-- Aditiva: tabela nova, isolada. Nenhuma tabela existente muda de forma.

-- CreateTable
CREATE TABLE IF NOT EXISTS "OrderReturnPendency" (
    "id" TEXT NOT NULL,
    "marketplaceAccountId" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "externalOrderId" TEXT NOT NULL,
    "payload" JSONB,
    "reason" TEXT NOT NULL,
    "detail" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "outcome" TEXT,
    "resolvedByUserId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextRetryAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderReturnPendency_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Reentrega/re-poll ATUALIZA o registro em vez de duplicar.
CREATE UNIQUE INDEX IF NOT EXISTS "OrderReturnPendency_marketplaceAccountId_externalOrderId_key" ON "OrderReturnPendency"("marketplaceAccountId", "externalOrderId");

-- CreateIndex
-- Serve a varredura do OrderReturnPendencyReconcilerService (status + nextRetryAt).
CREATE INDEX IF NOT EXISTS "OrderReturnPendency_status_nextRetryAt_idx" ON "OrderReturnPendency"("status", "nextRetryAt");

-- CreateIndex
-- Serve a listagem por tenant na tela /pedidos.
CREATE INDEX IF NOT EXISTS "OrderReturnPendency_marketplaceAccountId_status_idx" ON "OrderReturnPendency"("marketplaceAccountId", "status");

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'OrderReturnPendency_marketplaceAccountId_fkey'
  ) THEN
    ALTER TABLE "OrderReturnPendency"
      ADD CONSTRAINT "OrderReturnPendency_marketplaceAccountId_fkey"
      FOREIGN KEY ("marketplaceAccountId") REFERENCES "MarketplaceAccount"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
