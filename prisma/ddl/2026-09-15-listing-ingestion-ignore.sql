-- Lista de anúncios que a INGESTÃO deve ignorar (ListingIngestionIgnore).
--
-- EXECUTAR VIA psql "$DIRECT_URL" NA VPS (ou SQL editor do Supabase — aqui não
-- há CONCURRENTLY, então o editor serve).
--
-- ORDEM DE IMPLANTAÇÃO — TABELA NOVA PURA, a ordem folgada:
--   1. RODAR ESTE DDL com o código atual no ar (ninguém a referencia: seguro).
--   2. Deploy do código novo.
--   3. ⚠️ O deploy SEM `npm ci` NÃO roda `prisma generate` (é o postinstall).
--      Depois do pull, gerar o client NA VPS:
--        node node_modules/prisma/build/index.js generate --schema=prisma/schema.prisma
--      Sem isso, `prisma.listingIngestionIgnore` é undefined em runtime e o
--      preload da ingestão cai no catch — a lista fica INERTE em silêncio.
--
-- POR QUE A TABELA EXISTE: a limpeza de catálogo de terceiro (caso Ducelo)
-- apaga o Product local SEM encerrar o anúncio no marketplace, porque o
-- anúncio continua vendendo para o dono real. Sem esta lista, a varredura
-- seguinte recriava tudo (MK2: 998 limpos viraram 1.934 em um dia). O script
-- de limpeza grava aqui ANTES de apagar, na mesma transação.
--
-- 100% ADITIVO: nenhuma tabela existente é tocada.

BEGIN;

CREATE TABLE IF NOT EXISTS "ListingIngestionIgnore" (
  "id"                TEXT NOT NULL,
  "userId"            TEXT NOT NULL,
  "platform"          "Platform" NOT NULL,
  "externalListingId" TEXT NOT NULL,
  -- Auditável: qual limpeza/decisão pôs o anúncio aqui (ex.: "pai-celao-2026-09").
  "reason"            TEXT NOT NULL,
  "createdByUserId"   TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ListingIngestionIgnore_pkey" PRIMARY KEY ("id")
);

-- A unique é a identidade do bloqueio; o índice (userId, platform) serve o
-- preload em lote da ingestão (1 query por conta, nunca por item — regra R5).
CREATE UNIQUE INDEX IF NOT EXISTS
  "ListingIngestionIgnore_userId_platform_externalListingId_key"
  ON "ListingIngestionIgnore" ("userId", "platform", "externalListingId");

CREATE INDEX IF NOT EXISTS "ListingIngestionIgnore_userId_platform_idx"
  ON "ListingIngestionIgnore" ("userId", "platform");

COMMIT;
