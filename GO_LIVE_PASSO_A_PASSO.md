# Go-Live de Segurança — Passo a Passo (Dexo)

> Ordem de execução para colocar todo o hardening em produção **sem quebrar nada**.
> Regra de ouro: cada bloco sobe em modo compatível (legacy) primeiro; só viramos as travas finais depois de validar.
> Legenda: ✅ já feito · ⏳ a fazer · ⚠️ atenção (pode quebrar se pular).

---

## ✅ Já feito por você

- **Data API do Supabase DESLIGADA** → fecha o vetor nº 1 (anon/authenticated liam o banco via HTTPS). Era o mais crítico.
- **Pré-check do RLS** → `postgres` tem `rolbypassrls = true`, `anon`/`authenticated` = `false`. Isso **confirma que aplicar o RLS é seguro** (o app conecta como `postgres`, que bypassa o RLS).

---

## Bloco 1 — Banco (Supabase)

### 1.1 ⚠️ Resolver "Service restrictions" (cota do plano esgotada) — URGENTE

O aviso CRITICAL diz: _"Your services are restricted as your organization used up your Plan's quota"_. Isso é **billing**, não segurança, mas pode **degradar/pausar o banco de produção**.

- **Fazer:** no aviso → **Check usage** (ver o que estourou) e **Upgrade your Plan** (ou reduzir uso). Não deixe isso pendente — banco de produção restrito = app instável.

### 1.2 ⏳ Aplicar RLS + revoke (defesa em profundidade — agora é seguro)

O pré-check passou, então pode aplicar. Faça no **SQL Editor** do Supabase.

1. (Recomendado) teste antes em staging. Se for direto em prod, faça em janela de baixo tráfego.
2. Rode o conteúdo de **`supabase/security/enable_rls_all_public.sql`**.
3. Rode o conteúdo de **`supabase/security/revoke_anon_authenticated.sql`**.
4. **Validar** (cole no SQL Editor):
   ```sql
   -- todas as tabelas do public devem ter rls_enabled = true:
   SELECT c.relname, c.relrowsecurity AS rls FROM pg_class c
   JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' AND c.relkind='r' ORDER BY 1;
   -- anon/authenticated sem grants (resultado vazio):
   SELECT grantee, table_name FROM information_schema.role_table_grants
   WHERE table_schema='public' AND grantee IN ('anon','authenticated');
   ```
5. **Validar o app:** abra o Dexo e faça login + abrir produtos/pedidos. Tem que funcionar normal (o Prisma bypassa o RLS).

- **Rollback:** seção "Rollback" do `supabase/security/README.md`.

### 1.3 ⏳ (P1) Network restrictions + rotacionar chaves

- Settings → Database → **Network Restrictions**: permitir só o IP da VPS `72.61.57.38`.
- Como o banco ficou exposto um tempo: **rotacionar a senha do Postgres + as keys** e atualizar `DATABASE_URL`/`DIRECT_URL` na VPS.

---

## Bloco 2 — Deploy do código (sobe em modo LEGACY = zero mudança de comportamento)

Todo o branch `claude/keen-lederberg-2d5f37` foi feito para subir **sem regressão**: o auth fica em `legacy` (aceita o header `email` como hoje) e a cifra de tokens fica desligada. Então o deploy em si não muda nada visível.

### 2.1 ⚠️ ANTES de subir a API na VPS: confirmar `CORS_ORIGIN`

O PR-A4 fez o CORS **falhar fechado em produção**: se `NODE_ENV=production` e `CORS_ORIGIN` não estiver setado, a API **aborta o boot** de propósito.

- **Fazer:** garanta que a env **`CORS_ORIGIN`** na VPS é a origem EXATA do front (ex.: `https://app.seudominio.com`). Provavelmente já está setada (o app já funciona cross-origin hoje). Se não estiver, setar antes do deploy.

### 2.2 ⚠️ Confirmar que `NEXTAUTH_SECRET` é IGUAL nos dois lados

O token de auth é **assinado no NextAuth (front/Vercel)** e **verificado na API Fastify (VPS)** usando o mesmo segredo. Como não setamos `API_JWT_SECRET`, **os dois usam `NEXTAUTH_SECRET`** — então ele precisa ser **o mesmo valor** no front e na VPS (já deve ser). Se forem diferentes, o token não valida.

- **Fazer:** conferir que `NEXTAUTH_SECRET` é idêntico no painel do front e no `.env` da VPS. (Não precisa criar `API_JWT_SECRET` — deixe os dois caírem no `NEXTAUTH_SECRET`.)

