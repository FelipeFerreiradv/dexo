/**
 * sync-ml-listing-stock.ts
 *
 * Reconcilia a quantidade dos ANÚNCIOS de uma conta ML com o `Product.stock`
 * (fonte da verdade já reconciliada via balcão + sync de pedidos).
 *
 * Caso de uso: a JOTABEDESMONTE ficou pausada (modo feiras); peças venderam na
 * JOTABÊ (mesmo Product, stock caiu) mas os anúncios da DESMONTE ficaram com a
 * quantidade antiga. Este script empurra `available_quantity = Product.stock`
 * pros anúncios que estão OVERSTATED (ML mostra MAIS do que temos).
 *
 * Regras de segurança:
 *   - Só age em listings FISICAMENTE na conta-alvo (getSellerItemIds da conta).
 *   - Só empurra PRA BAIXO (qty_ML > stock). Understated (qty_ML < stock) é só
 *     reportado, NUNCA aumentado (não inflar anúncio com peça que talvez não exista).
 *   - Pula `closed`/`inactive` (não há o que ajustar).
 *   - `under_review` é tentado, mas o ML pode rejeitar (logado como falha, não fatal).
 *   - stock=0 → seta qty=0 (ML auto-pausa o anúncio; peça vendida não fica comprável).
 *   - DRY-RUN por padrão. --apply pra gravar no ML.
 *   - Refresh automático de token em 401.
 *
 * Uso:
 *   npx tsx scripts/sync-ml-listing-stock.ts                              # dry-run, JOTABEDESMONTE
 *   npx tsx scripts/sync-ml-listing-stock.ts --account=JOTABEDESMONTE
 *   npx tsx scripts/sync-ml-listing-stock.ts --apply                       # APLICA no ML
 *   npx tsx scripts/sync-ml-listing-stock.ts --apply --limit=10            # só 10 (teste)
 */
import "dotenv/config";
import path from "path";
import fs from "fs";
import { Platform } from "@prisma/client";
import prisma from "../app/lib/prisma";
import { MLApiService } from "../app/marketplaces/services/ml-api.service";
import { MLOAuthService } from "../app/marketplaces/services/ml-oauth.service";
import { MarketplaceRepository } from "../app/marketplaces/repositories/marketplace.repository";

const DEFAULT_USER = "cmn5yc4rn0000vsasmwv9m8nc";
const OUT_DIR = path.resolve(__dirname, "out");
const SKIP_STATUSES = new Set(["closed", "inactive", "deleted"]); // sem qty relevante

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
    account: get("account") ?? "JOTABEDESMONTE",
    apply: argv.includes("--apply"),
    limit: limitRaw && /^\d+$/.test(limitRaw) ? parseInt(limitRaw, 10) : null,
  };
}

function isMlAuthError(error: unknown): boolean {
  const status = (error as any)?.status ?? (error as any)?.response?.status ?? null;
  if (status === 401 || status === 403) return true;
  const msg = error instanceof Error ? error.message : String(error);
  return /unauthorized|invalid access token|token expired|forbidden/i.test(msg);
}

async function listSellerItemsWithRefresh(acc: {
  id: string;
  accessToken: string;
  refreshToken: string | null;
  externalUserId: string;
  accountName: string;
}): Promise<{ ids: string[]; accessToken: string }> {
  try {
    const ids = await MLApiService.getSellerItemIds(acc.accessToken, acc.externalUserId);
    return { ids, accessToken: acc.accessToken };
  } catch (err) {
    if (!isMlAuthError(err) || !acc.refreshToken) throw err;
    console.log(`[sync] token de ${acc.accountName} expirado — renovando…`);
    const refreshed = await MLOAuthService.refreshAccessTokenForAccount(acc.id, acc.refreshToken);
    await MarketplaceRepository.updateTokens(acc.id, {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: new Date(Date.now() + refreshed.expiresIn * 1000),
    });
    console.log(`[sync] ✓ token de ${acc.accountName} renovado.`);
    const ids = await MLApiService.getSellerItemIds(refreshed.accessToken, acc.externalUserId);
    return { ids, accessToken: refreshed.accessToken };
  }
}

