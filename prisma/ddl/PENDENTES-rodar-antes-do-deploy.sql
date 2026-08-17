-- ═══════════════════════════════════════════════════════════════════════════
--  DDLs PENDENTES — rodar TUDO de uma vez, ANTES do deploy
--  Gerado em 14/08/2026 · Dexo / ghd-plataform
-- ═══════════════════════════════════════════════════════════════════════════
--
-- COMO USAR: copie este arquivo inteiro, cole no SQL editor do Supabase e
-- execute. É uma transação só — ou tudo entra, ou nada entra.
--
-- ⚠️ RODE ANTES DO DEPLOY DO CÓDIGO NOVO.
-- Todas as adições abaixo são COLUNAS NOVAS em tabelas EXISTENTES. O Prisma
-- monta todo SELECT com a lista explícita de colunas do schema — nunca
-- `SELECT *`. Um client que conhece `sellerUserId` contra um banco que não a
-- tem quebra TODA query de Receivable: listagem, edição, recebimento,
-- dashboard. Não é a funcionalidade que falha; é a tela inteira.
--
-- Rodar primeiro é seguro: o código ATUAL não conhece nenhuma destas colunas.
-- Elas são nuláveis, ninguém as lê e ninguém as escreve. O banco fica pronto,
-- esperando.
--
-- É 100% ADITIVO: nenhuma coluna existente é tocada, nenhum dado é migrado,
-- nenhuma linha é reescrita, nenhum default é aplicado.
--
-- CONTEÚDO (equivalente aos três arquivos individuais, que seguem valendo):
--   · BLOCO B — Receivable.sellerUserId          (2026-08-14-receivable-seller.sql)
--   · BLOCO F — Receivable.saleStage             (2026-08-14-receivable-sale-stage.sql)
--   · BLOCO A — Receivable/ReceivablePayment.settledAt
--                                                (2026-08-14-receivable-settlement.sql)
--
-- JÁ APLICADOS (não estão aqui, conferido no banco em 14/08):
--   ReceivableEvent · BankAccount · cancelReason* · cancelledAt · bankAccountId
--
-- DEPOIS DO DEPLOY, ligar as flags:
--   .env da API  →  SALE_SELLER_ENABLED=1  SALE_STAGE_ENABLED=1
--                   SALE_SETTLEMENT_ENABLED=1        + pm2 restart
--   build        →  NEXT_PUBLIC_SALE_SELLER_ENABLED=true
--                   NEXT_PUBLIC_SALE_STAGE_ENABLED=true
--                   NEXT_PUBLIC_SALE_SETTLEMENT_ENABLED=true   + npm run build

BEGIN;

-- ── BLOCO B · vendedor da venda ────────────────────────────────────────────
-- Quem VENDEU, que pode não ser quem operou o caixa (o caixa lança a venda do
-- balconista, e a comissão é de quem vendeu). NULL = venda anterior ao recurso
-- → a tela exibe "—".
--
-- SEM FOREIGN KEY, de propósito — mesma decisão de `Product.createdByUserId`:
-- a venda é um fato histórico e não pode depender de o vendedor continuar no
-- time. Colaborador excluído vira relação null em vez de bloquear a exclusão
-- ou quebrar a leitura da venda.
ALTER TABLE "Receivable" ADD COLUMN IF NOT EXISTS "sellerUserId" TEXT;

CREATE INDEX IF NOT EXISTS "Receivable_userId_sellerUserId_idx"
  ON "Receivable" ("userId", "sellerUserId");

-- ── BLOCO F · estágio operacional da venda ─────────────────────────────────
-- Segunda dimensão, ortogonal ao status financeiro: uma venda pode estar PAGA
-- e ainda "em separação". NULL = venda anterior ao recurso, e a aplicação
-- DERIVA para o primeiro estágio em read-time — não há backfill.
--
-- TEXT e não enum: acrescentar/renomear/reordenar estágio vira edição de
-- arquivo. `ALTER TYPE` não remove valor de enum no Postgres, o que prenderia
-- o pipeline nos 11 primeiros para sempre.
--
-- Sem CHECK constraint de propósito: a validação vive no vocabulário TS, e um
-- CHECK teria o mesmo problema do enum.
ALTER TABLE "Receivable" ADD COLUMN IF NOT EXISTS "saleStage" TEXT;

