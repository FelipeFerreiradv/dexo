# Ações Manuais de Segurança — só o Felipe pode fazer

> Itens que dependem de painéis (Supabase, Hostinger, CloudPanel) ou de SSH na VPS — eu **não** executo. Priorizados por risco. Cada item tem **por quê** e **como verificar**.
> Os SQLs/scripts referenciados estão em `supabase/security/` e `infra/hardening/`.

---

## 🔴 P0 — Esta semana, ANTES de qualquer cliente novo

### 1. Supabase — investigar "Service restrictions are active" (12/04/2026)

- **Por quê:** aviso CRITICAL no projeto de **produção**. Pode ser spend cap / limite de plano / flag de abuso → risco de **pausa ou degradação do banco** no meio da campanha.
- **Fazer:** painel Supabase → abrir o aviso (aba Messages/Advisor) e o **Billing**. Resolver a causa (subir plano / ajustar spend cap / contestar flag).
- **Verificar:** o aviso some e o projeto está "Active/Healthy".

### 2. Supabase — desligar a Data API (PostgREST) do schema `public`

- **Por quê:** é o vetor nº 1 de vazamento. Com RLS off, `anon`/`authenticated` (anon key é **pública**) leem `User` (senha), `Customer` (CPF/CNPJ), financeiro e tokens via HTTPS. O app **não usa** a Data API (confirmado) → desligar tem **zero impacto**.
- **Fazer:** Project Settings → **API** → Data API → remover `public` dos "Exposed schemas" (ou desabilitar a Data API).
- **Verificar:** `curl https://<project>.supabase.co/rest/v1/User?apikey=<ANON_KEY>` deve retornar erro/404, não dados.

### 3. Supabase — aplicar RLS + revoke (defesa em profundidade)

- **Por quê:** rede de segurança caso a Data API seja religada por engano.
- **Fazer:** seguir `supabase/security/README.md` — **pré-check** (confirmar papel dono com `BYPASSRLS`), testar em **staging**, depois rodar `enable_rls_all_public.sql` e `revoke_anon_authenticated.sql` em produção.
- **Verificar:** todas as tabelas do `public` com `rls_enabled = true`; `anon/authenticated` sem grants; app continua funcionando (Prisma bypassa RLS).

### 4. Supabase — rotacionar senha do Postgres + chaves (anon/service_role)

- **Por quê:** o banco ficou exposto com RLS off por tempo indeterminado → trate a **anon key como potencialmente abusada**.
- **Fazer:** painel → Settings → Database (resetar senha) e API (rotacionar keys). Atualizar `DATABASE_URL`/`DIRECT_URL` (e qualquer uso da anon key) **na VPS** e redeploy.
- **Verificar:** app conecta com as novas credenciais; as antigas não funcionam mais.

### 5. Hostinger — firewall (hoje 0 regras)

- **Por quê:** portas potencialmente abertas (3000/3333/8000). Superfície de invasão.
- **Fazer:** rodar `infra/hardening/ufw-setup.sh` (ver `RUNBOOK_VPS.md`) **e/ou** configurar o firewall do painel Hostinger (liberar só 22/80/443/8443).
- **Verificar:** `ss -tlnp` não mostra 3333/8000 públicos; `ufw status verbose` default deny.

### 6. VPS — fechar o rembg (porta 8000) e endurecer o SSH

- **Por quê:** rembg sem auth exposto = DoS; root SSH = pior caso.
- **Fazer:** deploy do `docker-compose.yml` corrigido (bind `127.0.0.1:8000`) + seguir `infra/hardening/ssh-hardening.md` (trava anti-lockout).
- **Verificar:** `curl http://72.61.57.38:8000/health` falha de fora; `ssh root@...` recusado, `ssh deploy@...` por chave OK.

---

## 🟠 P1 — Logo em seguida

### 7. Supabase — Network restrictions + SSL + PITR

- **Por quê:** restringir quem conecta no banco + backups point-in-time.
- **Fazer:** painel → Database → **Network Restrictions**: permitir só o IP da VPS `72.61.57.38`. Exigir `sslmode=require` na connection string. Ativar **PITR/backup**.
- **Verificar:** conexão de outro IP é recusada; backups aparecem no painel.

### 8. Hostinger — backup diário + auto-renovação + malware scanner

- **Por quê:** hoje **2 snapshots** (raso); **auto-renew OFF, expira 2026-07-10** (perder a VPS no meio da campanha = catástrofe); **malware scanner não instalado**.
- **Fazer:** painel → ativar **backup diário**; **ligar auto-renovação** (ou alarme antes de 10/07/2026); **instalar o malware scanner** (ou ClamAV via SSH).
- **Verificar:** backup diário agendado; auto-renew "ON"; scanner instalado e com varredura agendada.

### 9. CloudPanel — senha forte + 2FA + restrição de IP

- **Por quê:** o painel (8443) administra todo o servidor.
- **Fazer:** trocar a senha do `admin` por uma forte; ativar **2FA**; restringir o 8443 por IP (no UFW ou no painel); manter o CloudPanel atualizado.
- **Verificar:** login exige 2FA; 8443 só acessível do seu IP.

### 10. VPS — permissões de segredos em disco

- **Por quê:** `.env` e certificados A1 não podem ficar legíveis por outros.
- **Fazer:** `.env` → `chmod 600` + dono do usuário do app; `FISCAL_STORAGE_PATH` fora do dir web, `700`/`600`, backup cifrado off-site (ver Passo 6 do `RUNBOOK_VPS.md`).
- **Verificar:** `ls -la` mostra `600`/`700` e dono correto.

---

## 🟡 P2 — Endurecimento contínuo

### 11. Cloudflare (free) na frente do app

- **Por quê:** esconde o IP de origem (já público: `72.61.57.38`), adiciona WAF, rate limit de borda e proteção DDoS — ótimo para um lançamento público.
- **Fazer:** apontar o DNS para o Cloudflare (proxy ON), configurar regras básicas de WAF/rate-limit.

### 12. Varredura de segredos no histórico git

- **Por quê:** confirmar que nenhum `.env`/chave/cert foi commitado no passado.
- **Fazer:** `truffleHog git file://.` (ou `gitleaks detect`). Se achar algo, **rotacionar** o segredo. (Não reescrever histórico sem coordenar.)

### 13. Monitoramento/alertas

- **Por quê:** detectar indisponibilidade e abuso cedo.
- **Fazer:** uptime check (ex.: UptimeRobot) na home/health; alerta de CPU/RAM/disco no painel.

---

## Resumo da divisão de trabalho

- **Código (já feito/em PRs por mim):** auth, hashing, isolamento, headers, rate-limit, cifra de tokens, redação de logs, webhooks — ver `PLANO_SEGURANCA.md`.
- **Banco (você aplica):** itens 1–4, 7 + SQLs de `supabase/security/`.
- **VPS/painéis (você executa):** itens 5–6, 8–13 + scripts de `infra/hardening/`.
