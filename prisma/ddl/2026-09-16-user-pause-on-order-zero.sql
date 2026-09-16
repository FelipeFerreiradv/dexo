-- Preferência do tenant: pausar anúncios quando a baixa de um PEDIDO zera a
-- peça (User.pauseListingsOnOrderZero).
--
-- EXECUTAR VIA psql "$DIRECT_URL" NA VPS (ou SQL editor), ANTES do deploy.
--
-- 🔴 ORDEM CRÍTICA — igual ao precedente user-reopen-listings-on-sale-cancel:
-- coluna NOVA em tabela EXISTENTE, e o `authMiddleware` lê o User (via
-- findUnique sem select) em TODA requisição autenticada. Client novo contra
-- banco sem a coluna quebraria o LOGIN inteiro. Rodar este DDL primeiro é
-- seguro: o código atual não conhece a coluna, ela é NOT NULL DEFAULT false e
-- ninguém a lê.
--
-- Depois do deploy: `prisma generate` manual na VPS (deploy sem npm ci não
-- roda o postinstall) e restart. Sem o generate, a leitura da preferência cai
-- no catch e o comportamento fica o de sempre — fail-safe, mas inerte.
--
-- POR QUE default FALSE: pausar-ao-zerar pelo pedido é a correção certa (o ML
-- recusa zerar quantidade de anúncio fora do ar; pausar é o que fecha o
-- caminho do oversell na origem), mas muda o comportamento VISÍVEL do
-- lojista. Nasce desligada e liga cliente a cliente:
--   UPDATE "User" SET "pauseListingsOnOrderZero" = true WHERE email = '...';
-- Primeiro candidato combinado: leonardo.lima.borges@outlook.com.br (Jotabê).

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "pauseListingsOnOrderZero" BOOLEAN NOT NULL DEFAULT false;
