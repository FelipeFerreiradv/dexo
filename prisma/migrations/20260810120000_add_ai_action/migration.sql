-- Fase 9 do Bitz: a AÇÃO DE ESCRITA proposta e ainda não executada.
--
-- ⭐ Esta tabela É a confirmação humana. O agente grava aqui uma proposta com
-- status 'pendente' e devolve o id; só o clique do lojista executa, e a
-- execução lê o `payload` DESTA LINHA — nunca o que o navegador devolveu.
--
-- 100% ADITIVA: tabela nova, sem FK, sem cascade, sem tocar em nada existente.
-- Rodar ANTES do deploy do código.

CREATE TABLE IF NOT EXISTS "AiAction" (
  "id"             TEXT NOT NULL,
  "dataOwnerId"    TEXT NOT NULL,
  "actorUserId"    TEXT NOT NULL,
  "conversationId" TEXT,
  "action"         TEXT NOT NULL,
  "status"         TEXT NOT NULL,
  "payload"        JSONB NOT NULL,
  "preview"        JSONB NOT NULL,
  "resultId"       TEXT,
  "errorCode"      TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decidedAt"      TIMESTAMP(3),
  "expiresAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AiAction_pkey" PRIMARY KEY ("id")
);

-- O índice da confirmação: toda leitura é (tenant, ator, status).
CREATE INDEX IF NOT EXISTS "AiAction_dataOwnerId_actorUserId_status_idx"
  ON "AiAction" ("dataOwnerId", "actorUserId", "status");

CREATE INDEX IF NOT EXISTS "AiAction_conversationId_idx"
  ON "AiAction" ("conversationId");
