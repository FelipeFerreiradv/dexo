-- Índice para a taxa de fallback do pipeline de imagem (observabilidade do
-- rembg): getFallbackStats() faz COUNT de SystemLog por action + janela de
-- createdAt; sem índice composto isso é seq scan na tabela inteira de logs.
--
-- Idempotente (IF NOT EXISTS): pode ser aplicado manualmente em produção
-- ANTES do deploy do código — `migrate deploy` vira no-op seguro lá e cria
-- em ambientes novos.
CREATE INDEX IF NOT EXISTS "SystemLog_action_createdAt_idx"
  ON "SystemLog"("action", "createdAt");
