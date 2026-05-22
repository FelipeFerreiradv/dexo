/**
 * rededuct-stock-safe.ts
 *
 * Versão SEGURA do rededuct-stock.ts. Diferenças críticas:
 *
 * 1. MATCH APROXIMADO (em vez de reason exato): considera o pedido já
 *    decrementado se houver QUALQUER StockLog negativo do produto na janela
 *    ±10min do Order.createdAt. Evita double-decrement quando a baixa foi
 *    feita com `reason` diferente (ex.: "Importação Shopee", "Reconciliação
 *    retroativa", "Manual update", etc.).
 *
 * 2. TRANSACTION TIMEOUT 60s (em vez do default 5s do Prisma) — corrige o
 *    P2028 "Transaction not found" que ocorria em pedidos com muitos listings.
 *
 * 3. DRY-RUN POR PADRÃO. Só aplica com --apply.
 *
 * Uso:
 *   npx tsx scripts/rededuct-stock-safe.ts                              # dry-run, default user, 180d
 *   npx tsx scripts/rededuct-stock-safe.ts --user-id=<id> --days=180
 *   npx tsx scripts/rededuct-stock-safe.ts --apply                       # APLICA as rededuções
 *   npx tsx scripts/rededuct-stock-safe.ts --window-min=10               # janela do match aproximado
 */
import "dotenv/config";
import path from "path";
import fs from "fs";
import prisma from "../app/lib/prisma";

const DEFAULT_USER = "cmn5yc4rn0000vsasmwv9m8nc";
const OUT_DIR = path.resolve(__dirname, "out");

function parseFlags() {
  const argv = process.argv.slice(2);
  const get = (n: string): string | undefined => {
    const f = `--${n}=`;
    const x = argv.find((a) => a.startsWith(f));
    return x ? x.slice(f.length) : undefined;
  };
  const daysRaw = get("days");
  const days = daysRaw && /^\d+$/.test(daysRaw) ? parseInt(daysRaw, 10) : 180;
  const winRaw = get("window-min");
  const windowMin = winRaw && /^\d+$/.test(winRaw) ? parseInt(winRaw, 10) : 10;
  return {
    userId: get("user-id") ?? DEFAULT_USER,
    days,
    windowMin,
    apply: argv.includes("--apply"),
  };
}

