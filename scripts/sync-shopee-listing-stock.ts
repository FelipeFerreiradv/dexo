/**
 * sync-shopee-listing-stock.ts
 *
 * Reconcilia a quantidade dos ANÚNCIOS ATIVOS de uma conta Shopee com o
 * `Product.stock` (fonte da verdade já reconciliada via balcão + sync de
 * pedidos do ML). Mesma filosofia do `sync-ml-listing-stock.ts`, adaptado
 * para a API da Shopee.
 *
 * Caso de uso real (JOTABÊ): a conta Shopee NÃO entrou no sync das contas ML
 * que fizemos antes (cliente ia mexer na conta). Resultado: a Shopee ainda
 * mostra quantidades antigas → vende algo que já não existe (porque foi
 * vendido no ML há tempos). Este script empurra o estoque correto.
 *
 * Regras de segurança (mesmas do ML):
 *   - Só age em listings cuja conta-alvo seja SHOPEE.
 *   - Só empurra PRA BAIXO (Shopee qty > Product.stock). NUNCA aumenta —
 *     understated é só reportado.
 *   - Pula itens com `status !== "NORMAL"` (UNLIST/BANNED/DELETED/REVIEWING
 *     não estão à venda, não precisam de update).
 *   - Itens com variações (`has_model=true`) sem `model_id` no
 *     `externalListingId` ficam DEFERIDOS — a Shopee ignora update_stock
 *     a nível de item quando o item tem modelos. Vão como `defer`.
 *   - DRY-RUN por padrão. `--apply` pra gravar no Shopee.
 *   - Refresh automático de token em erro de auth.
 *
 * Uso:
 *   npx tsx scripts/sync-shopee-listing-stock.ts                              # dry-run
 *   npx tsx scripts/sync-shopee-listing-stock.ts --user-id=<id>
 *   npx tsx scripts/sync-shopee-listing-stock.ts --account=<nome|id>          # filtra conta
 *   npx tsx scripts/sync-shopee-listing-stock.ts --apply                       # APLICA
 *   npx tsx scripts/sync-shopee-listing-stock.ts --apply --limit=10            # só 10
 */
import "dotenv/config";
import path from "path";
import fs from "fs";
import { Platform } from "@prisma/client";
import prisma from "../app/lib/prisma";
import { ShopeeApiService } from "../app/marketplaces/services/shopee-api.service";
import { ShopeeOAuthService } from "../app/marketplaces/services/shopee-oauth.service";
import { MarketplaceRepository } from "../app/marketplaces/repositories/marketplace.repository";
import type { ShopeeItem } from "../app/marketplaces/types/shopee-api.types";

const DEFAULT_USER = "cmn5yc4rn0000vsasmwv9m8nc";
const OUT_DIR = path.resolve(__dirname, "out");
// Status considerado "vivo" no Shopee (anúncio aparecendo pra venda)
const SHOPEE_LIVE_STATUSES = new Set(["NORMAL"]);
// Tamanho dos lotes — Shopee aceita até 50 IDs por chamada de base_info
const BASE_INFO_BATCH = 50;
// Page size do getItemList (cap da Shopee: 100)
const LIST_PAGE_SIZE = 100;

function parseFlags() {
  const argv = process.argv.slice(2);
  const get = (n: string) => {
    const f = `--${n}=`;
    const x = argv.find((a) => a.startsWith(f));
    return x ? x.slice(f.length) : undefined;
  };
  const limitRaw = get("limit");
  return {
    userId: get("user-id") ?? DEFAULT_USER,
    account: get("account"),
    apply: argv.includes("--apply"),
    limit: limitRaw && /^\d+$/.test(limitRaw) ? parseInt(limitRaw, 10) : null,
  };
}

/** Detecta erro de auth da Shopee (status 401/403 ou mensagem específica). */
function isShopeeAuthError(error: unknown): boolean {
  const status =
    (error as any)?.status ?? (error as any)?.response?.status ?? null;
  if (status === 401 || status === 403) return true;
  const msg = error instanceof Error ? error.message : String(error);
  return /token|auth|unauthorized|access\s*denied|permission|expired/i.test(msg);
}

