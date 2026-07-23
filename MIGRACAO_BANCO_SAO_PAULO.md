# Runbook — Migração do banco: Supabase Ohio (us-east-2) → Supabase São Paulo (sa-east-1)

> **Motivo:** RTT medido VPS→banco = **~148ms por query** (SP↔Ohio). Movendo o banco para
> São Paulo o RTT cai para ~5-15ms. A VPS **não muda** (IP intacto → Shopee allowlist e
> webhooks intactos), o storage local **não muda**, o código **não muda**: o cutover é a
> troca de 2 linhas do `.env` com um `pg_dump`/`pg_restore` no meio.
>
> **Base:** inventário de 23/07/2026 (3 agentes, ~110 verificações no código) + refutação
> adversarial do runbook (3 lentes, 20 correções incorporadas nesta v2). Projeto novo:
> `dexo-brasil` (sa-east-1, Medium, Data API OFF, Pool Size 40 ✓ — ref `tufjvwekqhlgfutohhtl`).
>
> **URLs (confirmadas na tela Connect; shape idêntico ao atual — só muda host/ref):**
>
> | | Ohio (atual) | São Paulo (novo) |
> |---|---|---|
> | `DATABASE_URL` | `postgres.lovzybhtgmfyasqimnba@aws-1-us-east-2.pooler.supabase.com:6543/postgres?pgbouncer=true` | `postgres.tufjvwekqhlgfutohhtl@aws-0-sa-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true` |
> | `DIRECT_URL` | `postgres.lovzybhtgmfyasqimnba@aws-1-us-east-2.pooler.supabase.com:5432/postgres` | `postgres.tufjvwekqhlgfutohhtl@aws-0-sa-east-1.pooler.supabase.com:5432/postgres` |
>
> ⚠️ O novo é `aws-0-`, o antigo é `aws-1-` — copiar literal, não "corrigir".
>
> **Janela realista: 20-30min (confirmar no ensaio). Anunciar 60min.**
> **Agenda definida: 20:00 America/Sao_Paulo** (horário sem uso; clientes avisados ✓).
> Durante o freeze o site responde 502.
>
> **Descoberta do Ohio (23/07) — fatos confirmados:** PostgreSQL **17.6** (mesma major do
> SP novo; client 17.10 instalado na VPS ✓). Zero triggers/views/matviews fantasma.
> Extensões: pg_trgm (public), **unaccent (public — replicar no SP!)**, pgcrypto/uuid-ossp/
> pg_stat_statements (schema `extensions`, padrão Supabase), supabase_vault. Setting manual
> único: `idle_in_transaction_session_timeout=120s` em nível de **DATABASE**.

---

## Fatos que sustentam este runbook (não pular a leitura)

1. **Só 2 envs de banco existem**: `DATABASE_URL` + `DIRECT_URL` (obrigatórias no boot —
   `env.ts` faz `exit(1)` se faltar). Zero conexão fora do Prisma. Trocar o `.env` +
   restart cobre 100% dos caminhos.
2. **`prisma/migrations` está CONGELADO desde 26/05** — schema evolui por SQL manual.
   **NUNCA rodar `prisma migrate deploy/dev` contra o banco novo.** Schema+dados = dump.
3. **O freeze é dos 4 processos pm2 — INCLUSIVE o `dexo-frontend`**: o login do NextAuth
   **escreve** no banco (rehash de senha em `app/lib/auth.ts:41`).
4. **O que protege o Prisma do RLS deny-by-default é OWNERSHIP** (ENABLE, nunca FORCE):
   restore como `postgres`, e a validação PROVA o owner antes do swap (gate 3.5-d).
5. **O projeto novo re-concede grants a `anon`/`authenticated` em cada tabela restaurada**
   → re-rodar `supabase/security/revoke_anon_authenticated.sql` pós-restore é OBRIGATÓRIO
   (no ensaio também, senão o check de grants dá falso-positivo).
6. **`pg_dump --schema=public` NÃO leva `CREATE EXTENSION`** — `pg_trgm` já criada no SP ✓.
7. **`ALTER ROLE/DATABASE ... SET` não vem no dump** — `idle_in_transaction_session_timeout=120s`
   já aplicado no SP ✓ (por isso o restore roda com `PGOPTIONS` neutralizando o timeout).
8. **NfeSequence é DADO** (tabela, não sequence) — dump sem freeze total = risco de
   **NF-e com número duplicado na SEFAZ**. E o rollback pós-swap tem gate fiscal próprio (Fase 4).
