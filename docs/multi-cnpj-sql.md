# Multi-CNPJ por tenant — SQL manual (2 momentos)

Convenção do repo: migrations não são versionadas; o SQL abaixo é aplicado
manualmente em PROD. Esta fase tem **DOIS momentos de SQL**, intercalados com o
deploy do código:

```
SQL-1 (alargar) → deploy PR-1 (backend) → verificação → SQL-2 (trocar uniques)
  → deploy PR-2 (front) → ativar flags
```

Por que é seguro: SQL-1 é alargamento puro (colunas NULL/default + índices que
não afetam o código velho); os uniques antigos de numeração só caem no SQL-2,
DEPOIS de o código novo já gravar `companyFiscalConfigId` em toda linha nova, e
com uniques parciais "legados" cobrindo qualquer linha antiga — a unicidade da
numeração fiscal NUNCA fica desprotegida.

⚠️ NUNCA rodar `prisma db push` cego em PROD: os uniques desta fase são
**parciais** (`WHERE ...`), que o Prisma não representa — só existem no banco e
neste doc. O `schema.prisma` declara apenas índices normais equivalentes.

⚠️ Execução: Supabase SQL editor (roda em transação) ou psql direto (porta
5432, session mode — nunca pelo transaction pooler). As tabelas fiscais são
pequenas (milhares de linhas), então `CREATE INDEX` transacional trava por
milissegundos — mesmo padrão do docs/nfce-fase2-sql.md. Se `NfeEmitida` crescer
para milhões de linhas, trocar por `CREATE INDEX CONCURRENTLY` via psql (um
statement por vez, fora de transação).

## SQL-1 — APPLY (ANTES do deploy do PR-1)

```sql
-- ── Passo 1: colunas (alargamento puro; fast-default do Postgres) ──
BEGIN;
ALTER TABLE "CompanyFiscalConfig" ADD COLUMN IF NOT EXISTS "isDefault" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "NfeSequence"         ADD COLUMN IF NOT EXISTS "companyFiscalConfigId" TEXT;
ALTER TABLE "NfeEmitida"          ADD COLUMN IF NOT EXISTS "companyFiscalConfigId" TEXT;
ALTER TABLE "NfeInutilizacao"     ADD COLUMN IF NOT EXISTS "companyFiscalConfigId" TEXT;
ALTER TABLE "MarketplaceAccount"  ADD COLUMN IF NOT EXISTS "companyFiscalConfigId" TEXT;
COMMIT;

-- ── Passo 2: backfill (idempotente — re-executável) ──
BEGIN;
-- Hoje há no máximo 1 config por user (userId era unique) ⇒ todas viram default.
UPDATE "CompanyFiscalConfig" SET "isDefault" = true WHERE "isDefault" = false;

UPDATE "NfeSequence" ns SET "companyFiscalConfigId" = c."id"
FROM "CompanyFiscalConfig" c
WHERE c."userId" = ns."userId" AND ns."companyFiscalConfigId" IS NULL;

UPDATE "NfeEmitida" ne SET "companyFiscalConfigId" = c."id"
FROM "CompanyFiscalConfig" c
WHERE c."userId" = ne."userId" AND ne."companyFiscalConfigId" IS NULL;

UPDATE "NfeInutilizacao" ni SET "companyFiscalConfigId" = c."id"
FROM "CompanyFiscalConfig" c
WHERE c."userId" = ni."userId" AND ni."companyFiscalConfigId" IS NULL;

-- MarketplaceAccount: NÃO backfillar — NULL significa "usa o CNPJ padrão".
COMMIT;

-- ── Passo 3: índices novos (uniques antigos FICAM até o SQL-2) ──
BEGIN;
-- 3a. No máximo 1 default por user (garantia no banco, não só no código):
CREATE UNIQUE INDEX IF NOT EXISTS "CompanyFiscalConfig_userId_default_key"
  ON "CompanyFiscalConfig"("userId") WHERE "isDefault" = true;

-- 3b. CNPJ não repete dentro do tenant:
CREATE UNIQUE INDEX IF NOT EXISTS "CompanyFiscalConfig_userId_cnpj_key"
  ON "CompanyFiscalConfig"("userId","cnpj");

-- 3c. Lookup por user (substitui o acesso via unique antigo):
CREATE INDEX IF NOT EXISTS "CompanyFiscalConfig_userId_idx"
  ON "CompanyFiscalConfig"("userId");

-- 3d. Numeração por CNPJ (sequence). PARCIAL: linhas NULL (código velho na
--     janela) escapam — quem as protege é o unique antigo, ainda de pé.
CREATE UNIQUE INDEX IF NOT EXISTS "NfeSequence_cfcId_ambiente_serie_modelo_key"
  ON "NfeSequence"("companyFiscalConfigId","ambiente","serie","modelo")
  WHERE "companyFiscalConfigId" IS NOT NULL;

-- 3e. Unicidade da nota por CNPJ. Também parcial em numero > 0: drafts usam
--     placeholder NEGATIVO -(count+1) por user (nfe.repository.ts) — dois
--     drafts de configs distintas podem ter o mesmo -1 sem problema.
CREATE UNIQUE INDEX IF NOT EXISTS "NfeEmitida_cfcId_ambiente_serie_numero_modelo_key"
  ON "NfeEmitida"("companyFiscalConfigId","ambiente","serie","numero","modelo")
  WHERE "companyFiscalConfigId" IS NOT NULL AND "numero" > 0;

CREATE INDEX IF NOT EXISTS "NfeEmitida_companyFiscalConfigId_idx"
  ON "NfeEmitida"("companyFiscalConfigId");

CREATE INDEX IF NOT EXISTS "MarketplaceAccount_companyFiscalConfigId_idx"
  ON "MarketplaceAccount"("companyFiscalConfigId");
COMMIT;
```

