-- BLOCO G — estoque comprometido por venda pendente (Product.reservedStock)
--
-- EXECUTAR NO SQL EDITOR DO SUPABASE, ANTES do deploy.
--
--   1. Rodar este DDL com o código atual no ar.
--   2. Deploy.
--   3. STOCK_RESERVATION_ENABLED=1 + pm2 restart
--      e NEXT_PUBLIC_STOCK_RESERVATION_ENABLED=true + npm run build.
--
-- ⚠️ COLUNA NOVA em tabela EXISTENTE — e esta tabela é a mais lida do sistema.
-- O Prisma monta todo SELECT com a lista explícita de colunas do schema, nunca
-- `SELECT *`. Um client que conhece `reservedStock` contra um banco sem ela
-- quebra TODA query de Product: catálogo, importação, sincronização de
-- anúncios, sucatas, PDV. Rodar primeiro é seguro — o código atual não conhece
-- a coluna.
--
-- ⚠️ NOT NULL DEFAULT 0, e isso é deliberado (as outras colunas deste projeto
-- foram nuláveis). Aqui o valor é uma CONTAGEM: `NULL` significaria "não sei
-- quanto está comprometido", e toda aritmética de disponibilidade precisaria
-- tratar esse caso. Zero é a verdade para as 16.697 peças existentes — nenhuma
-- delas tem reserva, porque a reserva ainda não existia.
--
-- O Postgres 11+ aplica DEFAULT em coluna nova sem reescrever a tabela
-- (default é armazenado no catálogo), então isto NÃO é um rewrite de 16 mil
-- linhas. Em versões anteriores seria — se este banco fosse PG 10, o caminho
-- correto seria adicionar nulável, backfillar em lotes e só então NOT NULL.

BEGIN;

ALTER TABLE "Product"
  ADD COLUMN IF NOT EXISTS "reservedStock" INTEGER NOT NULL DEFAULT 0;

-- Índice PARCIAL: só as peças efetivamente comprometidas entram. A esmagadora
-- maioria fica em 0 para sempre, e um índice cheio de zeros só custaria
-- escrita em todo INSERT de produto (são 16,7 mil hoje, e a importação cria
-- milhares de uma vez).
--
-- Serve à tela "o que está reservado" e ao diagnóstico de sobre-reserva
-- (reservedStock > stock), que é o sinal de que a venda dupla aconteceu.
CREATE INDEX IF NOT EXISTS "Product_userId_reservedStock_idx"
  ON "Product" ("userId", "reservedStock")
  WHERE "reservedStock" > 0;

COMMIT;

-- ── Verificação (rodar depois do COMMIT) ──
-- SELECT column_name, data_type, is_nullable, column_default
--   FROM information_schema.columns
--  WHERE table_name = 'Product' AND column_name = 'reservedStock';
--   → 1 linha, integer, NO, 0
--
-- Nenhuma peça deve nascer reservada:
-- SELECT count(*) FROM "Product" WHERE "reservedStock" <> 0;   → 0

-- ── ROLLBACK ──
-- ⚠️ Ordem invertida: desligar as flags → deploy do código anterior → só então
-- o DROP. Derrubar a coluna com o código novo no ar quebra toda query de
-- Product, que é a tabela mais lida do sistema.
--
-- BEGIN;
--   DROP INDEX IF EXISTS "Product_userId_reservedStock_idx";
--   ALTER TABLE "Product" DROP COLUMN IF EXISTS "reservedStock";
-- COMMIT;
