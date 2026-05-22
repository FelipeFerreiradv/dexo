/**
 * Backfill ONE-SHOT de pedidos atrasados para todas as contas ACTIVE de um user.
 *
 * Por que existe: o sync loop padrão (`sync:ordersAndMetrics:loop`) usa janela
 * de 7 dias. Se uma venda foi há mais de 7 dias E o ProductListing dela só foi
 * criado depois (ex.: nossa Fase 2 do import), aquele pedido NUNCA foi puxado
 * pro Dexo, e o estoque local não foi decrementado.
 *
 * O que faz: para cada conta ACTIVE do user, chama o MESMO método que o
 * sync loop usa (`OrderUseCase.importRecentOrdersForAccount` / `...Shopee...`)
 * mas com uma janela mais larga (default 90 dias). Como o UseCase é
 * idempotente (Orders já no banco viram `alreadyExists`), é seguro rodar várias
 * vezes e seguro rodar em paralelo com o sync loop normal.
 *
 * NÃO é um sync paralelo — é o sync existente, chamado uma vez, com janela
 * maior. Toda a lógica de fetch, dedup, criação de Order/OrderItem,
 * decremento de estoque, criação de StockLog, enfileiramento de StockSyncJob
 * é a do produto, testada e em produção.
 *
 * Uso:
 *   npx tsx scripts/backfill-orders-sync.ts                    # default user, 90 dias
 *   npx tsx scripts/backfill-orders-sync.ts --days=180         # janela maior
 *   npx tsx scripts/backfill-orders-sync.ts --user-id=<id>
 *   npx tsx scripts/backfill-orders-sync.ts --platform=ml      # só ML
 *   npx tsx scripts/backfill-orders-sync.ts --platform=shopee  # só Shopee
 *
 * Limitação Shopee: o sync loop produtivo usa `Math.min(syncDays, 15)`.
 * Isso pode ser um limite da API; mantenho o mesmo cap por segurança.
 */
import "dotenv/config";
import path from "path";
import fs from "fs";
import { Platform } from "@prisma/client";
import prisma from "../app/lib/prisma";
import { OrderUseCase } from "../app/marketplaces/usecases/order.usercase";

const DEFAULT_USER_ID = "cmn5yc4rn0000vsasmwv9m8nc";
const OUT_DIR = path.resolve(__dirname, "out");

interface Flags {
  userId: string;
  days: number;
  platform: "ml" | "shopee" | "all";
  maxOrders: number;
}

function parseFlags(): Flags {
  const argv = process.argv.slice(2);
  const get = (name: string): string | undefined => {
    const f = `--${name}=`;
    const x = argv.find((a) => a.startsWith(f));
    return x ? x.slice(f.length) : undefined;
  };
  const daysRaw = get("days");
  const days = daysRaw && /^\d+$/.test(daysRaw) ? parseInt(daysRaw, 10) : 90;
  const platRaw = (get("platform") ?? "all").toLowerCase();
  const platform: Flags["platform"] =
    platRaw === "ml" || platRaw === "shopee" ? platRaw : "all";
  const maxOrdersRaw = get("max-orders");
  // 5000 default no backfill (sync loop continua usando 500 do default da função).
  const maxOrders =
    maxOrdersRaw && /^\d+$/.test(maxOrdersRaw)
      ? parseInt(maxOrdersRaw, 10)
      : 5000;
  return {
    userId: get("user-id") ?? DEFAULT_USER_ID,
    days,
    platform,
    maxOrders,
  };
}

