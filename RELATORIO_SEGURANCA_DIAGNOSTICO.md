# Relatório de Segurança — Diagnóstico (Fase 0)

> Auditoria de segurança do Dexo (SaaS de gestão para desmontes/autopeças) antes da campanha de aquisição de clientes.
> Stack: **Next.js 15 (App Router) + API Fastify separada + Prisma 6 → Supabase Postgres**. VPS Hostinger KVM8 + CloudPanel.
> Metodologia: leitura direta do código + varredura multi-agente (read-only) + prints do painel Supabase Advisor e Hostinger (11/06/2026). Cada achado foi confirmado em `arquivo:linha`.
> Severidade: **P0** = corrigir antes de qualquer cliente novo · **P1** = logo em seguida · **P2** = endurecimento contínuo.
> Frentes: **A** = código · **B** = banco Supabase · **C** = VPS/infra.

---

## Resumo executivo

O Dexo tem **isolamento de tenant frágil e autenticação efetivamente ausente** na API Fastify. Os achados mais graves:

1. **Senhas em texto puro** no banco — e **expostas por endpoints sem autenticação** (`GET /users/:id`, `GET /users/me`). Qualquer um na rede lê a senha de qualquer usuário.
2. **Bypass total de auth**: a API confia no header `email` sem verificar senha/token/sessão.
3. **Rotas sem auth alguma** (logs do sistema, criação/edição de usuário, upload) — incluindo **leitura de logs de todos os tenants** e **destruição do trilho de auditoria**.
4. **IDOR** em vários repositórios: ler/alterar/apagar dados de outro tenant por `:id`.
5. **Banco Supabase com RLS desligado em todas as tabelas** e `User` com colunas sensíveis expostas pela Data API (confirmado no Advisor).
6. **VPS sem firewall**, sidecar `rembg` exposto, **SSH root**, sem antimalware.

A boa notícia: a app fala com o Postgres **só via Prisma como papel dono** (bypassa RLS), então é possível fechar a superfície pública do banco **sem regressão**; XXE já está mitigado nos parsers de NF-e; e o padrão de cifra AES-256-GCM já existe (certificado A1) para reusar nos tokens.

---

## Achados P0 (corrigir ANTES de qualquer cliente novo)

### P0-1 — [Frente A] Disclosure de senha (texto puro) por endpoint SEM autenticação · CRÍTICO

- **Evidência:** `GET /users/:id` e `GET /users/me` não tinham `authMiddleware` e devolviam o objeto do `mapUser`, que inclui `password: u.password` ([app/routes/user.routes.ts:105-126,132-149](app/routes/user.routes.ts), [app/repositories/user.repository.ts:11-19](app/repositories/user.repository.ts)).
- **Impacto:** qualquer um na rede lê a senha em claro de qualquer usuário sabendo/adivinhando o id ou e-mail. Pior achado do levantamento (o prompt original não previa este).
- **Status:** **CORRIGIDO** em PR-A0 (auth + ownership + `toPublicUser` — senha nunca mais sai em resposta).

### P0-2 — [Frente A] Senhas armazenadas e comparadas em texto puro

- **Evidência:** `if (user.password !== credentials.password)` com TODO admitindo o problema ([app/lib/auth.ts:27-30](app/lib/auth.ts)); `create()`/`update()` gravam `password` cru ([app/repositories/user.repository.ts:51,116](app/repositories/user.repository.ts)); `login()` também compara em claro ([app/usecases/user.usercase.ts:40](app/usecases/user.usercase.ts)).
- **Impacto:** dump do banco = todas as credenciais expostas; reuso de senha em outros serviços.
- **Correção (PR-A1):** `bcryptjs` cost 12 + **rehash transparente no login** (sem reset forçado, zero regressão).

### P0-3 — [Frente A] Bypass total de autenticação na API Fastify

- **Evidência:** identidade vem só do header `email`/`?email=`, sem senha/token/sessão ([app/middlewares/auth.middleware.ts:22-43](app/middlewares/auth.middleware.ts)); API escuta em `0.0.0.0:3333` ([app/api/api.ts:271-278](app/api/api.ts)); o browser chama direto em 60+ pontos com `headers:{ email }`.
- **Impacto:** trocar o header `email` = personificar qualquer tenant; acesso cruzado total.
- **Correção (PR-A2):** token HS256 assinado emitido pelo NextAuth + verificação no middleware; flag `API_AUTH_MODE` `legacy`→`strict` (cutover faseado, zero regressão no deploy).

### P0-4 — [Frente A] Rotas sem autenticação alguma

