-- =============================================================================
-- Dexo · Frente B · Revoga TODOS os privilégios dos papéis anon e authenticated
-- no schema public (defesa em profundidade, além do RLS).
--
-- POR QUE: mesmo com RLS ligado, os grants padrão do Supabase dão a anon/
-- authenticated acesso via Data API/PostgREST. Como o app NÃO usa a Data API
-- nem supabase-js (confirmado: zero ocorrências de @supabase/supabase-js,
-- createClient, supabase.auth, .rpc no código — só Supabase Storage para
-- imagens), revogar esses privilégios fecha a superfície sem afetar o app.
--
-- ZERO REGRESSÃO: o Prisma conecta como o papel dono (postgres), que é dono dos
-- objetos e não depende destes grants. O Storage usa um caminho próprio
-- (storage schema), não tocado aqui.
--
-- IDEMPOTENTE: REVOKE de algo já revogado é no-op.
--
-- OBS: este script NÃO desliga a Data API (isso é no painel — ver
-- ACOES_MANUAIS_SEGURANCA.md). Ele é a rede de segurança caso a Data API seja
-- (re)habilitada por engano no futuro.
-- =============================================================================

-- 1) Revoga privilégios atuais nos objetos existentes do schema public.
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;

-- 2) Remove o USAGE no schema (impede até enumerar objetos).
--    Mantemos comentado por padrão: em alguns projetos o PostgREST precisa de
--    USAGE para o schema exposto. Como vamos DESLIGAR a Data API no painel,
--    pode-se aplicar com segurança. Descomente se desejar o corte total:
-- REVOKE USAGE ON SCHEMA public FROM anon, authenticated;

-- 3) Default privileges: garante que objetos FUTUROS criados pelo dono também
--    não concedam nada a anon/authenticated. Repete para cada papel que pode
--    criar objetos no public (normalmente postgres).
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL ON TABLES    FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL ON FUNCTIONS FROM anon, authenticated;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON TABLES    FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON FUNCTIONS FROM anon, authenticated;

-- Conferência: privilégios remanescentes de anon/authenticated no public
-- (esperado: vazio).
SELECT grantee, table_schema, table_name, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND grantee IN ('anon', 'authenticated')
ORDER BY table_name, grantee, privilege_type;
