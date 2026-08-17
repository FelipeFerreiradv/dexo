-- BLOCO B — vendedor da venda (Receivable.sellerUserId)
--
-- EXECUTAR NO SQL EDITOR DO SUPABASE.
--
-- ORDEM DE IMPLANTAÇÃO — a mesma do BLOCO D, e pelo mesmo motivo:
--   1. RODAR ESTE DDL PRIMEIRO, com o código ATUAL ainda no ar.
--   2. Deploy do código novo.
--   3. Só então  SALE_SELLER_ENABLED=1  +  pm2 restart
--      e  NEXT_PUBLIC_SALE_SELLER_ENABLED=true  +  npm run build.
--
-- ⚠️ É COLUNA NOVA EM TABELA EXISTENTE, então a ordem NÃO é a do BLOCO H (que
-- era tabela nova). O Prisma monta todo SELECT com a lista explícita de
-- colunas do schema — nunca `SELECT *`. Um client que conhece `sellerUserId`
-- contra um banco que não a tem quebra TODA query de Receivable: listagem,
-- edição, recebimento, dashboard. A flag não protege disso, porque ela governa
-- a ESCRITA e a leitura quebrada acontece antes, em qualquer tela.
--
-- Rodar primeiro é seguro: o código atual não conhece a coluna, ela é nulável,
-- ninguém a lê e ninguém a escreve. O banco fica pronto, esperando.

BEGIN;

-- Quem VENDEU (pode não ser quem operou o caixa). NULL = venda anterior ao
-- recurso ou lançamento sem vendedor → a tela exibe "—".
--
-- SEM FOREIGN KEY, de propósito — mesma decisão de `Product.createdByUserId`:
-- o Prisma resolve o `include` sem constraint, e um id órfão (colaborador
-- excluído depois da venda) vira relação null em vez de bloquear a exclusão do
-- colaborador ou quebrar a leitura da venda. A venda é um fato histórico e não
-- pode depender de o vendedor continuar no time.
ALTER TABLE "Receivable" ADD COLUMN IF NOT EXISTS "sellerUserId" TEXT;

-- Serve ao relatório "vendas por vendedor no período". Não é parcial (ao
-- contrário do índice do BLOCO D): assim que o recurso estiver ligado, a
-- MAIORIA das vendas novas terá vendedor, então um índice parcial só cresceria
-- até virar o índice cheio com um predicado inútil pendurado.
CREATE INDEX IF NOT EXISTS "Receivable_userId_sellerUserId_idx"
  ON "Receivable" ("userId", "sellerUserId");

COMMIT;

-- ── Verificação (rodar depois do COMMIT) ──
-- SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--  WHERE table_name = 'Receivable' AND column_name = 'sellerUserId';
--
-- Deve vir 1 linha, text, is_nullable = 'YES'.
--
-- SELECT indexname FROM pg_indexes
--  WHERE tablename = 'Receivable' AND indexname LIKE '%sellerUserId%';

-- ── ROLLBACK ──
-- ⚠️ Espelha a ordem invertida: para largar a coluna é preciso VOLTAR O CÓDIGO
-- primeiro. Derrubá-la com o código novo no ar quebra TODA query de Receivable.
--   1. Desligar as flags (SALE_SELLER_ENABLED + pm2 restart;
--      NEXT_PUBLIC_SALE_SELLER_ENABLED + rebuild).
--   2. Deploy do código anterior.
--   3. Só então o DROP abaixo. (Ele apaga os vendedores já registrados.)
--
-- BEGIN;
--   DROP INDEX IF EXISTS "Receivable_userId_sellerUserId_idx";
--   ALTER TABLE "Receivable" DROP COLUMN IF EXISTS "sellerUserId";
-- COMMIT;
