-- Memória de categoria por plataforma no Product, para OLX e Facebook.
--
-- Espelha o trio que ML/Shopee/Magalu já têm (mlCategoryId/Source/ChosenAt):
-- a categoria escolhida pelo operador vira memória do produto, em vez de valer
-- para uma publicação só e ser recalculada na republicação ou ao publicar numa
-- segunda conta.
--
-- Complementa 20260730120000_add_olx_facebook_account_and_category_fields, que
-- cobriu as colunas de MarketplaceAccount e os overrides por anúncio, mas não
-- estas seis. Sem esta migration, o INSERT do Prisma em `Product` lista colunas
-- inexistentes e o cadastro de produto falha com 42703 — para TODOS os canais,
-- não só OLX/Facebook.
--
-- Aditivo e idempotente: todas nullable, sem DEFAULT e sem backfill, então
-- linha existente não muda e rodar de novo é no-op (o ambiente pode já ter
-- recebido o DDL manual do runbook).

-- OLX: código de VEÍCULO do autoupload (2101 carros, 2103 motos). O tipo de
-- peça viaja em `params` do anúncio, não aqui.
-- Facebook: google_product_category do Commerce Catalog.
ALTER TABLE "Product"
  ADD COLUMN IF NOT EXISTS "olxCategoryId" TEXT,
  ADD COLUMN IF NOT EXISTS "olxCategorySource" TEXT,
  ADD COLUMN IF NOT EXISTS "olxCategoryChosenAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "fbCategoryId" TEXT,
  ADD COLUMN IF NOT EXISTS "fbCategorySource" TEXT,
  ADD COLUMN IF NOT EXISTS "fbCategoryChosenAt" TIMESTAMP(3);
