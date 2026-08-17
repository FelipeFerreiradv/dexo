-- BLOCO F — estágio operacional da venda (Receivable.saleStage)
--
-- EXECUTAR NO SQL EDITOR DO SUPABASE.
--
-- ORDEM DE IMPLANTAÇÃO — a mesma dos BLOCOS D e B, e pelo mesmo motivo:
--   1. RODAR ESTE DDL PRIMEIRO, com o código ATUAL ainda no ar.
--   2. Deploy do código novo.
--   3. Só então  SALE_STAGE_ENABLED=1  +  pm2 restart
--      e  NEXT_PUBLIC_SALE_STAGE_ENABLED=true  +  npm run build.
--
-- ⚠️ É COLUNA NOVA EM TABELA EXISTENTE. O Prisma monta todo SELECT com a lista
-- explícita de colunas do schema — nunca `SELECT *`. Um client que conhece
-- `saleStage` contra um banco que não a tem quebra TODA query de Receivable:
-- listagem, edição, recebimento, dashboard. A flag não protege disso, porque
-- ela governa a ESCRITA e a leitura quebrada acontece antes, em qualquer tela.
--
-- Nada aqui depende dos NOMES dos estágios: a coluna é TEXT livre, e a lista
-- vive em `app/financeiro/lib/sale-stage.ts`. Mudar o pipeline no futuro é
-- editar aquele arquivo — este DDL continua valendo.

BEGIN;

-- Estágio operacional. NULL = venda anterior ao recurso; a aplicação DERIVA
-- para o primeiro estágio em read-time (sale-stage.ts:deriveSaleStage), então
-- NÃO há backfill e nenhuma linha é reescrita.
--
-- TEXT e não enum: acrescentar/renomear/reordenar estágio vira edição de
-- arquivo. `ALTER TYPE` não remove valor de enum no Postgres, o que prenderia
-- o pipeline nos primeiros 11 para sempre.
--
-- Sem CHECK constraint de propósito: a validação vive no vocabulário TS
-- (`normalizeSaleStage`), e um CHECK teria o mesmo problema do enum — mudar a
-- lista exigiria DDL. O risco em troca é escrita por fora da aplicação, que
-- aqui não existe (só o Prisma escreve nesta tabela).
ALTER TABLE "Receivable" ADD COLUMN IF NOT EXISTS "saleStage" TEXT;

-- Serve à contagem por coluna do painel de estágios. Não é parcial: assim que
-- o recurso estiver ligado, a maioria das vendas novas terá estágio.
CREATE INDEX IF NOT EXISTS "Receivable_userId_saleStage_idx"
  ON "Receivable" ("userId", "saleStage");

COMMIT;

-- ── Verificação (rodar depois do COMMIT) ──
-- SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--  WHERE table_name = 'Receivable' AND column_name = 'saleStage';
--
-- Deve vir 1 linha, text, is_nullable = 'YES'.
--
-- SELECT indexname FROM pg_indexes
--  WHERE tablename = 'Receivable' AND indexname LIKE '%saleStage%';

-- ── ROLLBACK ──
-- ⚠️ Ordem invertida: para largar a coluna é preciso VOLTAR O CÓDIGO primeiro.
-- Derrubá-la com o código novo no ar quebra TODA query de Receivable.
--   1. Desligar as flags (SALE_STAGE_ENABLED + pm2 restart;
--      NEXT_PUBLIC_SALE_STAGE_ENABLED + rebuild).
--   2. Deploy do código anterior.
--   3. Só então o DROP abaixo. (Ele apaga os estágios já registrados.)
--
-- BEGIN;
--   DROP INDEX IF EXISTS "Receivable_userId_saleStage_idx";
--   ALTER TABLE "Receivable" DROP COLUMN IF EXISTS "saleStage";
-- COMMIT;
