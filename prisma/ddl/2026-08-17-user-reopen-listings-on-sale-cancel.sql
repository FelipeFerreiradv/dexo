-- Preferência do tenant: reabrir anúncio quando a peça volta ao estoque
-- (User.reopenListingsOnSaleCancel)
--
-- EXECUTAR NO SQL EDITOR DO SUPABASE, ANTES do deploy.
--   1. Rodar este DDL com o código atual no ar.
--   2. Deploy.
--   3. Nada mais. O default `true` JÁ É o comportamento de hoje — não há flag
--      para ligar, e nenhum tenant muda de comportamento.
--
-- 🔴 A ORDEM AQUI É MAIS CRÍTICA QUE NOS DDLs ANTERIORES DESTE PROJETO.
--
-- Coluna NOVA em tabela EXISTENTE. O Prisma monta todo SELECT com a lista
-- explícita de colunas do schema, nunca `SELECT *`. E `UserRepositoryPrisma`
-- faz `findUnique({ where, include: { parent: ... } })` SEM `select`
-- (user.repository.ts:115-129), o que emite TODAS as colunas escalares do User.
--
-- Esse `findUnique` é chamado pelo `authMiddleware` em TODA requisição
-- autenticada. Portanto: código novo contra banco sem a coluna NÃO quebra a
-- funcionalidade — derruba a aplicação inteira. Login, dashboard, PDV, estoque,
-- financeiro. Tudo 500.
--
-- É pior que o precedente de `Receivable.cancelReasonCode`, onde o dano era
-- "toda tela de Receivable". Aqui a tabela é a da autenticação.
--
-- ⚠️ E FEATURE FLAG NÃO PROTEGE. Quem dirige aquela query é o schema.prisma,
-- não o código. Não existe `if` que evite a coluna aparecer no SELECT.
--
-- No sentido contrário é inerte: DDL antes do código é seguro, porque o client
-- antigo nunca nomeia a coluna nova (nem no SELECT, nem no INSERT — tem default).
--
-- Custo: no PG 11+ `ADD COLUMN NOT NULL DEFAULT <constante>` é metadata-only,
-- sem rewrite da tabela. ACCESS EXCLUSIVE por microssegundos.

BEGIN;

-- NOT NULL DEFAULT true, espelhando `User.isActive`:
--   * `true` É a verdade para todas as linhas existentes (o comportamento atual
--     é reabrir), não um "não sei" — por isso NOT NULL e não nullable.
--   * NOT NULL garante que `false` só passa a existir por escrita explícita de
--     alguém que foi na tela e desligou.
-- Mesmo assim toda LEITURA no código usa `?? true`: a defesa ali não é contra
-- NULL no banco, é contra objeto parcial (mock de teste, relação não carregada,
-- projeção enxuta).
ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "reopenListingsOnSaleCancel" BOOLEAN NOT NULL DEFAULT true;

COMMIT;

-- ── Verificação (rodar DEPOIS do COMMIT) ──────────────────────────────────
-- Esperado: 1 linha, is_nullable = NO, column_default = true
--
-- SELECT column_name, data_type, is_nullable, column_default
-- FROM information_schema.columns
-- WHERE table_name = 'User' AND column_name = 'reopenListingsOnSaleCancel';
--
-- Esperado: 0 — ninguém desligou ainda, todo mundo no comportamento de hoje.
-- SELECT count(*) FROM "User" WHERE "reopenListingsOnSaleCancel" = false;

-- ── ROLLBACK ──────────────────────────────────────────────────────────────
-- ⚠️ ORDEM INVERSA: derrubar o CÓDIGO primeiro, o DDL depois. Dropar a coluna
-- com o código novo no ar reproduz exatamente o apagão descrito no cabeçalho.
--
-- BEGIN;
--   ALTER TABLE "User" DROP COLUMN IF EXISTS "reopenListingsOnSaleCancel";
-- COMMIT;
