-- Bloco B — entrada no ato + parcelamento do saldo.
--
-- Modelagem: a venda vira 1 conta-ENTRADA (que carrega os itens e baixa o
-- estoque, exatamente pelo caminho de hoje) + N contas-PARCELA, filhas, sem
-- itens. Cada parcela é um Receivable comum — por isso baixa individual,
-- vencimento próprio, VENCIDA derivada em read-time e encargos por parcela
-- funcionam SEM valor novo no enum FinanceStatus e SEM tocar markPaid,
-- summary, relatórios ou dashboards.
--
-- Soma sem dupla contagem: entrada + parcelas = total da venda.
--
-- Idempotente (IF NOT EXISTS): aplicável manualmente em produção ANTES do
-- deploy do código; `migrate deploy` vira no-op lá e cria em ambientes novos.
--
-- ORDEM DE DEPLOY: DDL -> prisma generate -> deploy do código -> flag ON.

ALTER TABLE "Receivable"
  ADD COLUMN IF NOT EXISTS "parentReceivableId" TEXT;

-- 1..N dentro do split. NULL em conta normal — e é o NULL em 100% das linhas
-- existentes que mantém todo o comportamento atual intacto.
ALTER TABLE "Receivable"
  ADD COLUMN IF NOT EXISTS "installmentNumber" INTEGER;

ALTER TABLE "Receivable"
  ADD COLUMN IF NOT EXISTS "installmentTotal" INTEGER;

CREATE INDEX IF NOT EXISTS "Receivable_parentReceivableId_idx"
  ON "Receivable"("parentReceivableId");

-- Auto-relação. ON DELETE SET NULL de propósito, NUNCA CASCADE: apagar a
-- conta-entrada jamais pode sumir com parcelas que o cliente ainda deve. O
-- usecase bloqueia esse delete e manda estornar; isto aqui é a rede de
-- segurança do banco.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Receivable_parentReceivableId_fkey'
  ) THEN
    ALTER TABLE "Receivable"
      ADD CONSTRAINT "Receivable_parentReceivableId_fkey"
      FOREIGN KEY ("parentReceivableId") REFERENCES "Receivable"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
