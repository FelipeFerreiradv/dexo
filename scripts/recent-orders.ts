/**
 * recent-orders.ts
 *
 * Lista os pedidos mais recentes ingeridos no sistema, com filtro opcional
 * por accountName (substring, case-insensitive) e janela em minutos.
 *
 * Útil quando um pedido "saiu" num marketplace mas você não vê dedução
 * local — confirma se foi ingerido, em qual status, e quais itens/SKUs.
 *
 * Uso:
 *   npx tsx scripts/recent-orders.ts                     # últimos 60min, todas contas
 *   npx tsx scripts/recent-orders.ts --minutes 180
 *   npx tsx scripts/recent-orders.ts --account "1679461742"
 *   npx tsx scripts/recent-orders.ts --account Shopee --minutes 1440
 *   npx tsx scripts/recent-orders.ts --order 250418ABC123
 */

import prisma from "../app/lib/prisma";

function parseArgs() {
  const args = process.argv.slice(2);
  let minutes = 60;
  let account: string | null = null;
  let orderId: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--minutes" && args[i + 1]) {
      minutes = Number(args[++i]);
    } else if (args[i] === "--account" && args[i + 1]) {
      account = args[++i];
    } else if (args[i] === "--order" && args[i + 1]) {
      orderId = args[++i];
    }
  }
  return { minutes, account, orderId };
}

async function run() {
  const { minutes, account, orderId } = parseArgs();
  const since = new Date(Date.now() - minutes * 60 * 1000);

  const where: any = orderId
    ? { externalOrderId: { contains: orderId, mode: "insensitive" } }
    : { createdAt: { gte: since } };

  if (account && !orderId) {
    where.marketplaceAccount = {
      accountName: { contains: account, mode: "insensitive" },
    };
  }

  const orders = await prisma.order.findMany({
    where,
    include: {
      marketplaceAccount: {
        select: { platform: true, accountName: true },
      },
      items: {
        include: {
          product: { select: { sku: true, name: true, stock: true } },
          listing: {
            select: { externalListingId: true },
          },
        },
      },
    },
    orderBy: { createdAt: "desc" },
    take: 30,
  });

  console.log(
    `\n${orders.length} pedido(s) ${orderId ? `matching '${orderId}'` : `nos últimos ${minutes}min${account ? ` (account~'${account}')` : ""}`}:`,
  );
  console.log("=".repeat(100));

  for (const o of orders) {
    console.log(
      `\n[${o.createdAt.toISOString()}] ${o.marketplaceAccount.platform} "${o.marketplaceAccount.accountName}"`,
    );
    console.log(
      `  externalOrderId=${o.externalOrderId} | status=${o.status} | total=R$${o.totalAmount} | itens=${o.items.length}`,
    );
    for (const item of o.items) {
      // Buscar StockLog que referencie este pedido (best-effort — procura por externalOrderId na reason)
      const stockLog = await prisma.stockLog.findFirst({
        where: {
          productId: item.productId,
          reason: { contains: o.externalOrderId },
        },
        orderBy: { createdAt: "desc" },
      });
      const stockStatus = stockLog
        ? `descontado ${stockLog.previousStock}→${stockLog.newStock} em ${stockLog.createdAt.toISOString()}`
        : `⚠ SEM StockLog para este pedido`;
      console.log(
        `    - sku=${item.product?.sku ?? "?"} "${item.product?.name ?? "?"}" qty=${item.quantity} | estoque atual=${item.product?.stock ?? "?"} | listing=${item.listing?.externalListingId ?? "?"} | ${stockStatus}`,
      );
    }
  }

  if (orders.length === 0 && !orderId) {
    console.log(
      `\n⚠ Nenhum pedido ingerido na janela. Possibilidades:\n` +
        `  - O pedido ainda não foi sincronizado (sync-orders processa a cada intervalo)\n` +
        `  - Webhook não chegou\n` +
        `  - Ingestão falhou (check pm2 logs dexo-sync-orders)`,
    );
  }
}

run()
  .catch((err) => {
    console.error("[recent-orders] Erro fatal:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