CREATE INDEX IF NOT EXISTS "Receivable_userId_saleStage_idx"
  ON "Receivable" ("userId", "saleStage");

-- ── BLOCO A (2ª metade) · liquidação ───────────────────────────────────────
-- Quando o dinheiro DE FATO caiu, distinto de `paidAt` ("a venda foi baixada,
-- o estoque saiu"). Só é gravado quando alguém MARCA explicitamente: no caso
-- comum a liquidação é DERIVADA da forma de pagamento em read-time
-- (dinheiro/PIX/débito/transferência caem no ato; crédito e boleto, não).
--
-- ⚠️ NULL aqui NÃO significa "não caiu" — significa "ninguém marcou", e aí a
-- regra por forma decide. Uma venda no PIX fica NULL e é lida como liquidada.
-- Não há backfill a fazer, e não faria sentido fazer.
ALTER TABLE "Receivable" ADD COLUMN IF NOT EXISTS "settledAt" TIMESTAMP(3);

-- Por forma: é o que permite "o PIX já caiu, o cartão não" na MESMA venda.
ALTER TABLE "ReceivablePayment" ADD COLUMN IF NOT EXISTS "settledAt" TIMESTAMP(3);

-- Índice PARCIAL: só as vendas com marcação explícita entram. A esmagadora
-- maioria fica NULL (derivada), e um índice cheio de NULL só custaria escrita
-- em todo INSERT de venda.
CREATE INDEX IF NOT EXISTS "Receivable_userId_settledAt_idx"
  ON "Receivable" ("userId", "settledAt")
  WHERE "settledAt" IS NOT NULL;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
--  VERIFICAÇÃO — rode depois do COMMIT. Devem vir 4 linhas, todas com "OK".
-- ═══════════════════════════════════════════════════════════════════════════
--
-- SELECT 'Receivable.sellerUserId' AS coluna,
--        CASE WHEN EXISTS(SELECT 1 FROM information_schema.columns
--                          WHERE table_name='Receivable' AND column_name='sellerUserId')
--             THEN 'OK' ELSE 'FALTA' END AS estado
-- UNION ALL SELECT 'Receivable.saleStage',
--        CASE WHEN EXISTS(SELECT 1 FROM information_schema.columns
--                          WHERE table_name='Receivable' AND column_name='saleStage')
--             THEN 'OK' ELSE 'FALTA' END
-- UNION ALL SELECT 'Receivable.settledAt',
--        CASE WHEN EXISTS(SELECT 1 FROM information_schema.columns
--                          WHERE table_name='Receivable' AND column_name='settledAt')
--             THEN 'OK' ELSE 'FALTA' END
-- UNION ALL SELECT 'ReceivablePayment.settledAt',
--        CASE WHEN EXISTS(SELECT 1 FROM information_schema.columns
--                          WHERE table_name='ReceivablePayment' AND column_name='settledAt')
--             THEN 'OK' ELSE 'FALTA' END;

-- ═══════════════════════════════════════════════════════════════════════════
--  ROLLBACK — ⚠️ ordem INVERTIDA
-- ═══════════════════════════════════════════════════════════════════════════
-- Derrubar estas colunas com o código novo no ar quebra toda query de
-- Receivable. A ordem é:
--   1. desligar as 6 flags (pm2 restart + rebuild);
--   2. deploy do código anterior;
--   3. só então o bloco abaixo.
--
-- BEGIN;
--   DROP INDEX IF EXISTS "Receivable_userId_settledAt_idx";
--   ALTER TABLE "ReceivablePayment" DROP COLUMN IF EXISTS "settledAt";
--   ALTER TABLE "Receivable" DROP COLUMN IF EXISTS "settledAt";
--   DROP INDEX IF EXISTS "Receivable_userId_saleStage_idx";
--   ALTER TABLE "Receivable" DROP COLUMN IF EXISTS "saleStage";
--   DROP INDEX IF EXISTS "Receivable_userId_sellerUserId_idx";
--   ALTER TABLE "Receivable" DROP COLUMN IF EXISTS "sellerUserId";
-- COMMIT;
