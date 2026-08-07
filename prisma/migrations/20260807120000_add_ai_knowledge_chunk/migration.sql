-- Bitz (agente de IA) — Fase 4: base de conhecimento sobre o Dexo.
--
-- UMA tabela nova. Nenhuma tabela existente é alterada, nenhum índice
-- existente é tocado, nenhum valor novo em enum existente, NENHUMA EXTENSÃO
-- NOVA no Postgres.
--
-- A tabela é GLOBAL de propósito: não existe coluna de tenant aqui. O conteúdo
-- é sobre COMO O DEXO FUNCIONA (cadastrar peça, publicar anúncio, entender um
-- anúncio pausado), nunca sobre o cliente. Não ter a coluna é mais forte que
-- filtrar por ela — não há query que possa esquecer o WHERE.
--
-- Sem índice além do unique/docId: o conteúdo inteiro são 84 linhas (13
-- documentos, medido em 07/08/2026). Nesse volume o planner escolhe seq scan
-- de qualquer forma, e um GIN de trigram ficaria parado ocupando espaço.
-- Se a base crescer uma ordem de grandeza,
-- o índice a criar é
--   CREATE INDEX CONCURRENTLY "AiKnowledgeChunk_search_trgm_idx"
--     ON "AiKnowledgeChunk" USING GIN ("search" gin_trgm_ops);
-- (pg_trgm já está instalado em produção — ver app/repositories/product.repository.ts).
--
-- Idempotente (IF NOT EXISTS): aplicável manualmente em produção ANTES do
-- deploy do código; `migrate deploy` vira no-op lá e cria em ambientes novos.
--
-- ORDEM DE DEPLOY: DDL -> prisma generate -> deploy do código ->
--                  npm run ai:index -- --apply -> flag ON.
-- Sem o `ai:index`, a tabela fica vazia e o Bitz simplesmente responde sem
-- base de conhecimento (degradação, não erro).

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

-- (docId, ord) é a chave natural do upsert incremental do indexador: reindexar
-- um documento inalterado não escreve nada, e reindexar um documento encurtado
-- apaga só as posições que sobraram.
CREATE UNIQUE INDEX IF NOT EXISTS "AiKnowledgeChunk_docId_ord_key"
  ON "AiKnowledgeChunk"("docId", "ord");

CREATE INDEX IF NOT EXISTS "AiKnowledgeChunk_docId_idx"
  ON "AiKnowledgeChunk"("docId");

-- ROLLBACK (down):
--   DROP TABLE IF EXISTS "AiKnowledgeChunk";
--
-- Reversível sem perda: nenhuma outra tabela aponta para esta, e o conteúdo é
-- 100 % reproduzível a partir dos .md do repositório (`npm run ai:index`).
-- Com a tabela ausente, o retriever devolve lista vazia e o chat segue
-- funcionando sem a base — nenhum caminho de negócio é afetado.
