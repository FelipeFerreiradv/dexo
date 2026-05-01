#!/usr/bin/env node
/**
 * Cliente Node.js end-to-end de integração com a GHD Platform API.
 *
 * Uso:
 *   API_BASE=http://localhost:3333 \
 *   EMAIL=usuario@empresa.com \
 *   ML_ACCOUNT_ID=acc_ml_01 \
 *   SHOPEE_ACCOUNT_ID=acc_shopee_01 \
 *   ML_CATEGORY=MLB252712 \
 *   SHOPEE_CATEGORY=100018 \
 *   IMAGE_PATH=./parte.jpg \
 *   node desmont-hub-integration.mjs
 *
 * Pré-requisito: Node 18+ (fetch e FormData nativos).
 *
 * Demonstra:
 *  1) Upload de imagem (multipart)
 *  2) Sugerir SKU
 *  3) Sugerir categoria ML
 *  4) Criar produto + anúncios em ML/Shopee (fire-and-forget)
 *  5) Polling com backoff exponencial até status sair de PENDING
 *  6) Tratamento idempotente de SKU duplicado (409)
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";

const API_BASE = process.env.API_BASE ?? "http://localhost:3333";
const EMAIL = required("EMAIL");
const ML_ACCOUNT_ID = required("ML_ACCOUNT_ID");
const SHOPEE_ACCOUNT_ID = required("SHOPEE_ACCOUNT_ID");
const ML_CATEGORY = required("ML_CATEGORY");
const SHOPEE_CATEGORY = required("SHOPEE_CATEGORY");
const IMAGE_PATH = required("IMAGE_PATH");

// ─────────────────────────────────────────────────────────────────────
// HTTP helper
// ─────────────────────────────────────────────────────────────────────

async function request(path, init = {}) {
  const url = `${API_BASE}${path}`;
  const headers = { email: EMAIL, ...(init.headers ?? {}) };
  const res = await fetch(url, { ...init, headers });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, ok: res.ok, body };
}

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`✖ Variável de ambiente obrigatória ausente: ${name}`);
    process.exit(1);
  }
  return v;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────
// Steps
// ─────────────────────────────────────────────────────────────────────

async function uploadImage(localPath) {
  const buf = await readFile(localPath);
  const fd = new FormData();
  fd.append(
    "file",
    new Blob([buf], { type: "image/jpeg" }),
    basename(localPath),
  );
  const res = await fetch(`${API_BASE}/upload/image`, {
    method: "POST",
    body: fd,
  });
  if (!res.ok) throw new Error(`upload falhou: HTTP ${res.status}`);
  const json = await res.json();
  return json.imageUrl;
}

async function suggestSku() {
  const { ok, body } = await request("/products/next-sku");
  if (!ok) throw new Error(`next-sku falhou: ${JSON.stringify(body)}`);
  return body.sku;
}

async function createProduct(productInput) {
  const { status, body } = await request("/products", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(productInput),
  });

  if (status === 201) return body;
  if (status === 409) {
    // SKU já existe — idempotente: aceitar como sucesso e seguir.
    console.warn(`! Produto com SKU ${productInput.sku} já existia (409). Recuperando...`);
    return await findProductBySku(productInput.sku);
  }
  throw new Error(`POST /products falhou (${status}): ${JSON.stringify(body)}`);
}

async function findProductBySku(sku) {
  const { ok, body } = await request(
    `/products?search=${encodeURIComponent(sku)}&limit=1`,
  );
  if (!ok) throw new Error(`busca por SKU falhou: ${JSON.stringify(body)}`);
  const found = body.products?.find((p) => p.sku === sku);
  if (!found) throw new Error(`SKU ${sku} retornou 409 mas não foi encontrado`);
  return found;
}

async function pollListingsUntilDone(productId) {
  const delays = [1000, 2000, 5000, 10000, 20000, 20000];
  for (const delay of delays) {
    await sleep(delay);
    const { ok, body } = await request(
      `/listings/status?productId=${encodeURIComponent(productId)}`,
    );
    if (!ok) {
      console.warn(`! poll falhou: ${JSON.stringify(body)}`);
      continue;
    }
    const listings = body.listings ?? [];
    console.log(
      `  [+${delay / 1000}s] ${listings.length} anúncios →`,
      listings.map((l) => `${l.platform}=${l.status}`).join(" "),
    );
    if (listings.length > 0 && listings.every((l) => l.status !== "PENDING")) {
      return listings;
    }
  }
  console.warn("! tempo limite atingido — ListingRetryService continuará tentando em background");
  return null;
}

// ─────────────────────────────────────────────────────────────────────
// Run
// ─────────────────────────────────────────────────────────────────────

(async () => {
  console.log("[1/5] Subindo imagem...");
  const imageUrl = await uploadImage(IMAGE_PATH);
  console.log("    imageUrl:", imageUrl);

  console.log("[2/5] Pedindo SKU sugerido (apenas referência — vamos usar um SKU determinístico)...");
  const suggested = await suggestSku();
  console.log("    sugerido:", suggested, "(usaremos DESMONT-NODE-DEMO no lugar)");

  const sku = "DESMONT-NODE-DEMO-001";

  console.log("[3/5] Criando produto + dispatch para ML e Shopee...");
  const product = await createProduct({
    sku,
    name: "Mangueira radiador Gol G5 1.0 8V 2008-2014",
    description: "Cadastro feito via cliente Node.js de exemplo.",
    price: 89.9,
    stock: 1,
    brand: "Volkswagen",
    model: "Gol",
    year: "2010",
    version: "1.0 8V",
    partNumber: "5U0121049",
    quality: "SEMINOVO",
    imageUrl,
    imageUrls: [imageUrl],
    mlCategory: ML_CATEGORY,
    shopeeCategory: SHOPEE_CATEGORY,
    compatibilities: [
      {
        brand: "Volkswagen",
        model: "Gol",
        yearFrom: 2008,
        yearTo: 2014,
        version: "1.0 8V",
      },
    ],
    listings: [
      {
        platform: "MERCADO_LIVRE",
        categoryId: ML_CATEGORY,
        accountIds: [ML_ACCOUNT_ID],
        listingType: "gold_special",
        itemCondition: "used",
        hasWarranty: true,
        warrantyUnit: "dias",
        warrantyDuration: 30,
        shippingMode: "me2",
      },
      {
        platform: "SHOPEE",
        categoryId: SHOPEE_CATEGORY,
        accountIds: [SHOPEE_ACCOUNT_ID],
      },
    ],
  });
  console.log("    productId:", product.id);

  console.log("[4/5] Polling de status (backoff exponencial)...");
  const final = await pollListingsUntilDone(product.id);

  console.log("[5/5] Pronto.");
  if (final) {
    for (const l of final) {
      console.log(`  - ${l.platform} (${l.accountName}): ${l.status} ${l.permalink ?? ""}`);
    }
  }
})().catch((err) => {
  console.error("✖ Falha:", err);
  process.exit(1);
});