Sem FOREIGN KEY nas colunas novas (mesmo padrão do módulo fiscal): evita lock
de validação em tabela quente; a posse é validada na aplicação (sempre por
`userId`).

### SQL-1 — ROLLBACK

```sql
-- Índices (qualquer momento, sem pré-condição):
BEGIN;
DROP INDEX IF EXISTS "NfeEmitida_cfcId_ambiente_serie_numero_modelo_key";
DROP INDEX IF EXISTS "NfeSequence_cfcId_ambiente_serie_modelo_key";
DROP INDEX IF EXISTS "CompanyFiscalConfig_userId_cnpj_key";
DROP INDEX IF EXISTS "CompanyFiscalConfig_userId_default_key";
DROP INDEX IF EXISTS "CompanyFiscalConfig_userId_idx";
DROP INDEX IF EXISTS "NfeEmitida_companyFiscalConfigId_idx";
DROP INDEX IF EXISTS "MarketplaceAccount_companyFiscalConfigId_idx";
COMMIT;

-- Colunas: normalmente NÃO dropar (são inertes para o código velho — manter é
-- mais seguro). Se precisar mesmo, só após rollback do código:
-- BEGIN;
-- ALTER TABLE "MarketplaceAccount"  DROP COLUMN IF EXISTS "companyFiscalConfigId";
-- ALTER TABLE "NfeInutilizacao"     DROP COLUMN IF EXISTS "companyFiscalConfigId";
-- ALTER TABLE "NfeEmitida"          DROP COLUMN IF EXISTS "companyFiscalConfigId";
-- ALTER TABLE "NfeSequence"         DROP COLUMN IF EXISTS "companyFiscalConfigId";
-- ALTER TABLE "CompanyFiscalConfig" DROP COLUMN IF EXISTS "isDefault";
-- COMMIT;
```

## Verificação entre SQL-1/PR-1 e SQL-2

Após o deploy do PR-1, rodar o REPARO da janela e as verificações:

```sql
-- REPARO da janela SQL-1→deploy: config criada pelo CÓDIGO VELHO nesse
-- intervalo nasce com isDefault=false (o backfill do SQL-1 já tinha rodado).
-- Marca como padrão a config de todo user que não tem NENHUM padrão
-- (guardado: só toca o caso "única config sem padrão" — multi-CNPJ ainda
-- não existe antes da flag). Idempotente; rodar de novo antes do SQL-2.
UPDATE "CompanyFiscalConfig" c SET "isDefault" = true
WHERE NOT c."isDefault"
  AND NOT EXISTS (
    SELECT 1 FROM "CompanyFiscalConfig" d
    WHERE d."userId" = c."userId" AND d."isDefault"
  )
  AND NOT EXISTS (
    SELECT 1 FROM "CompanyFiscalConfig" e
    WHERE e."userId" = c."userId" AND e."id" <> c."id"
  );

-- Deve retornar 0 (nenhuma emissão nova sem configId):
SELECT count(*) FROM "NfeEmitida"
WHERE "companyFiscalConfigId" IS NULL
  AND "createdAt" > '<timestamp do deploy do PR-1>';

-- Deve retornar 0 (nenhum user sem config padrão):
SELECT count(DISTINCT "userId") FROM "CompanyFiscalConfig" c
WHERE NOT EXISTS (
  SELECT 1 FROM "CompanyFiscalConfig" d
  WHERE d."userId" = c."userId" AND d."isDefault"
);

-- Sequences adotadas (informativo):
SELECT count(*) FILTER (WHERE "companyFiscalConfigId" IS NULL) AS legadas,
       count(*) FILTER (WHERE "companyFiscalConfigId" IS NOT NULL) AS adotadas
FROM "NfeSequence";
```

