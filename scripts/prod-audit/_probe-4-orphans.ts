/**
 * Probe focado: investiga os 4 pedidos órfãos que sobraram depois
 * da correção do heuristic em audit-orders-linkage.ts.
 *
 * Para cada orderId:
 *  - Order + items + marketplaceAccount
 *  - Para cada productId do pedido: Product atual (stock, updatedAt)
 *  - TODOS os StockLog do(s) productId(s) em janela ±30min do createdAt do pedido
 *  - Último StockLog daqueles productIds (qualquer data)
 *
 * Read-only.
 */
import { prisma, withPrisma } from "./shared";

const ORPHAN_IDS = [
  "cmn9bc7a800dh18opdgtyjrru",
  "cmncl1pup002h186xk98qg6jj",
  "cmncl1tz7002n186xeg6algay",
  "cmncl2esf003h186xten3pbm2",
];

async function main() {
  for (const orderId of ORPHAN_IDS) {
    console.log("=".repeat(74));
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        externalOrderId: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        marketplaceAccount: {
          select: { platform: true, accountName: true, status: true },
        },
        items: {
          select: {
            id: true,
            productId: true,
            listingId: true,
            quantity: true,
          },
        },
      },
    });

    if (!order) {
      console.log(`order=${orderId} NAO ENCONTRADO`);
      continue;
    }

    console.log(
      `order=${order.id} ext=${order.externalOrderId} status=${order.status}`,
    );
    console.log(
      `plat=${order.marketplaceAccount.platform} acct=${order.marketplaceAccount.accountName} accStatus=${order.marketplaceAccount.status}`,
    );
    console.log(
      `createdAt=${order.createdAt.toISOString()} updatedAt=${order.updatedAt.toISOString()}`,
    );
    console.log(`items=${order.items.length}`);
    for (const it of order.items) {
      console.log(
        `  item=${it.id} prod=${it.productId} listing=${it.listingId ?? "(null)"} qty=${it.quantity}`,
      );
    }

    if (order.items.length === 0) {
      console.log("  (sem items, pular)");
      continue;
    }

    const productIds = order.items.map((i) => i.productId);

    const products = await prisma.product.findMany({
      where: { id: { in: productIds } },
      select: {
        id: true,
        sku: true,
        stock: true,
        updatedAt: true,
      },
    });
    console.log(`  products encontrados: ${products.length}/${productIds.length}`);
    for (const p of products) {
      console.log(
        `    prod=${p.id} sku=${p.sku} stock=${p.stock} updatedAt=${p.updatedAt.toISOString()}`,
      );
    }
    const missingProd = productIds.filter(
      (id) => !products.some((p) => p.id === id),
    );
    if (missingProd.length > 0) {
      console.log(`    !! produtos referenciados mas inexistentes: ${missingProd.join(", ")}`);
    }

    const windowStart = new Date(order.createdAt.getTime() - 30 * 60 * 1000);
    const windowEnd = new Date(order.createdAt.getTime() + 30 * 60 * 1000);
    const logsInWindow = await prisma.stockLog.findMany({
      where: {
        productId: { in: productIds },
        createdAt: { gte: windowStart, lte: windowEnd },
      },
      select: {
        id: true,
        productId: true,
        change: true,
        reason: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    });
    console.log(`  StockLogs janela ±30min: ${logsInWindow.length}`);
    logsInWindow.forEach((l) =>
      console.log(
        `    - ${l.createdAt.toISOString()} prod=${l.productId} change=${l.change} reason="${l.reason}"`,
      ),
    );

    const lastLogs = await prisma.stockLog.findMany({
      where: { productId: { in: productIds } },
      select: {
        id: true,
        productId: true,
        change: true,
        reason: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
      take: 5,
    });
    console.log(`  últimos 5 StockLog (qualquer data) desses produtos:`);
    lastLogs.forEach((l) =>
      console.log(
        `    - ${l.createdAt.toISOString()} prod=${l.productId} change=${l.change} reason="${l.reason}"`,
      ),
    );

    const syncJobs = await prisma.stockSyncJob.findMany({
      where: { productId: { in: productIds } },
      select: {
        id: true,
        productId: true,
        status: true,
        attempts: true,
        lastError: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: "desc" },
      take: 5,
    });
    console.log(`  últimos 5 StockSyncJob desses produtos:`);
    syncJobs.forEach((j) =>
      console.log(
        `    - ${j.createdAt.toISOString()} prod=${j.productId} status=${j.status} attempts=${j.attempts} lastError=${j.lastError ?? "-"}`,
      ),
    );
  }
  console.log("=".repeat(74));
}

withPrisma(main).catch((e) => {
  console.error(e);
  process.exit(2);
});
