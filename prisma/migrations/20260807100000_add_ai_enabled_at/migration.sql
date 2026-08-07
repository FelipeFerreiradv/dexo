-- Bitz (agente de IA) — Fase 1: gate Premium por tenant.
--
-- Uma coluna, nullable, sem default. NULL = sem acesso, que é o estado de
-- 100% dos usuários existentes — por construção, esta migração não muda
-- absolutamente nada para ninguém. O acesso é concedido explicitamente por
-- scripts/set-ai-access.ts, e ainda depende da flag global
-- NEXT_PUBLIC_AI_MODULE_ENABLED estar ligada (dupla camada).
--
-- Espelha deliberadamente User.whatsappEnabledAt: mesmo tipo, mesma semântica,
-- mesmo serviço de entitlement com cache de 60s. Dois irmãos independentes —
-- não foi extraída abstração compartilhada para não tocar no módulo WhatsApp,
-- que está em produção e funcionando.
--
-- Idempotente (IF NOT EXISTS): aplicável manualmente em produção ANTES do
-- deploy do código; `migrate deploy` vira no-op lá e cria em ambientes novos.
--
-- ORDEM DE DEPLOY: DDL -> prisma generate -> deploy do código -> flag ON.

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "aiEnabledAt" TIMESTAMP(3);

-- ROLLBACK (down):
--   ALTER TABLE "User" DROP COLUMN IF EXISTS "aiEnabledAt";
--
-- Reversível sem perda: a coluna só guarda a data de concessão do plano.
-- Antes do rollback, desligar NEXT_PUBLIC_AI_MODULE_ENABLED (rebuild do front)
-- para que nenhum caminho tente ler a coluna.
