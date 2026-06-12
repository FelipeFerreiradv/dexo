# SSH Hardening — VPS Dexo (com TRAVA ANTI-LOCKOUT)

> Estado atual (painel): acesso **root via SSH** (`ssh root@72.61.57.38`) — o pior cenário.
> Objetivo: usuário sudo **não-root**, **somente chave**, sem login de root, sem senha.
> **NUNCA feche sua sessão root atual até validar a nova sessão.** Siga na ordem.

## 0. Pré-requisitos (na sua máquina local)

Se ainda não tem um par de chaves:

```bash
ssh-keygen -t ed25519 -C "felipe-dexo"   # gera ~/.ssh/id_ed25519(.pub)
```

## 1. Criar usuário sudo não-root (na VPS, como root)

```bash
adduser deploy                 # defina uma senha forte (guardada, não será usada p/ SSH)
usermod -aG sudo deploy
```

## 2. Instalar sua chave pública para o novo usuário

Opção A — da sua máquina local:

```bash
ssh-copy-id -i ~/.ssh/id_ed25519.pub deploy@72.61.57.38
```

Opção B — manual (na VPS, como root):

```bash
mkdir -p /home/deploy/.ssh
# cole o conteúdo do seu id_ed25519.pub na linha abaixo:
echo "ssh-ed25519 AAAA... felipe-dexo" > /home/deploy/.ssh/authorized_keys
chmod 700 /home/deploy/.ssh
chmod 600 /home/deploy/.ssh/authorized_keys
chown -R deploy:deploy /home/deploy/.ssh
```

## 3. ⚠️ TRAVA ANTI-LOCKOUT — teste a nova sessão ANTES de mexer no sshd

**Mantenha a sessão root atual ABERTA.** Em **outro terminal**, abra uma nova sessão:

```bash
ssh deploy@72.61.57.38            # deve entrar SEM pedir senha (via chave)
sudo whoami                        # deve responder: root
```

Só prossiga se as duas coisas funcionarem. Se falhar, corrija a chave/permissões
antes de continuar (você ainda tem a sessão root aberta).

## 4. Endurecer o sshd (na sessão root, com a sessão deploy validada aberta)

```bash
cp /etc/ssh/sshd_config /etc/ssh/sshd_config.bak.$(date +%s)   # backup p/ rollback
```

Edite `/etc/ssh/sshd_config` (ou crie `/etc/ssh/sshd_config.d/99-dexo.conf`) com:

```
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
ChallengeResponseAuthentication no
KbdInteractiveAuthentication no
UsePAM yes
X11Forwarding no
MaxAuthTries 3
```

Valide a sintaxe e recarregue (NÃO reinicie de um jeito que derrube tudo):

```bash
sshd -t && systemctl reload ssh    # 'ssh' no Ubuntu 24.04 (não 'sshd')
```

## 5. Validar de novo (terceira sessão)

Em **mais um terminal**:

```bash
ssh deploy@72.61.57.38             # deve entrar por chave
ssh root@72.61.57.38               # deve ser RECUSADO (PermitRootLogin no)
```

Se `deploy` entra e `root` é recusado, está OK. **Agora** pode fechar a sessão root.

## 6. Rollback (se algo der errado e você ainda tiver uma sessão)

```bash
cp /etc/ssh/sshd_config.bak.<timestamp> /etc/ssh/sshd_config
sshd -t && systemctl reload ssh
```

Se você se trancou para fora completamente: use o **console/VNC da Hostinger**
(painel → VPS → Terminal/Console) para entrar e reverter.

## 7. Depois

- Desative a senha de root na Hostinger ou troque-a por uma forte (o painel pode
  reabilitar login por senha — confira).
- Rode `fail2ban-setup.sh` (proteção brute-force) e `ufw-setup.sh` (firewall).
