-- BLOCO D — motivo do cancelamento da venda (Receivable)
--
-- EXECUTAR NO SQL EDITOR DO SUPABASE — E AQUI A ORDEM É O CONTRÁRIO DO BLOCO H.
--
-- ORDEM DE IMPLANTAÇÃO:
--   1. RODAR ESTE DDL PRIMEIRO, com o código ATUAL ainda no ar.
--   2. Deploy do código novo.
--   3. Só então  SALE_CANCEL_REASON_ENABLED=1  +  pm2 restart
--      e  NEXT_PUBLIC_SALE_CANCEL_REASON_ENABLED=true  +  npm run build.
--
-- ⚠️⚠️ POR QUE INVERTE EM RELAÇÃO AO BLOCO H: lá a mudança era uma TABELA NOVA,
-- tocada só por código atrás de flag — subir o código antes era inofensivo.
-- Aqui são COLUNAS NOVAS numa tabela EXISTENTE, e o Prisma monta todo SELECT
-- com a lista explícita de colunas do schema (nunca `SELECT *`). Um client que
-- conhece `cancelReasonCode` contra um banco que não a tem quebra TODA query
-- de Receivable — listagem, edição, recebimento, dashboard —, não só o
-- cancelamento. E a flag NÃO protege disso: ela governa a ESCRITA, e a leitura
-- quebrada acontece antes, em qualquer tela.
--
-- Precedente na casa: `Scrap.nickname` (PR #193) passou exatamente por isso.
--
-- Rodar o DDL primeiro é seguro porque o código ATUAL não conhece as colunas:
-- elas são nuláveis, ninguém as lê, ninguém as escreve. O banco fica pronto,
-- esperando.
--
-- A flag de backend continua existindo, mas com outro papel: é o kill-switch
-- da ESCRITA (o motivo é gravado DENTRO da transação do estorno, então poder
-- desligá-lo sem redeploy importa) e o que mantém o `data` do UPDATE
-- byte-idêntico enquanto o recurso não está liberado.
--
-- É 100% ADITIVO: três colunas NULÁVEIS numa tabela existente. Nenhum dado é
-- migrado, nenhuma linha é reescrita, nenhum default é aplicado — toda venda
-- que já existe fica com NULL nas três, que é a leitura correta ("não sabemos
-- o motivo, porque na época não havia campo"). O rollback está no fim.

BEGIN;

-- Código do vocabulário estável (CLIENTE_DESISTIU, ERRO_LANCAMENTO,
-- PECA_DEFEITO, TROCA, OUTRO). TEXT e não enum: motivo novo é editar
-- app/financeiro/lib/cancel-reasons.ts, sem ALTER TYPE no banco.
ALTER TABLE "Receivable" ADD COLUMN IF NOT EXISTS "cancelReasonCode" TEXT;

-- Observação livre do operador. A aplicação trunca em 500 caracteres na
-- fronteira do POST; aqui fica TEXT para nunca rejeitar uma escrita já aceita.
ALTER TABLE "Receivable" ADD COLUMN IF NOT EXISTS "cancelReason" TEXT;

-- Quando foi cancelada. Sem isto, o único carimbo de data seria `updatedAt`,
-- que qualquer edição posterior sobrescreve — e aí "cancelamentos do mês"
-- passa a mentir.
ALTER TABLE "Receivable" ADD COLUMN IF NOT EXISTS "cancelledAt" TIMESTAMP(3);

-- Índice PARCIAL: só as linhas que têm motivo entram. A esmagadora maioria das
-- contas nunca foi cancelada, e um índice cheio de NULL só custaria escrita em
-- todo INSERT de venda. Serve ao relatório "cancelamentos por causa no período".
CREATE INDEX IF NOT EXISTS "Receivable_userId_cancelledAt_idx"
  ON "Receivable" ("userId", "cancelledAt")
  WHERE "cancelledAt" IS NOT NULL;

COMMIT;

-- ── Verificação (rodar depois do COMMIT) ──
-- SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--  WHERE table_name = 'Receivable'
--    AND column_name IN ('cancelReasonCode','cancelReason','cancelledAt');
--
-- Devem vir 3 linhas, todas com is_nullable = 'YES'.
--
-- SELECT indexname FROM pg_indexes
--  WHERE tablename = 'Receivable' AND indexname LIKE '%cancelledAt%';

-- ── ROLLBACK ──
-- ⚠️ Espelha a ordem invertida: para largar estas colunas é preciso VOLTAR O
-- CÓDIGO primeiro (deploy da versão sem elas no schema). Derrubá-las com o
-- código novo no ar quebra TODA query de Receivable, não só o cancelamento.
--   1. Desligar as flags (SALE_CANCEL_REASON_ENABLED + pm2 restart;
--      NEXT_PUBLIC_SALE_CANCEL_REASON_ENABLED + rebuild).
--   2. Deploy do código anterior.
--   3. Só então o DROP abaixo. (Ele apaga os motivos já registrados.)
--
-- BEGIN;
--   DROP INDEX IF EXISTS "Receivable_userId_cancelledAt_idx";
--   ALTER TABLE "Receivable" DROP COLUMN IF EXISTS "cancelledAt";
--   ALTER TABLE "Receivable" DROP COLUMN IF EXISTS "cancelReason";
--   ALTER TABLE "Receivable" DROP COLUMN IF EXISTS "cancelReasonCode";
-- COMMIT;
