#!/usr/bin/env bash
#
# Monta o bundle de CAs ICP-Brasil (raízes AC-Raiz + ACs intermediárias) num
# único arquivo PEM, para o Node confiar nele ao validar o certificado TLS dos
# web services da SEFAZ (SVRS/SVAN/SEFAZ próprio enviam só o leaf — os
# intermediários e a raiz ICP-Brasil NÃO vêm no Node nem no .pfx do cliente).
#
# Depois de rodar:
#   1) adicione ao .env (UMA linha):  SEFAZ_CA_BUNDLE_PATH=<caminho impresso>
#   2) pm2 restart all --update-env && pm2 save
#   3) reemita a nota (ou rode o diagnose para confirmar).
#
# O SefazDirectProvider lê SEFAZ_CA_BUNDLE_PATH e ANEXA este bundle ao trust
# store padrão do Node (ver app/fiscal/sefaz/soap-client.service.ts).
#
# Uso:
#   bash scripts/fiscal/install-icp-brasil-ca.sh [caminho-de-saida.pem]
#
# Requer: curl, unzip, openssl.

set -uo pipefail

OUT="${1:-${FISCAL_STORAGE_PATH:-$(pwd)/.fiscal-storage}/sefaz-icp-trust.pem}"
ACS_URL="https://acraiz.icpbrasil.gov.br/credenciadas/CertificadosAC-ICP-Brasil/ACcompactado.zip"
RAIZ_BASE="https://acraiz.icpbrasil.gov.br/credenciadas/RAIZ"
ROOTS="v2 v5 v6 v7 v10 v12 v13"

for bin in curl unzip openssl; do
  command -v "$bin" >/dev/null 2>&1 || { echo "ERRO: '$bin' não encontrado. Instale-o."; exit 1; }
done

mkdir -p "$(dirname "$OUT")"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"

echo "→ Baixando ACs intermediárias (ACcompactado.zip)..."
curl -fsSL -o acs.zip "$ACS_URL" || { echo "ERRO ao baixar $ACS_URL (tente novamente; se persistir, rede/proxy)"; exit 2; }
unzip -oq acs.zip -d acs || { echo "ERRO ao descompactar ACcompactado.zip"; exit 3; }

echo "→ Baixando raízes AC-Raiz ICP-Brasil ($ROOTS)..."
mkdir -p raiz
for v in $ROOTS; do
  curl -fsSL -o "raiz/ICP-Brasil${v}.crt" "${RAIZ_BASE}/ICP-Brasil${v}.crt" \
    || echo "  (aviso: raiz $v indisponível — seguindo)"
done

echo "→ Convertendo para PEM e concatenando em $OUT ..."
: > "$OUT"
chmod 644 "$OUT" 2>/dev/null || true
count=0
while IFS= read -r -d '' f; do
  if openssl x509 -inform DER -in "$f" >> "$OUT" 2>/dev/null; then
    count=$((count + 1))
  elif openssl x509 -inform PEM -in "$f" >> "$OUT" 2>/dev/null; then
    count=$((count + 1))
  fi
done < <(find acs raiz -type f \( -iname '*.crt' -o -iname '*.cer' -o -iname '*.pem' \) -print0)

total="$(grep -c 'BEGIN CERTIFICATE' "$OUT" 2>/dev/null || echo 0)"
echo
echo "✓ Bundle gerado: $OUT"
echo "  certificados incluídos: $total"
echo
echo "Próximos passos:"
echo "  1) Garanta no .env (UMA linha):  SEFAZ_CA_BUNDLE_PATH=$OUT"
echo "  2) pm2 restart all --update-env && pm2 save"
echo "  3) npx tsx scripts/fiscal/diagnose-sefaz-tls.ts --email=<email>   # deve dar veredito ✅"
echo "  4) Reemita a nota."