## SQL-2 — APPLY (após PR-1 estável; PRÉ-REQUISITO para ligar `FISCAL_MULTI_CNPJ_ENABLED`)

```sql
-- ── Passo 4: sweep — adota linhas NULL criadas por código velho na janela ──
BEGIN;
-- Reparo da janela ANTES do sweep (mesmo statement da seção Verificação;
-- idempotente): garante que todo user tem exatamente 1 config padrão —
-- sem isso, o sweep abaixo pularia o tenant e deixaria linhas NULL órfãs.
UPDATE "CompanyFiscalConfig" c SET "isDefault" = true
WHERE NOT c."isDefault"
  AND NOT EXISTS (
    SELECT 1 FROM "CompanyFiscalConfig" d
    WHERE d."userId" = c."userId" AND d."isDefault"
  )
  AND NOT EXISTS (
    SELECT 1 FROM "CompanyFiscalConfig" e
    WHERE e."userId" = c."userId" AND e."id" <> c."id"
  );

UPDATE "NfeSequence" ns SET "companyFiscalConfigId" = c."id"
FROM "CompanyFiscalConfig" c
WHERE c."userId" = ns."userId" AND c."isDefault" AND ns."companyFiscalConfigId" IS NULL;

UPDATE "NfeEmitida" ne SET "companyFiscalConfigId" = c."id"
FROM "CompanyFiscalConfig" c
WHERE c."userId" = ne."userId" AND c."isDefault" AND ne."companyFiscalConfigId" IS NULL;

UPDATE "NfeInutilizacao" ni SET "companyFiscalConfigId" = c."id"
FROM "CompanyFiscalConfig" c
WHERE c."userId" = ni."userId" AND c."isDefault" AND ni."companyFiscalConfigId" IS NULL;
COMMIT;

-- Verificação (todas devem retornar 0):
SELECT count(*) FROM "NfeSequence" WHERE "companyFiscalConfigId" IS NULL;
SELECT count(*) FROM "NfeEmitida"  WHERE "companyFiscalConfigId" IS NULL;

-- ── Passo 5: uniques parciais LEGADOS antes de dropar os antigos (unicidade
--    nunca fica desprotegida) + índices normais das chaves antigas ──
BEGIN;
CREATE UNIQUE INDEX IF NOT EXISTS "NfeSequence_legacy_null_key"
  ON "NfeSequence"("userId","ambiente","serie","modelo")
  WHERE "companyFiscalConfigId" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "NfeEmitida_legacy_null_key"
  ON "NfeEmitida"("userId","ambiente","serie","numero","modelo")
  WHERE "companyFiscalConfigId" IS NULL;

CREATE INDEX IF NOT EXISTS "NfeSequence_userId_ambiente_serie_modelo_idx"
  ON "NfeSequence"("userId","ambiente","serie","modelo");
CREATE INDEX IF NOT EXISTS "NfeEmitida_userId_ambiente_serie_numero_modelo_idx"
  ON "NfeEmitida"("userId","ambiente","serie","numero","modelo");
COMMIT;

-- ── Passo 6: derruba os uniques antigos (é O passo que permite 2 CNPJs
--    usarem a mesma serie/numero — e que permite a 2ª CONFIG existir) ──
BEGIN;
DROP INDEX IF EXISTS "NfeSequence_userId_ambiente_serie_modelo_key";
DROP INDEX IF EXISTS "NfeEmitida_userId_ambiente_serie_numero_modelo_key";
-- SEM este drop, o POST /fiscal/companies (2º CNPJ) morre em P2002: o unique
-- 1:1 da era antiga (criado na migration F0 do módulo fiscal) impede a 2ª
-- linha por userId. O unique parcial (userId) WHERE isDefault (SQL-1 3a) é
-- quem garante "1 padrão por user" daqui em diante.
DROP INDEX IF EXISTS "CompanyFiscalConfig_userId_key";
COMMIT;
```