/**
 * Refresh proativo do token da conta Shopee, persistindo no DB. Mirrora o
 * padrão de `sync.usercase.ts`. Retorna o novo accessToken.
 */
async function refreshShopeeToken(acc: {
  id: string;
  refreshToken: string | null;
  shopId: number | null;
  accountName: string;
}): Promise<string> {
  if (!acc.refreshToken || !acc.shopId) {
    throw new Error(
      `Conta ${acc.accountName} sem refreshToken/shopId — não consigo renovar`,
    );
  }
  console.log(`[sync-shopee] renovando token de "${acc.accountName}"…`);
  const refreshed = await ShopeeOAuthService.refreshAccessToken(
    acc.refreshToken,
    acc.shopId,
  );
  await MarketplaceRepository.updateTokens(acc.id, {
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token,
    expiresAt: new Date(Date.now() + refreshed.expire_in * 1000),
  });
  console.log(`[sync-shopee] ✓ token de "${acc.accountName}" renovado.`);
  return refreshed.access_token;
}

/**
 * Extrai a quantidade visível atualmente para o item (ou modelo específico).
 * Mirrora a lógica de `getShopeeAvailableStock` do app.
 */
function getItemStock(
  item: ShopeeItem & any,
  modelId?: number,
): { qty: number; source: string } {
  // Item com variações + modelId → usa o modelo específico
  if (modelId && Array.isArray(item.model_list)) {
    const model = item.model_list.find((m: any) => m.model_id === modelId);
    if (model) {
      const sv2 = model?.stock_info_v2?.summary_info?.total_available_stock;
      if (typeof sv2 === "number") return { qty: sv2, source: "model.v2" };
      if (Array.isArray(model.stock_info) && model.stock_info.length > 0) {
        const q = model.stock_info[0]?.stock_quantity;
        if (typeof q === "number") return { qty: q, source: "model.legacy" };
      }
    }
    return { qty: 0, source: "model.notfound" };
  }
  // Item simples
  const sv2 = item?.stock_info_v2?.summary_info?.total_available_stock;
  if (typeof sv2 === "number") return { qty: sv2, source: "item.v2" };
  if (Array.isArray(item?.stock_info) && item.stock_info.length > 0) {
    const q = item.stock_info[0]?.stock_quantity;
    if (typeof q === "number") return { qty: q, source: "item.legacy" };
  }
  return { qty: 0, source: "item.empty" };
}

function parseItemId(externalId: string): number {
  return parseInt(externalId.split(":")[0], 10);
}

