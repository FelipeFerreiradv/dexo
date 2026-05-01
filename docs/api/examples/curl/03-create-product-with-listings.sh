#!/usr/bin/env bash
# Cria um produto E dispara anúncios em ML + Shopee em background.
#
# Variáveis:
#   API_BASE       default http://localhost:3333
#   EMAIL          obrigatório
#   IMAGE_URL      obrigatório (saída de 01-upload-image.sh)
#   ML_ACCOUNT_ID  obrigatório (de GET /marketplace/ml/accounts)
#   ML_CATEGORY    obrigatório (ex.: MLB252712)
#   SHOPEE_ACCOUNT_ID  obrigatório
#   SHOPEE_CATEGORY    obrigatório (categoria folha)

set -euo pipefail

API_BASE="${API_BASE:-http://localhost:3333}"
: "${EMAIL:?}"
: "${IMAGE_URL:?}"
: "${ML_ACCOUNT_ID:?}"
: "${ML_CATEGORY:?}"
: "${SHOPEE_ACCOUNT_ID:?}"
: "${SHOPEE_CATEGORY:?}"

curl -sS -X POST "$API_BASE/products" \
  -H "email: $EMAIL" \
  -H 'Content-Type: application/json' \
  -d @- <<EOF
{
  "sku": "DESMONT-FULL-001",
  "name": "Mangueira radiador Gol G5 1.0 8V 2008-2014",
  "description": "Mangueira superior do radiador, original/usada em bom estado.",
  "price": 89.90,
  "costPrice": 35.00,
  "stock": 2,
  "brand": "Volkswagen",
  "model": "Gol",
  "year": "2010",
  "version": "1.0 8V",
  "partNumber": "5U0121049",
  "quality": "SEMINOVO",
  "heightCm": 12,
  "widthCm": 8,
  "lengthCm": 45,
  "weightKg": 0.4,
  "imageUrl": "$IMAGE_URL",
  "imageUrls": ["$IMAGE_URL"],
  "mlCategory": "$ML_CATEGORY",
  "shopeeCategory": "$SHOPEE_CATEGORY",
  "compatibilities": [
    { "brand": "Volkswagen", "model": "Gol", "yearFrom": 2008, "yearTo": 2014, "version": "1.0 8V" }
  ],
  "listings": [
    {
      "platform": "MERCADO_LIVRE",
      "categoryId": "$ML_CATEGORY",
      "accountIds": ["$ML_ACCOUNT_ID"],
      "listingType": "gold_special",
      "itemCondition": "used",
      "hasWarranty": true,
      "warrantyUnit": "dias",
      "warrantyDuration": 30,
      "shippingMode": "me2"
    },
    {
      "platform": "SHOPEE",
      "categoryId": "$SHOPEE_CATEGORY",
      "accountIds": ["$SHOPEE_ACCOUNT_ID"]
    }
  ]
}
EOF
