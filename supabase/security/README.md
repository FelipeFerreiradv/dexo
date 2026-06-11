# Frente B — Fechar a superfície pública do Postgres (Supabase)

> Resolve os avisos CRÍTICOS do Supabase Advisor: **"RLS Disabled in Public"** (~28 tabelas) e **"Sensitive Columns Exposed → public.User"**.
> **Você (Felipe) executa.** Nada aqui roda automaticamente. Teste em **staging** antes de produção.

## Por que é seguro (zero regressão)

O Dexo acessa o Postgres **só via Prisma**, conectado como o papel **dono** das tabelas (`postgres`), que tem `BYPASSRLS`. Confirmado no código: **não há** `@supabase/supabase-js`, `createClient`, `supabase.auth`, `.rpc` nem PostgREST (só Supabase **Storage** para imagens, que usa outro schema). Logo:

- Ligar **RLS deny-by-default** (RLS ON, sem policies) barra `anon`/`authenticated`, mas **não** o dono → Prisma intacto.
- **Revogar** grants de `anon`/`authenticated` fecha a Data API → app intacto.

## PRÉ-CHECK OBRIGATÓRIO (rode no SQL Editor antes de tudo)

```sql
select current_user, session_user;
select rolname, rolbypassrls from pg_roles
  where rolname in ('postgres','anon','authenticated');
```

**Confirme que a connection string do app (`DATABASE_URL`/`DIRECT_URL`) usa um papel com `rolbypassrls = true`** (normalmente `postgres`). Se o app conectar como um papel **sem** bypass, o RLS deny-by-default o bloquearia → **NÃO aplique** sem antes ajustar a connection string ou criar policies. (No setup padrão do Supabase com Prisma, é `postgres` → ok.)

## Ordem de aplicação

1. **Staging primeiro.** Crie um branch/projeto de staging do Supabase (ou um banco de teste com o mesmo schema) e:
   1. Rode `enable_rls_all_public.sql`.
   2. Rode `revoke_anon_authenticated.sql`.
   3. **Valide o app**: aponte o app de staging para esse banco e rode um fluxo de leitura+escrita (criar produto, listar pedidos) e a suíte `npm run audit:prod`. Tudo deve funcionar normalmente (Prisma bypassa RLS).
2. **Produção** (após validar em staging): repita 1.i e 1.ii no banco de produção, **em janela de baixo tráfego**, com a connection string do app pronta.
3. **No painel** (ver `ACOES_MANUAIS_SEGURANCA.md`): **desligue a Data API** e **rotacione as chaves** — é isso que de fato elimina o vetor; o RLS+revoke é a defesa em profundidade.

## Como validar que deu certo

```sql
-- Todas as tabelas do public devem ter rls_enabled = true:
SELECT c.relname, c.relrowsecurity AS rls_enabled
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname='public' AND c.relkind='r' ORDER BY 1;

-- anon/authenticated não devem ter NENHUM grant no public (resultado vazio):
SELECT grantee, table_name, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema='public' AND grantee IN ('anon','authenticated');
```

E no app: login, CRUD de produto, busca, pedidos, NF-e continuam funcionando.

## Rollback

Se algo quebrar (sinal de que o app NÃO conecta como dono — revise o pré-check):

```sql
-- Desliga RLS de novo em todas as tabelas do public:
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='public' LOOP
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY;', r.tablename);
  END LOOP;
END $$;

-- Re-concede os grants padrão do Supabase (se necessário):
GRANT ALL ON ALL TABLES    IN SCHEMA public TO anon, authenticated;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO anon, authenticated;
```

## Arquivos

- `enable_rls_all_public.sql` — liga RLS (deny-by-default, sem FORCE) em todo o `public`.
- `revoke_anon_authenticated.sql` — revoga grants de `anon`/`authenticated` + default privileges.
