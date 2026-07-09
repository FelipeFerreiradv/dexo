import "dotenv/config";
import path from "path";
import fs from "fs";
import { Platform } from "@prisma/client";
import prisma from "../app/lib/prisma";
import { normalizeSku } from "../app/lib/sku";
import { MLApiService } from "../app/marketplaces/services/ml-api.service";
import { MLOAuthService } from "../app/marketplaces/services/ml-oauth.service";
import { ShopeeApiService } from "../app/marketplaces/services/shopee-api.service";
import { ShopeeOAuthService } from "../app/marketplaces/services/shopee-oauth.service";
import { MarketplaceRepository } from "../app/marketplaces/repositories/marketplace.repository";
import { ListingRepository } from "../app/marketplaces/repositories/listing.repository";
import {
  ListingAutodetectUseCase,
  type NormalizedMarketplaceItem,
} from "../app/marketplaces/usecases/listing-autodetect.usercase";
import type { ShopeeItem } from "../app/marketplaces/types/shopee-api.types";
import type { MLItemDetails } from "../app/marketplaces/types/ml-api.types";

/**
 * REGRA (Felipe): em TODO usuário com migração completa, cada produto tem que
 * estar linkado (`ProductListing`) aos seus anúncios em TODAS as contas de
 * marketplace conectadas (todas ML + todas Shopee), casando por SKU — para que
 * uma venda em QUALQUER conta/canal gere o pedido e baixe o estoque.
 *
 * Este script varre o catálogo de cada conta ACTIVE do usuário e, para cada
 * anúncio cujo SKU casa com um `Product` existente (skuNormalized), cria o
 * listing se ainda não existir. **LINK-ONLY**: nunca cria produto novo (anúncio
 * sem produto correspondente é só reportado). Reusa o caminho canônico do app
 * (`normalizeMLItem`/`normalizeShopeeItem` + `ListingRepository.upsertAutodetectedListing`).
 * Idempotente (skip do que já está linkado; unique key à prova de corrida).
 *
 *   npx tsx scripts/link-marketplace-listings.ts --user-id=<ID> --dry-run
 *   npx tsx scripts/link-marketplace-listings.ts --user-id=<ID> --apply
 *   npx tsx scripts/link-marketplace-listings.ts --all-migrated --apply
 *   npx tsx scripts/link-marketplace-listings.ts --user-id=<ID> --platform=shopee --apply
 */

// Clientes migrados nesta sessão (status completo). --all-migrated usa esta lista.
const MIGRATED_USERS = [
  "cmql2zugq0000vs8g376rend5", // 704 / vaapt
  "cmr2fgwvl0000vsocesp87mi1", // IBR / srlautopecas
  "cmrb07ess0000vs5knt9smr7w", // Mesquita
  "cmqzaf2xy0000vs0ot3y4wau2", // Magoo
  "cmr9qjsbx0001vsnko2g6gbcj", // Garagem 341
  "cmr5bhtp40000vszcw26c2guy", // K2
];

const OUT_DIR = path.resolve(__dirname, "out");
const SHOPEE_LIST_PAGE = 100;
const SHOPEE_BASEINFO_BATCH = 50;

interface Flags {
  userIds: string[];
  dryRun: boolean;
  apply: boolean;
  platform: "ml" | "shopee" | "all";
  account: string | null;
  limit: number | null;
}

function parseFlags(): Flags {
  const argv = process.argv.slice(2);
  const get = (n: string) => {
    const f = `--${n}=`;
    const x = argv.find((a) => a.startsWith(f));
    return x ? x.slice(f.length) : undefined;
  };
  const has = (n: string) => argv.includes(`--${n}`);
  const apply = has("apply");
  const uid = get("user-id");
  const platform = (get("platform") ?? "all") as Flags["platform"];
  const limitRaw = get("limit");
  return {
    userIds: uid ? [uid] : has("all-migrated") ? MIGRATED_USERS : [],
    apply,
    dryRun: has("dry-run") || !apply,
    platform: ["ml", "shopee", "all"].includes(platform) ? platform : "all",
    account: get("account") ?? null,
    limit: limitRaw && /^\d+$/.test(limitRaw) ? parseInt(limitRaw, 10) : null,
  };
}