async function main(): Promise<void> {
  const flags = parseFlags();
  console.log(
    `[backfill-orders] userId=${flags.userId} days=${flags.days} platform=${flags.platform} maxOrders=${flags.maxOrders} (Shopee não usa maxOrders)`,
  );

  // Sanity check
  const user = await prisma.user.findUnique({
    where: { id: flags.userId },
    select: { id: true, email: true, parentUserId: true },
  });
  if (!user) throw new Error(`User ${flags.userId} não encontrado.`);
  if (user.parentUserId !== null)
    throw new Error(
      `User ${flags.userId} é colaborador (parentUserId=${user.parentUserId}); backfill só p/ admin.`,
    );
  console.log(`[backfill-orders] user OK: ${user.email}`);

  const accounts = await prisma.marketplaceAccount.findMany({
    where: { userId: flags.userId, status: "ACTIVE" },
    select: {
      id: true,
      platform: true,
      accountName: true,
      expiresAt: true,
    },
  });
  console.log(`[backfill-orders] contas ACTIVE: ${accounts.length}`);
  for (const a of accounts) {
    console.log(
      `[backfill-orders]   ${a.platform}/${a.accountName} (id=${a.id}) tokenExpiresAt=${a.expiresAt.toISOString()}`,
    );
  }

  const targets = accounts.filter((a) => {
    if (flags.platform === "ml") return a.platform === Platform.MERCADO_LIVRE;
    if (flags.platform === "shopee") return a.platform === Platform.SHOPEE;
    return true;
  });
  console.log(`[backfill-orders] contas alvo: ${targets.length}`);

  const startedAt = new Date().toISOString();
  const results: Array<{
    accountId: string;
    accountName: string;
    platform: Platform;
    daysRequested: number;
    daysEffective: number;
    success: boolean;
    error: string | null;
    totalOrders: number;
    imported: number;
    alreadyExists: number;
    noProducts: number;
    stockDeductions: number;
    errors: number;
    elapsedMs: number;
  }> = [];

  for (const acc of targets) {
    const t0 = Date.now();
    // Shopee tem cap de 15 dias (mesmo do sync loop). ML aceita janela maior.
    const isShopee = acc.platform === Platform.SHOPEE;
    const daysEffective = isShopee ? Math.min(flags.days, 15) : flags.days;
    if (isShopee && daysEffective < flags.days) {
      console.log(
        `[backfill-orders] ${acc.accountName}: Shopee cap aplicado — usando ${daysEffective} dias em vez de ${flags.days}`,
      );
    }

    console.log(
      `\n[backfill-orders] >> processando ${acc.platform}/${acc.accountName} (${daysEffective} dias)…`,
    );
    try {
      const r = isShopee
        ? await OrderUseCase.importRecentShopeeOrdersForAccount(
            acc.id,
            daysEffective,
            true,
          )
        : await OrderUseCase.importRecentOrdersForAccount(
            acc.id,
            daysEffective,
            true,
            flags.maxOrders,
          );

      const elapsedMs = Date.now() - t0;
      console.log(
        `[backfill-orders] << ${acc.platform}/${acc.accountName} OK em ${elapsedMs}ms — total=${r.totalOrders} importados=${r.imported} jaExistiam=${r.alreadyExists} semProdutos=${r.noProducts} baixasEstoque=${r.stockDeductions} erros=${r.errors}`,
      );
      results.push({
        accountId: acc.id,
        accountName: acc.accountName,
        platform: acc.platform,
        daysRequested: flags.days,
        daysEffective,
        success: true,
        error: null,
        totalOrders: r.totalOrders,
        imported: r.imported,
        alreadyExists: r.alreadyExists,
        noProducts: r.noProducts,
        stockDeductions: r.stockDeductions,
        errors: r.errors,
        elapsedMs,
      });
    } catch (err) {
      const elapsedMs = Date.now() - t0;
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[backfill-orders] !! ${acc.platform}/${acc.accountName} FALHOU em ${elapsedMs}ms: ${message}`,
      );
      results.push({
        accountId: acc.id,
        accountName: acc.accountName,
        platform: acc.platform,
        daysRequested: flags.days,
        daysEffective,
        success: false,
        error: message,
        totalOrders: 0,
        imported: 0,
        alreadyExists: 0,
        noProducts: 0,
        stockDeductions: 0,
        errors: 0,
        elapsedMs,
      });
    }
  }

  const finishedAt = new Date().toISOString();
  const tot = {
    accounts: results.length,
    okAccounts: results.filter((r) => r.success).length,
    failedAccounts: results.filter((r) => !r.success).length,
    totalOrders: results.reduce((s, r) => s + r.totalOrders, 0),
    imported: results.reduce((s, r) => s + r.imported, 0),
    alreadyExists: results.reduce((s, r) => s + r.alreadyExists, 0),
    noProducts: results.reduce((s, r) => s + r.noProducts, 0),
    stockDeductions: results.reduce((s, r) => s + r.stockDeductions, 0),
    errors: results.reduce((s, r) => s + r.errors, 0),
  };
  console.log(`\n========== RESUMO BACKFILL ==========`);
  console.log(`contas:                 ${tot.accounts} (OK=${tot.okAccounts}, falhou=${tot.failedAccounts})`);
  console.log(`Orders totais (na API): ${tot.totalOrders}`);
  console.log(`importados (novos):     ${tot.imported}`);
  console.log(`já existiam (skip):     ${tot.alreadyExists}`);
  console.log(`sem produto (no_match): ${tot.noProducts}`);
  console.log(`baixas de estoque:      ${tot.stockDeductions}`);
  console.log(`erros internos:         ${tot.errors}`);
  console.log(`=======================================\n`);

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = path.join(OUT_DIR, `backfill-orders-${ts}.json`);
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      { startedAt, finishedAt, userId: flags.userId, flags, totals: tot, results },
      null,
      2,
    ),
    "utf8",
  );
  console.log(`[report] ${outPath}`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exitCode = 1;
});
