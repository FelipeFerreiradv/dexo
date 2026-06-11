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

## Verificações finais (checklist)

- [ ] `ss -tlnp` — só 22/80/443 públicos; 3333/8000 em 127.0.0.1.
- [ ] `ufw status verbose` — default deny incoming.
- [ ] `ssh root@...` recusado; `ssh deploy@...` por chave OK.
- [ ] `fail2ban-client status sshd` ativo.
- [ ] App funcionando (home, login, upload de imagem usando o rembg local).
- [ ] Snapshot/backup recente existe.