function isAuthErr(e: unknown): boolean {
  const s = (e as any)?.status ?? (e as any)?.response?.status ?? null;
  if (s === 401 || s === 403) return true;
  const m = e instanceof Error ? e.message : String(e);
  return /token|auth|unauthorized|access\s*denied|expired/i.test(m);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function chunk<T>(a: T[], n: number): T[][] {
  const o: T[][] = [];
  for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n));
  return o;
}

/* ------------------------------- Tokens -------------------------------- */

interface AccLite {
  id: string;
  platform: Platform;
  accountName: string;
  externalUserId: string | null;
  shopId: number | null;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
}

const mlTokenCache = new Map<string, string>();
async function getMlToken(acc: AccLite, dryRun: boolean): Promise<string> {
  const cached = mlTokenCache.get(acc.id);
  if (cached) return cached;
  if (new Date(acc.expiresAt).getTime() > Date.now() + 60_000) {
    mlTokenCache.set(acc.id, acc.accessToken);
    return acc.accessToken;
  }
  const r = await MLOAuthService.refreshAccessTokenForAccount(acc.id, acc.refreshToken ?? "");
  if (!dryRun) {
    await prisma.marketplaceAccount.update({
      where: { id: acc.id },
      data: { accessToken: r.accessToken, refreshToken: r.refreshToken, expiresAt: new Date(Date.now() + r.expiresIn * 1000) },
    });
  }
  mlTokenCache.set(acc.id, r.accessToken);
  return r.accessToken;
}
async function refreshShopee(acc: AccLite): Promise<string> {
  if (!acc.refreshToken || !acc.shopId) throw new Error(`Shopee ${acc.accountName} sem refreshToken/shopId`);
  const r = await ShopeeOAuthService.refreshAccessToken(acc.refreshToken, acc.shopId);
  await MarketplaceRepository.updateTokens(acc.id, {
    accessToken: r.access_token,
    refreshToken: r.refresh_token,
    expiresAt: new Date(Date.now() + r.expire_in * 1000),
  });
  return r.access_token;
}

/* ------------------------------- Scans --------------------------------- */

async function scanMl(acc: AccLite, dryRun: boolean): Promise<NormalizedMarketplaceItem[]> {
  if (!acc.externalUserId) return [];
  let token = await getMlToken(acc, dryRun);
  let ids: string[];
  try {
    ids = await MLApiService.getSellerItemIds(token, acc.externalUserId);
  } catch (e) {
    if (isAuthErr(e)) {
      mlTokenCache.delete(acc.id);
      token = await getMlToken(acc, dryRun);
      ids = await MLApiService.getSellerItemIds(token, acc.externalUserId);
    } else throw e;
  }
  const out: NormalizedMarketplaceItem[] = [];
  for (const c of chunk(ids, 20 * 10)) {
    let details: MLItemDetails[];
    try {
      details = await MLApiService.getItemsDetails(token, c);
    } catch (e) {
      if (isAuthErr(e)) {
        mlTokenCache.delete(acc.id);
        token = await getMlToken(acc, dryRun);
        details = await MLApiService.getItemsDetails(token, c);
      } else throw e;
    }
    for (const d of details) {
      try {
        out.push(ListingAutodetectUseCase.normalizeMLItem({ id: acc.id, userId: (acc as any).userId }, d));
      } catch {
        // item com shape inesperado (ex.: atributo id null) → pula, não aborta a conta
      }
    }
  }
  return out;
}

