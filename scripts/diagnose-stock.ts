/**
 * diagnose-stock.ts
 *
 * Script de diagnóstico para verificar o estado de estoque de produtos
 * específicos: estoque local, StockLogs, pedidos vinculados, e StockSyncJobs.
 *
 * Uso:
 *   npx tsx scripts/diagnose-stock.ts <sku1> <sku2> ...
 *
 * Exemplo:
 *   npx tsx scripts/diagnose-stock.ts 26837 21632 3005485 100647
 */

import prisma from "../app/lib/prisma";

const skus = process.argv.slice(2);

if (skus.length === 0) {
  console.error("Uso: npx tsx scripts/diagnose-stock.ts <sku1> <sku2> ...");
  process.exit(1);
}

async function run() {
  for (const sku of skus) {
    console.log(`\n${"=".repeat(80)}`);
    console.log(`SKU: ${sku}`);
    console.log("=".repeat(80));

    // 1. Buscar produto
    const product = await prisma.product.findFirst({
      where: { sku },
      include: {
        listings: {
          include: {
            marketplaceAccount: {
              select: { id: true, platform: true, accountName: true },
            },
          },
        },
      },
    });

    if (!product) {
      console.log(`  [PRODUTO] NÃO ENCONTRADO`);
      continue;
    }

    console.log(`  [PRODUTO] id=${product.id}`);
    console.log(`  [PRODUTO] nome="${product.name}"`);
    console.log(`  [PRODUTO] estoque atual=${product.stock}`);

    // 2. Listar listings vinculados + último STOCK_UPDATE por listing
    console.log(`  [LISTINGS] ${product.listings.length} listing(s):`);
    for (const listing of product.listings) {
      const ext = listing.externalListingId;
      console.log(
        `    - ${listing.marketplaceAccount.platform} "${listing.marketplaceAccount.accountName}" | listingId=${ext} | id=${listing.id}`,
      );

      const lastSync = await prisma.syncLog.findFirst({
        where: {
          marketplaceAccountId: listing.marketplaceAccount.id,
          type: "STOCK_UPDATE",
          payload: { path: ["externalListingId"], equals: ext },
        },
        orderBy: { createdAt: "desc" },
      });

      if (lastSync) {
        const p = (lastSync.payload ?? {}) as Record<string, unknown>;
        console.log(
          `        ↳ último STOCK_UPDATE: ${lastSync.createdAt.toISOString()} | status=${lastSync.status} | previous=${p.previousStock ?? "?"} → desired=${p.desiredStock ?? p.newStock ?? "?"} | msg="${lastSync.message ?? ""}"`,
        );
      } else {
        console.log(
          `        ↳ ⚠ NENHUM STOCK_UPDATE registrado para este listing`,
        );
      }
    }

    // 3. Buscar StockLogs
    const stockLogs = await prisma.stockLog.findMany({
      where: { productId: product.id },
      orderBy: { createdAt: "desc" },
      take: 20,
    });

    console.log(`  [STOCK_LOGS] ${stockLogs.length} entrada(s) recentes:`);
    for (const log of stockLogs) {
      console.log(
        `    ${log.createdAt.toISOString()} | ${log.previousStock} → ${log.newStock} (change=${log.change}) | reason="${log.reason}"`,
      );
    }

    // 4. Buscar pedidos que contêm este produto
    const orderItems = await prisma.orderItem.findMany({
      where: { productId: product.id },
      include: {
        order: {
          include: {
            marketplaceAccount: {
              select: { platform: true, accountName: true },
            },
          },
        },
      },
      orderBy: { order: { createdAt: "desc" } },
      take: 20,
    });

    console.log(`  [PEDIDOS] ${orderItems.length} pedido(s) com este produto:`);
    for (const item of orderItems) {
      console.log(
        `    ${item.order.createdAt.toISOString()} | extOrderId=${item.order.externalOrderId} | qty=${item.quantity} | status=${item.order.status} | ${item.order.marketplaceAccount.platform} "${item.order.marketplaceAccount.accountName}"`,
      );
    }

    // 5. Verificar StockSyncJobs pendentes
    const syncJobs = await prisma.stockSyncJob.findMany({
      where: {
        productId: product.id,
      },
      orderBy: { createdAt: "desc" },
      take: 10,
    });

    console.log(`  [SYNC_JOBS] ${syncJobs.length} job(s):`);
    for (const job of syncJobs) {
      console.log(
        `    status=${job.status} | targetStock=${job.targetStock} | listingId=${job.listingId} | attempts=${job.attempts} | created=${job.createdAt.toISOString()}`,
      );
    }

    // 6. Calcular estoque esperado
    // Estoque esperado = soma de todos os StockLogs (último newStock se existir)
    // vs total de vendas (pedidos PAID)
    const totalSold = orderItems.reduce((sum, item) => sum + item.quantity, 0);
    const totalDeducted = stockLogs
      .filter((l) => l.change < 0)
      .reduce((sum, l) => sum + Math.abs(l.change), 0);

    console.log(`  [ANÁLISE]`);
    console.log(`    Total vendido (pedidos): ${totalSold}`);
    console.log(`    Total descontado (StockLogs negativos): ${totalDeducted}`);
    console.log(`    Diferença (vendas sem desconto): ${totalSold - totalDeducted}`);
    if (totalSold > totalDeducted) {
      console.log(`    ⚠ ESTOQUE PODE ESTAR INFLADO em ${totalSold - totalDeducted} unidade(s)`);
    } else if (totalDeducted > totalSold) {
      console.log(`    ⚠ ESTOQUE PODE ESTAR DEFLADO (double deduction?) em ${totalDeducted - totalSold} unidade(s)`);
    } else {
      console.log(`    ✓ Vendas e descontos batem`);
    }
  }
}

run()
  .catch((err) => {
    console.error("[diagnose-stock] Erro fatal:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
