-- Migration: catalogo persistente de atributos de categoria Shopee.
-- A API /api/v2/product/get_attributes da Shopee retorna 403
-- permission_denied em algumas categorias (autopecas) mesmo com o app
-- corretamente autorizado. Esse cache substitui o anterior em disco
-- (.cache/shopee-category-attrs.json) que nao sobrevive deploys.
--
-- Chave unica (region, categoryId, locale): o schema de atributos da
-- Shopee e global por regiao, nao por loja. Isso permite harvest
-- cross-account (loja A 403 mas loja B ja tem cache) e poupa storage.
--
-- "attributes" JSONB guarda o attribute_list bruto retornado pela API
-- ou extraido (harvest) via get_item_base_info de listing existente.

CREATE TABLE "ShopeeCategoryAttribute" (
    "id" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "categoryId" INTEGER NOT NULL,
    "locale" TEXT NOT NULL,
    "attributes" JSONB NOT NULL,
    "source" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ttlExpiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopeeCategoryAttribute_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ShopeeCategoryAttribute_region_categoryId_locale_key"
    ON "ShopeeCategoryAttribute"("region", "categoryId", "locale");

CREATE INDEX "ShopeeCategoryAttribute_ttlExpiresAt_idx"
    ON "ShopeeCategoryAttribute"("ttlExpiresAt");

CREATE INDEX "ShopeeCategoryAttribute_categoryId_idx"
    ON "ShopeeCategoryAttribute"("categoryId");
