-- NUMERAÇÃO V2 DA NF-e/NFC-e — reserva × consumo de número (docs/fiscal-numeracao-v2.md)
--
-- EXECUTAR NO SQL EDITOR DO SUPABASE, ANTES de ligar a flag.
--
-- ORDEM DE IMPLANTAÇÃO (importante):
--   1. Deploy do código com NFE_NUMERACAO_V2_ENABLED ausente → nada lê, nada
--      escreve nestas tabelas; emissão byte-idêntica à de hoje.
--   2. Rodar este DDL (pré-condição abaixo) e o bloco de VERIFICAÇÃO.
--   3. Só então NFE_NUMERACAO_V2_ENABLED="true" + NFE_NUMERACAO_V2_CONFIG_IDS=<ids>
--      + pm2 restart dexo-api (NUNCA --update-env).
--
-- Se 3 acontecer antes de 2, o código degrada para o fluxo antigo (captura
-- "relation does not exist"), mas não deixe assim.
--
-- É 100% ADITIVO: duas tabelas novas. Nenhuma coluna existente é tocada,
-- nenhum dado é migrado. Tabelas novas e vazias ⇒ CREATE INDEX normal dentro da
-- transação é seguro (CONCURRENTLY não é necessário nem possível aqui).
--
-- ⛔ O índice PARCIAL "NfeNumeroReserva_nfeId_vivo_key" NÃO existe no
-- schema.prisma. `prisma db push` o apagaria — push continua PROIBIDO.
--
-- PRÉ-CONDIÇÃO (deve retornar 1 linha — a V2 grava cStatRejeicao):
--   SELECT 1 FROM information_schema.columns
--    WHERE table_name = 'NfeEmitida' AND column_name = 'cStatRejeicao';

BEGIN;

CREATE TABLE IF NOT EXISTS "NfeNumeroReserva" (
  "id"                    TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "userId"                TEXT NOT NULL,
  "companyFiscalConfigId" TEXT NOT NULL,
  "ambiente"              TEXT NOT NULL,
  "modelo"                TEXT NOT NULL,
  "serie"                 INTEGER NOT NULL,
  "numero"                INTEGER NOT NULL,
  -- Sem FK: a reserva sobrevive à exclusão do rascunho (trilha do número).
  "nfeId"                 TEXT,
  "estado"                TEXT NOT NULL,
  "origem"                TEXT NOT NULL,
  -- cNF fixo por número ⇒ reenvio no mesmo mês gera a MESMA chave de acesso.
  "cNF"                   CHAR(8),
  "provedorUltimo"        TEXT,
  "ultimaClasse"          TEXT,
  "ultimoCStat"           INTEGER,
  "ultimoCodigoProvedor"  VARCHAR(64),
  "motivo"                VARCHAR(500),
  "requerInutilizacao"    BOOLEAN NOT NULL DEFAULT false,
  "bloqueadoAte"          TIMESTAMP(3),
  "leaseAte"              TIMESTAMP(3),
  "consumidoEm"           TIMESTAMP(3),
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "NfeNumeroReserva_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "NfeNumeroReserva_estado_chk" CHECK ("estado" IN (
    'RESERVADO','REJEITADO','EM_TRANSMISSAO','INCERTO','BLOQUEADO','AUTORIZADO',
    'CANCELADO','DENEGADO','INUTILIZADO','CONSUMIDO_EXTERNO','ABANDONADO')),
  CONSTRAINT "NfeNumeroReserva_origem_chk" CHECK ("origem" IN ('CONTADOR','LEGADO_V1','READBACK_FOCUS')),
  CONSTRAINT "NfeNumeroReserva_dominio_chk" CHECK (
    "modelo" IN ('55','65')
    AND "ambiente" IN ('HOMOLOGACAO','PRODUCAO')
    AND "serie" BETWEEN 0 AND 999
    AND "numero" BETWEEN 1 AND 999999999),
  -- Estado vivo ou fiscalmente vinculado exige documento.
  CONSTRAINT "NfeNumeroReserva_vinculo_chk" CHECK (
    "estado" NOT IN ('RESERVADO','REJEITADO','EM_TRANSMISSAO','INCERTO','BLOQUEADO','AUTORIZADO','CANCELADO')
    OR "nfeId" IS NOT NULL)
);

-- Um número aparece UMA vez por chave fiscal durante toda a vida
-- (rede de segurança do FOR UPDATE no NfeSequence).
CREATE UNIQUE INDEX IF NOT EXISTS "NfeNumeroReserva_cfc_amb_mod_serie_num_key"
  ON "NfeNumeroReserva" ("companyFiscalConfigId", "ambiente", "modelo", "serie", "numero");

