/**
 * Cria Product + ProductListing locais para listings ML que não têm correspondência local.
 *
 * Lê: scripts/out/ml-orphans.json (gerado por _analyze_audit.ts)
 * Saída:
 *   - scripts/out/orphan-import-plan.csv  (sempre, para revisão)
 *   - scripts/out/orphan-import-result.csv (apenas com APPLY=1)
 *
 * Modos:
 *   npx tsx scripts/_create_orphan_products.ts            -> DRY-RUN (default)
 *   APPLY=1 npx tsx scripts/_create_orphan_products.ts    -> grava no DB
 *
 * Segurança:
 *  - SKU de cada órfão: SELLER_SKU do anúncio. Se ausente, "ML-<itemId>".
 *  - Antes de criar, checa se já existe Product (userId, sku) — se sim, apenas linka.
 *  - Cada criação roda dentro de uma transação por item para isolar falhas.
 *  - mlCategoryId é resolvido contra MarketplaceCategory.externalId; se não houver, fica null.
 *  - Stock e price vêm direto do ML.
 *  - Dimensões vêm de resolveDim() (mesmo mapa do mass-fix).
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { Prisma, PrismaClient } from "@prisma/client";
import prisma from "../app/lib/prisma";
import { MLApiService } from "../app/marketplaces/services/ml-api.service";
import { MLOAuthService } from "../app/marketplaces/services/ml-oauth.service";
import { normalizeSku as buildSkuNormalized } from "../app/lib/sku";
import { resolveDim } from "./_ml_dim_defaults";

const USER_ID = "cmn5yc4rn0000vsasmwv9m8nc";
const APPLY = process.env.APPLY === "1";

interface Orphan {
  itemId: string;
  account: string;
  title: string;
  category: string;
  permalink?: string;
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

function findAttr(attrs: any[] | undefined, ids: string[]): string | undefined {
  if (!Array.isArray(attrs)) return undefined;
  for (const id of ids) {
    const a = attrs.find((x) => x?.id === id);
    if (a?.value_name) return String(a.value_name);
  }
  return undefined;
}

interface PlanRow {
  itemId: string;
  account: string;
  category: string;
  title: string;
  derivedSku: string;
  skuSource: "SELLER_SKU" | "fallback-itemId";
  price: number;
  stock: number;
  height: number;
  width: number;
  length: number;
  weightKg: number;
  dimSource: string;
  mlCategoryLocalId: string | null;
  existingProductId: string | null;
  action: "link-existing" | "create-new" | "skip-no-price" | "skip-error";
  error?: string;
}

async function main() {
  const orphansPath = path.join("scripts", "out", "ml-orphans.json");
  if (!fs.existsSync(orphansPath)) {
    throw new Error(`${orphansPath} não existe — rode _analyze_audit.ts antes.`);
  }
  const orphans: Orphan[] = JSON.parse(fs.readFileSync(orphansPath, "utf-8"));
  console.log(`[orphan-import] modo=${APPLY ? "APPLY" : "DRY-RUN"} · ${orphans.length} órfãos`);

  // Mapear conta -> token
  const accounts = await prisma.marketplaceAccount.findMany({
    where: { userId: USER_ID, platform: "MERCADO_LIVRE" },
  });
  const tokenByAccount = new Map<string, { id: string; token: string; accountName: string }>();
  for (const acc of accounts) {
    const t = await getValidAccessToken(acc);
    if (!t) {
      console.warn(`[orphan-import] conta ${acc.accountName} sem token válido — itens serão pulados`);
      continue;
    }
    tokenByAccount.set(acc.accountName, { id: acc.id, token: t, accountName: acc.accountName });
  }

  // Indexar marketplace categories locais por externalId
  const allCats = await prisma.marketplaceCategory.findMany({ select: { id: true, externalId: true } });
  const catIdByExternal = new Map(allCats.map((c) => [c.externalId, c.id]));

  // Pré-checar SKUs existentes do usuário (carregamos todos uma vez para evitar 4k queries)
  const existingProducts = await prisma.product.findMany({
    where: { userId: USER_ID },
    select: { id: true, sku: true },
  });
  const productIdBySku = new Map(existingProducts.map((p) => [p.sku.trim().toUpperCase(), p.id]));

  // Pré-checar ProductListing existentes (caso já exista vínculo por externalListingId em outra conta)
  const allListings = await prisma.productListing.findMany({
    where: { marketplaceAccount: { userId: USER_ID, platform: "MERCADO_LIVRE" } },
    select: { externalListingId: true, marketplaceAccountId: true },
  });
  const listingKey = (acc: string, ext: string) => `${acc}::${ext}`;
  const listingExists = new Set<string>();
  for (const l of allListings) {
    const acc = accounts.find((a) => a.id === l.marketplaceAccountId);
    if (acc) listingExists.add(listingKey(acc.accountName, l.externalListingId));
  }

  // Buscar detalhes via multiget, em lotes de 20, agrupado por conta
  const orphansByAccount = new Map<string, Orphan[]>();
  for (const o of orphans) {
    if (!orphansByAccount.has(o.account)) orphansByAccount.set(o.account, []);
    orphansByAccount.get(o.account)!.push(o);
  }

  const plan: PlanRow[] = [];

  for (const [accName, list] of orphansByAccount.entries()) {
    const ctx = tokenByAccount.get(accName);
    if (!ctx) {
      console.warn(`[orphan-import] sem token para conta ${accName}, pulando ${list.length} itens`);
      continue;
    }
    console.log(`\n[orphan-import] Conta ${accName}: ${list.length} itens — fetching detalhes…`);
    const ids = list.map((o) => o.itemId);
    const details = await MLApiService.getItemsDetails(ctx.token, ids);
    const detailById = new Map<string, any>(details.map((d: any) => [d.id, d]));

    for (const o of list) {
      const d: any = detailById.get(o.itemId);
      if (!d) {
        plan.push({
          itemId: o.itemId, account: accName, category: o.category, title: o.title,
          derivedSku: "", skuSource: "fallback-itemId", price: 0, stock: 0,
          height: 0, width: 0, length: 0, weightKg: 0, dimSource: "",
          mlCategoryLocalId: null, existingProductId: null, action: "skip-error",
          error: "no detail returned",
        });
        continue;
      }
      const sellerSku = findAttr(d.attributes, ["SELLER_SKU"]) || (d.seller_custom_field ? String(d.seller_custom_field) : undefined);
      const derivedSku = (sellerSku && sellerSku.trim()) || `ML-${o.itemId}`;
      const skuKey = derivedSku.trim().toUpperCase();
      const existingId = productIdBySku.get(skuKey) || null;
      const dim = resolveDim(o.category, o.title);
      const localCatId = catIdByExternal.get(o.category) || null;
      const price = Number(d.price);
      const stock = Number(d.available_quantity ?? 0);

      const row: PlanRow = {
        itemId: o.itemId,
        account: accName,
        category: o.category,
        title: o.title,
        derivedSku,
        skuSource: sellerSku ? "SELLER_SKU" : "fallback-itemId",
        price: Number.isFinite(price) ? price : 0,
        stock: Number.isFinite(stock) ? stock : 0,
        height: dim.heightCm, width: dim.widthCm, length: dim.lengthCm, weightKg: dim.weightKg,
        dimSource: dim.source,
        mlCategoryLocalId: localCatId,
        existingProductId: existingId,
        action: existingId ? "link-existing" : (Number.isFinite(price) && price > 0 ? "create-new" : "skip-no-price"),
      };
      plan.push(row);
    }
  }

  // Resumo do plano
  const summary: Record<string, number> = {};
  for (const p of plan) summary[p.action] = (summary[p.action] || 0) + 1;
  const skuFromML = plan.filter((p) => p.skuSource === "SELLER_SKU").length;
  console.log("\n=== PLANO ===");
  console.log(summary);
  console.log(`SKU vindo de SELLER_SKU: ${skuFromML} / ${plan.length}`);
  console.log(`SKU fallback (ML-<id>):  ${plan.length - skuFromML}`);

  // Salvar plano CSV
  fs.mkdirSync(path.join("scripts", "out"), { recursive: true });
  const planPath = path.join("scripts", "out", "orphan-import-plan.csv");
  const headers = [
    "itemId","account","category","title","derivedSku","skuSource","price","stock",
    "h","w","l","weightKg","dimSource","mlCategoryLocalId","existingProductId","action","error",
  ];
  const esc = (v: any) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [headers.join(",")];
  for (const p of plan) {
    lines.push([
      p.itemId, p.account, p.category, p.title, p.derivedSku, p.skuSource, p.price, p.stock,
      p.height, p.width, p.length, p.weightKg, p.dimSource, p.mlCategoryLocalId,
      p.existingProductId, p.action, p.error,
    ].map(esc).join(","));
  }
  fs.writeFileSync(planPath, lines.join("\n"));
  console.log(`Plano salvo em ${planPath}`);

  if (!APPLY) {
    console.log("\nDRY-RUN: nada gravado. Rode com APPLY=1 para aplicar.");
    process.exit(0);
  }

  // ===== APPLY =====
  console.log("\n=== APPLY ===");
  const result: Array<PlanRow & { newProductId?: string; newListingId?: string; commitError?: string }> = [];
  let created = 0, linked = 0, errors = 0;

  for (const p of plan) {
    if (p.action === "skip-no-price" || p.action === "skip-error") {
      result.push(p);
      continue;
    }
    const acc = accounts.find((a) => a.accountName === p.account);
    if (!acc) {
      result.push({ ...p, commitError: "account not found" });
      errors++;
      continue;
    }
    const accountKey = listingKey(p.account, p.itemId);
    if (listingExists.has(accountKey)) {
      // Pode ter sido criado entre dump e apply; pular
      result.push({ ...p, commitError: "listing already exists (race)" });
      continue;
    }

    try {
      const out = await prisma.$transaction(async (tx) => {
        let productId = p.existingProductId;
        if (!productId) {
          const np = await tx.product.create({
            data: {
              userId: USER_ID,
              sku: p.derivedSku,
              skuNormalized: buildSkuNormalized(p.derivedSku),
              name: p.title.slice(0, 250),
              price: new Prisma.Decimal(p.price),
              stock: p.stock,
              heightCm: p.height,
              widthCm: p.width,
              lengthCm: p.length,
              weightKg: new Prisma.Decimal(p.weightKg),
              mlCategoryId: p.mlCategoryLocalId || undefined,
              mlCategorySource: "ml-orphan-import",
              mlCategoryChosenAt: new Date(),
            },
            select: { id: true },
          });
          productId = np.id;
          created++;
        } else {
          // Linka existente — também atualiza dims se faltarem
          await tx.product.update({
            where: { id: productId },
            data: {
              heightCm: p.height,
              widthCm: p.width,
              lengthCm: p.length,
              weightKg: new Prisma.Decimal(p.weightKg),
            },
          });
          linked++;
        }
        const listing = await tx.productListing.create({
          data: {
            productId,
            marketplaceAccountId: acc.id,
            externalListingId: p.itemId,
            externalSku: p.derivedSku,
            status: "active",
          },
          select: { id: true },
        });
        return { productId, listingId: listing.id };
      });
      result.push({ ...p, newProductId: out.productId!, newListingId: out.listingId });
    } catch (e: any) {
      errors++;
      result.push({ ...p, commitError: e?.message || String(e) });
      console.error(`[orphan-import] FALHA item=${p.itemId} sku=${p.derivedSku}: ${e?.message}`);
    }
  }

  // CSV resultado
  const resultPath = path.join("scripts", "out", "orphan-import-result.csv");
  const resHeaders = [...headers, "newProductId", "newListingId", "commitError"];
  const resLines = [resHeaders.join(",")];
  for (const r of result) {
    resLines.push([
      r.itemId, r.account, r.category, r.title, r.derivedSku, r.skuSource, r.price, r.stock,
      r.height, r.width, r.length, r.weightKg, r.dimSource, r.mlCategoryLocalId,
      r.existingProductId, r.action, r.error, (r as any).newProductId, (r as any).newListingId, (r as any).commitError,
    ].map(esc).join(","));
  }
  fs.writeFileSync(resultPath, resLines.join("\n"));
  console.log(`Resultado em ${resultPath}`);
  console.log(`Resumo: created=${created}, linked=${linked}, errors=${errors}`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
