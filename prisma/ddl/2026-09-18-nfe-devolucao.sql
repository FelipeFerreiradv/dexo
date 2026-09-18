-- NF-e DE DEVOLUÇÃO (finNFe=4) — NfeDevolucao + NfeDevolucaoItem (docs/fiscal-devolucao.md)
--
-- EXECUTAR NO SQL EDITOR DO SUPABASE, ANTES de ligar a flag.
--
-- ORDEM DE IMPLANTAÇÃO:
--   1. Deploy do código com NFE_DEVOLUCAO_ENABLED ausente → nada lê, nada escreve.
--   2. Rodar este DDL (e o da numeração V2 — a devolução só emite pela V2).
--   3. NFE_DEVOLUCAO_ENABLED="true" + NFE_DEVOLUCAO_CONFIG_IDS=<ids> + pm2 restart
--      dexo-api; UI: NEXT_PUBLIC_NFE_DEVOLUCAO_ENABLED=true + build.
--
-- É 100% ADITIVO: tabelas novas; NfeEmitida/NfeItem não ganham coluna. As FKs
-- vivem só aqui (sem @relation no schema). ⛔ NUNCA `prisma db push`.

BEGIN;

CREATE TABLE IF NOT EXISTS "NfeDevolucao" (
  "id"                   TEXT NOT NULL,
  "nfeId"                TEXT NOT NULL,
  "userId"               TEXT NOT NULL,
  "tipo"                 TEXT NOT NULL,
  "fonte"                TEXT NOT NULL,
  "escopoSolicitado"     TEXT NOT NULL,
  -- NULL na criação; a emissão exige TRUE (recusa/não entrega = finNFe 5).
  "devolvidaAposEntrega" BOOLEAN,
  "confirmadoSemXml"     BOOLEAN NOT NULL DEFAULT false,
  "indFinal"             TEXT NOT NULL,
  "origensJson"          JSONB NOT NULL,
  -- Quem OPEROU (colaborador ou admin), diferente do dono dos dados.
  "createdByUserId"      TEXT NOT NULL,
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "NfeDevolucao_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "NfeDevolucao_tipo_chk"     CHECK ("tipo" IN ('VENDA_ENTRADA','COMPRA_SAIDA')),
  CONSTRAINT "NfeDevolucao_fonte_chk"    CHECK ("fonte" IN ('DEXO','XML_IMPORTADO','MANUAL')),
  CONSTRAINT "NfeDevolucao_escopo_chk"   CHECK ("escopoSolicitado" IN ('TOTAL','PARCIAL')),
  CONSTRAINT "NfeDevolucao_indFinal_chk" CHECK ("indFinal" IN ('0','1'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "NfeDevolucao_nfeId_key"
  ON "NfeDevolucao" ("nfeId");
CREATE INDEX IF NOT EXISTS "NfeDevolucao_userId_createdAt_idx"
  ON "NfeDevolucao" ("userId", "createdAt");

-- Apagar o rascunho da devolução leva o cabeçalho junto (como NfeItem).
ALTER TABLE "NfeDevolucao" DROP CONSTRAINT IF EXISTS "NfeDevolucao_nfeId_fkey";
ALTER TABLE "NfeDevolucao" ADD CONSTRAINT "NfeDevolucao_nfeId_fkey"
  FOREIGN KEY ("nfeId") REFERENCES "NfeEmitida"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "NfeDevolucao" ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS "NfeDevolucaoItem" (
  "id"                    TEXT NOT NULL,
  "devolucaoNfeId"        TEXT NOT NULL,
  "userId"                TEXT NOT NULL,
  "ordem"                 INTEGER NOT NULL,
  "originalNfeId"         TEXT,
  "chaveAcessoOriginal"   TEXT NOT NULL,
  "nItemOriginal"         INTEGER NOT NULL,
  "codigoOriginal"        TEXT NOT NULL,
  "quantidadeOriginal"    DECIMAL(15,4),
  "valorUnitarioOriginal" DECIMAL(15,4),
  "quantidade"            DECIMAL(15,4) NOT NULL,
  "valor"                 DECIMAL(15,2) NOT NULL,
  "impostoOriginalJson"   JSONB,
  "tributacaoJson"        JSONB NOT NULL,
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "NfeDevolucaoItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "NfeDevolucaoItem_chave_chk" CHECK ("chaveAcessoOriginal" ~ '^[0-9]{44}$'),
  CONSTRAINT "NfeDevolucaoItem_nItem_chk" CHECK ("nItemOriginal" BETWEEN 1 AND 990),
  CONSTRAINT "NfeDevolucaoItem_ordem_chk" CHECK ("ordem" BETWEEN 1 AND 990),
  CONSTRAINT "NfeDevolucaoItem_qtd_chk"   CHECK ("quantidade" > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "NfeDevolucaoItem_devolucaoNfeId_ordem_key"
  ON "NfeDevolucaoItem" ("devolucaoNfeId", "ordem");
-- Rejeição 1072 (mesma chave+nItem duas vezes na nota) barrada no banco.
CREATE UNIQUE INDEX IF NOT EXISTS "NfeDevolucaoItem_devol_chave_nitem_key"
  ON "NfeDevolucaoItem" ("devolucaoNfeId", "chaveAcessoOriginal", "nItemOriginal");
-- "Devoluções da original X" e "saldo por item original".
CREATE INDEX IF NOT EXISTS "NfeDevolucaoItem_user_chave_nitem_idx"
  ON "NfeDevolucaoItem" ("userId", "chaveAcessoOriginal", "nItemOriginal");
CREATE INDEX IF NOT EXISTS "NfeDevolucaoItem_originalNfeId_idx"
  ON "NfeDevolucaoItem" ("originalNfeId");

ALTER TABLE "NfeDevolucaoItem" DROP CONSTRAINT IF EXISTS "NfeDevolucaoItem_devolucaoNfeId_fkey";
ALTER TABLE "NfeDevolucaoItem" ADD CONSTRAINT "NfeDevolucaoItem_devolucaoNfeId_fkey"
  FOREIGN KEY ("devolucaoNfeId") REFERENCES "NfeEmitida"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
-- A original pode ser apagada (ex.: nota importada): a chave continua na linha,
-- então o saldo por chave sobrevive.
ALTER TABLE "NfeDevolucaoItem" DROP CONSTRAINT IF EXISTS "NfeDevolucaoItem_originalNfeId_fkey";
ALTER TABLE "NfeDevolucaoItem" ADD CONSTRAINT "NfeDevolucaoItem_originalNfeId_fkey"
  FOREIGN KEY ("originalNfeId") REFERENCES "NfeEmitida"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "NfeDevolucaoItem" ENABLE ROW LEVEL SECURITY;

COMMIT;

-- VERIFICAÇÃO:
--   SELECT indexname FROM pg_indexes WHERE tablename IN ('NfeDevolucao','NfeDevolucaoItem');
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conrelid IN ('"NfeDevolucao"'::regclass, '"NfeDevolucaoItem"'::regclass);

-- ROLLBACK (desligar NFE_DEVOLUCAO_ENABLED + restart ANTES):
--   BEGIN; DROP TABLE IF EXISTS "NfeDevolucaoItem"; DROP TABLE IF EXISTS "NfeDevolucao"; COMMIT;
