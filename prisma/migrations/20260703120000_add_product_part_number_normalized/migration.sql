-- Espelha a coluna/índice de skuNormalized para partNumber (busca exata por
-- part number com paridade ao SKU). Idempotente (IF NOT EXISTS) porque em
-- produção a coluna/índice já foram aplicados manualmente via SQL antes deste
-- migration existir — assim `migrate deploy` é no-op seguro lá e cria em
-- ambientes novos. Aditivo e nulável: zero regressão quando ausente/null.

-- AlterTable
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "partNumberNormalized" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Product_userId_partNumberNormalized_idx" ON "Product"("userId", "partNumberNormalized");
