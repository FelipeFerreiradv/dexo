-- Bitz (agente de IA) — Fase 2: persistência da conversa.
--
-- Duas tabelas NOVAS. Nenhuma tabela existente é alterada, nenhum índice
-- existente é tocado, nenhum valor novo em enum existente. Com a flag
-- NEXT_PUBLIC_AI_MODULE_ENABLED desligada elas simplesmente ficam vazias.
--
-- AiConversation carrega DOIS ids de propósito: `dataOwnerId` é o tenant
-- (escopo de tudo que o agente consulta) e `actorUserId` é quem digitou (dono
-- da conversa). Um colaborador escreve no tenant do admin pai, mas o histórico
-- é dele — por isso a FK é com o ator e existe índice pelos dois.
--
-- A quota NÃO tem tabela: reusa ProviderDailyUsage com `provider` =
-- 'ai:tenant:<id>' e 'ai:global'.
--
-- Idempotente (IF NOT EXISTS): aplicável manualmente em produção ANTES do
-- deploy do código; `migrate deploy` vira no-op lá e cria em ambientes novos.
--
-- ORDEM DE DEPLOY: DDL -> prisma generate -> deploy do código -> flag ON.

CREATE TABLE IF NOT EXISTS "AiConversation" (
    "id"          TEXT NOT NULL,
    "dataOwnerId" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "title"       TEXT,
    "summary"     TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiConversation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AiMessage" (
    "id"             TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role"           TEXT NOT NULL,
    "content"        TEXT NOT NULL,
    "toolCalls"      JSONB,
    "sources"        JSONB,
    "provider"       TEXT,
    "model"          TEXT,
    "inputTokens"    INTEGER,
    "outputTokens"   INTEGER,
    "latencyMs"      INTEGER,
    "errorCode"      TEXT,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiMessage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AiConversation_dataOwnerId_updatedAt_idx"
  ON "AiConversation"("dataOwnerId", "updatedAt");

CREATE INDEX IF NOT EXISTS "AiConversation_actorUserId_updatedAt_idx"
  ON "AiConversation"("actorUserId", "updatedAt");

CREATE INDEX IF NOT EXISTS "AiMessage_conversationId_createdAt_idx"
  ON "AiMessage"("conversationId", "createdAt");

-- onDelete: Cascade na mensagem — apagar a conversa leva as mensagens junto.
-- Na FK com User NÃO há cascade: apagar usuário é operação rara e manual, e um
-- cascade silencioso ali apagaria trilha de auditoria sem ninguém pedir.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'AiConversation_actorUserId_fkey'
  ) THEN
    ALTER TABLE "AiConversation"
      ADD CONSTRAINT "AiConversation_actorUserId_fkey"
      FOREIGN KEY ("actorUserId") REFERENCES "User"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'AiMessage_conversationId_fkey'
  ) THEN
    ALTER TABLE "AiMessage"
      ADD CONSTRAINT "AiMessage_conversationId_fkey"
      FOREIGN KEY ("conversationId") REFERENCES "AiConversation"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- ROLLBACK (down):
--   DROP TABLE IF EXISTS "AiMessage";
--   DROP TABLE IF EXISTS "AiConversation";
--
-- Reversível sem perda para o resto do sistema: nenhuma outra tabela aponta
-- para estas duas. Antes do rollback, desligar NEXT_PUBLIC_AI_MODULE_ENABLED
-- (rebuild do front) para que nenhum caminho tente escrever nelas.
