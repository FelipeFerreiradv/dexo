-- =============================================================================
-- Dexo · Frente B · Habilita RLS (deny-by-default) em TODAS as tabelas do schema
-- public do Supabase Postgres.
--
-- POR QUE: o Advisor do Supabase aponta ~28 tabelas com "RLS Disabled in Public"
-- (CRITICAL) e "Sensitive Columns Exposed" em public.User. Com RLS desligado,
-- os papéis anon/authenticated (a anon key é pública) podem ler/escrever os
-- dados via Data API/PostgREST.
--
-- ZERO REGRESSÃO: o app Dexo fala com o Postgres APENAS via Prisma, conectado
-- como o papel DONO das tabelas (postgres), que tem BYPASSRLS. Ligar RLS NÃO
-- afeta o Prisma — apenas barra anon/authenticated. Por isso usamos ENABLE
-- (nunca FORCE: FORCE restringiria também o dono e quebraria o app).
--
-- IDEMPOTENTE: rodar várias vezes é no-op (ALTER ... ENABLE em tabela já com RLS
-- não dá erro). Cobre automaticamente novas tabelas, _prisma_migrations e
-- tabelas de join M2M implícitas do Prisma.
--
-- PRÉ-CHECK OBRIGATÓRIO (rode antes — ver README.md):
--   select current_user, session_user;
--   select rolname, rolbypassrls from pg_roles
--     where rolname in ('postgres','anon','authenticated');
-- Confirme que a connection string do app usa um papel com rolbypassrls = true.
-- Se NÃO for, NÃO aplique sem ajustar (o app passaria a ser bloqueado pelo RLS).
-- =============================================================================

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
  LOOP
    EXECUTE format(
      'ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;',
      r.tablename
    );
    RAISE NOTICE 'RLS habilitado em public.%', r.tablename;
  END LOOP;
END $$;

-- Conferência: lista as tabelas do public e o estado de RLS (esperado: todas t).
SELECT n.nspname AS schema,
       c.relname AS table,
       c.relrowsecurity AS rls_enabled,
       c.relforcerowsecurity AS rls_forced
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
ORDER BY c.relname;
