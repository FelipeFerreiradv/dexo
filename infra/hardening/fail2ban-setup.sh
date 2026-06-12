#!/usr/bin/env bash
# =============================================================================
# Dexo · Frente C · fail2ban (proteção contra brute-force de SSH)
# Ubuntu 24.04. Rode como root/sudo.
# =============================================================================
set -euo pipefail

echo "==> Instalando fail2ban"
apt-get update -y
apt-get install -y fail2ban

echo "==> Configurando jail local (SSH)"
cat > /etc/fail2ban/jail.local <<'EOF'
[DEFAULT]
# Banir por 1h após 5 falhas em 10 min. Ajuste a gosto.
bantime  = 1h
findtime = 10m
maxretry = 5
# Use backend systemd no Ubuntu 24.04.
backend  = systemd
# Nunca se auto-banir de redes confiáveis (adicione o IP do Felipe se fixo):
ignoreip = 127.0.0.1/8 ::1

[sshd]
enabled = true
port    = ssh
EOF

echo "==> Habilitando e iniciando fail2ban"
systemctl enable fail2ban
systemctl restart fail2ban
sleep 1
fail2ban-client status sshd || true

echo "OK. Veja banimentos com: fail2ban-client status sshd"