9. **Senha do banco novo: só alfanumérica** (`@:#/%` quebra o parse da URL do Prisma).
10. **Nunca `pm2 restart --update-env`**; deploys/religadas sempre simples (portas pinadas).
11. **Diffs de validação sempre com `LC_ALL=C sort`** — Ohio e SP podem ter glibc/major
    diferentes e ordenar texto diferente; diff sem normalização = falso positivo às 3h.

---

## FASE 0 — Descoberta e preparação (hoje, zero impacto; rodar na VPS)

```bash
mkdir -p /root/cutover && cd /root/cutover
```

Shapes atuais (conferência):

```bash
grep -E '^(DATABASE_URL|DIRECT_URL|PRISMA_CONNECTION_LIMIT)' /var/www/dexo/.env | sed 's/:[^:@]*@/:***@/'
```

Descoberta no Ohio (versão, extensões, objetos fantasma, settings manuais — guardar):

```bash
OHIO=$(sed -n 's/^DIRECT_URL=//p' /var/www/dexo/.env | tr -d '"')
psql "$OHIO" -c "SELECT version();" \
  -c "SELECT e.extname, n.nspname, e.extversion FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace ORDER BY 1;" \
  -c "SELECT tgname, c.relname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT tgisinternal;" \
  -c "SELECT viewname FROM pg_views WHERE schemaname='public';" \
  -c "SELECT matviewname FROM pg_matviews WHERE schemaname='public';" \
  -c "SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public';" \
  -c "SELECT coalesce(r.rolname,'-') AS role, coalesce(d.datname,'-') AS db, unnest(s.setconfig) AS setting FROM pg_db_role_setting s LEFT JOIN pg_roles r ON r.oid=s.setrole LEFT JOIN pg_database d ON d.oid=s.setdatabase;" \
  | tee /root/cutover/descoberta-ohio.txt
```

Baseline de performance do Ohio (para comparar na Fase 5):

```bash
psql "$OHIO" -c "SELECT calls, round(mean_exec_time::numeric,1) AS mean_ms, round(total_exec_time::numeric) AS total_ms, left(query,90) AS query FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 20;" > /root/cutover/pgss-baseline-ohio.txt
```

**Auditoria de escritores fora do pm2** (cron/timers/sessões esquecidas — TEM que estar limpo):

```bash
crontab -l ; sudo crontab -l 2>/dev/null ; ls /etc/cron.d/ /etc/cron.daily/ 2>/dev/null ; systemctl list-timers --all | head -25 ; screen -ls 2>/dev/null ; tmux ls 2>/dev/null ; ps aux | grep -E 'tsx|psql' | grep -v grep
```

Client tools (dump/restore devem usar client ≥ maior major entre os 2 projetos):

```bash
sudo sh -c 'apt-get install -y postgresql-common && /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y && apt-get install -y postgresql-client-17' && pg_dump --version
```

Disco para o dump (~0,5-1GB): `df -h /root`

## FASE 1 — Setup do projeto `dexo-brasil` (D-7..D-1)

- [x] Região **sa-east-1**, compute **Medium** ✓ (resize REINICIA o banco — nunca na janela).
- [x] **Data API OFF** ✓ · [x] **Pool Size = 40** ✓
- [ ] **GitHub integration**: conferir em Project Settings → Integrations e **desconectar**
      `FelipeFerreiradv/dexo` se estiver ligada (deploy automático de schema = risco sem uso).