- **Evidência:** `system-log` GET `/`, GET `/stats`, **DELETE `/cleanup`** ([app/routes/system-log.routes.ts](app/routes/system-log.routes.ts)); `POST /users`, `PUT /users/:id/settings`, `GET /users/:id` ([app/routes/user.routes.ts](app/routes/user.routes.ts)); `POST /upload/image` ([app/routes/upload.routes.ts:65](app/routes/upload.routes.ts)). A rota Next `app/api/system-logs/route.ts` também era pública e sem escopo.
- **Impacto:** leitura de logs de **todos** os tenants (PII no `details`), **destruição do trilho de auditoria** (anti-forense), criação/edição de usuário sem auth, upload anônimo.
- **Status:** **CORRIGIDO** em PR-A0 para logs/usuários (auth + escopo de tenant). Upload migra para auth no PR-A2 (hoje não envia credencial — adicionar auth agora quebraria o upload de imagem de produto) + rate-limit no PR-A4.

### P0-5 — [Frente A] IDOR / quebra de isolamento multi-tenant nos repositórios

- **Evidência (confirmada por leitura):**
  - `order.findById(id)` / `order.update(id, data)` sem `userId` ([app/repositories/order.repository.ts:224,509](app/repositories/order.repository.ts)).
  - `product.delete(id, userId?)` / `findById(id, userId?)` — `userId` **opcional** vira no-op se omitido ([app/repositories/product.repository.ts:1336-1382](app/repositories/product.repository.ts)).
  - `scrap.getScrapMoney` não checa o scrap raiz ([app/repositories/scrap.repository.ts:247-285](app/repositories/scrap.repository.ts)).
  - `compatibility.delete(id)` sem dono ([app/repositories/compatibility.repository.ts:68](app/repositories/compatibility.repository.ts)).
  - `nfe.deleteDraft/updateDraft` recebem `userId` mas **não usam** no `where` ([app/repositories/nfe.repository.ts:125-215](app/repositories/nfe.repository.ts)).
  - `location.update` (userId opcional) e `deleteRecursive` (sem dono) ([app/repositories/location.repository.ts:175-246](app/repositories/location.repository.ts)).
  - `system-log.findById` sem dono.
  - Rotas `PUT /listings/:id/stock` e `DELETE /listings/:id` não passam `userId` ([app/routes/listing.routes.ts:279-318,643-673](app/routes/listing.routes.ts)).
- **Impacto:** ler/alterar/apagar pedidos, produtos, sucatas, NF-e e estoque de outros tenants por id.
- **Correção (PR-A3):** `userId` **obrigatório** + filtro de dono em todo `where`; testes A-não-acessa-B (leitura e escrita).

### P0-B — [Frente B] RLS desligado em todas as tabelas `public` + colunas sensíveis expostas

- **Evidência (Supabase Advisor → Security, prints 11/06):** ~28 tabelas com **"RLS Disabled in Public" (CRITICAL)** — `User, Customer, Order, OrderItem, Receivable, Payable, ReceivableItem, MarketplaceAccount, Product, ProductListing, SystemLog, WebhookEventLog, SyncLog, StockLog, StockSyncJob, NfeSequence, Location, Unidade, MarketplaceCategory, CategoryAlias, MarketplaceQuestion, MarketplaceAnswer, BulkListingJob, MLCategoryAttributeCache, ShopeeCategoryAttribute, _prisma_migrations` (+ "Show 4 more"); e **"Sensitive Columns Exposed → `public.User`" (CRITICAL)**.
- **Impacto:** se a Data API/PostgREST está exposta (o lint "Sensitive Columns Exposed" indica que sim), `anon`/`authenticated` (anon key é pública) leem/escrevem `User` (senha em claro), `Customer` (CPF/CNPJ), financeiro e tokens via HTTPS. **Vetor de vazamento nº 1 do banco.**
- **Correção:** SQL idempotente de RLS deny-by-default + revoke (Frente B, ver `supabase/security/`) + ações de painel (desligar Data API, rotacionar chaves). App não usa PostgREST → **zero regressão** (Prisma conecta como dono que bypassa RLS).

### P0-B2 — [Frente B] "Service restrictions are active" (12/04/2026, CRITICAL)

- **Evidência:** Supabase Advisor → Messages (print). Projeto **PRODUCTION**.
- **Impacto:** pode ser spend cap / limite de plano / flag de abuso → risco de pausa/degradação do banco de produção. **Investigação manual urgente** (ver `ACOES_MANUAIS_SEGURANCA.md`).

### P0-C — [Frente C] VPS sem firewall + rembg público + SSH root

