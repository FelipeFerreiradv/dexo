-- Fase 11 do Bitz: A MEMÓRIA DA LOJA — o que o administrador ensinou ao agente.
--
-- ⭐ Guarda REGRA, nunca FATO. "meu markup padrão é 2,2x" é regra; "o farol
-- custa 180" é fato, muda sozinho, e guardado aqui viraria uma mentira que o
-- Bitz repetiria com confiança em vez de consultar o banco.
--
-- Escopo: `dataOwnerId` e nada mais. A memória é da LOJA (toda a equipe recebe
-- as mesmas regras), mas só o administrador grava e apaga.
--
-- 100% ADITIVA: tabela nova, sem FK, sem cascade, sem tocar em nada existente.
-- Vazia, o Bitz se comporta exatamente como antes desta fase existir.
-- Rodar ANTES do deploy do código.

CREATE TABLE IF NOT EXISTS "AiMemory" (
  "id"              TEXT NOT NULL,
  "dataOwnerId"     TEXT NOT NULL,
  "createdByUserId" TEXT NOT NULL,
  "topico"          TEXT NOT NULL,
  "conteudo"        TEXT NOT NULL,
  "conversationId"  TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AiMemory_pkey" PRIMARY KEY ("id")
);

-- Toda leitura é (tenant, ordem de criação): o prompt lê as mais recentes, e a
-- tela lista na mesma ordem.
CREATE INDEX IF NOT EXISTS "AiMemory_dataOwnerId_createdAt_idx"
  ON "AiMemory" ("dataOwnerId", "createdAt");