async function scanShopee(acc: AccLite): Promise<NormalizedMarketplaceItem[]> {
  if (!acc.shopId) return [];
  let token = acc.accessToken;
  if (new Date(acc.expiresAt).getTime() < Date.now() + 60_000) token = await refreshShopee(acc);
  // 1) lista todos os item_ids
  const itemIds: number[] = [];
  let offset = 0;
  while (true) {
    const params = { offset, page_size: SHOPEE_LIST_PAGE, item_status: ["NORMAL"] as any };
    let resp: any;
    try {
      resp = await ShopeeApiService.getItemList(token, acc.shopId, params as any);
    } catch (e) {
      if (isAuthErr(e)) {
        token = await refreshShopee(acc);
        resp = await ShopeeApiService.getItemList(token, acc.shopId, params as any);
      } else throw e;
    }
    const items = (resp?.item ?? []) as Array<{ item_id: number }>;
    for (const it of items) itemIds.push(it.item_id);
    if (!resp?.has_next_page || items.length === 0) break;
    offset = typeof resp.next_offset === "number" && resp.next_offset !== offset ? resp.next_offset : offset + items.length;
    await sleep(80);
  }
  // 2) base info em lotes
  const out: NormalizedMarketplaceItem[] = [];
  for (const c of chunk(itemIds, SHOPEE_BASEINFO_BATCH)) {
    let batch: ShopeeItem[];
    try {
      batch = await ShopeeApiService.getItemsBaseInfo(token, acc.shopId, c);
    } catch (e) {
      if (isAuthErr(e)) {
        token = await refreshShopee(acc);
        batch = await ShopeeApiService.getItemsBaseInfo(token, acc.shopId, c);
      } else throw e;
    }
    for (const it of batch) {
      try {
        out.push(ListingAutodetectUseCase.normalizeShopeeItem({ id: acc.id, userId: (acc as any).userId }, it));
      } catch {
        // item com shape inesperado → pula, não aborta a conta
      }
    }
    await sleep(100);
  }
  return out;
}

/* -------------------------------- Core --------------------------------- */

interface AccountReport {
  account: string;
  platform: string;
  scanned: number;
  already_linked: number;
  linked: number;
  no_product_for_sku: number;
  no_sku: number;
  errors: number;
}

async function processAccount(
  acc: AccLite & { userId: string },
  skuMap: Map<string, string>,
  flags: Flags,
): Promise<AccountReport> {
  const rep: AccountReport = {
    account: acc.accountName,
    platform: acc.platform,
    scanned: 0,
    already_linked: 0,
    linked: 0,
    no_product_for_sku: 0,
    no_sku: 0,
    errors: 0,
  };

  // Anúncios já linkados nesta conta (idempotência).
  const existing = new Set(
    (
      await prisma.productListing.findMany({
        where: { marketplaceAccountId: acc.id },
        select: { externalListingId: true },
      })
    ).map((l) => l.externalListingId),
  );

  let items: NormalizedMarketplaceItem[];
  try {
    items = acc.platform === Platform.SHOPEE ? await scanShopee(acc) : await scanMl(acc, flags.dryRun);
  } catch (e) {
    rep.errors++;
    console.error(`  [${acc.accountName}] scan falhou: ${e instanceof Error ? e.message : String(e)}`);
    return rep;
  }
  rep.scanned = items.length;
  const sliced = flags.limit !== null ? items.slice(0, flags.limit) : items;

  let done = 0;
  for (const it of sliced) {
    if (existing.has(it.externalListingId)) {
      rep.already_linked++;
      continue;
    }
    const nsku = normalizeSku(it.rawSku);
    if (!nsku) {
      rep.no_sku++;
      continue;
    }
    const pid = skuMap.get(nsku);
    if (!pid) {
      rep.no_product_for_sku++;
      continue;
    }
    if (flags.dryRun) {
      rep.linked++;
      existing.add(it.externalListingId);
      continue;
    }
    try {
      await ListingRepository.upsertAutodetectedListing({
        productId: pid,
        marketplaceAccountId: acc.id,
        externalListingId: it.externalListingId,
        externalSku: it.rawSku || undefined,
        permalink: it.permalink,
        status: it.status,
      });
      rep.linked++;
      existing.add(it.externalListingId);
    } catch (e) {
      rep.errors++;
    }
    if (++done % 500 === 0) console.log(`  [${acc.accountName}] ${done} processados (linked=${rep.linked})`);
  }
  console.log(
    `  [${acc.accountName}/${acc.platform}] scan=${rep.scanned} linked=${rep.linked} already=${rep.already_linked} semProduto=${rep.no_product_for_sku} semSKU=${rep.no_sku} erros=${rep.errors}`,
  );
  return rep;
}