-- PARCIAL (fora do schema.prisma): no máximo 1 reserva viva/autorizada por documento.
CREATE UNIQUE INDEX IF NOT EXISTS "NfeNumeroReserva_nfeId_vivo_key"
  ON "NfeNumeroReserva" ("nfeId")
  WHERE "estado" IN ('RESERVADO','REJEITADO','EM_TRANSMISSAO','INCERTO','BLOQUEADO','AUTORIZADO','CANCELADO');

CREATE INDEX IF NOT EXISTS "NfeNumeroReserva_nfeId_idx"
  ON "NfeNumeroReserva" ("nfeId");

CREATE INDEX IF NOT EXISTS "NfeNumeroReserva_userId_estado_idx"
  ON "NfeNumeroReserva" ("userId", "estado");

CREATE TABLE IF NOT EXISTS "NfeNumeroTentativa" (
  "id"              TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "reservaId"       TEXT NOT NULL,
  "nfeId"           TEXT NOT NULL,
  "userId"          TEXT NOT NULL,
  "seq"             INTEGER NOT NULL,
  "provedor"        TEXT NOT NULL,
  "ambiente"        TEXT NOT NULL,
  "tpEmis"          INTEGER NOT NULL DEFAULT 1,
  "chaveAcesso"     CHAR(44),
  "cNF"             CHAR(8),
  "dhEmi"           TIMESTAMP(3),
  "digestValue"     TEXT,
  "xmlAssinadoPath" TEXT,
  "conteudoSha256"  CHAR(64) NOT NULL,
  "focusRef"        TEXT,
  "nRec"            TEXT,
  "fase"            TEXT NOT NULL,
  "httpStatus"      INTEGER,
  "transporte"      TEXT,
  "cStat"           INTEGER,
  "codigoProvedor"  VARCHAR(64),
  "classe"          TEXT,
  "prova"           TEXT,
  "mensagem"        VARCHAR(500),
  "protocolo"       TEXT,
  "numeroLido"      INTEGER,
  "serieLida"       INTEGER,
  "transmitidaEm"   TIMESTAMP(3) NOT NULL,
  "respondidaEm"    TIMESTAMP(3),
  "consultadaEm"    TIMESTAMP(3),
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "NfeNumeroTentativa_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "NfeNumeroTentativa_fase_chk" CHECK ("fase" IN ('TRANSMITINDO','RESPONDIDA','FECHADA')),
  CONSTRAINT "NfeNumeroTentativa_provedor_chk" CHECK ("provedor" IN ('SEFAZ_DIRECT','FOCUS_NFE'))
);

ALTER TABLE "NfeNumeroTentativa"
  DROP CONSTRAINT IF EXISTS "NfeNumeroTentativa_reservaId_fkey";
ALTER TABLE "NfeNumeroTentativa"
  ADD CONSTRAINT "NfeNumeroTentativa_reservaId_fkey"
  FOREIGN KEY ("reservaId") REFERENCES "NfeNumeroReserva"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS "NfeNumeroTentativa_reserva_seq_key"
  ON "NfeNumeroTentativa" ("reservaId", "seq");
CREATE INDEX IF NOT EXISTS "NfeNumeroTentativa_chave_idx"
  ON "NfeNumeroTentativa" ("chaveAcesso");
CREATE INDEX IF NOT EXISTS "NfeNumeroTentativa_nfeId_idx"
  ON "NfeNumeroTentativa" ("nfeId");
CREATE INDEX IF NOT EXISTS "NfeNumeroTentativa_focusRef_idx"
  ON "NfeNumeroTentativa" ("focusRef");

-- RLS: o app é dono da conexão (Prisma, BYPASSRLS) — não muda nada para a
-- aplicação; é a trava contra exposição pela Data API/PostgREST.
ALTER TABLE "NfeNumeroReserva"   ENABLE ROW LEVEL SECURITY;
ALTER TABLE "NfeNumeroTentativa" ENABLE ROW LEVEL SECURITY;

COMMIT;

-- VERIFICAÇÃO (todas as linhas com indisvalid = t e relrowsecurity = t):
--   SELECT c.relname, i.indisvalid
--     FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
--    WHERE c.relname LIKE 'NfeNumero%';
--   SELECT relname, relrowsecurity FROM pg_class
--    WHERE relname IN ('NfeNumeroReserva','NfeNumeroTentativa');

-- ROLLBACK (desligar NFE_NUMERACAO_V2_ENABLED + restart ANTES; guardar cópia):
--   CREATE SCHEMA IF NOT EXISTS ops_backup;
--   CREATE TABLE ops_backup."NfeNumeroReserva_AAAAMMDD"   AS TABLE "NfeNumeroReserva";
--   CREATE TABLE ops_backup."NfeNumeroTentativa_AAAAMMDD" AS TABLE "NfeNumeroTentativa";
--   BEGIN;
--   DROP TABLE IF EXISTS "NfeNumeroTentativa";
--   DROP TABLE IF EXISTS "NfeNumeroReserva";
--   COMMIT;
