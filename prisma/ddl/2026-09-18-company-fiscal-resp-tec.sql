-- RESPONSÁVEL TÉCNICO POR EMPRESA (CompanyFiscalRespTec) — 1:1 com CompanyFiscalConfig
--
-- EXECUTAR NO SQL EDITOR DO SUPABASE, ANTES de ligar a flag.
--
-- ORDEM DE IMPLANTAÇÃO:
--   1. Deploy do código com NFE_RESP_TEC_EMPRESA_ENABLED ausente → nada lê,
--      nada escreve; o SEFAZ direto segue usando NFE_RESP_TEC_* do .env e o
--      Focus segue sem enviar responsável técnico (idêntico ao de hoje).
--   2. Rodar este DDL.
--   3. NFE_RESP_TEC_EMPRESA_ENABLED="true" + NFE_RESP_TEC_EMPRESA_CONFIG_IDS=<ids>
--      + pm2 restart dexo-api; UI: NEXT_PUBLIC_NFE_RESP_TEC_EMPRESA_ENABLED=true + build.
--
-- É 100% ADITIVO: tabela nova. CompanyFiscalConfig não é tocada (a FK vive só
-- aqui, sem @relation no schema). "csrtEnc" é segredo cifrado (FISCAL_CERT_ENC_KEY)
-- e nunca sai da API.

BEGIN;

CREATE TABLE IF NOT EXISTS "CompanyFiscalRespTec" (
  "id"                    TEXT NOT NULL,
  "companyFiscalConfigId" TEXT NOT NULL,
  "userId"                TEXT NOT NULL,
  "modo"                  TEXT NOT NULL DEFAULT 'PADRAO',
  "cnpj"                  TEXT,
  "xContato"              TEXT,
  "email"                 TEXT,
  "fone"                  TEXT,
  "idCsrt"                TEXT,
  "csrtEnc"               TEXT,
  "updatedByUserId"       TEXT,
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CompanyFiscalRespTec_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CompanyFiscalRespTec_modo_chk" CHECK ("modo" IN ('PADRAO','PROVEDOR','PERSONALIZADO','NENHUM'))
);

-- Apagar a empresa fiscal leva a configuração de RT junto.
ALTER TABLE "CompanyFiscalRespTec"
  DROP CONSTRAINT IF EXISTS "CompanyFiscalRespTec_companyFiscalConfigId_fkey";
ALTER TABLE "CompanyFiscalRespTec"
  ADD CONSTRAINT "CompanyFiscalRespTec_companyFiscalConfigId_fkey"
  FOREIGN KEY ("companyFiscalConfigId") REFERENCES "CompanyFiscalConfig"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS "CompanyFiscalRespTec_companyFiscalConfigId_key"
  ON "CompanyFiscalRespTec" ("companyFiscalConfigId");
CREATE INDEX IF NOT EXISTS "CompanyFiscalRespTec_userId_idx"
  ON "CompanyFiscalRespTec" ("userId");

ALTER TABLE "CompanyFiscalRespTec" ENABLE ROW LEVEL SECURITY;

COMMIT;

-- VERIFICAÇÃO:
--   SELECT indexname FROM pg_indexes WHERE tablename = 'CompanyFiscalRespTec';
--   SELECT relrowsecurity FROM pg_class WHERE relname = 'CompanyFiscalRespTec';

-- ROLLBACK (desligar a flag + restart ANTES):
--   BEGIN; DROP TABLE IF EXISTS "CompanyFiscalRespTec"; COMMIT;