function parseModelId(externalId: string): number | undefined {
  const parts = externalId.split(":");
  if (parts.length < 2) return undefined;
  const n = parseInt(parts[1], 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Lista todos os item_ids da loja, paginando, com auto-refresh de token. */
async function listAllItemIds(acc: {
  id: string;
  accessToken: string;
  refreshToken: string | null;
  shopId: number | null;
  accountName: string;
}): Promise<{ itemIds: number[]; accessToken: string }> {
  let workingToken = acc.accessToken;
  const itemIds: number[] = [];
  let offset = 0;
  let pageCount = 0;
  while (true) {
    pageCount++;
    const params = {
      offset,
      page_size: LIST_PAGE_SIZE,
      item_status: ["NORMAL"] as any,
    };
    let resp: any;
    try {
      resp = await ShopeeApiService.getItemList(
        workingToken,
        acc.shopId!,
        params,
      );
    } catch (err) {
      if (isShopeeAuthError(err) && acc.refreshToken) {
        workingToken = await refreshShopeeToken(acc);
        resp = await ShopeeApiService.getItemList(
          workingToken,
          acc.shopId!,
          params,
        );
      } else throw err;
    }
    const items = (resp?.item || []) as Array<{ item_id: number }>;
    for (const it of items) itemIds.push(it.item_id);
    if (!resp?.has_next_page) break;
    if (typeof resp.next_offset === "number" && resp.next_offset !== offset)
      offset = resp.next_offset;
    else offset += items.length;
    if (items.length === 0) break;
    // sleep leve entre páginas
    await new Promise((r) => setTimeout(r, 80));
  }
  console.log(
    `[sync-shopee]   getItemList: ${itemIds.length} itens NORMAL em ${pageCount} página(s)`,
  );
  return { itemIds, accessToken: workingToken };
}

/** Busca details em lotes; retorna map itemId -> ShopeeItem. */
async function fetchAllItemsBaseInfo(
  acc: {
    id: string;
    accessToken: string;
    refreshToken: string | null;
    shopId: number | null;
    accountName: string;
  },
  itemIds: number[],
  initialToken: string,
): Promise<{ map: Map<number, ShopeeItem>; accessToken: string }> {
  let workingToken = initialToken;
  const map = new Map<number, ShopeeItem>();
  for (let i = 0; i < itemIds.length; i += BASE_INFO_BATCH) {
    const chunk = itemIds.slice(i, i + BASE_INFO_BATCH);
    let batch: ShopeeItem[];
    try {
      batch = await ShopeeApiService.getItemsBaseInfo(
        workingToken,
        acc.shopId!,
        chunk,
      );
    } catch (err) {
      if (isShopeeAuthError(err) && acc.refreshToken) {
        workingToken = await refreshShopeeToken(acc);
        batch = await ShopeeApiService.getItemsBaseInfo(
          workingToken,
          acc.shopId!,
          chunk,
        );
      } else throw err;
    }
    for (const it of batch) map.set(it.item_id, it);
    if ((i + BASE_INFO_BATCH) % 500 === 0)
      console.log(
        `[sync-shopee]   getItemsBaseInfo: ${Math.min(i + BASE_INFO_BATCH, itemIds.length)}/${itemIds.length}…`,
      );
    await new Promise((r) => setTimeout(r, 100));
  }
  return { map, accessToken: workingToken };
}

async function main(): Promise<void> {
  const flags = parseFlags();
  const isDry = !flags.apply;
  console.log(
    `[sync-shopee] userId=${flags.userId}${flags.account ? ` account=${flags.account}` : ""} apply=${flags.apply} ${isDry ? "(DRY-RUN, nada gravado no Shopee)" : "(VAI GRAVAR NO SHOPEE)"}`,
  );

  // 1) Contas Shopee ACTIVE alvo
  const accounts = await prisma.marketplaceAccount.findMany({
    where: {
      userId: flags.userId,
      status: "ACTIVE",
      platform: Platform.SHOPEE,
      ...(flags.account
        ? {
            OR: [{ accountName: flags.account }, { id: flags.account }],
          }
        : {}),
    },
    select: {
      id: true,
      accessToken: true,
      refreshToken: true,
      shopId: true,
      accountName: true,
    },
  });
  if (accounts.length === 0) {
    console.error(
      `[sync-shopee] nenhuma conta Shopee ACTIVE encontrada${flags.account ? ` para "${flags.account}"` : ""}. Aborto.`,
    );
    await prisma.$disconnect();
    return;
  }
  console.log(
    `[sync-shopee] contas-alvo: ${accounts.map((a) => a.accountName).join(", ")}`,
  );

  type Action = "qty" | "defer" | "skip";
  type Cand = {
    accountId: string;
    accountName: string;
    itemId: number;
    modelId: number | null;
    sku: string;
    name: string;
    status: string;
    mlQty: number;
    stock: number;
    action: Action;
    reason?: string;
  };

  // Acumuladores cross-account pro relatório consolidado
  const overallReport: Array<{
    account: string;
    counts: Record<string, number>;
    candidates: Cand[];
  }> = [];
  const allCandidates: Cand[] = [];

  for (const acc of accounts) {
    if (!acc.accessToken || !acc.shopId) {
      console.warn(`[sync-shopee] "${acc.accountName}" sem credenciais — pulada`);
      continue;
    }
    console.log(`\n[sync-shopee] >> ${acc.accountName}: listando anúncios…`);

    // 2) Lista IDs + buscas details (com refresh automático)
    let workingToken: string;
    let itemIds: number[];
    try {
      const r1 = await listAllItemIds(acc);
      itemIds = r1.itemIds;
      workingToken = r1.accessToken;
    } catch (err) {
      console.error(
        `[sync-shopee] falha listando itens de ${acc.accountName}: ${err instanceof Error ? err.message : err}`,
      );
      continue;
    }
    if (itemIds.length === 0) {
      console.log(`[sync-shopee]   conta sem itens NORMAL.`);
      continue;
    }

    let itemMap: Map<number, ShopeeItem>;
    try {
      const r2 = await fetchAllItemsBaseInfo(acc, itemIds, workingToken);
      itemMap = r2.map;
      workingToken = r2.accessToken;
    } catch (err) {
      console.error(
        `[sync-shopee] falha em getItemsBaseInfo de ${acc.accountName}: ${err instanceof Error ? err.message : err}`,
      );
      continue;
    }
    console.log(`[sync-shopee]   detalhes recebidos: ${itemMap.size}`);

    // 3) Carrega ProductListings DB Shopee desta conta
    const listings = await prisma.productListing.findMany({
      where: { marketplaceAccountId: acc.id },
      select: {
        externalListingId: true,
        product: { select: { sku: true, stock: true, name: true } },
      },
    });
    console.log(
      `[sync-shopee]   ProductListings DB desta conta: ${listings.length}`,
    );

    // 4) Classifica
    const overstated: Cand[] = [];
    let synced = 0;
    let understated = 0;
    let skippedNotLive = 0;
    let deferModelMissing = 0;
    let noItemInShop = 0;
    let noProduct = 0;
    for (const l of listings) {
      if (!l.product) {
        noProduct++;
        continue;
      }
      const itemId = parseItemId(l.externalListingId);
      if (!Number.isFinite(itemId) || itemId <= 0) {
        noItemInShop++;
        continue;
      }
      const modelId = parseModelId(l.externalListingId) ?? null;
      const item = itemMap.get(itemId);
      if (!item) {
        // Anúncio existe no DB mas não retornou no getItemList (NORMAL) —
        // pode estar UNLIST/BANNED/DELETED/REVIEWING. Não há o que fazer.
        noItemInShop++;
        continue;
      }
      const status = String((item as any).item_status ?? (item as any).status ?? "");
      if (!SHOPEE_LIVE_STATUSES.has(status)) {
        skippedNotLive++;
        continue;
      }
      const hasModel = Boolean((item as any).has_model);
      if (hasModel && !modelId) {
        // Não dá pra atualizar estoque a nível de item se há variações.
        deferModelMissing++;
        allCandidates.push({
          accountId: acc.id,
          accountName: acc.accountName,
          itemId,
          modelId: null,
          sku: l.product.sku,
          name: l.product.name,
          status,
          mlQty: -1,
          stock: l.product.stock,
          action: "defer",
          reason: "has_model=true sem model_id no externalListingId",
        });
        continue;
      }
      const { qty } = getItemStock(item as any, modelId ?? undefined);
      const stock = l.product.stock;
      if (qty > stock) {
        const cand: Cand = {
          accountId: acc.id,
          accountName: acc.accountName,
          itemId,
          modelId,
          sku: l.product.sku,
          name: l.product.name.slice(0, 60),
          status,
          mlQty: qty,
          stock,
          action: "qty",
        };
        overstated.push(cand);
        allCandidates.push(cand);
      } else if (qty === stock) synced++;
      else understated++;
    }
    overstated.sort((a, b) => b.mlQty - b.stock - (a.mlQty - a.stock));

    const counts = {
      listings: listings.length,
      synced,
      overstated: overstated.length,
      understated,
      skippedNotLive,
      deferModelMissing,
      noItemInShop,
      noProduct,
    };
    console.log(
      `\n========== SYNC ${acc.accountName} (qty Shopee → Product.stock) ==========`,
    );
    console.log(`ProductListings DB desta conta:      ${listings.length}`);
    console.log(`  em sincronia (qty == stock):       ${synced}`);
    console.log(`  overstated (qty > stock) ← agir:   ${overstated.length}`);
    console.log(`  understated (qty < stock, ignorar):${understated}`);
    console.log(`  pulados (item não NORMAL):         ${skippedNotLive}`);
    console.log(`  deferidos (has_model sem model_id):${deferModelMissing}`);
    console.log(`  sem item ativo no Shopee atual:    ${noItemInShop}`);
    console.log(`  sem Product no DB:                 ${noProduct}`);
    console.log(`==========================================================`);

    if (overstated.length > 0) {
      console.log(`\nAmostra acionáveis (top 25):`);
      for (const c of overstated.slice(0, 25)) {
        const mod = c.modelId ? `:${c.modelId}` : "";
        console.log(
          `  sku=${c.sku} qty ${c.mlQty} → ${c.stock} (${c.status}) item=${c.itemId}${mod} "${c.name}"`,
        );
      }
      if (overstated.length > 25)
        console.log(`  … (+${overstated.length - 25} mais)`);
    }

    overallReport.push({
      account: acc.accountName,
      counts,
      candidates: overstated,
    });

    if (isDry) continue;

    // 5) Apply: empurra qty pra Product.stock
    const targets =
      flags.limit !== null ? overstated.slice(0, flags.limit) : overstated;
    console.log(
      `\n[sync-shopee] APLICANDO em ${targets.length} anúncio(s) da ${acc.accountName}…`,
    );
    let ok = 0;
    let fail = 0;
    const failures: Array<{ itemId: number; sku: string; error: string }> = [];
    for (const c of targets) {
      try {
        await ShopeeApiService.updateItemStock(
          workingToken,
          acc.shopId!,
          c.itemId,
          c.stock,
          c.modelId ?? undefined,
        );
        ok++;
        const mod = c.modelId ? `:${c.modelId}` : "";
        console.log(
          `  [shopee] item=${c.itemId}${mod} qty ${c.mlQty} → ${c.stock}  sku=${c.sku}`,
        );
      } catch (err) {
        // Auth → refresh + retry 1x
        if (isShopeeAuthError(err) && acc.refreshToken) {
          try {
            workingToken = await refreshShopeeToken(acc);
            await ShopeeApiService.updateItemStock(
              workingToken,
              acc.shopId!,
              c.itemId,
              c.stock,
              c.modelId ?? undefined,
            );
            ok++;
            const mod = c.modelId ? `:${c.modelId}` : "";
            console.log(
              `  [shopee] item=${c.itemId}${mod} qty ${c.mlQty} → ${c.stock}  sku=${c.sku} (após refresh)`,
            );
            continue;
          } catch {
            // cai pro log de falha abaixo
          }
        }
        const m = err instanceof Error ? err.message : String(err);
        fail++;
        failures.push({ itemId: c.itemId, sku: c.sku, error: m.slice(0, 200) });
        console.error(
          `  [shopee][FAIL] item=${c.itemId} sku=${c.sku}: ${m.slice(0, 160)}`,
        );
      }
      // pausa leve entre requisições
      await new Promise((r) => setTimeout(r, 200));
    }

    console.log(`\n========== RESUMO SYNC ${acc.accountName} ==========`);
    console.log(`Alvos:     ${targets.length}`);
    console.log(`Sucesso:   ${ok}`);
    console.log(`Falhas:    ${fail}`);
    console.log(`==================================================`);

    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const outApply = path.join(
      OUT_DIR,
      `sync-shopee-stock-${acc.accountName}-applied-${ts}.json`,
    );
    fs.writeFileSync(
      outApply,
      JSON.stringify(
        { account: acc.accountName, ok, fail, failures },
        null,
        2,
      ),
      "utf8",
    );
    console.log(`[report] ${outApply}`);
  }

  // Relatório consolidado (dry-run também grava)
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = path.join(
    OUT_DIR,
    `sync-shopee-stock-${isDry ? "dryrun" : "apply"}-${ts}.json`,
  );
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      { userId: flags.userId, apply: flags.apply, reports: overallReport },
      null,
      2,
    ),
    "utf8",
  );
  console.log(`\n[report] ${outPath}`);

  if (isDry) {
    const args: string[] = ["--apply"];
    if (flags.userId !== DEFAULT_USER) args.push(`--user-id=${flags.userId}`);
    if (flags.account) args.push(`--account=${flags.account}`);
    if (flags.limit !== null) args.push(`--limit=${flags.limit}`);
    console.log(
      `\n[sync-shopee] DRY-RUN. Para aplicar:\n  npx tsx scripts/sync-shopee-listing-stock.ts ${args.join(" ")}`,
    );
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exitCode = 1;
});
