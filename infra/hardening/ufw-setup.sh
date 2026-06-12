#!/usr/bin/env bash
# =============================================================================
# Dexo · Frente C · Firewall UFW (Ubuntu 24.04 / Hostinger KVM8)
#
# Estado atual (painel): "Firewall rules: 0" — portas potencialmente abertas.
# Este script aplica default-deny e libera SÓ o necessário.
#
# IMPORTANTE (anti-lockout): o SSH é liberado ANTES de habilitar o firewall.
# Rode como root (ou sudo). Revise as variáveis abaixo antes de executar.
#
# Uso:
#   sudo bash ufw-setup.sh            # aplica
#   sudo bash ufw-setup.sh --dry-run  # só mostra o que faria
# =============================================================================
set -euo pipefail

DRY_RUN="${1:-}"

# --- Configuração (ajuste se necessário) -------------------------------------
SSH_PORT="22"
# IP do Felipe para restringir o painel CloudPanel (8443). Deixe vazio para
# liberar 8443 para qualquer origem (menos seguro). Ex.: ADMIN_IP="203.0.113.5"
ADMIN_IP=""
CLOUDPANEL_PORT="8443"
# -----------------------------------------------------------------------------

run() {
  if [ "$DRY_RUN" = "--dry-run" ]; then
    echo "[dry-run] $*"
  else
    echo "+ $*"
    eval "$@"
  fi
}

echo "==> Configurando UFW (default deny incoming / allow outgoing)"
run "ufw --force reset"
run "ufw default deny incoming"
run "ufw default allow outgoing"

echo "==> Liberando SSH ($SSH_PORT) PRIMEIRO (anti-lockout)"
run "ufw allow ${SSH_PORT}/tcp comment 'SSH'"

echo "==> Liberando HTTP/HTTPS (80/443) para o app via CloudPanel"
run "ufw allow 80/tcp comment 'HTTP'"
run "ufw allow 443/tcp comment 'HTTPS'"

echo "==> Painel CloudPanel (${CLOUDPANEL_PORT})"
if [ -n "$ADMIN_IP" ]; then
  run "ufw allow from ${ADMIN_IP} to any port ${CLOUDPANEL_PORT} proto tcp comment 'CloudPanel (admin IP)'"
else
  echo "   ATENCAO: ADMIN_IP vazio -> liberando ${CLOUDPANEL_PORT} para qualquer origem."
  echo "   Recomendado: defina ADMIN_IP e re-rode, OU restrinja depois."
  run "ufw allow ${CLOUDPANEL_PORT}/tcp comment 'CloudPanel'"
fi

# NÃO liberar 3000/3333 (Next/Fastify) nem 8000 (rembg): eles só devem ser
# acessados localmente (reverse proxy do CloudPanel em 80/443 / 127.0.0.1).
echo "==> Garantindo que portas internas NAO estejam abertas (3000/3333/8000)"
run "ufw deny 3000/tcp comment 'Next (interno)'"
run "ufw deny 3333/tcp comment 'Fastify API (interno)'"
run "ufw deny 8000/tcp comment 'rembg (interno)'"

echo "==> Habilitando UFW"
run "ufw --force enable"
run "ufw status verbose"

echo ""
echo "OK. Verifique: 'ss -tlnp' (nada de 3333/8000 escutando em 0.0.0.0 publicamente)"
echo "e 'ufw status verbose'. Mantenha uma sessao SSH aberta ao testar."
