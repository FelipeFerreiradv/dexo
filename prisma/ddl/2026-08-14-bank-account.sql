-- BLOCO A — conta bancária / caixa (BankAccount) + destino do dinheiro
--
-- EXECUTAR NO SQL EDITOR DO SUPABASE.
--
-- ORDEM DE IMPLANTAÇÃO:
--   1. RODAR ESTE DDL PRIMEIRO, com o código ATUAL ainda no ar.
--   2. Deploy do código novo.
--   3. Só então  BANK_ACCOUNTS_ENABLED=1  +  pm2 restart
--      e  NEXT_PUBLIC_BANK_ACCOUNTS_ENABLED=true  +  npm run build.
--
-- ⚠️ ESTE DDL TEM AS DUAS NATUREZAS, E POR ISSO A ORDEM É A DA MAIS RESTRITIVA.
-- A TABELA nova (BankAccount) permitiria subir o código antes — nada a
-- referencia com a flag desligada. Mas as três COLUNAS novas em tabelas
-- EXISTENTES não permitem: o Prisma monta todo SELECT com a lista explícita de
-- colunas do schema, nunca `SELECT *`, então um client que conhece
-- `bankAccountId` contra um banco que não a tem quebra TODA query de
-- Receivable e Payable — listagem, edição, recebimento, dashboard. Rodar tudo
-- primeiro é seguro: o código atual não conhece nada disto.

BEGIN;

-- ── A conta em si ──
CREATE TABLE IF NOT EXISTS "BankAccount" (
  "id"     TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  -- Nome que o operador reconhece: "Itaú da loja", "Caixa do balcão".
  "name"   TEXT NOT NULL,
  -- Dados bancários OPCIONAIS: "Caixa" e carteira digital não têm agência.
  "bankName"      TEXT,
  "agency"        TEXT,
  "accountNumber" TEXT,
  -- BANCO | CAIXA | CARTEIRA_DIGITAL. TEXT e não enum: tipo novo é editar
  -- app/financeiro/lib/bank-accounts.ts, sem DDL.
  "kind"      TEXT NOT NULL DEFAULT 'BANCO',
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  -- Desativação em vez de exclusão: a conta é referenciada por lançamentos
  -- históricos, e apagá-la responderia "de onde saiu esse dinheiro?" com
  -- silêncio.
  "isActive"  BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "BankAccount_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "BankAccount"
  DROP CONSTRAINT IF EXISTS "BankAccount_userId_fkey";
ALTER TABLE "BankAccount"
  ADD CONSTRAINT "BankAccount_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "BankAccount_userId_isActive_idx"
  ON "BankAccount" ("userId", "isActive");

-- "No máximo UMA conta padrão por usuário" — UNIQUE PARCIAL, que o Prisma não
-- sabe expressar (mesma decisão de CompanyFiscalConfig). A garantia é do
-- banco: sem ela, duas telas marcando padrão ao mesmo tempo deixariam o
-- formulário sugerindo conta diferente a cada carregamento.
CREATE UNIQUE INDEX IF NOT EXISTS "BankAccount_userId_default_uq"
  ON "BankAccount" ("userId")
  WHERE "isDefault";

ALTER TABLE "BankAccount" ENABLE ROW LEVEL SECURITY;

-- ── O destino/origem do dinheiro nos lançamentos ──
-- Todos NULÁVEIS: 178 das 260 contas existentes vieram do legado sem forma de
-- pagamento sequer. Campo obrigatório aqui quebraria todas elas.
--
-- FK com ON DELETE SET NULL: desativar ou apagar uma conta NUNCA pode apagar
-- um lançamento. O caminho normal é `isActive = false`, que preserva o
-- vínculo histórico; o SET NULL é só a rede de segurança do banco.
ALTER TABLE "Receivable" ADD COLUMN IF NOT EXISTS "bankAccountId" TEXT;
ALTER TABLE "Payable" ADD COLUMN IF NOT EXISTS "bankAccountId" TEXT;
ALTER TABLE "ReceivablePayment" ADD COLUMN IF NOT EXISTS "bankAccountId" TEXT;

ALTER TABLE "Receivable"
  DROP CONSTRAINT IF EXISTS "Receivable_bankAccountId_fkey";
ALTER TABLE "Receivable"
  ADD CONSTRAINT "Receivable_bankAccountId_fkey"
  FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Payable"
  DROP CONSTRAINT IF EXISTS "Payable_bankAccountId_fkey";
ALTER TABLE "Payable"
  ADD CONSTRAINT "Payable_bankAccountId_fkey"
  FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ReceivablePayment"
  DROP CONSTRAINT IF EXISTS "ReceivablePayment_bankAccountId_fkey";
ALTER TABLE "ReceivablePayment"
  ADD CONSTRAINT "ReceivablePayment_bankAccountId_fkey"
  FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;

-- ── Verificação (rodar depois do COMMIT) ──
-- SELECT table_name, column_name FROM information_schema.columns
--  WHERE column_name = 'bankAccountId' ORDER BY table_name;
--   → 3 linhas: Payable, Receivable, ReceivablePayment.
--
-- SELECT indexname FROM pg_indexes WHERE tablename = 'BankAccount';
--   → deve incluir "BankAccount_userId_default_uq".
--
-- Prova de que o unique parcial funciona (deve FALHAR na 2a linha):
--   INSERT INTO "BankAccount" ("id","userId","name","isDefault","updatedAt")
--   VALUES ('t1','<seu-user-id>','A',true,now()), ('t2','<seu-user-id>','B',true,now());
--   (rode dentro de uma transação e dê ROLLBACK)

-- ── ROLLBACK ──
-- ⚠️ Ordem invertida: VOLTAR O CÓDIGO primeiro. Derrubar as colunas com o
-- código novo no ar quebra toda query de Receivable e Payable.
--   1. Desligar as flags + pm2 restart + rebuild.
--   2. Deploy do código anterior.
--   3. Só então:
--
-- BEGIN;
--   ALTER TABLE "ReceivablePayment" DROP COLUMN IF EXISTS "bankAccountId";
--   ALTER TABLE "Payable" DROP COLUMN IF EXISTS "bankAccountId";
--   ALTER TABLE "Receivable" DROP COLUMN IF EXISTS "bankAccountId";
--   DROP TABLE IF EXISTS "BankAccount";
-- COMMIT;
