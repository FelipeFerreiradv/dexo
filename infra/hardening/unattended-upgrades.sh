#!/usr/bin/env bash
# =============================================================================
# Dexo · Frente C · Security updates automáticos (unattended-upgrades)
# Ubuntu 24.04. Rode como root/sudo.
# =============================================================================
set -euo pipefail

echo "==> Instalando unattended-upgrades"
apt-get update -y
apt-get install -y unattended-upgrades apt-listchanges

echo "==> Habilitando atualizações automáticas de segurança"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::Download-Upgradeable-Packages "1";
APT::Periodic::AutocleanInterval "7";
EOF

# Garante que só o canal de SECURITY seja aplicado automaticamente (padrão do
# Ubuntu já faz isto; reforçamos e ligamos reboot automático em janela noturna
# SE houver kernel novo — ajuste se preferir reboots manuais).
cat > /etc/apt/apt.conf.d/50unattended-upgrades <<'EOF'
Unattended-Upgrade::Allowed-Origins {
    "${distro_id}:${distro_codename}";
    "${distro_id}:${distro_codename}-security";
    "${distro_id}ESMApps:${distro_codename}-apps-security";
    "${distro_id}ESM:${distro_codename}-infra-security";
};
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::Automatic-Reboot-Time "04:00";
EOF

echo "==> Testando (dry-run)"
unattended-upgrade --dry-run --debug || true

systemctl enable unattended-upgrades
systemctl restart unattended-upgrades

echo "OK. Reboot automático está DESLIGADO (Automatic-Reboot \"false\")."
echo "Se quiser reboot automático em kernel novo, mude para \"true\"."
