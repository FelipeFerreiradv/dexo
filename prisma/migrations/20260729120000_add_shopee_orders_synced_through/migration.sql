-- Marca d'agua do poll de PEDIDOS da Shopee: ate quando a janela por
-- `update_time` ja foi varrida com sucesso. Espelha o
-- `shopeeListingsSyncedThrough`, que faz o mesmo para anuncios.
--
-- Idempotente (IF NOT EXISTS) porque em producao a coluna pode ser aplicada
-- manualmente por SQL antes do `migrate deploy` — assim o deploy vira no-op
-- seguro la e cria em ambientes novos.
--
-- Aditiva e nulavel: com NULL o importador cai na janela por dias, que e o
-- comportamento anterior. Zero regressao quando ausente.

-- AlterTable
ALTER TABLE "MarketplaceAccount" ADD COLUMN IF NOT EXISTS "shopeeOrdersSyncedThrough" TIMESTAMP(3);