### 2.3 ⏳ Deploy

- **Front (Next):** merge do branch + deploy normal (Vercel/etc).
- **API (VPS):** `git pull` no projeto + reiniciar o processo do `npm run api`. ⚠️ Rode `npm install` na VPS (entraram deps novas: bcryptjs, @fastify/helmet, @fastify/rate-limit, jsonwebtoken types).

### 2.4 ⏳ Validar (modo legacy — tudo deve funcionar IGUAL a antes)

- Login, criar/editar produto, busca, estoque, pedido, venda balcão, financeiro, localização/unidade, conectar+sync ML/Shopee, mensagens, emitir NF-e + DANFE/XML, upload de imagem.
- **Bônus que já passa a valer:** senhas viram hash no primeiro login de cada usuário (rehash transparente); logs sem PII; rate-limit/headers ativos; rotas de log/usuário com auth.

---

## Bloco 3 — Fechar o bypass de auth (cutover para STRICT)

O mecanismo já está no código (modo legacy). A "ponte" no front (`ApiAuthBridge`) já injeta o token em toda chamada à API. Agora é validar e virar a chave.

### 3.1 ⏳ Validar que o token está chegando em TODAS as telas

Antes de virar strict, confirme que toda requisição leva o `Authorization: Bearer`:

- **Jeito rápido (DevTools):** abra o app logado → F12 → aba **Network** → clique numa chamada pra API (ex.: `/products`, `/orders`, `/customers`, `/finance`, NF-e, sucatas, integrações) e confira que tem o header **`authorization: Bearer ...`**. Passe pelas telas principais.
- **Jeito robusto (log temporário):** posso adicionar um log no `authMiddleware` que registra requisições que chegam SEM Bearer (com a rota), você roda em legacy por 1-2 dias e vê se sobrou alguma tela. Me peça que eu faço.

### 3.2 ⏳ Virar strict

- Na VPS, setar **`API_AUTH_MODE=strict`** no `.env` e reiniciar a API.
- Nesse momento eu adiciono `authMiddleware` ao `POST /upload/image` (hoje sem auth porque o componente de upload não mandava credencial — com a ponte, passa a mandar). **Me peça** que eu faço junto.
- **A partir daqui o bypass está FECHADO:** requisição só com header `email` (sem token) → 401.

### 3.3 ⏳ Validar de novo + rollback

- Repasse as telas principais. Se algo der 401, é uma tela que não estava mandando o token → **rollback imediato:** `API_AUTH_MODE=legacy` + restart (volta a aceitar email). Me mande qual rota falhou que eu cubro.
- **Pendências conhecidas para o strict:** links de **download** de XML/DANFE que usam `?email=` na URL (browser não manda header em `<a href>`). Antes de virar strict, me peça para tratar esses (token na URL assinado ou endpoint dedicado). Hoje são poucos (`app/notas-fiscais/...`).

---

## Bloco 4 — VPS (firewall, rembg, SSH)

Seguir **`infra/hardening/RUNBOOK_VPS.md`** (tem ordem segura + trava anti-lockout). Resumo: snapshot → UFW → fechar rembg (deploy do `docker-compose.yml`) → SSH key-only (sem root) → fail2ban → unattended-upgrades. Mais os itens de painel em **`ACOES_MANUAIS_SEGURANCA.md`** (backup diário, auto-renew 10/07, malware scanner, CloudPanel 2FA).

---

## Bloco 5 — Pendentes (eu faço quando você pedir; tocam fluxo de receita → validar em staging)

- **A5 — ligar a cifra de tokens ML/Shopee:** wiring do `SecretCipher` cobrindo todos os reads (inclui `include:{marketplaceAccount}`). Depois setar `MARKETPLACE_TOKEN_ENC_KEY` (gere com `openssl rand -hex 32`) e validar publish/sync/mensagens.
- **A6 — assinatura de webhooks** (HMAC Shopee + IP allowlist ML), flag log-only primeiro.
- **Downloads `?email=`** para o modo strict (item 3.3).

---

## Resumo da ordem

1. Resolver cota Supabase (1.1) + aplicar RLS (1.2).
2. Conferir `CORS_ORIGIN` e `NEXTAUTH_SECRET` (2.1/2.2) → deploy (2.3) → validar legacy (2.4).
3. Validar token chegando (3.1) → `API_AUTH_MODE=strict` (3.2) → validar (3.3).
4. VPS hardening (Bloco 4).
5. Me chamar para A5/A6/downloads (Bloco 5).
