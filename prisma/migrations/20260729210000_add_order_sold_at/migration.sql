-- Data da venda no marketplace, separada da data de IMPORTACAO (`createdAt`).
--
-- Motivo: Dashboard e Financeiro filtram por `createdAt`, que e a hora em que o
-- Dexo importou o pedido. Com o ciclo de sync levando ate 71,9 h (incidente de
-- 29/07/2026), o faturamento era atribuido a data errada, as vezes atravessando
-- virada de mes.
--
-- Idempotente: pode rodar duas vezes. Pedidos antigos ficam NULL e todo filtro
-- usa COALESCE("soldAt", "createdAt"), entao o historico nao muda de
-- comportamento.
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "soldAt" TIMESTAMP(3);

-- Indice espelhando o de (marketplaceAccountId, createdAt), que serve os
-- mesmos filtros por periodo.
CREATE INDEX IF NOT EXISTS "Order_marketplaceAccountId_soldAt_idx"
  ON "Order"("marketplaceAccountId", "soldAt");
