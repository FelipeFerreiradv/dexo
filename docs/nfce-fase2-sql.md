# NFC-e (modelo 65) — SQL manual da Fase 2

Convenção do repo: migrations não são versionadas; o SQL abaixo é aplicado
manualmente em PROD **ANTES do deploy do código** desta fase.

Por que é seguro: alargamento puro. A coluna `modelo` nasce com default `'55'`
(linhas existentes = NF-e), os uniques novos são criados ANTES de dropar os
antigos (unicidade nunca fica desprotegida) e nenhum dado existente pode violar
um unique mais largo. A numeração da NF-e 55 continua exatamente do contador
atual.

## APPLY

```sql
BEGIN;

-- NfeSequence: dimensão modelo (numeração 65 independente da 55)
ALTER TABLE "NfeSequence" ADD COLUMN IF NOT EXISTS "modelo" TEXT NOT NULL DEFAULT '55';
CREATE UNIQUE INDEX IF NOT EXISTS "NfeSequence_userId_ambiente_serie_modelo_key"
  ON "NfeSequence"("userId","ambiente","serie","modelo");
DROP INDEX IF EXISTS "NfeSequence_userId_ambiente_serie_key";

-- NfeEmitida: unique alargado com modelo (coluna já existe, default '55')
CREATE UNIQUE INDEX IF NOT EXISTS "NfeEmitida_userId_ambiente_serie_numero_modelo_key"
  ON "NfeEmitida"("userId","ambiente","serie","numero","modelo");
DROP INDEX IF EXISTS "NfeEmitida_userId_ambiente_serie_numero_key";

-- CompanyFiscalConfig: campos NFC-e (todos aditivos)
ALTER TABLE "CompanyFiscalConfig" ADD COLUMN IF NOT EXISTS "serieNfce" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "CompanyFiscalConfig" ADD COLUMN IF NOT EXISTS "cscId" TEXT;
ALTER TABLE "CompanyFiscalConfig" ADD COLUMN IF NOT EXISTS "cscToken" TEXT;
ALTER TABLE "CompanyFiscalConfig" ADD COLUMN IF NOT EXISTS "ncmPadrao" TEXT;

COMMIT;
```

## ROLLBACK

Válido enquanto NÃO houver linhas com `modelo = '65'` (senão os uniques
estreitos não constroem — apague as linhas 65 antes, se necessário).

```sql
BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS "NfeSequence_userId_ambiente_serie_key"
  ON "NfeSequence"("userId","ambiente","serie");
DROP INDEX IF EXISTS "NfeSequence_userId_ambiente_serie_modelo_key";
ALTER TABLE "NfeSequence" DROP COLUMN IF EXISTS "modelo";

CREATE UNIQUE INDEX IF NOT EXISTS "NfeEmitida_userId_ambiente_serie_numero_key"
  ON "NfeEmitida"("userId","ambiente","serie","numero");
DROP INDEX IF EXISTS "NfeEmitida_userId_ambiente_serie_numero_modelo_key";

ALTER TABLE "CompanyFiscalConfig" DROP COLUMN IF EXISTS "serieNfce";
ALTER TABLE "CompanyFiscalConfig" DROP COLUMN IF EXISTS "cscId";
ALTER TABLE "CompanyFiscalConfig" DROP COLUMN IF EXISTS "cscToken";
ALTER TABLE "CompanyFiscalConfig" DROP COLUMN IF EXISTS "ncmPadrao";

COMMIT;
```

## Runbook de deploy

1. Aplicar o SQL APPLY acima (Supabase SQL editor / psql).
2. Deploy do código (o `postinstall` roda `prisma generate` na VPS).
3. Build com `NEXT_PUBLIC_NFCE_ENABLED=true` (e `NEXT_PUBLIC_FISCAL_MODULE_ENABLED` já ligada) quando for ativar a UI.
4. Configurar na UI fiscal: CSC Id + CSC (SEFAZ_DIRECT), Série NFC-e, NCM padrão.
