/**
 * rededuct-stock.ts
 *
 * Script one-shot para re-processar desconto de estoque em pedidos que foram
 * importados mas cujo desconto falhou (ex: bug P2010 do pg_advisory_xact_lock).
 *
 * Identifica pedidos status=COMPLETED que NÃO possuem StockLog correspondente
 * e re-executa o desconto de estoque + criação de StockSyncJob.
 *
 * Uso:
 *   npx tsx scripts/rededuct-stock.ts [userId] [days]
 */

import prisma from "../app/lib/prisma";

const userId = process.argv[2] || null;
const days = parseInt(process.argv[3] ?? "14", 10);

async function run() {
  console.log(
    `[rededuct-stock] Buscando pedidos sem StockLog: userId=${userId ?? "ALL"}, days=${days}`,
  );

  const dateFrom = new Date();
  dateFrom.setDate(dateFrom.getDate() - days);

  // Busca pedidos com itens vinculados a produtos, criados no período
  const orders = await prisma.order.findMany({
    where: {
      createdAt: { gte: dateFrom },
      status: "COMPLETED",
      ...(userId
        ? { marketplaceAccount: { userId } }
        : {}),
    },
    include: {
      items: true,
      marketplaceAccount: {
        select: { id: true, platform: true, accountName: true },
      },
    },
  });

  console.log(`[rededuct-stock] ${orders.length} pedido(s) encontrado(s) no período.`);

  // Para cada pedido, verificar se já existe StockLog com reason correspondente
  let rededucted = 0;
  let skipped = 0;
  let errors = 0;

  for (const order of orders) {
    const reason = order.marketplaceAccount.platform === "MERCADO_LIVRE"
      ? `Venda ML #${order.externalOrderId}`
      : `Venda Shopee #${order.externalOrderId}`;

    // Verifica se já existe StockLog para este pedido
    const existingLog = await prisma.stockLog.findFirst({
      where: { reason },
    });

    if (existingLog) {
      skipped++;
      continue;
    }

    // Filtrar apenas itens que têm productId
    const itemsWithProduct = order.items.filter((i) => i.productId);
    if (itemsWithProduct.length === 0) {
      skipped++;
      continue;
    }

    console.log(
      `[rededuct-stock] Re-processando pedido ${order.externalOrderId} (${order.marketplaceAccount.platform} "${order.marketplaceAccount.accountName}")...`,
    );

    try {
      await prisma.$transaction(async (tx) => {
        for (const item of itemsWithProduct) {
          const locked = await tx.$queryRaw<
            { id: string; name: string; stock: number }[]
          >`SELECT id, name, stock FROM "Product" WHERE id = ${item.productId} FOR UPDATE`;

          const product = locked[0];
          if (!product) continue;

          const previousStock = product.stock;
          const decrementBy = Math.min(item.quantity, Math.max(0, previousStock));
          const newStock = previousStock - decrementBy;

          await tx.product.update({
            where: { id: item.productId },
            data: { stock: newStock },
          });

          await tx.stockLog.create({
            data: {
              productId: item.productId,
              change: -decrementBy,
              reason,
              previousStock,
              newStock,
            },
          });

          console.log(
            `  [stock] ${product.name}: ${previousStock} → ${newStock} (qty=${item.quantity})`,
          );

          // Criar StockSyncJob para cada listing vinculado
          const listings = await tx.productListing.findMany({
            where: { productId: item.productId },
            include: { marketplaceAccount: { select: { platform: true } } },
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
                productId: item.productId,
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
      });

      rededucted++;
    } catch (err) {
      console.error(`[rededuct-stock] ERRO no pedido ${order.externalOrderId}:`, err);
      errors++;
    }
  }

  console.log(`\n[rededuct-stock] === RESUMO ===`);
  console.log(`  Pedidos re-processados: ${rededucted}`);
  console.log(`  Pedidos já com estoque descontado: ${skipped}`);
  console.log(`  Erros: ${errors}`);
  console.log(
    `  StockSyncJobs pendentes serão processados pelo StockSyncRetryService (intervalo 30s).`,
  );
}

run()
  .catch((err) => {
    console.error("[rededuct-stock] Erro fatal:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
