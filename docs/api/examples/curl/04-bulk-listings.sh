#!/usr/bin/env bash
# Bulk listing: cria N anúncios para M produtos em background.
# 1) Preflight Shopee (valida categoria folha)
# 2) Cria job
# 3) Polling de status
#
# Variáveis:
#   API_BASE
#   EMAIL
#   ML_ACCOUNT_ID
#   SHOPEE_ACCOUNT_ID
#   PRODUCT_IDS  separados por vírgula (ex.: "p1,p2,p3")

set -euo pipefail

API_BASE="${API_BASE:-http://localhost:3333}"
: "${EMAIL:?}"
: "${ML_ACCOUNT_ID:?}"
: "${SHOPEE_ACCOUNT_ID:?}"
: "${PRODUCT_IDS:?}"

# Converte CSV em JSON array
IFS=',' read -ra IDS_ARR <<< "$PRODUCT_IDS"
IDS_JSON=$(printf '"%s",' "${IDS_ARR[@]}")
IDS_JSON="[${IDS_JSON%,}]"

echo ">> 1/3 Preflight Shopee..."
curl -sS -X POST "$API_BASE/listings/bulk/preflight" \
  -H "email: $EMAIL" \
  -H 'Content-Type: application/json' \
  -d "{\"shopeeAccountId\": \"$SHOPEE_ACCOUNT_ID\", \"productIds\": $IDS_JSON}"
echo

echo ">> 2/3 Criando job bulk..."
JOB_RESP=$(curl -sS -X POST "$API_BASE/listings/bulk" \
  -H "email: $EMAIL" \
  -H 'Content-Type: application/json' \
  -d "{
    \"productIds\": $IDS_JSON,
    \"requests\": [
      { \"platform\": \"MERCADO_LIVRE\", \"accountId\": \"$ML_ACCOUNT_ID\", \"mlSettings\": { \"listingType\": \"gold_special\", \"itemCondition\": \"used\" } },
      { \"platform\": \"SHOPEE\", \"accountId\": \"$SHOPEE_ACCOUNT_ID\" }
    ]
  }")
echo "$JOB_RESP"
JOB_ID=$(echo "$JOB_RESP" | grep -oE '"jobId":"[^"]+"' | cut -d'"' -f4)
echo "JOB_ID=$JOB_ID"

echo ">> 3/3 Polling status..."
for i in 1 2 3 5 8 13 20; do
  sleep "$i"
  STATUS=$(curl -sS "$API_BASE/listings/bulk/$JOB_ID" -H "email: $EMAIL")
  echo "  [+${i}s] $STATUS"
  echo "$STATUS" | grep -q '"status":"FINISHED"' && break
done