async function main(): Promise<void> {
  const flags = parseFlags();
  if (flags.userIds.length === 0) {
    throw new Error("Informe --user-id=<id> ou --all-migrated. Abortando.");
  }
  console.log(
    `[link-listings] modo=${flags.dryRun ? "DRY-RUN" : "APPLY"} platform=${flags.platform} usuários=${flags.userIds.length}${flags.account ? ` conta=${flags.account}` : ""}`,
  );

  const wantPlatforms: Platform[] =
    flags.platform === "ml"
      ? [Platform.MERCADO_LIVRE]
      : flags.platform === "shopee"
        ? [Platform.SHOPEE]
        : [Platform.MERCADO_LIVRE, Platform.SHOPEE];

  const all: Array<{ user: string; email: string; reports: AccountReport[] }> = [];

  for (const userId of flags.userIds) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    if (!user) {
      console.warn(`[link-listings] usuário ${userId} não encontrado — pulado`);
      continue;
    }
    // Mapa skuNormalized → productId (findFirst-like: primeiro vence).
    const products = await prisma.product.findMany({
      where: { userId },
      select: { id: true, skuNormalized: true },
    });
    const skuMap = new Map<string, string>();
    for (const p of products) if (p.skuNormalized && !skuMap.has(p.skuNormalized)) skuMap.set(p.skuNormalized, p.id);

    const accounts = (await prisma.marketplaceAccount.findMany({
      where: {
        userId,
        status: "ACTIVE",
        platform: { in: wantPlatforms },
        ...(flags.account ? { OR: [{ accountName: flags.account }, { id: flags.account }] } : {}),
      },
      select: {
        id: true,
        platform: true,
        accountName: true,
        externalUserId: true,
        shopId: true,
        accessToken: true,
        refreshToken: true,
        expiresAt: true,
      },
    })) as unknown as AccLite[];

    console.log(
      `\n=== ${user.email} (${userId}) — produtos=${products.length} (skuMap=${skuMap.size}) contas=${accounts.length} ===`,
    );
    const reports: AccountReport[] = [];
    for (const acc of accounts) {
      const rep = await processAccount({ ...acc, userId }, skuMap, flags);
      reports.push(rep);
    }
    all.push({ user: userId, email: user.email, reports });
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.writeFileSync(
    path.join(OUT_DIR, `link-listings-${flags.dryRun ? "dryrun" : "apply"}-${stamp}.json`),
    JSON.stringify({ mode: flags.dryRun ? "dry-run" : "apply", platform: flags.platform, users: all }, null, 2),
    "utf8",
  );

  console.log("\n===== RESUMO cross-account =====");
  let tScan = 0,
    tLinked = 0,
    tAlready = 0,
    tNoProd = 0,
    tNoSku = 0,
    tErr = 0;
  for (const u of all) {
    for (const r of u.reports) {
      tScan += r.scanned;
      tLinked += r.linked;
      tAlready += r.already_linked;
      tNoProd += r.no_product_for_sku;
      tNoSku += r.no_sku;
      tErr += r.errors;
    }
  }
  console.log(`modo: ${flags.dryRun ? "DRY-RUN (0 escritas)" : "APPLY"}`);
  console.log(`  anúncios varridos:        ${tScan}`);
  console.log(`  ${flags.dryRun ? "linkaria" : "linkados"}:                ${tLinked}`);
  console.log(`  já linkados (skip):       ${tAlready}`);
  console.log(`  sem produto p/ o SKU:     ${tNoProd}`);
  console.log(`  sem SKU no anúncio:       ${tNoSku}`);
  console.log(`  erros:                    ${tErr}`);
  console.log("================================");

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("[link-listings][fatal]", e);
  await prisma.$disconnect();
  process.exit(1);
});
