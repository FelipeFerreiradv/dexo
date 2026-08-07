-- Bloco A — mais de uma forma de pagamento na mesma venda.
--
-- Tabela FILHA, puramente aditiva: `Receivable.paymentMethod` continua
-- existindo e continua preenchido (com o método PREDOMINANTE — o de maior
-- valor). Nenhuma das 41 leituras de `paymentMethod` muda; venda com uma
-- única forma não grava linha nenhuma aqui e segue byte-idêntica.
--
-- Idempotente (IF NOT EXISTS): aplicável manualmente em produção ANTES do
-- deploy do código; `migrate deploy` vira no-op lá e cria em ambientes novos.
--
-- ORDEM DE DEPLOY: DDL -> prisma generate -> deploy do código -> flag ON.
-- Nunca a flag antes do DDL.

CREATE TABLE IF NOT EXISTS "ReceivablePayment" (
  "id"           TEXT NOT NULL,
  "receivableId" TEXT NOT NULL,
  -- Código estável de app/lib/payment-methods.ts (PIX, DINHEIRO, ...).
  -- TEXT e não enum: a fonte da verdade é a aplicação, e um enum no banco
  -- exigiria DDL a cada forma de pagamento nova.
  "method"       TEXT NOT NULL,
  "amount"       DECIMAL(12,2) NOT NULL,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReceivablePayment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ReceivablePayment_receivableId_idx"
  ON "ReceivablePayment"("receivableId");

-- Cascade espelha ReceivableItem (schema.prisma:1091): apagar a conta leva
-- junto os pagamentos, senão sobrariam linhas órfãs somando dinheiro.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ReceivablePayment_receivableId_fkey'
  ) THEN
    ALTER TABLE "ReceivablePayment"
      ADD CONSTRAINT "ReceivablePayment_receivableId_fkey"
      FOREIGN KEY ("receivableId") REFERENCES "Receivable"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- RLS deny-by-default, igual a todas as tabelas do public (ver
-- supabase/security/enable_rls_all_public.sql). O Prisma conecta como o papel
-- DONO (BYPASSRLS), então isto não afeta o app — apenas barra anon/authenticated
-- via Data API/PostgREST. ENABLE, nunca FORCE.
ALTER TABLE "ReceivablePayment" ENABLE ROW LEVEL SECURITY;
