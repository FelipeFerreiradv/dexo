#!/usr/bin/env bash
# Sobe uma imagem de produto. Retorna `imageUrl` que será usada em POST /products.
#
# Uso:
#   ./01-upload-image.sh ./minha-imagem.jpg
#
# Pré-requisitos:
#   - Servidor Fastify rodando (http://localhost:3333 ou ajuste API_BASE)

set -euo pipefail

API_BASE="${API_BASE:-http://localhost:3333}"
IMAGE_PATH="${1:?Informe o caminho da imagem como primeiro argumento}"

curl -sS -X POST "$API_BASE/upload/image" \
  -F "file=@${IMAGE_PATH}" \
  | tee /dev/stderr
