-- "Criado por" real (autor/colaborador): grava request.user.id na criação de
-- produto/anúncio, distinto do userId (dono/tenant = dataOwnerId). Aditivo e
-- nulável: NULL = registro legado ou fluxo de sistema (import/autodetect/
-- scripts/sync) → UI exibe "—". Idempotente (IF NOT EXISTS): pode ser aplicado
-- manualmente em produção ANTES do deploy do código — `migrate deploy` vira
-- no-op seguro lá e cria em ambientes novos.
-- SEM FK física (decisão): exclusão de colaborador nunca passa a falhar por
-- constraint nova; o Prisma resolve o include sem FK e id órfão vira relação
-- null → "—".

-- SEM índice na coluna (decisão de perf): nenhuma query filtra/ordena por
-- createdByUserId — a leitura resolve pela PK de "User" via include. Índice
-- aqui seria só amplificação de escrita nas duas tabelas mais quentes
-- (sync de estoque/preço em Product, sweep de status em ProductListing).
-- Se um dia nascer filtro "criados por X", o índice entra junto do consumidor.

-- AlterTable
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "createdByUserId" TEXT;
ALTER TABLE "ProductListing" ADD COLUMN IF NOT EXISTS "createdByUserId" TEXT;