- [ ] **Senha só alfanumérica** (se tiver `@:#/%` → Reset database password).
- [ ] **Enforce SSL on incoming connections** = ON (Settings → Database, igual ao Ohio).
- [ ] **Backups/PITR** habilitados (banco fiscal!).
- [ ] **Spend cap/billing da org** revisado para 2 projetos em paralelo no overlap.
- [ ] **Network Restrictions**: `72.61.57.38/32` (IP da VPS). SQL Editor continua funcionando.
- [x] No SQL Editor do `dexo-brasil` (já feito):

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
ALTER ROLE postgres SET idle_in_transaction_session_timeout = '120s';
```

- [ ] **Complemento pós-descoberta** (SQL Editor do `dexo-brasil`) — paridade exata com o
      Ohio: a extensão `unaccent` existe no `public` de lá (sem ela o diff de objetos da
      validação falha com falso positivo), e o timeout do playbook está em nível de
      DATABASE:

```sql
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public;
ALTER DATABASE postgres SET idle_in_transaction_session_timeout = '120s';
```

- [ ] **Reboot planejado da VPS antes do dia D** (kernel 6.8.0-136 pendente apareceu no
      apt; ~1-2min de indisponibilidade num horário calmo). Depois do reboot, conferir:
      `pm2 status` (os 4 online — o resurrect usa o dump salvo com portas pinadas) e
      `curl /ready`. **Nunca deixar um reboot pendente atravessar a janela.**

- [ ] **Criar o arquivo de credenciais da janela** (na VPS — resolve o problema de "variável
      sumiu porque abri outro SSH"; o `$OHIO` fica GRAVADO agora, antes de qualquer swap):

```bash
cat > /root/cutover/env.sh <<EOF
export SP_SESSION='postgresql://postgres.tufjvwekqhlgfutohhtl:<SENHA>@aws-0-sa-east-1.pooler.supabase.com:5432/postgres'
export SP_TX='postgresql://postgres.tufjvwekqhlgfutohhtl:<SENHA>@aws-0-sa-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true'
export OHIO='$(sed -n 's/^DIRECT_URL=//p' /var/www/dexo/.env | tr -d '"')'
EOF
chmod 600 /root/cutover/env.sh && nano /root/cutover/env.sh   # substituir <SENHA> pela senha real do dexo-brasil
```

- [ ] **Gate de conectividade + identidade** (prova quem somos no SP — pilar do RLS):

```bash
source /root/cutover/env.sh && psql "$SP_SESSION" -c "SELECT version();" -c "SELECT current_user;" 
```

Esperado: versão do SP + `current_user = postgres`. Anotar a major do SP e comparar com a
do Ohio (descoberta da Fase 0).

- [ ] **D-1: baseline funcional no Ohio** (para comparar com o pré-swap da janela):

```bash
cd /var/www/dexo && npm run audit:prod > /root/cutover/audit-ohio-baseline.txt 2>&1 ; tail -20 /root/cutover/audit-ohio-baseline.txt
```

## FASE 2 — ENSAIO GERAL cronometrado (D-2, sem freeze, produção intocada)

Obrigatório: transforma estimativa em fato e caça surpresas (client, disco, `-j 4`).
**Sempre começar com** `source /root/cutover/env.sh`.

```bash
source /root/cutover/env.sh && cd /root/cutover && time pg_dump "$OHIO" --schema=public -Fc -Z 3 -f ensaio.dump && pg_restore --list ensaio.dump > /dev/null && echo DUMP-INTEGRO && pg_restore --list ensaio.dump | grep -c 'TABLE DATA'
```

**Anotar o nº de `TABLE DATA`** = ___ (vira o valor esperado da janela real).

```bash
time env PGOPTIONS='-c idle_in_transaction_session_timeout=0' pg_restore -d "$SP_SESSION" --no-owner --no-privileges -j 4 ensaio.dump ; echo "exit=$? (warnings de 'schema public already exists' sao esperados e OK)"
```

Pós-restore de segurança (IGUAL ao da janela — o ensaio ensaia ISSO também):

```bash
psql "$SP_SESSION" -f /var/www/dexo/supabase/security/enable_rls_all_public.sql && psql "$SP_SESSION" -f /var/www/dexo/supabase/security/revoke_anon_authenticated.sql
```

```bash
time vacuumdb -d "$SP_SESSION" --analyze-only --jobs 4
```

Rodar a **validação da Fase 3.5 inteira** (contagens vão divergir um pouco — produção
viva — mas o processo e os gates ficam validados). Depois, **zerar o SP** para a janela:

```sql
-- SQL Editor do dexo-brasil:
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;  -- o DROP CASCADE derruba a extensão junto!
```

Tempos do ensaio: dump=___ · restore=___ · analyze=___ · validação=___ → janela ≈ soma+10min.

## FASE 3 — A JANELA (20:00 America/Sao_Paulo; ~20-30min)

> ⚠️ **TODA a Fase 3 roda no MESMO terminal.** Se cair o SSH ou a VPS reiniciar:
> reconectar → `source /root/cutover/env.sh` → `pm2 stop dexo-catalog-stats dexo-sync-orders dexo-api dexo-frontend`
> → repetir o check de silêncio → **REFAZER o dump (3.3)**. Dump anterior a uma queda é INVÁLIDO.

### 3.0 Preparar a sessão (gates de partida)

```bash
source /root/cutover/env.sh && psql "$SP_SESSION" -c 'SELECT 1;' && psql "$OHIO" -c 'SELECT 1;' && cd /root/cutover && echo "GATES-OK — pode congelar"
```

### 3.1 Freeze (batches → API → frontend) + trava anti-reboot

```bash
cd /var/www/dexo && pm2 stop dexo-catalog-stats dexo-sync-orders dexo-api dexo-frontend && pm2 save && pm2 status
```

(`pm2 save` aqui grava a lista com os 4 PARADOS — se a VPS reiniciar no meio, o resurrect
não religa nada apontando pro Ohio.)

Silêncio no banco — só conexões de app interessam (autovacuum/serviços internos do
Supabase podem aparecer e NÃO são problema):

```bash
psql "$OHIO" -c "SELECT usename, application_name, backend_type, state, count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid <> pg_backend_pid() GROUP BY 1,2,3,4 ORDER BY 5 DESC;"
```

**Gate:** nenhuma linha com `application_name` de Prisma/tsx e `backend_type='client backend'`
ativo. Linhas de `autovacuum`/`Supavisor`/walsender são normais.

### 3.2 Backup do .env

```bash
cp /var/www/dexo/.env /root/cutover/.env.pre-cutover.bak
```

### 3.3 Dump final + gate de integridade

```bash
cd /root/cutover && time pg_dump "$OHIO" --schema=public -Fc -Z 3 -f dexo-final.dump && pg_restore --list dexo-final.dump > /dev/null && echo DUMP-INTEGRO && pg_restore --list dexo-final.dump | grep -c 'TABLE DATA'
```

**Gate:** `DUMP-INTEGRO` + nº de `TABLE DATA` **igual ao do ensaio** (___). Diferente → investigar antes de seguir.

### 3.4 Restore no SP + pós-restore

```bash
time env PGOPTIONS='-c idle_in_transaction_session_timeout=0' pg_restore -d "$SP_SESSION" --no-owner --no-privileges -j 4 dexo-final.dump 2> /root/cutover/restore-errs.txt ; echo "exit=$?" ; grep -c 'error:' /root/cutover/restore-errs.txt
```

**Como ler:** exit=1 com erros APENAS de `schema "public" already exists` = OK (esperado).
**Qualquer outro erro / restore morto no meio → NÃO seguir com banco meio-populado:**
rodar no SQL Editor do SP o reset (`DROP SCHEMA public CASCADE; CREATE SCHEMA public;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;`) e repetir o 3.4 do zero —
o Ohio continua congelado, só custa tempo de janela.

```bash
psql "$SP_SESSION" -f /var/www/dexo/supabase/security/enable_rls_all_public.sql && psql "$SP_SESSION" -f /var/www/dexo/supabase/security/revoke_anon_authenticated.sql
```

```bash
time vacuumdb -d "$SP_SESSION" --analyze-only --jobs 4
```

### 3.5 VALIDAÇÃO (toda ANTES do swap — é ela que garante rollback de custo zero)

**a) Contagens exatas por tabela** (diff normalizado com sort byte-a-byte):

```bash
for side in ohio sp; do URL=$([ $side = ohio ] && echo "$OHIO" || echo "$SP_SESSION"); psql "$URL" -XAtq -o /root/cutover/counts-$side.txt <<'SQL'
SELECT format('SELECT %L AS tbl, count(*) FROM %I.%I;', tablename, schemaname, tablename) FROM pg_tables WHERE schemaname='public' ORDER BY tablename
\gexec
SQL
done; diff <(LC_ALL=C sort /root/cutover/counts-ohio.txt) <(LC_ALL=C sort /root/cutover/counts-sp.txt) && echo "CONTAGENS-OK"
```

**b) Índices + RLS + funções:**

```bash
for side in ohio sp; do URL=$([ $side = ohio ] && echo "$OHIO" || echo "$SP_SESSION"); psql "$URL" -XAtq -o /root/cutover/objs-$side.txt -c "SELECT 'IDX:'||indexname FROM pg_indexes WHERE schemaname='public' UNION ALL SELECT 'RLSOFF:'||relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND relkind='r' AND NOT relrowsecurity UNION ALL SELECT 'FN:'||proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public';"; done; diff <(LC_ALL=C sort /root/cutover/objs-ohio.txt) <(LC_ALL=C sort /root/cutover/objs-sp.txt) && echo "OBJETOS-OK"
```

**c) NfeSequence byte a byte (CRÍTICO fiscal):**

```bash
for side in ohio sp; do URL=$([ $side = ohio ] && echo "$OHIO" || echo "$SP_SESSION"); psql "$URL" -XAtq -o /root/cutover/nfeseq-$side.txt -c 'SELECT "userId","ambiente","serie","proximoNumero" FROM "NfeSequence";'; done; diff <(LC_ALL=C sort /root/cutover/nfeseq-ohio.txt) <(LC_ALL=C sort /root/cutover/nfeseq-sp.txt) && echo "NFESEQ-OK"
```

**d) OWNER das tabelas = postgres nos dois lados** (o pilar do RLS-bypass do Prisma):

```bash
for side in ohio sp; do URL=$([ $side = ohio ] && echo "$OHIO" || echo "$SP_SESSION"); echo "== $side"; psql "$URL" -XAtq -c "SELECT DISTINCT tableowner FROM pg_tables WHERE schemaname='public';"; done
```

**Gate:** `postgres` (e SÓ `postgres`) nos dois lados.

**e) Busca fuzzy indexada no SP** (esperado: plano com Bitmap, não Seq Scan):

```bash
psql "$SP_SESSION" -c "SET pg_trgm.similarity_threshold=0.2; EXPLAIN SELECT p.\"id\" FROM \"Product\" p WHERE immutable_unaccent(lower(p.\"name\")) % 'molla' OR immutable_unaccent(lower(p.\"sku\")) % 'molla';"
```

**f) Grants zerados** (esperado: 0 linhas):

```bash
psql "$SP_SESSION" -c "SELECT grantee, table_name FROM information_schema.role_table_grants WHERE table_schema='public' AND grantee IN ('anon','authenticated') LIMIT 5;"
```

**g) Auditoria funcional REAL contra o SP — sem subir nenhum app** (compara com o baseline D-1):

```bash
cd /var/www/dexo && DATABASE_URL="$SP_TX" DIRECT_URL="$SP_SESSION" npm run audit:prod > /root/cutover/audit-sp-pre-swap.txt 2>&1 ; tail -20 /root/cutover/audit-sp-pre-swap.txt
```

Comparar (a olho) com `/root/cutover/audit-ohio-baseline.txt` — mesmos totais/findings.

**⛔ Se QUALQUER gate falhar: NÃO troca o .env. `pm2 restart all && pm2 save` religa tudo
no Ohio (zero perda) e investiga com calma.**

### 3.6 Swap do .env + gate de conexão real

```bash
nano /var/www/dexo/.env   # trocar DATABASE_URL e DIRECT_URL pelas do dexo-brasil (tabela do topo; manter ?pgbouncer=true na primeira)
```

```bash
grep -E '^(DATABASE_URL|DIRECT_URL)' /var/www/dexo/.env | sed 's/:[^:@]*@/:***@/'   # visual: sa-east-1 nas DUAS
```

```bash
psql "$(sed -n 's/^DIRECT_URL=//p' /var/www/dexo/.env | tr -d '"')" -c 'SELECT current_user;'   # gate REAL: conecta no SP e responde postgres
```

### 3.7 Religada escalonada + GO/NO-GO

```bash
pm2 restart dexo-api && sleep 10 && curl -s -w "\n/ready -> %{http_code} em %{time_total}s\n" http://localhost:3333/ready
```

Esperado: corpo `{"status":"ready",...}` + `200` + **< 0,1s** (o RTT novo).

```bash
pm2 restart dexo-frontend && sleep 5 && curl -s -o /dev/null -w "frontend -> %{http_code}\n" http://localhost:3000
```

Smoke real no navegador: **login**, `/produtos`, uma **busca**, `/localizacoes`.

> **GO/NO-GO:** só anunciar "manutenção encerrada" DEPOIS do smoke OK. A partir do
> anúncio, rollback deixa de ser grátis (escritas reais no SP).

Depois de 5-10min de calma:

```bash
pm2 restart dexo-sync-orders dexo-catalog-stats && pm2 save
```

### 3.8 Monitoração (primeiros 30min)

```bash
watch -n 30 'curl -s -o /dev/null -w "ready: %{http_code} em %{time_total}s\n" http://localhost:3333/ready; pm2 logs dexo-api --err --lines 3 --nostream | grep -Ei "P2024|pool|timeout" | tail -3'
```

```bash
source /root/cutover/env.sh && psql "$SP_SESSION" -c "SELECT state, count(*) FROM pg_stat_activity WHERE datname=current_database() GROUP BY 1;"
```

Após 30min estáveis, zerar o placar para o baseline do dia 1:

```bash
psql "$SP_SESSION" -c "SELECT extensions.pg_stat_statements_reset();"
```

(Se der "does not exist", conferir o schema com `\dx` e qualificar pelo schema real.)

## FASE 4 — ROLLBACK

**Antes do swap (até 3.5):** rollback = `pm2 restart all && pm2 save` — **zero perda**.

**Depois do swap (3.6+), com gate fiscal:**

1. **Primeiro, conferir se houve emissão de NF-e no SP** durante a exposição (em 2 passos
   para que FALHA DE CONEXÃO aborte explicitamente em vez de parecer divergência fiscal):

```bash
source /root/cutover/env.sh && psql "$SP_SESSION" -XAtq -o /root/cutover/nfeseq-sp-agora.txt -c 'SELECT "userId","ambiente","serie","proximoNumero" FROM "NfeSequence";' && echo "LEITURA-DO-SP-OK"
```

```bash
diff <(LC_ALL=C sort /root/cutover/nfeseq-sp-agora.txt) <(LC_ALL=C sort /root/cutover/nfeseq-sp.txt) && echo "SEM-EMISSAO-NO-SP"
```

   - `SEM-EMISSAO-NO-SP` → rollback direto (passo 2).
   - Divergiu → **houve NF-e emitida no SP**: replicar os `proximoNumero` MAIORES no Ohio
     ANTES de religar (senão a próxima NF-e no Ohio duplica número na SEFAZ) — ou preferir
     **fix-forward** (ficar no SP e corrigir o problema) se a falha não for do banco.
   - Pedidos gravados no SP se recuperam sozinhos após rollback (sync-loop reimporta 7d ML /
     15d Shopee); status de anúncio idem (sweep re-deriva do marketplace).

2. Reverter e religar:

```bash
cp /root/cutover/.env.pre-cutover.bak /var/www/dexo/.env && pm2 restart all && sleep 10 && curl -s -w "\n/ready -> %{http_code}\n" http://localhost:3333/ready && pm2 save
```

## FASE 5 — Pós-estabilização (D+2 a D+30)

- [ ] **D+2**: rebaixar o compute do Ohio para **Micro** (plano Pro **não tem "pausar"**;
      Micro ≈ US$0,35/dia; o downgrade reinicia o banco dele — irrelevante sem tráfego).
- [ ] **D+7**: comparar pg_stat do SP com `/root/cutover/pgss-baseline-ohio.txt` — medir o ganho.
- [ ] **D+14..D+30 — ANTES de deletar o Ohio:**
  1. Auditoria de URLs legadas de Storage (esperado 0 nas DUAS):

```bash
source /root/cutover/env.sh && psql "$SP_SESSION" -c "SELECT count(*) FROM \"Product\" WHERE \"imageUrl\" LIKE '%lovzybhtgmfyasqimnba.supabase.co/storage%' OR EXISTS (SELECT 1 FROM unnest(\"imageUrls\") u WHERE u LIKE '%lovzybhtgmfyasqimnba.supabase.co/storage%');" -c "SELECT count(*) FROM \"Scrap\" WHERE EXISTS (SELECT 1 FROM unnest(\"imageUrls\") u WHERE u LIKE '%lovzybhtgmfyasqimnba.supabase.co/storage%');"
```

  2. **Dump final de arquivamento do Ohio** (retenção fiscal/forense), guardado em 2 lugares:

```bash
pg_dump "$OHIO" --schema=public -Fc -Z 6 -f /root/cutover/ohio-arquivo-final-$(date +%Y%m%d).dump && ls -lh /root/cutover/ohio-arquivo-final-*.dump
```

     (copiar também para fora da VPS — download local / storage frio.)
  3. Só então **deletar** o projeto Ohio.
- [ ] Atualizar `GO_LIVE_PASSO_A_PASSO.md`/docs internos com as URLs novas.

## Congelamento de mudanças (da criação do projeto até o cutover)

- **Nenhum DDL manual no Ohio** na semana do cutover (se inevitável, anotar e reaplicar no
  SP — ex.: índice de dedupe de SKU do PR #187, `ALTER TYPE Role` dos PRs #124/#125).
- Nenhuma mudança de compute/pool/painel no meio da janela.
