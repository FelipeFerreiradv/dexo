-- Bitz (agente de IA) — prévia gratuita: teto diário configurável por tenant.
--
-- Uma coluna, nullable, sem default. NULL = "usa o teto padrão do sistema"
-- (AI_MAX_DAILY_PER_TENANT, hoje 5/dia), que é o estado de 100% dos usuários
-- existentes — por construção, esta migração não muda nada para ninguém.
--
-- Quem escreve aqui é EXCLUSIVAMENTE a rota de superadmin
-- (app/routes/superadmin.routes.ts, PATCH .../ai), que aplica um teto próprio
-- no servidor. A coluna NÃO está em `UserUpdate`: PUT /users/me/settings é
-- incapaz de escrevê-la, por construção de tipo, e há teste provando
-- (tests/security/user-settings-mass-assignment.spec.ts).
--
-- ⚠️ POR QUE ESTE ARQUIVO EXISTE, E POR QUE ELE VEM ANTES DO DEPLOY. O Prisma
-- não faz `SELECT *`: ele expande a lista NOMINAL de colunas do schema. Se o
-- código subir antes deste ALTER TABLE, TODA leitura de `User` passa a citar
-- uma coluna que não existe no banco e falha — login inclusive. Não é
-- degradação parcial, é a aplicação inteira fora do ar.
--
-- Idempotente (IF NOT EXISTS): aplicável manualmente em produção ANTES do
-- deploy do código; `migrate deploy` vira no-op lá e cria em ambientes novos.
--
-- ORDEM DE DEPLOY: DDL -> prisma generate -> deploy do código -> flag ON.

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "aiDailyLimit" INTEGER;

-- ROLLBACK (down):
--   ALTER TABLE "User" DROP COLUMN IF EXISTS "aiDailyLimit";
--
-- Reversível sem perda: a coluna só guarda um teto por tenant. Cair fora dela
-- devolve todo mundo ao teto padrão do sistema, que é o comportamento de hoje.
-- Antes do rollback, desligar NEXT_PUBLIC_AI_MODULE_ENABLED (rebuild do front)
-- para que nenhum caminho tente ler a coluna.