async function main(): Promise<void> {
  const flags = parseFlags();
  const isDry = !flags.apply;
  console.log(
    `[rededuct-safe] userId=${flags.userId} days=${flags.days} window=±${flags.windowMin}min apply=${flags.apply} ${isDry ? "(DRY-RUN, nada será gravado)" : "(VAI GRAVAR)"}`,
  );

  const dateFrom = new Date();
  dateFrom.setDate(dateFrom.getDate() - flags.days);

  const orders = await prisma.order.findMany({
    where: {
      createdAt: { gte: dateFrom },
      status: { in: ["PAID", "SHIPPED", "DELIVERED"] },
      marketplaceAccount: { userId: flags.userId },
    },
    include: {
      items: { select: { productId: true, quantity: true } },
      marketplaceAccount: {
        select: { id: true, platform: true, accountName: true },
      },
    },
  });
  console.log(`[rededuct-safe] ${orders.length} pedidos no período.`);

  type CatA = { order: (typeof orders)[number] };
  const skippedExact: CatA[] = [];
  const skippedNear: Array<
    CatA & { nearLogReason: string | null; deltaMin: number }
  > = [];
  const truly: Array<
    CatA & { reason: string; productIds: string[] }
  > = [];

  let scanned = 0;
  for (const order of orders) {
    scanned++;
    if (scanned % 200 === 0) {
      console.log(
        `[rededuct-safe] classificando ${scanned}/${orders.length}…`,
      );
    }
    const isML = order.marketplaceAccount.platform === "MERCADO_LIVRE";
    const expectedReason = isML
      ? `Venda ML #${order.externalOrderId}`
      : `Importação Shopee pedido #${order.externalOrderId}`;
    const itemProductIds = order.items
      .map((i) => i.productId)
      .filter((x): x is string => !!x);
    if (itemProductIds.length === 0) continue;

    // (a) reason exato
    const exact = await prisma.stockLog.findFirst({
      where: { reason: expectedReason },
      select: { id: true },
    });
    if (exact) {
      skippedExact.push({ order });
      continue;
    }

    // (b) match aproximado: StockLog negativo do mesmo produto, janela ±N min
    const windowStart = new Date(
      order.createdAt.getTime() - flags.windowMin * 60_000,
    );
    const windowEnd = new Date(
      order.createdAt.getTime() + flags.windowMin * 60_000,
    );
    const near = await prisma.stockLog.findFirst({
      where: {
        productId: { in: itemProductIds },
        createdAt: { gte: windowStart, lte: windowEnd },
        change: { lt: 0 },
      },
      select: { reason: true, createdAt: true },
    });
    if (near) {
      const deltaMin =
        (near.createdAt.getTime() - order.createdAt.getTime()) / 60_000;
      skippedNear.push({ order, nearLogReason: near.reason, deltaMin });
      continue;
    }

    // (c) realmente sem baixa
    truly.push({
      order,
      reason: expectedReason,
      productIds: itemProductIds,
    });
  }

  console.log(`\nClassificação:`);
  console.log(
    `  (a) skip — reason exato já existe:                       ${skippedExact.length}`,
  );
  console.log(
    `  (b) skip — baixa próxima sob outro reason (±${flags.windowMin}min): ${skippedNear.length}`,
  );
  console.log(
    `  (c) APLICAR — sem nenhuma baixa próxima:                 ${truly.length}`,
  );

  if (truly.length > 0) {
    console.log(
      `\nAmostra dos pedidos a serem ${isDry ? "RE-DECREMENTADOS (dry-run)" : "RE-DECREMENTADOS"} (top 20):`,
    );
    for (const t of truly.slice(0, 20)) {
      const o = t.order;
      console.log(
        `  ${o.externalOrderId}  ${o.marketplaceAccount.platform}/${o.marketplaceAccount.accountName}  ${o.createdAt.toISOString()}  items=${o.items.length}`,
      );
    }
  }

  let applied = 0;
  let failed = 0;
  const failures: Array<{ order: string; error: string }> = [];

  if (isDry) {
    console.log(
      `\n[rededuct-safe] DRY-RUN — nada foi gravado. Para aplicar:\n  npx tsx scripts/rededuct-stock-safe.ts --apply --days=${flags.days}`,
    );
  } else {
    console.log(
      `\n[rededuct-safe] APLICANDO baixas em ${truly.length} pedidos…\n`,
    );
    for (const t of truly) {
      const order = t.order;
      const itemsWithProduct = order.items.filter((i) => i.productId);
      if (itemsWithProduct.length === 0) continue;
      try {
        await prisma.$transaction(
          async (tx) => {
            for (const item of itemsWithProduct) {
              const locked = await tx.$queryRaw<
                { id: string; name: string; stock: number }[]
              >`SELECT id, name, stock FROM "Product" WHERE id = ${item.productId} FOR UPDATE`;
              const product = locked[0];
              if (!product) continue;
              const previousStock = product.stock;
              const decrementBy = Math.min(
                item.quantity,
                Math.max(0, previousStock),
              );
              const newStock = previousStock - decrementBy;

              await tx.product.update({
                where: { id: item.productId! },
                data: { stock: newStock },
              });
              await tx.stockLog.create({
                data: {
                  productId: item.productId!,
                  change: -decrementBy,
                  reason: t.reason,
                  previousStock,
                  newStock,
                },
              });
              console.log(
                `  [stock] ${product.name}: ${previousStock} → ${newStock} (qty=${item.quantity}) order=${order.externalOrderId}`,
              );

              const listings = await tx.productListing.findMany({
                where: { productId: item.productId! },
                include: {
                  marketplaceAccount: { select: { platform: true } },
                },
              });
              for (const listing of listings) {
                await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"stock_sync_job:" + listing.id}))`;
                await tx.stockSyncJob.upsert({
                  where: {
                    listingId_status: {
                      listingId: listing.id,
                      status: "PENDING",
                    },
                  },
                  create: {
                    productId: item.productId!,
                    listingId: listing.id,
                    platform: listing.marketplaceAccount.platform,
                    targetStock: newStock,
                    orderId: order.id,
                    status: "PENDING",
                  },
                  update: {
                    targetStock: newStock,
                    attempts: 0,
                    nextRunAt: new Date(),
                    lastError: null,
                    orderId: order.id,
                  },
                });
              }
            }
          },
          { timeout: 60_000, maxWait: 20_000 },
        );
        applied++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          `[rededuct-safe] FALHA order=${order.externalOrderId}: ${message.slice(0, 200)}`,
        );
        failures.push({
          order: order.externalOrderId ?? order.id,
          error: message.slice(0, 500),
        });
        failed++;
      }
    }
  }

  console.log(`\n========== RESUMO REDEDUCT-SAFE ==========`);
  console.log(`Modo:                          ${isDry ? "DRY-RUN" : "APLICADO"}`);
  console.log(`Pedidos no período:            ${orders.length}`);
  console.log(`(a) já tem reason exato:       ${skippedExact.length}`);
  console.log(`(b) já tem baixa próxima:      ${skippedNear.length}`);
  console.log(`(c) candidatos órfãos:         ${truly.length}`);
  if (!isDry) {
    console.log(`    aplicados com sucesso:     ${applied}`);
    console.log(`    falhas:                    ${failed}`);
  }
  console.log(`==========================================\n`);

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = path.join(
    OUT_DIR,
    `rededuct-safe-${isDry ? "dryrun" : "apply"}-${ts}.json`,
  );
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        userId: flags.userId,
        days: flags.days,
        windowMin: flags.windowMin,
        apply: flags.apply,
        counts: {
          orders: orders.length,
          skippedExact: skippedExact.length,
          skippedNear: skippedNear.length,
          truly: truly.length,
          applied,
          failed,
        },
        trulyOrphans: truly.map((t) => ({
          order: t.order.externalOrderId ?? t.order.id,
          platform: t.order.marketplaceAccount.platform,
          accountName: t.order.marketplaceAccount.accountName,
          createdAt: t.order.createdAt.toISOString(),
          itemsCount: t.order.items.length,
          productIds: t.productIds,
        })),
        failures,
      },
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
