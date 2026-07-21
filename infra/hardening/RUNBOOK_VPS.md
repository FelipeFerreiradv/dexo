# Runbook de Hardening da VPS — Dexo (Frente C)

> VPS: `srv1141695.hstgr.cloud` · Hostinger **KVM8** · Ubuntu 24.04 + CloudPanel · IP `72.61.57.38`.
> Estado inicial (painel): **Firewall: 0 regras** · **Malware scanner: não instalado** · **root SSH habilitado** · rembg em `0.0.0.0:8000` · **Backups: 2 snapshots**.
> **Você (Felipe) executa via SSH.** Cada passo tem verificação e rollback. Faça **um snapshot da VPS no painel antes de começar**.

## Ordem segura (não inverta)

A ordem evita lockout: firewall libera SSH antes de tudo; o corte do root SSH só acontece depois de validar a chave.

### Passo 0 — Snapshot + sessão de segurança

1. Painel Hostinger → VPS → **criar snapshot** (rollback de emergência).
2. Abra **duas** sessões SSH root e deixe ambas abertas durante o processo.
   ```bash
   ssh root@72.61.57.38
   ```

### Passo 1 — Firewall (UFW)

```bash
# copie os scripts para a VPS (scp) ou cole o conteúdo:
sudo bash ufw-setup.sh --dry-run     # revise o que fará
sudo bash ufw-setup.sh               # aplica (libera SSH ANTES de ativar)
```

**Verificar:** `sudo ufw status verbose` (22/80/443 abertos; 3000/3333/8000 negados).
Em outra sessão, confirme que o SSH ainda conecta.
**Rollback:** `sudo ufw disable`.

### Passo 2 — Fechar o rembg (porta 8000)

A correção do bind está no repo (`docker-compose.yml` → `127.0.0.1:8000:8000`). Faça deploy e recrie o container:

```bash
cd /caminho/do/projeto
git pull
docker compose up -d --force-recreate rembg
```

**Verificar:**

```bash
ss -tlnp | grep 8000           # deve mostrar 127.0.0.1:8000, NÃO 0.0.0.0:8000
curl -s http://127.0.0.1:8000/health   # deve responder localmente
curl -s --max-time 5 http://72.61.57.38:8000/health || echo "OK: 8000 nao acessivel externamente"
```

**Rollback:** reverter o `docker-compose.yml` e `docker compose up -d --force-recreate rembg` (não recomendado — reabre o DoS).

### Passo 3 — SSH hardening (sem root, key-only)

Siga **`ssh-hardening.md`** à risca (tem a trava anti-lockout). Resumo:

1. `adduser deploy` + `usermod -aG sudo deploy`.
2. Instalar sua chave pública em `deploy`.
3. **Testar `ssh deploy@... ` + `sudo whoami` em nova sessão ANTES de mexer no sshd.**
4. `PermitRootLogin no`, `PasswordAuthentication no` → `sshd -t && systemctl reload ssh`.
5. Validar (deploy entra, root é recusado) e só então fechar a sessão root.
   **Rollback:** restaurar `/etc/ssh/sshd_config.bak.*` + `systemctl reload ssh`; em último caso, console/VNC do painel.

### Passo 4 — fail2ban

```bash
sudo bash fail2ban-setup.sh
```

**Verificar:** `sudo fail2ban-client status sshd`.
**Rollback:** `sudo systemctl stop fail2ban && sudo systemctl disable fail2ban`.

### Passo 5 — Atualizações automáticas de segurança

```bash
sudo bash unattended-upgrades.sh
```

**Verificar:** `systemctl status unattended-upgrades` e o dry-run impresso.

### Passo 6 — Permissões de segredos em disco

```bash
# .env do app: dono = usuário do app, 600
sudo chown deploy:deploy /caminho/do/projeto/.env
sudo chmod 600 /caminho/do/projeto/.env

# FISCAL_STORAGE_PATH (certs A1 + XMLs): fora do dir servido pela web, 700
sudo chmod 700 "$FISCAL_STORAGE_PATH"
find "$FISCAL_STORAGE_PATH" -type f -name '*.pfx' -exec chmod 600 {} \;
```

**Verificar:** `ls -la` mostra `600`/`700` e dono correto.

### Passo 7 — Itens de painel (ver ACOES_MANUAIS_SEGURANCA.md)

Firewall do painel, **backup diário**, **auto-renew (expira 2026-07-10)**, **malware scanner**, CloudPanel 2FA + restrição de IP no 8443.

### Passo 8 — nginx: timeouts do proxy e CORS nas respostas de erro

> **Contexto:** o modal de criação de produto mostrava `Status code: 504` +
> `CORS header 'Access-Control-Allow-Origin' missing` no upload com remoção de
> fundo. O 504 é gerado pelo **nginx**, não pelo app — e por isso não passa pelo
> `@fastify/cors`, o browser descarta a resposta e a imagem se perde. O app já
> foi corrigido para **sempre responder dentro de ~45s** (degradando para imagem
> otimizada + aviso). Este passo é **defesa em profundidade**.

> ⚠️ **`api.usedexo.com.br` NÃO é um Site do CloudPanel.** É um vhost **manual**
> em `/etc/nginx/conf.d/usedexo.com.br.conf` (o `sites-available/usedexo.com.br`
> existe mas **não** está enabled). Logs em `/var/log/nginx/`, não em
> `/home/<site-user>/logs/`. Confirme antes de editar qualquer coisa.

