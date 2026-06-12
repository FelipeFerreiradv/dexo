# Plano de Segurança — Implementação (Fase 1)

> Plano de correção do `RELATORIO_SEGURANCA_DIAGNOSTICO.md`. **Regra mestra: ZERO REGRESSÃO.**
> 1 PR por correção (ou grupo coeso), conventional commit, com risco + como testar. P0 primeiro.
> **Decisões aprovadas:** auth = dual-mode faseado (`legacy`→`strict`); hash = `bcryptjs` cost 12 com rehash transparente; `POST /users` = restrito a admin (não há signup público no front — confirmado).

## Ordem de execução

P0: **A0 → A1 → A3 → A2** (código) · SQL Frente B · runbook Frente C.
P1: A4 → A5 → A7 → A6. P2: A8.

---

## Frente A — Código

### PR-A0 — `fix(security): fecha disclosure de senha e rotas sem auth` · P0 · ✅ FEITO

- Serializer `toPublicUser()` ([app/lib/user-serializer.ts](app/lib/user-serializer.ts)) — `password` nunca sai em resposta.
- `authMiddleware` + ownership em `GET /users/:id`, `PUT /users/:id/settings`, `GET/PUT /users/me*`; `POST /users` agora admin-only (`blockCollaborator`); erros sem `stack`.
- `system-log` (Fastify): auth + escopo de tenant (`getTenantUserIds`); `DELETE /cleanup` admin-only + escopado.
- Rota Next `app/api/system-logs[/stats]`: `getServerSession` + escopo de tenant.
- **Risco:** baixo. Upload **não** recebeu auth aqui (o componente não envia credencial hoje → quebraria) — vai no PR-A2 + rate-limit no PR-A4.
- **Testes:** `tests/security/user-routes-auth.spec.ts` (8) + `tests/system-log.routes.spec.ts` atualizado (11) — verdes. Sem regressão na suíte.

### PR-A1 — `feat(security): hashing de senha com rehash transparente` · P0

- `bcryptjs` cost 12. Hash em `create`/`update` ([user.repository.ts](app/repositories/user.repository.ts)).
- **Rehash transparente no login:** se o valor não for hash (`!/^\$2[aby]\$/`), compara texto; se bater, regrava como hash. Aplica em `auth.ts` (`authorize`) e `user.usecase.login`. **Sem reset forçado.**
- **Risco:** baixo. **Testar:** login legado (texto) → ok + vira hash; login novo → hash; senha errada → 401.

### PR-A3 — `fix(security): isolamento multi-tenant nos repositórios (IDOR)` · P0

- `userId` obrigatório + filtro de dono em `order`, `product`, `scrap.getScrapMoney`, `compatibility`, `nfe` (deleteDraft/updateDraft), `location` (update/deleteRecursive), `system-log.findById`; ownership nas rotas `listing :id/stock` e `DELETE :id`.
- **Risco:** médio (amplo, mecânico). **Testar:** A não lê/edita/apaga recurso de B (403/404), leitura e escrita.

### PR-A2 — `feat(security): auth por token verificado (flag dual-mode)` · P0 · maior risco

- Token HS256 (`jsonwebtoken`, já é dep) emitido no callback do NextAuth (`API_JWT_SECRET`), exposto em `session.apiToken`.
- `authMiddleware` aceita `Authorization: Bearer`; flag `API_AUTH_MODE` `legacy` (default, aceita token **ou** email) → `strict` (rejeita email puro). Helper `apiFetch()` no front injeta o Bearer; migrar os ~60 call sites; upload passa a enviar o token + ganhar `authMiddleware`.
- **Risco:** ALTO. **Mitigação:** flag default `legacy` (deploy sem mudança), cutover faseado, testes (sem token→401 strict; forjado→401).

### PR-A4 — `feat(security): headers + helmet + rate-limit + CORS fail-closed` · P1

- `next.config.ts` `headers()` (HSTS/X-CTO/X-Frame/Referrer/Permissions/CSP report-only); estreitar `images.remotePatterns`.
- `@fastify/helmet` + `@fastify/rate-limit` (global + estrito em auth + upload; health isento). `CORS_ORIGIN` obrigatório em prod.

### PR-A5 — `feat(security): cifra de tokens de marketplace em repouso` · P1

- `SecretCipherService` (reusa AES-256-GCM do cert, `MARKETPLACE_TOKEN_ENC_KEY`, fail-closed em prod). Cifra em `createAccount`/`updateTokens`; **decrypt-on-read com fallback texto** → sem migration, zero regressão.

### PR-A6 — `feat(security): verificação de webhooks` · P1

- Shopee: HMAC do corpo com `partner_key`. ML: allowlist de IP + validação estrutural (ML não assina). Verificação **log-only** → enforce via flag.

### PR-A7 — `fix(security): redação de PII/segredos em logs` · P1

- `sanitize` recursivo + lista PII (`cpf/cnpj/rg/email/phone/endereço/cert*`) em body/query/params; serializer pino redatando headers `email`/`authorization`.

### PR-A8 — `fix(security): erros genéricos em prod + deps` · P2

- 5xx genérico + `requestId` em prod (detalhe só no log); nunca `stack`. Avaliar upgrade do `xlsx`. `.gitignore` cobrir `*.key/*.pfx/*.p12`.

---

## Frente B — Banco Supabase (artefatos; Felipe aplica)

`supabase/security/`: `enable_rls_all_public.sql` (RLS deny-by-default, sem FORCE), `revoke_anon_authenticated.sql`, `README.md` (pré-check de papel dono, validação em staging, rollback). Ver também `ACOES_MANUAIS_SEGURANCA.md` (desligar Data API + rotacionar chaves = o que elimina o vetor).

## Frente C — VPS (scripts + runbook; Felipe executa)

`infra/hardening/`: `ufw-setup.sh`, `ssh-hardening.md` (trava anti-lockout), `fail2ban-setup.sh`, `unattended-upgrades.sh`, bind do `rembg` em `127.0.0.1`, `RUNBOOK_VPS.md`.

## Validação (cada PR)

`npm run build`, `npm run lint` + `lint:prettier:check`, `npm test` (+ testes de segurança novos), `npm run audit:prod` quando fizer sentido. Baseline: suíte verde (0 falhas). Checklist funcional: login; CRUD produto; busca; estoque; pedido; venda balcão; financeiro; localização/unidade; conectar+sync ML/Shopee; mensagens; emitir NF-e + DANFE/XML; upload.
