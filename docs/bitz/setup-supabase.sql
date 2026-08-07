-- ===========================================================================
-- BITZ (agente de IA) — TODO o DDL, num arquivo só.
--
-- Cole isto inteiro no SQL Editor do Supabase e rode UMA vez.
--
-- É seguro rodar de novo: cada comando é IF NOT EXISTS / DO $$ com guarda.
-- Rodar duas vezes não duplica nada e não apaga nada.
--
-- O QUE ISTO FAZ COM O SISTEMA ATUAL: nada.
--   • 1 coluna nova em "User", nullable, sem default → NULL em 100% das linhas
--     existentes, e NULL significa "sem acesso ao Bitz".
--   • 3 tabelas novas, vazias.
--   • Nenhuma tabela existente alterada, nenhum índice existente tocado,
--     nenhum enum existente mudado, NENHUMA extensão nova no Postgres.
--
-- Enquanto NEXT_PUBLIC_AI_MODULE_ENABLED não estiver ligada, nada nem lê estas
-- tabelas.
--
-- Ordem: este SQL → `npx prisma generate` → subir os servidores →
--        `npm run ai:index -- --apply` → liberar o seu usuário (passo 4).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1/4 — Gate Premium por tenant (Fase 1)
--
-- Espelha `User.whatsappEnabledAt`: mesmo tipo, mesma semântica. NULL = sem
-- acesso. O acesso é concedido explicitamente, nunca por default.
-- ---------------------------------------------------------------------------
ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "aiEnabledAt" TIMESTAMP(3);

-- ---------------------------------------------------------------------------
-- 2/4 — Persistência da conversa (Fase 2)
--
-- `dataOwnerId` é o TENANT (escopo de tudo que o agente consulta) e
-- `actorUserId` é QUEM DIGITOU (dono da conversa). Um colaborador escreve no
-- tenant do admin pai, mas o histórico é dele — por isso os dois ids e os dois
-- índices.
--
-- A quota NÃO tem tabela: reusa `ProviderDailyUsage`, que já existe.
-- ---------------------------------------------------------------------------
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

-- Apagar a conversa leva as mensagens junto (CASCADE). Apagar o USUÁRIO, não:
-- é operação rara e manual, e um cascade silencioso ali apagaria trilha de
-- auditoria sem ninguém pedir — por isso RESTRICT.
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

-- ---------------------------------------------------------------------------
-- 3/4 — Base de conhecimento sobre o Dexo (Fase 4)
--
-- Tabela GLOBAL de propósito: NÃO tem coluna de tenant. O conteúdo é sobre
-- como o Dexo funciona, nunca sobre o cliente. Não ter a coluna é mais forte
-- do que filtrar por ela — não existe query que possa esquecer o WHERE.
--
-- Fica VAZIA até você rodar `npm run ai:index -- --apply`. Vazia, o Bitz
-- responde sem base de conhecimento — degradação, não erro.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "AiKnowledgeChunk" (
    "id"        TEXT NOT NULL,
    "docId"     TEXT NOT NULL,
    "ord"       INTEGER NOT NULL,
    "heading"   TEXT,
    "content"   TEXT NOT NULL,
    "search"    TEXT NOT NULL,
    "checksum"  TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiKnowledgeChunk_pkey" PRIMARY KEY ("id")
);

-- (docId, ord) é a chave natural do upsert incremental do indexador:
-- reindexar documento inalterado não escreve nada.
CREATE UNIQUE INDEX IF NOT EXISTS "AiKnowledgeChunk_docId_ord_key"
  ON "AiKnowledgeChunk"("docId", "ord");

CREATE INDEX IF NOT EXISTS "AiKnowledgeChunk_docId_idx"
  ON "AiKnowledgeChunk"("docId");

-- ---------------------------------------------------------------------------
-- 4/4 — LIBERE O SEU USUÁRIO
--
-- ⚠️ TROQUE O E-MAIL ABAIXO PELO SEU e rode esta linha. Sem ela, o mascote não
-- aparece e /ai/chat responde 403 — que é exatamente o comportamento correto
-- para quem não contratou.
--
-- O e-mail é comparado como está gravado: o cadastro só faz `trim()`, nunca
-- lowercase. Se não achar, confira com o SELECT logo abaixo.
--
-- Alternativa pelo terminal (idempotente, com validação):
--   npx tsx scripts/set-ai-access.ts --email=voce@exemplo.com --on
-- ---------------------------------------------------------------------------
UPDATE "User"
   SET "aiEnabledAt" = NOW()
 WHERE "email" = 'TROQUE-PELO-SEU-EMAIL@exemplo.com'
   AND "aiEnabledAt" IS NULL;

-- ===========================================================================
-- CONFERÊNCIA — rode e veja se está tudo de pé
-- ===========================================================================
SELECT
  (SELECT count(*) FROM information_schema.columns
    WHERE table_name = 'User' AND column_name = 'aiEnabledAt')        AS coluna_aiEnabledAt,
  (SELECT count(*) FROM information_schema.tables
    WHERE table_name = 'AiConversation')                              AS tabela_conversation,
  (SELECT count(*) FROM information_schema.tables
    WHERE table_name = 'AiMessage')                                   AS tabela_message,
  (SELECT count(*) FROM information_schema.tables
    WHERE table_name = 'AiKnowledgeChunk')                            AS tabela_knowledge,
  (SELECT count(*) FROM "AiKnowledgeChunk")                           AS pedacos_indexados,
  (SELECT count(*) FROM "User" WHERE "aiEnabledAt" IS NOT NULL)       AS usuarios_liberados;

-- Esperado depois deste script: 1, 1, 1, 1, 0, 1
-- `pedacos_indexados` vira 85 depois do `npm run ai:index -- --apply`.

-- Não achou o seu usuário no passo 4? Veja como o e-mail está gravado:
-- SELECT "id", "email", "aiEnabledAt" FROM "User" ORDER BY "createdAt" LIMIT 20;

-- ===========================================================================
-- DESFAZER TUDO (se quiser voltar ao estado anterior)
--
-- Antes: desligue NEXT_PUBLIC_AI_MODULE_ENABLED, para nenhum caminho tentar
-- ler o que vai sumir.
--
--   DROP TABLE IF EXISTS "AiMessage";
--   DROP TABLE IF EXISTS "AiConversation";
--   DROP TABLE IF EXISTS "AiKnowledgeChunk";
--   ALTER TABLE "User" DROP COLUMN IF EXISTS "aiEnabledAt";
--
-- Nenhuma outra tabela aponta para estas três, e a coluna só guarda a data de
-- concessão do plano. Reversível sem perda para o resto do sistema.
-- ===========================================================================
