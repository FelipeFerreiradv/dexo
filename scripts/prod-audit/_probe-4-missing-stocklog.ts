/**
 * Probe: os 4 pedidos PAID reportados pelo audit como "sem StockLog".
 * Objetivo: confirmar se houve dedução real (em qualquer formato de reason) ou
 * se o estoque realmente escapou.
 *
 * Para cada pedido:
 *  - carrega Order + items + produto atual
 *  - procura StockLog por productId em janela de ±24h
 *  - procura StockLog por reason contendo o externalOrderId
 *  - procura StockSyncJob enfileirado com reference contendo o externalOrderId
 *  - procura SystemLog (STOCK_SYNC_FAILED / OVERSELL_DETECTED) do mesmo período
 */
import { prisma, withPrisma } from "./shared";

const TARGET_ORDER_IDS = [
  "cmn9bc7a800dh18opdgtyjrru",
  "cmncl1pup002h186xk98qg6jj",
  "cmncl1tz7002n186xeg6algay",
  "cmncl2esf003h186xten3pbm2",
];

async function probe() {
  for (const orderId of TARGET_ORDER_IDS) {
    console.log("\n=====================================================");
    console.log(`ORDER ${orderId}`);
    console.log("=====================================================");

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: {
          include: {
            product: {
              select: { id: true, name: true, sku: true, stock: true },
            },
            listing: {
              select: {
                id: true,
                externalListingId: true,
                marketplaceAccount: { select: { platform: true } },
              },
            },
          },
        },
        marketplaceAccount: {
          select: { platform: true, accountName: true, userId: true },
        },
      },
    });

    if (!order) {
      console.log("  ❌ pedido não encontrado");
      continue;
    }

    console.log(`  externalOrderId: ${order.externalOrderId}`);
    console.log(`  status:          ${order.status}`);
    console.log(`  platform:        ${order.marketplaceAccount.platform}`);
    console.log(`  account:         ${order.marketplaceAccount.accountName}`);
    console.log(`  createdAt:       ${order.createdAt.toISOString()}`);
    console.log(`  items:           ${order.items.length}`);

    for (const item of order.items) {
      console.log(`\n  → item ${item.id}`);
      console.log(`    productId:   ${item.productId}`);
      console.log(`    product:     ${item.product?.name ?? "(null)"} [sku=${item.product?.sku ?? "-"}]`);
      console.log(`    stockAtual:  ${item.product?.stock ?? "(null)"}`);
      console.log(`    quantity:    ${item.quantity}`);
      console.log(`    listingId:   ${item.listingId ?? "(null)"}`);
      if (item.listing) {
        console.log(`    listingExt:  ${item.listing.externalListingId} (${item.listing.marketplaceAccount.platform})`);
      }

      // 1) StockLog por reason contendo externalOrderId
      const byExternal = await prisma.stockLog.findMany({
        where: {
          productId: item.productId,
          reason: { contains: order.externalOrderId },
        },
        select: {
          id: true,
          change: true,
          previousStock: true,
          newStock: true,
          reason: true,
          createdAt: true,
        },
      });

      // 2) StockLog em janela ±24h
      const windowStart = new Date(order.createdAt.getTime() - 24 * 60 * 60 * 1000);
      const windowEnd = new Date(order.createdAt.getTime() + 24 * 60 * 60 * 1000);
      const byWindow = await prisma.stockLog.findMany({
        where: {
          productId: item.productId,
          createdAt: { gte: windowStart, lte: windowEnd },
        },
        select: {
          id: true,
          change: true,
          previousStock: true,
          newStock: true,
          reason: true,
          createdAt: true,
        },
        orderBy: { createdAt: "asc" },
      });

      // 3) StockSyncJob pertinente
      const jobs = await prisma.stockSyncJob.findMany({
        where: {
          productId: item.productId,
          createdAt: { gte: windowStart, lte: windowEnd },
        },
        select: {
          id: true,
          status: true,
          attempts: true,
          lastError: true,
          platform: true,
          listingId: true,
          targetStock: true,
          orderId: true,
          createdAt: true,
        },
        orderBy: { createdAt: "asc" },
      });

      // 4) SystemLog de erros no período
      const systemLogs = await prisma.systemLog.findMany({
        where: {
          userId: order.marketplaceAccount.userId,
          createdAt: { gte: windowStart, lte: windowEnd },
          OR: [
            { action: "STOCK_SYNC_FAILED" },
            { action: "OVERSELL_DETECTED" },
            { message: { contains: order.externalOrderId } },
          ],
        },
        select: {
          id: true,
          level: true,
          action: true,
          message: true,
          createdAt: true,
        },
      });

      console.log(`    StockLog (por externalOrderId): ${byExternal.length}`);
      for (const l of byExternal) {
        console.log(
          `      · ${l.createdAt.toISOString()} change=${l.change} ${l.previousStock}→${l.newStock} reason="${l.reason}"`,
        );
      }
      console.log(`    StockLog (janela ±24h): ${byWindow.length}`);
      for (const l of byWindow) {
        console.log(
          `      · ${l.createdAt.toISOString()} change=${l.change} ${l.previousStock}→${l.newStock} reason="${l.reason}"`,
        );
      }
      console.log(`    StockSyncJob (janela ±24h): ${jobs.length}`);
      for (const j of jobs) {
        console.log(
          `      · ${j.createdAt.toISOString()} ${j.platform} status=${j.status} attempts=${j.attempts} target=${j.targetStock} listing=${j.listingId} orderId=${j.orderId ?? "-"} err=${j.lastError ?? "-"}`,
        );
      }
      console.log(`    SystemLog erros (janela ±24h): ${systemLogs.length}`);
      for (const l of systemLogs) {
        console.log(
          `      · ${l.createdAt.toISOString()} [${l.level}] ${l.action}: ${l.message}`,
        );
      }
    }
  }
}

withPrisma(probe)
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