#### 8.1 — Diagnóstico PRIMEIRO (não pule: é o que fecha a causa-raiz)

```bash
# Onde o vhost realmente está e quais timeouts valem hoje:
nginx -T 2>/dev/null | grep -nE 'server_name|proxy_read_timeout|proxy_send_timeout|client_max_body_size'
ls -la /etc/nginx/conf.d/ /etc/nginx/sites-enabled/

# O 504 no access.log — o $request_time dele É o proxy_read_timeout efetivo:
grep ' /upload/image ' /var/log/nginx/*access.log | grep ' 504 ' | tail -20

# O motivo exato, no error.log:
grep -F 'upstream timed out' /var/log/nginx/*error.log | grep -i upload | tail -20

# Cruzar com o app no MESMO horário:
pm2 logs dexo-api --lines 500 --nostream | grep -E 'sidecar rembg falhou|orçamento/fila'
```

**Como ler:**

| Evidência | Conclusão |
|---|---|
| `upstream timed out ... while reading response header` | É o `proxy_read_timeout`. Causa confirmada. |
| `... while connecting to upstream` | O Fastify não estava aceitando conexão (outro problema). |
| `$status 413` com `$request_time < 1s` | Corpo grande — ver 8.3. |
| Nenhuma entrada no nginx | O 504 veio de algo **na frente** do nginx (CDN/WAF). |
| `sidecar rembg falhou` ANTES do corte | A degradação funcionou; investigar outra causa. |

#### 8.2 — Alinhar os timeouts

No `server { ... }` de `api.usedexo.com.br` (dentro do `location` que faz
`proxy_pass` para `127.0.0.1:3333`):

```nginx
proxy_read_timeout 120s;
proxy_send_timeout 120s;
```

O app degrada sozinho em ~45s, então o nginx só cortaria numa anomalia real.
Para ajustar o orçamento do app sem redeploy, use `UPLOAD_HANDLER_BUDGET_MS` no
`.env` (default 45000) — mantenha-o **bem abaixo** do valor acima.

**Verificar:** `nginx -t && systemctl reload nginx`, depois repetir o upload com
"Remover fundo" + "Adicionar sombra" ligados.
**Rollback:** remover as duas linhas e `nginx -t && systemctl reload nginx`.

#### 8.3 — Conferir o limite de corpo (provavelmente já OK)

```bash
nginx -T 2>/dev/null | grep -n client_max_body_size
```

Verificado em 2026-07-08: é **global** em `/etc/nginx/nginx.conf` = `64M`, sem
override por vhost — folgado para os 20 MB que o app aceita. **Só confirme.** Se
algum dia aparecer um valor `< 20M`, suba para `64M`.

#### 8.4 — CORS **apenas** nas respostas de erro geradas pelo nginx

Sem isto, um 502/504 chega ilegível ao browser (`TypeError` opaco) e o front não
consegue diferenciar timeout de falha real.

```nginx
# DENTRO do location que faz proxy_pass:
proxy_intercept_errors on;
error_page 502 503 504 = @api_error;

# NO MESMO server block:
location @api_error {
    add_header 'Access-Control-Allow-Origin' 'https://app.usedexo.com.br' always;
    add_header 'Access-Control-Allow-Credentials' 'true' always;
    add_header 'Vary' 'Origin' always;
    default_type application/json;
    return 504 '{"error":"Gateway Timeout","message":"O servidor de imagens esta sobrecarregado. Tente novamente."}';
}
```

> ⚠️ **ALERTA CRÍTICO — NÃO duplicar o header.** Ponha o `add_header` **somente**
> na location de erro. O Fastify já envia `Access-Control-Allow-Origin` em todas
> as respostas que ele mesmo produz; **dois** headers `Access-Control-Allow-Origin`
> fazem o navegador **rejeitar a resposta inteira** — você trocaria um bug por
> outro pior, que atingiria o caminho feliz.
>
> Troque `https://app.usedexo.com.br` pelo valor **exato** de `CORS_ORIGIN` do
> `.env` (`grep '^CORS_ORIGIN=' /var/www/dexo/.env`). Precisa bater byte a byte:
> sem barra final, com o mesmo esquema/host/porta.

**Verificar:** com o app parado (`pm2 stop dexo-api`), um `curl -i -H 'Origin: <CORS_ORIGIN>'
https://api.usedexo.com.br/upload/image -X POST` deve trazer **exatamente um**
`Access-Control-Allow-Origin`. Religue com `pm2 start dexo-api`.
**Rollback:** remover o `error_page`/`location @api_error` + `nginx -t && systemctl reload nginx`.

## Verificações finais (checklist)

- [ ] `ss -tlnp` — só 22/80/443 públicos; 3333/8000 em 127.0.0.1.
- [ ] `ufw status verbose` — default deny incoming.
- [ ] `ssh root@...` recusado; `ssh deploy@...` por chave OK.
- [ ] `fail2ban-client status sshd` ativo.
- [ ] App funcionando (home, login, upload de imagem usando o rembg local).
- [ ] `nginx -T | grep proxy_read_timeout` — 120s no vhost da API.
- [ ] Upload no modal com "Remover fundo" + "Adicionar sombra": ou sai o PNG
      recortado, ou sai a imagem otimizada **com aviso** — nunca "falhou".
- [ ] `curl -i` num erro do nginx traz **um único** `Access-Control-Allow-Origin`.
- [ ] Snapshot/backup recente existe.