async function main(): Promise<void> {
  const flags = parseFlags();
  const isDry = !flags.apply;
  console.log(
    `[sync] userId=${flags.userId} account=${flags.account} apply=${flags.apply} ${isDry ? "(DRY-RUN, nada gravado no ML)" : "(VAI GRAVAR NO ML)"}`,
  );

  // 1) Conta-alvo
  const acc = await prisma.marketplaceAccount.findFirst({
    where: {
      userId: flags.userId,
      status: "ACTIVE",
      platform: Platform.MERCADO_LIVRE,
      OR: [{ accountName: flags.account }, { id: flags.account }],
    },
    select: { id: true, accessToken: true, refreshToken: true, externalUserId: true, accountName: true },
  });
  if (!acc || !acc.accessToken || !acc.externalUserId) {
    console.error(`[sync] conta ML ACTIVE "${flags.account}" não encontrada (ou sem credenciais). Aborto.`);
    await prisma.$disconnect();
    return;
  }

  // 2) MLBs físicos da conta-alvo + status + qty (com refresh)
  console.log(`[sync] >> ${acc.accountName}: listando anúncios…`);
  const { ids, accessToken: workingToken } = await listSellerItemsWithRefresh(acc);
  console.log(`[sync]    ${ids.length} anúncios. Buscando status+qty…`);
  const details = await MLApiService.getItemsDetails(workingToken, ids);
  const mlInfo = new Map<string, { status: string; qty: number }>();
  for (const d of details)
    mlInfo.set(d.id, { status: d.status, qty: d.available_quantity ?? 0 });
  console.log(`[sync]    detalhes: ${details.length}`);

  // 3) Mapa MLB -> Product.stock (carrega ProductListings ML em lotes)
  const listingSelect = {
    id: true,
    externalListingId: true,
    product: { select: { sku: true, stock: true, name: true } },
  } as const;
  type LRow = Awaited<
    ReturnType<typeof prisma.productListing.findMany<{ select: typeof listingSelect }>>
  >[number];
  const mlbToProduct = new Map<string, { stock: number; sku: string; name: string }>();
  let cursorId: string | undefined = undefined;
  const CHUNK = 3000;
  while (true) {
    const batch: LRow[] = await prisma.productListing.findMany({
      where: { marketplaceAccount: { platform: Platform.MERCADO_LIVRE, userId: flags.userId } },
      select: listingSelect,
      orderBy: { id: "asc" },
      take: CHUNK,
      ...(cursorId ? { skip: 1, cursor: { id: cursorId } } : {}),
    });
    if (batch.length === 0) break;
    for (const l of batch) {
      if (!l.product) continue;
      // primeira ocorrência vence (um MLB deveria ter 1 listing)
      if (!mlbToProduct.has(l.externalListingId))
        mlbToProduct.set(l.externalListingId, {
          stock: l.product.stock,
          sku: l.product.sku,
          name: l.product.name,
        });
    }
    if (batch.length < CHUNK) break;
    cursorId = batch[batch.length - 1].id;
  }
  console.log(`[sync] MLBs com Product no DB: ${mlbToProduct.size}`);

  // 4) Identifica candidatos overstated (qty_ML > stock) e a AÇÃO correta,
  // espelhando a lógica canônica do app (sync.usercase.ts):
  //   - stock > 0           → "qty": updateItemStock(stock)   [reduz a quantidade]
  //   - stock = 0 + active  → "pause": updateItem status=paused [ML não aceita qty=0]
  //   - stock = 0 + paused/under_review/inactive → "defer": não dá p/ mexer via API
  //     (já não-comprável; o ML trava edição de under_review). Pausados com qty
  //     remota>0 ficam como risco latente de oversell SE reativados manualmente.
  type Action = "qty" | "pause" | "defer";
  type Cand = {
    mlb: string; sku: string; name: string; status: string;
    mlQty: number; stock: number; action: Action;
  };
  const overstated: Cand[] = [];
  let synced = 0;
  let understated = 0;
  let skippedStatus = 0;
  let noProduct = 0;
  for (const id of ids) {
    const info = mlInfo.get(id);
    if (!info) continue;
    if (SKIP_STATUSES.has(info.status)) {
      skippedStatus++;
      continue;
    }
    const p = mlbToProduct.get(id);
    if (!p) {
      noProduct++;
      continue;
    }
    if (info.qty > p.stock) {
      let action: Action;
      if (p.stock > 0) action = "qty";
      else if (info.status === "active") action = "pause";
      else action = "defer";
      overstated.push({
        mlb: id, sku: p.sku, name: p.name.slice(0, 45),
        status: info.status, mlQty: info.qty, stock: p.stock, action,
      });
    } else if (info.qty === p.stock) synced++;
    else understated++;
  }
  overstated.sort((a, b) => b.mlQty - b.stock - (a.mlQty - a.stock));
  const nQty = overstated.filter((c) => c.action === "qty").length;
  const nPause = overstated.filter((c) => c.action === "pause").length;
  const nDefer = overstated.filter((c) => c.action === "defer").length;

  console.log(`\n========== SYNC ${acc.accountName} (ML qty → Product.stock) ==========`);
  console.log(`Anúncios não-encerrados analisados: ${overstated.length + synced + understated}`);
  console.log(`  em sincronia:                     ${synced}`);
  console.log(`  overstated (ML > stock):          ${overstated.length}`);
  console.log(`    → reduzir quantidade (stock>0):  ${nQty}  [acionável]`);
  console.log(`    → pausar anúncio (stock=0+active):${nPause}  [acionável]`);
  console.log(`    → deferir (under_review/paused):  ${nDefer}  [ML trava; aguardar moderação]`);
  console.log(`  understated (ML < stock, ignorar):${understated}`);
  console.log(`  pulados (closed/inactive):        ${skippedStatus}`);
  console.log(`  sem Product no DB:                ${noProduct}`);
  console.log(`====================================================`);

  if (nQty + nPause > 0) {
    console.log(`\nAcionáveis agora (top 25):`);
    for (const c of overstated.filter((x) => x.action !== "defer").slice(0, 25)) {
      const act = c.action === "qty" ? `qty→${c.stock}` : "PAUSAR";
      console.log(`  sku=${c.sku} ${act} (ML_qty=${c.mlQty}, ${c.status}) ${c.mlb} "${c.name}"`);
    }
  }
  if (nDefer > 0) {
    console.log(`\nDeferidos (${nDefer}) — ML em moderação, reexecutar quando virarem active. Amostra:`);
    for (const c of overstated.filter((x) => x.action === "defer").slice(0, 10)) {
      console.log(`  sku=${c.sku} ML_qty=${c.mlQty}→${c.stock} (${c.status}) ${c.mlb}`);
    }
  }

  // 5) Relatório
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = path.join(OUT_DIR, `sync-ml-stock-${acc.accountName}-${isDry ? "dryrun" : "apply"}-${ts}.json`);
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      { account: acc.accountName, apply: flags.apply, counts: { overstated: overstated.length, actionableQty: nQty, actionablePause: nPause, deferred: nDefer, synced, understated, skippedStatus, noProduct }, overstated },
      null,
      2,
    ),
    "utf8",
  );
  console.log(`[report] ${outPath}`);

  if (isDry) {
    console.log(`\n[sync] DRY-RUN. Para aplicar no ML:\n  npx tsx scripts/sync-ml-listing-stock.ts --apply --account=${flags.account}`);
    await prisma.$disconnect();
    return;
  }

  // 6) Apply: só age nos ACIONÁVEIS (qty + pause). Deferidos são pulados.
  const actionable = overstated.filter((c) => c.action !== "defer");
  const targets = flags.limit !== null ? actionable.slice(0, flags.limit) : actionable;
  console.log(
    `\n[sync] APLICANDO em ${targets.length} anúncios acionáveis no ML (${nDefer} deferidos pulados)…`,
  );
  let ok = 0;
  let fail = 0;
  const failures: Array<{ mlb: string; sku: string; error: string }> = [];
  for (const c of targets) {
    try {
      if (c.action === "qty") {
        await MLApiService.updateItemStock(workingToken, c.mlb, c.stock);
        console.log(`  [ml] ${c.mlb} qty ${c.mlQty} → ${c.stock}  sku=${c.sku}`);
      } else {
        // action === "pause": stock=0 + active → pausa (jeito certo no ML)
        await MLApiService.updateItem(workingToken, c.mlb, { status: "paused" });
        console.log(`  [ml] ${c.mlb} PAUSADO (stock=0)  sku=${c.sku}`);
      }
      ok++;
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      fail++;
      failures.push({ mlb: c.mlb, sku: c.sku, error: m.slice(0, 160) });
      console.error(`  [ml][FAIL] ${c.mlb} sku=${c.sku}: ${m.slice(0, 160)}`);
    }
    await new Promise((r) => setTimeout(r, 60)); // suaviza rate limit
  }

  console.log(`\n========== RESUMO SYNC ==========`);
  console.log(`Acionáveis alvo:  ${targets.length}  (deferidos: ${nDefer})`);
  console.log(`Sucesso:   ${ok}`);
  console.log(`Falhas:    ${fail}`);
  console.log(`=================================`);

  const outApply = path.join(OUT_DIR, `sync-ml-stock-${acc.accountName}-applied-${ts}.json`);
  fs.writeFileSync(outApply, JSON.stringify({ account: acc.accountName, ok, fail, failures }, null, 2), "utf8");
  console.log(`[report] ${outApply}`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("[fatal]", e);
  process.exitCode = 1;
});
