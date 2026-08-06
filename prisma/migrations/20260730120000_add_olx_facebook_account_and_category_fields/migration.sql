-- Campos por-conta e de categoria das integrações OLX/Facebook.
-- Complementa 20260719120000_add_olx_platform e 20260721120000_add_facebook_platform,
-- que só criaram o enum + olxListId/fbCatalogItemId. IF NOT EXISTS mantém o passo
-- aditivo e idempotente (o schema já pode ter sido sincronizado à mão em algum ambiente).

-- Categoria por anúncio (override) — ProductListing
ALTER TABLE "ProductListing"
  ADD COLUMN IF NOT EXISTS "olxCategoryOverride" TEXT,
  ADD COLUMN IF NOT EXISTS "fbCategoryOverride" TEXT;

-- Dados de vendedor POR CONTA (antes eram env global — furo de multi-tenant).
-- NULL = usa o .env como fallback, então não muda nada para contas existentes.
ALTER TABLE "MarketplaceAccount"
  ADD COLUMN IF NOT EXISTS "olxSellerPhone" TEXT,
  ADD COLUMN IF NOT EXISTS "olxSellerZipcode" TEXT,
  ADD COLUMN IF NOT EXISTS "fbCatalogId" TEXT,
  ADD COLUMN IF NOT EXISTS "fbProductUrlBase" TEXT;
