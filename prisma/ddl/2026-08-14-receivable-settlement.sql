-- BLOCO A, 2ª METADE — liquidação (o dinheiro caiu?)
--
-- EXECUTAR NO SQL EDITOR DO SUPABASE.
--
-- ORDEM: DDL PRIMEIRO, deploy depois, flags por último. São COLUNAS NOVAS em
-- tabelas EXISTENTES — o Prisma monta todo SELECT com a lista explícita de
-- colunas, nunca `SELECT *`, então um client que conhece `settledAt` contra um
-- banco sem ela quebra TODA query de Receivable.
--
--   1. Rodar este DDL com o código atual no ar.
--   2. Deploy.
--   3. SALE_SETTLEMENT_ENABLED=1 + pm2 restart
--      e NEXT_PUBLIC_SALE_SETTLEMENT_ENABLED=true + npm run build.
--
-- ⚠️ SÃO SÓ DUAS COLUNAS PORQUE QUASE TUDO É DERIVADO. A regra por forma
-- (PIX/dinheiro/débito/transferência caem no ato; crédito e boleto não) vive
-- em `app/financeiro/lib/settlement.ts` e é aplicada em READ-TIME, do mesmo
-- jeito que o status VENCIDA sempre foi. Estas colunas guardam apenas a
-- EXCEÇÃO: "conferi o extrato, o dinheiro do cartão caiu no dia X".
--
-- Por isso NULL aqui NÃO significa "não caiu" — significa "ninguém marcou", e
-- aí a regra por forma decide. Uma venda no PIX fica com `settledAt` NULL e é
-- lida como liquidada. Não há backfill a fazer, e não faria sentido fazer.

BEGIN;

-- Quando o dinheiro da VENDA caiu (para as vendas sem linhas de pagamento —
-- medido: 77 das 82 com forma).
ALTER TABLE "Receivable" ADD COLUMN IF NOT EXISTS "settledAt" TIMESTAMP(3);

-- Quando ESTA forma caiu. É o que permite "o PIX já caiu, o cartão não" na
-- mesma venda.
ALTER TABLE "ReceivablePayment" ADD COLUMN IF NOT EXISTS "settledAt" TIMESTAMP(3);

-- Índice PARCIAL: só as vendas com marcação explícita entram. A esmagadora
-- maioria fica NULL (derivada), e um índice cheio de NULL só custaria escrita
-- em todo INSERT de venda.
CREATE INDEX IF NOT EXISTS "Receivable_userId_settledAt_idx"
  ON "Receivable" ("userId", "settledAt")
  WHERE "settledAt" IS NOT NULL;

COMMIT;

-- ── Verificação (rodar depois do COMMIT) ──
-- SELECT table_name, column_name, data_type
--   FROM information_schema.columns
--  WHERE column_name = 'settledAt' ORDER BY table_name;
--   → 2 linhas: Receivable e ReceivablePayment, ambas timestamp.

-- ── ROLLBACK ──
-- ⚠️ Ordem invertida: desligar flags → deploy do código anterior → só então:
--
-- BEGIN;
--   DROP INDEX IF EXISTS "Receivable_userId_settledAt_idx";
--   ALTER TABLE "ReceivablePayment" DROP COLUMN IF EXISTS "settledAt";
--   ALTER TABLE "Receivable" DROP COLUMN IF EXISTS "settledAt";
-- COMMIT;