### SQL-2 — ROLLBACK

Válido enquanto nenhum tenant tiver 2 CNPJs com colisão de numeração (antes de
ligar a flag: sempre; depois: rodar a pré-checagem — se retornar linhas, o
rollback de banco não é mais possível e o rollback passa a ser só de flag).

```sql
-- Pré-checagem de colisão (TODAS devem retornar 0 linhas):
SELECT "userId","ambiente","serie","numero","modelo", count(*)
FROM "NfeEmitida" WHERE "numero" > 0
GROUP BY 1,2,3,4,5 HAVING count(*) > 1;

SELECT "userId","ambiente","serie","modelo", count(*)
FROM "NfeSequence" GROUP BY 1,2,3,4 HAVING count(*) > 1;

-- Users com mais de 1 config (impede recriar o unique 1:1 de userId):
SELECT "userId", count(*) FROM "CompanyFiscalConfig"
GROUP BY 1 HAVING count(*) > 1;

-- Recria os uniques antigos ANTES de dropar os legados:
BEGIN;
CREATE UNIQUE INDEX IF NOT EXISTS "NfeSequence_userId_ambiente_serie_modelo_key"
  ON "NfeSequence"("userId","ambiente","serie","modelo");
CREATE UNIQUE INDEX IF NOT EXISTS "NfeEmitida_userId_ambiente_serie_numero_modelo_key"
  ON "NfeEmitida"("userId","ambiente","serie","numero","modelo");
CREATE UNIQUE INDEX IF NOT EXISTS "CompanyFiscalConfig_userId_key"
  ON "CompanyFiscalConfig"("userId");
DROP INDEX IF EXISTS "NfeSequence_legacy_null_key";
DROP INDEX IF EXISTS "NfeEmitida_legacy_null_key";
DROP INDEX IF EXISTS "NfeSequence_userId_ambiente_serie_modelo_idx";
DROP INDEX IF EXISTS "NfeEmitida_userId_ambiente_serie_numero_modelo_idx";
COMMIT;
```

## Runbook de deploy e rollback pareado

1. Aplicar **SQL-1** (idempotente).
2. Deploy do **PR-1** (backend). Sem flag, comportamento idêntico ao atual.
3. Rodar a **verificação** acima por alguns dias de emissão normal.
4. Aplicar **SQL-2**.
5. Deploy do **PR-2** (front) + `FISCAL_MULTI_CNPJ_ENABLED=true` no `.env` da
   API + rebuild do front com `NEXT_PUBLIC_MULTI_CNPJ_ENABLED=true`.

⚠️ **Par proibido: código do PR-1 revertido + banco pós-SQL-2.** Se precisar
voltar o binário para antes do PR-1 estando o SQL-2 aplicado, rodar ANTES o
ROLLBACK do SQL-2 (com a pré-checagem de colisão). O código velho consulta a
sequence por `userId` e, sem o unique antigo, a primeira emissão de uma
combinação nova poderia criar contador duplicado. Na dúvida: em vez de reverter
o binário, desligar `FISCAL_MULTI_CNPJ_ENABLED` (congela criação de CNPJs; a
emissão pelo default continua correta) — esse é o rollback recomendado.

## Nota sobre o Prisma Client — REQUISITO DURO

O `schema.prisma` desta fase remove o `@unique` de `CompanyFiscalConfig.userId`
e os `@@unique` de numeração (viram `@@index`).

⚠️ **O código do PR-1 EXIGE o client regenerado do schema novo.** O
`(prisma as any)` só silencia o TypeScript — a validação de RUNTIME do Prisma
continua: rodar o código novo com o client velho quebra o módulo fiscal
inteiro (`Unknown argument isDefault/companyFiscalConfigId` em todo caminho,
inclusive os legados). No deploy da VPS isso é garantido pela ordem natural
(`npm install` → `postinstall: prisma generate` → restart do pm2) — NUNCA
reiniciar o pm2 no meio de um install falhado. Em dev/worktree: regenerar com
o binário pinado 6.2.1 ANTES de rodar `npm run api` com este código (nunca
`npx prisma` de outra versão — ver memória do projeto). O caminho inverso
(código VELHO + client novo) não existe em PROD; os scripts de
migração/ops foram atualizados neste PR para formas válidas nos dois clients.
