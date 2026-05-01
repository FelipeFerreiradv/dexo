#!/usr/bin/env bash
# Cria um produto SEM anunciar (apenas cadastro interno).
#
# Variáveis:
#   API_BASE   default http://localhost:3333
#   EMAIL      obrigatório (e-mail do usuário cadastrado)
#   IMAGE_URL  obrigatório (saída de 01-upload-image.sh)

set -euo pipefail

API_BASE="${API_BASE:-http://localhost:3333}"
: "${EMAIL:?Defina EMAIL=usuario@empresa.com}"
: "${IMAGE_URL:?Defina IMAGE_URL=http://localhost:3333/uploads/...jpg}"

curl -sS -X POST "$API_BASE/products" \
  -H "email: $EMAIL" \
  -H 'Content-Type: application/json' \
  -d @- <<EOF
{
  "sku": "DESMONT-DEMO-001",
  "name": "Peça de demonstração",
  "description": "Cadastro de teste — sem publicar anúncio.",
  "price": 49.90,
  "stock": 1,
  "imageUrl": "$IMAGE_URL"
}
EOF
