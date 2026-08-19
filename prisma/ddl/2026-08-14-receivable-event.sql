-- BLOCO H — histórico da venda (ReceivableEvent)
--
-- EXECUTAR NO SQL EDITOR DO SUPABASE, ANTES de ligar a flag.
--
-- ORDEM DE IMPLANTAÇÃO (importante):
--   1. Deploy do código com SALE_TIMELINE_ENABLED ausente  → nada escreve,
--      nada lê, comportamento byte-idêntico ao de hoje.
--   2. Rodar este DDL.
--   3. Só então  SALE_TIMELINE_ENABLED=1  +  pm2 restart.
--
-- Inverter 2 e 3 faria o registro de eventos falhar — inofensivo, porque toda
-- escrita é best-effort, mas encheria o log de erro sem necessidade.
--
-- É 100% ADITIVO: cria uma tabela nova. Nenhuma coluna existente é tocada,
-- nenhum dado é migrado. O rollback está no fim do arquivo.

BEGIN;

CREATE TABLE IF NOT EXISTS "ReceivableEvent" (
  "id"           TEXT NOT NULL,
  "receivableId" TEXT NOT NULL,
  -- Dono dos dados (admin do tenant). Escopo de toda leitura.
  "userId"       TEXT NOT NULL,
  -- Quem OPEROU. NULL = ação de sistema, que é diferente de "não sabemos".
  "actorId"      TEXT,
  -- Snapshot: o nome do colaborador muda, o histórico não.
  "actorName"    TEXT,
  -- CREATED | UPDATED | PAID | REVERSED | FISCAL_EMITTED
  "type"         TEXT NOT NULL,
  "message"      TEXT,
  "details"      JSONB,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ReceivableEvent_pkey" PRIMARY KEY ("id")
);

-- Apagar a venda leva o histórico junto (mesma semântica de
-- ReceivableItem/ReceivablePayment). A EXCLUSÃO em si continua registrada no
-- SystemLog, que sobrevive à linha.
ALTER TABLE "ReceivableEvent"
  DROP CONSTRAINT IF EXISTS "ReceivableEvent_receivableId_fkey";
ALTER TABLE "ReceivableEvent"
  ADD CONSTRAINT "ReceivableEvent_receivableId_fkey"
  FOREIGN KEY ("receivableId") REFERENCES "Receivable"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- A leitura da timeline é sempre (venda, mais recente primeiro).
CREATE INDEX IF NOT EXISTS "ReceivableEvent_receivableId_createdAt_idx"
  ON "ReceivableEvent" ("receivableId", "createdAt");

CREATE INDEX IF NOT EXISTS "ReceivableEvent_userId_createdAt_idx"
  ON "ReceivableEvent" ("userId", "createdAt");

-- RLS: o app é dono da conexão (Prisma, BYPASSRLS), então isto NÃO muda nada
-- para a aplicação — é a trava contra exposição pela Data API/PostgREST, que
-- é silenciosa do ponto de vista do app e por isso fácil de esquecer.
ALTER TABLE "ReceivableEvent" ENABLE ROW LEVEL SECURITY;

COMMIT;

-- ── Verificação (rodar depois do COMMIT) ──
-- SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--  WHERE table_name = 'ReceivableEvent'
--  ORDER BY ordinal_position;
--
-- SELECT indexname FROM pg_indexes WHERE tablename = 'ReceivableEvent';
--
-- SELECT relrowsecurity FROM pg_class WHERE relname = 'ReceivableEvent';

-- ── ROLLBACK ──
-- Desligue a flag ANTES (SALE_TIMELINE_ENABLED + pm2 restart); com ela ligada
-- e a tabela ausente, cada venda registra um erro best-effort no log.
--
-- BEGIN;
--   DROP TABLE IF EXISTS "ReceivableEvent";
-- COMMIT;
