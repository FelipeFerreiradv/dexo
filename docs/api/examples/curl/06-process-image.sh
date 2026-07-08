#!/usr/bin/env bash
# Remove o fundo de uma imagem (e opcionalmente aplica sombra), devolvendo os
# BYTES da imagem processada. Endpoint STATELESS — nada é salvo no servidor Dexo.
#
# Uso:
#   TOKEN=<jwt> ./06-process-image.sh ./parte.jpg [saida.png]
#   EMAIL=usuario@empresa.com ./06-process-image.sh ./parte.jpg
#
# Variáveis:
#   API_BASE   default http://localhost:3333
#   TOKEN      JWT Bearer (recomendado). Se ausente, usa EMAIL (modo legacy).
#   EMAIL      e-mail cadastrado (fallback quando não há TOKEN)
#
# Pré-requisitos:
#   - Servidor Fastify rodando (http://localhost:3333 ou ajuste API_BASE)

set -euo pipefail

API_BASE="${API_BASE:-http://localhost:3333}"
IMAGE_PATH="${1:?Informe o caminho da imagem como primeiro argumento}"
OUT_PATH="${2:-parte-processada.png}"

# Monta o header de auth: Bearer se houver TOKEN, senão o header email.
AUTH_HEADER=()
if [[ -n "${TOKEN:-}" ]]; then
  AUTH_HEADER=(-H "Authorization: Bearer ${TOKEN}")
elif [[ -n "${EMAIL:-}" ]]; then
  AUTH_HEADER=(-H "email: ${EMAIL}")
else
  echo "Defina TOKEN=<jwt> OU EMAIL=<email cadastrado>" >&2
  exit 1
fi

# -D - imprime os headers de resposta (X-Removed-Background, X-Warning, ...).
# -o grava os bytes da imagem processada em OUT_PATH.
curl -sS -X POST "$API_BASE/v1/images/process" \
  "${AUTH_HEADER[@]}" \
  -F "file=@${IMAGE_PATH}" \
  -F "removeBackground=true" \
  -F "addShadow=true" \
  -D - \
  -o "$OUT_PATH"

echo "Imagem processada salva em: $OUT_PATH" >&2
