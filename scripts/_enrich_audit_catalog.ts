/**
 * Enriquece ml-dims-audit.json com:
 *  - catalog_product_id de cada item (via multiget /items?ids=...)
 *  - dimensões registradas no produto de catálogo (HEIGHT/WIDTH/LENGTH/WEIGHT)
 *
 * Também classifica cada linha em uma das estratégias possíveis:
 *  - "skip-already-filled" : todos os 4 SELLER_PACKAGE_* já preenchidos no item
 *                            → não tocar (não regredir manual do usuário)
 *  - "skip-no-shipping-immutable" : tem SELLER_PACKAGE_* parcial mas falta
 *                            shipping.dimensions → unfixable (campo imutável)
 *                            (heurística: marcamos só se NENHUM SELLER_PACKAGE_*
 *                             pode levar o item ao "completo" com nosso push.
 *                             Por ora classificamos só por "tem qualquer attr".)
 *  - "push-with-catalog-floor" : tem catalog_product_id → usar max(tier, catalog)
 *  - "push-tier" : sem catalog_product_id → usar tier puro
 *
 * Read-only (nada é gravado em ML nem no DB).
 * Lê: scripts/out/ml-dims-audit.json
 * Saída: scripts/out/ml-dims-enriched.json + ml-dims-enriched-summary.json
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import axios from "axios";
import prisma from "../app/lib/prisma";
import { MLApiService } from "../app/marketplaces/services/ml-api.service";
import { MLOAuthService } from "../app/marketplaces/services/ml-oauth.service";

const USER_ID = "cmn5yc4rn0000vsasmwv9m8nc";
const API = "https://api.mercadolibre.com";
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : undefined;

interface AuditRow {
  itemId: string;
  account: string;
  status: string;
  title: string;
  category: string;
  severity: "OK" | "WARN" | "BLOCK";
  shippingDimensionsRaw?: string | null;
  attrPkgHeight?: string;
  attrPkgWidth?: string;
  attrPkgLength?: string;
  attrPkgWeight?: string;
}

interface CatalogDims {
  heightCm?: number;
  widthCm?: number;
  lengthCm?: number;
  weightG?: number;
  raw?: Record<string, string>;
}

interface EnrichedRow extends AuditRow {
  catalogProductId: string | null;
  catalogDims: CatalogDims | null;
  catalogFetchError?: string;
  hasAllSellerPkg: boolean;
  hasAnySellerPkg: boolean;
  shippingNull: boolean;
  strategy:
    | "skip-already-filled"
    | "skip-no-shipping-immutable"
    | "push-with-catalog-floor"
    | "push-tier"
    | "skip-not-block";
}

async function getValidAccessToken(account: any): Promise<string | null> {
  const now = new Date();
  if (account.expiresAt && new Date(account.expiresAt) > new Date(now.getTime() + 60_000)) {
    return account.accessToken;
  }
  try {
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
  } catch (e: any) {
    console.warn(`[token] FALHA refresh ${account.accountName}: ${e?.message || e}`);
    return null;
  }
}

function parseNumericWithUnit(s?: string): number | undefined {
  if (!s) return undefined;
  const m = String(s).match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : undefined;
}

function findAttr(attrs: any[] | undefined, id: string): any {
  if (!Array.isArray(attrs)) return undefined;
  return attrs.find((x) => x?.id === id);
}

function extractCatalogDims(product: any): CatalogDims {
  const attrs = product?.attributes || [];
  const raw: Record<string, string> = {};
  const get = (id: string) => {
    const a = findAttr(attrs, id);
    if (!a) return undefined;
    const v = a.value_name ?? a.value_struct?.number;
    if (v != null) raw[id] = String(v) + (a.value_struct?.unit ? ` ${a.value_struct.unit}` : "");
    // value_struct.unit can be cm/m/mm/kg/g
    if (a.value_struct && typeof a.value_struct.number === "number") {
      const num = a.value_struct.number;
      const unit = String(a.value_struct.unit || "").toLowerCase();
      if (unit === "cm") return num;
      if (unit === "mm") return num / 10;
      if (unit === "m") return num * 100;
      if (unit === "g") return num;
      if (unit === "kg") return num * 1000;
      return num;
    }
    return parseNumericWithUnit(a.value_name);
  };
  const h = get("HEIGHT");
  const w = get("WIDTH");
  const l = get("LENGTH");
  const wg = get("WEIGHT");
  return { heightCm: h, widthCm: w, lengthCm: l, weightG: wg, raw };
}

async function fetchCatalogProduct(token: string, cpid: string): Promise<any | null> {
  try {
    const r = await axios.get(`${API}/products/${cpid}`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15000,
    });
    return r.data;
  } catch (e: any) {
    throw new Error(`${e?.response?.status || "?"} ${e?.message || e}`);
  }
}

async function main() {
  const auditPath = path.join("scripts", "out", "ml-dims-audit.json");
  const all: AuditRow[] = JSON.parse(fs.readFileSync(auditPath, "utf-8"));
  console.log(`[enrich] auditadas: ${all.length}`);

  // Só faz sentido enriquecer BLOCK (alvo do push)
  let blockRows = all.filter((r) => r.severity === "BLOCK");
  if (LIMIT) blockRows = blockRows.slice(0, LIMIT);
  console.log(`[enrich] BLOCK a enriquecer: ${blockRows.length}${LIMIT ? ` (LIMIT=${LIMIT})` : ""}`);

  // Tokens
  const accounts = await prisma.marketplaceAccount.findMany({
    where: { userId: USER_ID, platform: "MERCADO_LIVRE" },
  });
  const tokenByAccount = new Map<string, string>();
  for (const acc of accounts) {
    const t = await getValidAccessToken(acc);
    if (t) tokenByAccount.set(acc.accountName, t);
    else console.warn(`[enrich] sem token para ${acc.accountName}`);
  }

  // Agrupar por conta para multiget
  const byAccount = new Map<string, AuditRow[]>();
  for (const r of blockRows) {
    if (!byAccount.has(r.account)) byAccount.set(r.account, []);
    byAccount.get(r.account)!.push(r);
  }

  // 1) Buscar detalhes para extrair catalog_product_id
  const itemDetail = new Map<string, any>();
  for (const [accName, list] of byAccount.entries()) {
    const token = tokenByAccount.get(accName);
    if (!token) continue;
    console.log(`[enrich] ${accName}: fetching details para ${list.length} itens…`);
    const ids = list.map((r) => r.itemId);
    const details = await MLApiService.getItemsDetails(token, ids);
    for (const d of details) itemDetail.set((d as any).id, d);
    console.log(`[enrich] ${accName}: ${details.length} detalhes recebidos`);
  }

  // 2) Coletar catalog_product_ids únicos
  const cpidSet = new Set<string>();
  for (const r of blockRows) {
    const d = itemDetail.get(r.itemId);
    const cpid = d?.catalog_product_id;
    if (cpid) cpidSet.add(cpid);
  }
  console.log(`[enrich] catalog_product_ids únicos: ${cpidSet.size}`);

  // 3) Buscar cada catalog product (1x por cpid). Reuso de qualquer token válido.
  const anyToken = [...tokenByAccount.values()][0];
  if (!anyToken) throw new Error("nenhum token disponível para buscar catalog products");

  const catalogCache = new Map<string, { dims: CatalogDims | null; error?: string }>();
  const cpids = [...cpidSet];
  const CONC = 6;
  let cpidIdx = 0;
  const cpidWorker = async () => {
    while (true) {
      const i = cpidIdx++;
      if (i >= cpids.length) break;
      const cpid = cpids[i];
      try {
        const product = await fetchCatalogProduct(anyToken, cpid);
        catalogCache.set(cpid, { dims: extractCatalogDims(product) });
      } catch (e: any) {
        catalogCache.set(cpid, { dims: null, error: String(e?.message || e) });
      }
      if ((i + 1) % 50 === 0) console.log(`[enrich] catalog progress: ${i + 1}/${cpids.length}`);
      await new Promise((r) => setTimeout(r, 30));
    }
  };
  await Promise.all(Array.from({ length: CONC }, cpidWorker));
  console.log(`[enrich] catalog cache pronto: ${catalogCache.size}`);

  // 4) Construir rows enriquecidas + estratégia
  const enriched: EnrichedRow[] = [];
  const summary: Record<string, number> = {};
  for (const r of blockRows) {
    const d = itemDetail.get(r.itemId);
    const cpid = d?.catalog_product_id || null;
    const cat = cpid ? catalogCache.get(cpid) : undefined;

    const hasH = !!r.attrPkgHeight;
    const hasW = !!r.attrPkgWidth;
    const hasL = !!r.attrPkgLength;
    const hasWg = !!r.attrPkgWeight;
    const hasAll = hasH && hasW && hasL && hasWg;
    const hasAny = hasH || hasW || hasL || hasWg;
    const shippingNull = !r.shippingDimensionsRaw;

    let strategy: EnrichedRow["strategy"];
    if (hasAll) {
      strategy = "skip-already-filled";
    } else if (cpid && cat?.dims) {
      strategy = "push-with-catalog-floor";
    } else {
      strategy = "push-tier";
    }

    summary[strategy] = (summary[strategy] || 0) + 1;

    enriched.push({
      ...r,
      catalogProductId: cpid,
      catalogDims: cat?.dims || null,
      catalogFetchError: cat?.error,
      hasAllSellerPkg: hasAll,
      hasAnySellerPkg: hasAny,
      shippingNull,
      strategy,
    });
  }

  // Counts auxiliares
  const partialAttrs = enriched.filter((e) => e.hasAnySellerPkg && !e.hasAllSellerPkg).length;
  const noAttrs = enriched.filter((e) => !e.hasAnySellerPkg).length;
  const withCatalog = enriched.filter((e) => e.catalogProductId).length;
  const catalogFetchErrors = enriched.filter((e) => e.catalogFetchError).length;

  fs.mkdirSync(path.join("scripts", "out"), { recursive: true });
  const outPath = path.join("scripts", "out", "ml-dims-enriched.json");
  fs.writeFileSync(outPath, JSON.stringify(enriched, null, 2));

  const summaryPath = path.join("scripts", "out", "ml-dims-enriched-summary.json");
  const summaryObj = {
    totalEnriched: enriched.length,
    strategy: summary,
    partialSellerPkg: partialAttrs,
    noSellerPkg: noAttrs,
    withCatalogProduct: withCatalog,
    catalogFetchErrors,
    uniqueCatalogProducts: cpidSet.size,
  };
  fs.writeFileSync(summaryPath, JSON.stringify(summaryObj, null, 2));

  console.log("\n=== RESUMO ===");
  console.log(summaryObj);
  console.log(`\nEnriquecido: ${outPath}`);
  console.log(`Resumo:      ${summaryPath}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
