#!/usr/bin/env bash
# Polling com backoff exponencial após POST /products.
#
# Variáveis:
#   API_BASE
#   EMAIL
#   PRODUCT_ID

set -euo pipefail

API_BASE="${API_BASE:-http://localhost:3333}"
: "${EMAIL:?}"
: "${PRODUCT_ID:?}"

for delay in 1 2 5 10 20; do
  RESP=$(curl -sS "$API_BASE/listings/status?productId=$PRODUCT_ID" -H "email: $EMAIL")
  echo "[t+${delay}s] $RESP"
  echo "$RESP" | grep -q '"status":"PENDING"' || break
  sleep "$delay"
done
