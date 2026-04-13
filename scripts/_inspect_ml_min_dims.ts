/**
 * Investigação read-only: descobrir por que o ML rejeita SELLER_PACKAGE_* em alguns itens.
 *
 * Para cada item suspeito:
 *  - GET /items/{id} (com include_attributes=all) — pega catalog_product_id e attributes
 *  - Se tem catalog_product_id, GET /products/{cpid} — registra dimensions/specs do catálogo
 *  - GET /categories/{cat}/attributes — procura SELLER_PACKAGE_* (value_min/value_max?)
 *
 * Saída: scripts/out/ml-min-dims-inspection.json
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import axios from "axios";
import prisma from "../app/lib/prisma";
import { MLOAuthService } from "../app/marketplaces/services/ml-oauth.service";

const USER_ID = "cmn5yc4rn0000vsasmwv9m8nc";
const API = "https://api.mercadolibre.com";

// Itens que falharam no smoke-test + alguns que passaram (controle)
const SUSPECT_ITEMS = [
  "MLB3189216682", // FAIL — Lanterna Uno Vivace
  "MLB3189176379", // FAIL — Lanterna Uno Vivace
  "MLB3189105338", // FAIL — Lanterna Uno
];

async function getValidAccessToken(account: any): Promise<string | null> {
  const now = new Date();
  if (account.expiresAt && new Date(account.expiresAt) > new Date(now.getTime() + 60_000)) {
    return account.accessToken;
  }
  const refreshed = await MLOAuthService.refreshAccessToken(account.refreshToken);
  await prisma.marketplaceAccount.update({
    where: { id: account.id },
    data: {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: new Date(Date.now() + refreshed.expiresIn * 1000),
    },
  });
  return refreshed.accessToken;
}

async function main() {
  const accounts = await prisma.marketplaceAccount.findMany({
    where: { userId: USER_ID, platform: "MERCADO_LIVRE" },
  });
  // Use a primeira conta com token válido (todos os itens suspeitos são da JOTABÊ)
  const acc = accounts.find((a) => a.accountName === "JOTABÊ AUTOPEÇAS") || accounts[0];
  const token = await getValidAccessToken(acc);
  if (!token) throw new Error("sem token");

  const out: any[] = [];
  const seenCats = new Set<string>();
  const catAttrCache: Record<string, any> = {};

  for (const id of SUSPECT_ITEMS) {
    console.log(`\n=== ${id} ===`);
    const itemRes = await axios.get(`${API}/items/${id}?include_attributes=all`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const it = itemRes.data;
    const catalogProductId = it.catalog_product_id || null;
    const catId = it.category_id;
    const sellerAttrs = (it.attributes || []).filter((a: any) =>
      String(a.id).startsWith("SELLER_PACKAGE") ||
      a.id === "PACKAGE_HEIGHT" || a.id === "PACKAGE_WIDTH" ||
      a.id === "PACKAGE_LENGTH" || a.id === "PACKAGE_WEIGHT" ||
      a.id === "HEIGHT" || a.id === "WIDTH" || a.id === "LENGTH" || a.id === "WEIGHT" ||
      a.id === "DEPTH"
    );
    const shipping = it.shipping || {};
    console.log(`  category_id=${catId}`);
    console.log(`  catalog_product_id=${catalogProductId}`);
    console.log(`  shipping.dimensions=${shipping.dimensions || "(null)"}`);
    console.log(`  domain_id=${it.domain_id}`);
    console.log(`  seller-related dim attrs:`);
    for (const a of sellerAttrs) {
      console.log(`    ${a.id} = ${a.value_name || a.value_struct?.number + a.value_struct?.unit || JSON.stringify(a.values)}`);
    }

    let catalogProduct: any = null;
    if (catalogProductId) {
      try {
        const cpRes = await axios.get(`${API}/products/${catalogProductId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        catalogProduct = cpRes.data;
        const cpAttrs = (catalogProduct.attributes || []).filter((a: any) =>
          /HEIGHT|WIDTH|LENGTH|DEPTH|WEIGHT|PACKAGE/.test(a.id || ""),
        );
        console.log(`  >> catalog product dim attrs:`);
        for (const a of cpAttrs) {
          console.log(`     ${a.id} = ${a.value_name || JSON.stringify(a.values)}`);
        }
      } catch (e: any) {
        console.log(`  >> catalog product fetch erro: ${e?.response?.status} ${e?.message}`);
      }
    }

    if (!seenCats.has(catId)) {
      seenCats.add(catId);
      try {
        const catAttrRes = await axios.get(`${API}/categories/${catId}/attributes`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        catAttrCache[catId] = catAttrRes.data;
        const dimAttrs = (catAttrRes.data || []).filter((a: any) =>
          /HEIGHT|WIDTH|LENGTH|DEPTH|WEIGHT|PACKAGE/.test(a.id || ""),
        );
        console.log(`  >> category ${catId} dim attrs (${dimAttrs.length}):`);
        for (const a of dimAttrs) {
          const tags = a.tags ? Object.keys(a.tags).filter((k) => a.tags[k]).join(",") : "";
          console.log(`     ${a.id} type=${a.value_type} unit=${a.default_unit || ""} tags=[${tags}]`);
          if (a.value_max_length) console.log(`        value_max_length=${a.value_max_length}`);
          if (a.allowed_units) console.log(`        allowed_units=${JSON.stringify(a.allowed_units)}`);
        }
      } catch (e: any) {
        console.log(`  >> category attrs erro: ${e?.response?.status} ${e?.message}`);
      }
    }

    out.push({
      itemId: id,
      categoryId: catId,
      domainId: it.domain_id,
      catalogProductId,
      shippingDimensions: shipping.dimensions,
      itemAttrs: sellerAttrs,
      catalogProduct: catalogProduct
        ? {
            id: catalogProduct.id,
            name: catalogProduct.name,
            attributes: (catalogProduct.attributes || []).filter((a: any) =>
              /HEIGHT|WIDTH|LENGTH|DEPTH|WEIGHT|PACKAGE/.test(a.id || ""),
            ),
          }
        : null,
      categoryAttrs: catAttrCache[catId]
        ? (catAttrCache[catId] || []).filter((a: any) =>
            /HEIGHT|WIDTH|LENGTH|DEPTH|WEIGHT|PACKAGE/.test(a.id || ""),
          )
        : null,
    });
  }

  fs.mkdirSync(path.join("scripts", "out"), { recursive: true });
  const outPath = path.join("scripts", "out", "ml-min-dims-inspection.json");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\nDump em ${outPath}`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