- **Evidência (Hostinger Overview, print):** `srv1141695.hstgr.cloud`, Ubuntu 24.04 **KVM8**, IP `72.61.57.38`, CloudPanel user `admin`, **root SSH habilitado**, **Firewall rules: 0**, **Malware scanner: Not installed**, **Backups: 2 snapshots**; `docker-compose` mapeia `8000:8000` (0.0.0.0) ([docker-compose.yml:14-15](docker-compose.yml)).
- **Impacto:** portas potencialmente abertas (3000/3333/8000); rembg sem auth/rate-limit exposto (DoS/abuso); root SSH é o pior caso; sem antimalware; backup raso.
- **Correção:** scripts + runbook (Frente C, ver `infra/hardening/`) + ações de painel.

---

## Achados P1

| #    | Frente | Achado                                                                                    | Evidência                                                                                          |
| ---- | ------ | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| P1-1 | A/B    | Tokens ML/Shopee em **texto puro** no banco                                               | [marketplace.repository.ts:30-31,170-171](app/marketplaces/repositories/marketplace.repository.ts) |
| P1-2 | A/C    | Sem security headers (HSTS/X-CTO/X-Frame/Referrer/Permissions/CSP); sem `@fastify/helmet` | [next.config.ts](next.config.ts), [api.ts:38-58](app/api/api.ts)                                   |
| P1-3 | A      | Sem rate limit / anti-brute-force                                                         | [package.json](package.json), [user.routes.ts](app/routes/user.routes.ts)                          |
| P1-4 | A/C    | CORS não falha fechado (`CORS_ORIGIN` opcional, fallback localhost)                       | [api.ts:43-47](app/api/api.ts), [env.ts:50](app/lib/env.ts)                                        |
| P1-5 | A      | Webhooks ML/Shopee sem verificação de assinatura/origem                                   | [marketplace.routes.ts:284-338,1522-1576](app/routes/marketplace.routes.ts)                        |
| P1-6 | A      | Logs com PII/segredos (`sanitizeBody` raso; query/params crus; pino loga header `email`)  | [logging.middleware.ts:56-63,314-328](app/middlewares/logging.middleware.ts)                       |
| P1-7 | A      | `next/image` com `hostname:"**"` https em `/uploads/**`                                   | [next.config.ts:16-20](next.config.ts)                                                             |
| P1-8 | A      | `xlsx@0.18.5` com CVEs (proto-pollution/ReDoS) — uso só em scripts admin                  | [package.json:85](package.json)                                                                    |

## Achados P2

Erro vaza `message`/`stack` ao cliente ([api.ts:204-207](app/api/api.ts)); `fastifyStatic` serve `public/` (expõe `api-docs`, sem segredos); `.gitignore` poderia cobrir `*.key/*.pfx/*.p12`; caches de token em memória sem invalidação no refresh; varredura de segredos no histórico git (manual); `FISCAL_STORAGE_PATH` em disco sem cifra (escopo infra).

---

## Correções ao diagnóstico inicial (o que estava impreciso após ler o código)

1. **Senha não é "hash fraco" — é texto puro**, e há **disclosure não-autenticada** dela (P0-1) — não previsto no prompt, é o achado nº 1.
2. **XXE já está mitigado** nos parsers de NF-e: guarda de `DOCTYPE/ENTITY` + `processEntities:false` + testes ([parse-nfe-xml.ts:48-66](app/fiscal/nfe-import/parse-nfe-xml.ts), [nfe-xml-parser.service.ts:144-157](app/fiscal/sefaz/nfe-xml-parser.service.ts)). Resta só replicar a guarda antes do `xml-crypto` (defesa em profundidade).
3. **Frente B é zero-regressão de verdade:** o Prisma conecta como papel dono (`postgres`, `BYPASSRLS`); RLS deny-by-default + revoke `anon/authenticated` **não afeta** a app. Não precisa de policies nem session-context. **Usar `ENABLE`, nunca `FORCE`** (FORCE restringiria o dono e quebraria o Prisma).
4. **`jsonwebtoken@9` está nas deps mas não é usado** — reaproveitado para emitir/verificar o token da API (PR-A2). NextAuth v4 cifra o cookie (JWE) — não dá pra `jwt.verify` direto; por isso emitimos um token HS256 irmão.
5. **Confirmado:** não há `@supabase/supabase-js`/PostgREST/Supabase Auth no código (só Storage de imagens) → fechar a Data API é seguro.

---

## Estado da implementação (atualizado conforme os PRs avançam)

- **PR-A0 (fecha disclosure de senha + rotas sem auth):** ✅ implementado + testes verdes.
- **PR-A1 (hashing bcrypt):** em andamento.
- Demais PRs e artefatos de Frente B/C: ver `PLANO_SEGURANCA.md`.
