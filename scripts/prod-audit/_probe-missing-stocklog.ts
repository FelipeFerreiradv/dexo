/**
 * Probe ad-hoc: pega 3 pedidos PAID/SHIPPED/DELIVERED que o audit marcou como
 * "sem StockLog" e verifica se existem StockLogs correlacionados por
 * externalOrderId (ML) ou por productId+timestamp (Shopee).
 *
 * Read-only.
 */
import { DEFAULT_USER_ID, prisma, withPrisma } from "./shared";

async function main() {
  const userId = DEFAULT_USER_ID;

  const paid = await prisma.order.findMany({
    where: {
      marketplaceAccount: { userId },
      status: { in: ["PAID", "SHIPPED", "DELIVERED"] as any },
      items: { some: {} },
    },
    select: {
      id: true,
      externalOrderId: true,
      status: true,
      createdAt: true,
      marketplaceAccount: { select: { platform: true, accountName: true } },
      items: { select: { productId: true, quantity: true } },
    },
    take: 200,
  });

  const orphans: typeof paid = [];
  for (const o of paid) {
    const byInternalId = await prisma.stockLog.findFirst({
      where: {
        productId: { in: o.items.map((i) => i.productId) },
        reason: { contains: o.id },
      },
      select: { id: true },
    });
    if (!byInternalId) orphans.push(o);
  }

  console.log(`\n[probe] total PAID amostrados: ${paid.length}`);
  console.log(`[probe] orfaos pela heuristica antiga: ${orphans.length}\n`);

  const samples = orphans.slice(0, 5);
  for (const o of samples) {
    console.log("=".repeat(70));
    console.log(
      `order=${o.id} ext=${o.externalOrderId} status=${o.status} plat=${o.marketplaceAccount.platform} acct=${o.marketplaceAccount.accountName}`,
    );
    console.log(`createdAt=${o.createdAt.toISOString()} items=${o.items.length}`);

    const byExternal = await prisma.stockLog.findMany({
      where: {
        productId: { in: o.items.map((i) => i.productId) },
        reason: { contains: o.externalOrderId },
      },
      select: {
        id: true,
        productId: true,
        change: true,
        reason: true,
        createdAt: true,
      },
      take: 10,
    });
    console.log(`  stocklogs by externalOrderId: ${byExternal.length}`);
    byExternal.forEach((l) =>
      console.log(
        `    - ${l.createdAt.toISOString()} prod=${l.productId} change=${l.change} reason="${l.reason}"`,
      ),
    );

    const windowStart = new Date(o.createdAt.getTime() - 10 * 60 * 1000);
    const windowEnd = new Date(o.createdAt.getTime() + 10 * 60 * 1000);
    const byWindow = await prisma.stockLog.findMany({
      where: {
        productId: { in: o.items.map((i) => i.productId) },
        createdAt: { gte: windowStart, lte: windowEnd },
      },
      select: {
        id: true,
        productId: true,
        change: true,
        reason: true,
        createdAt: true,
      },
      take: 10,
    });
    console.log(`  stocklogs em janela ±10min: ${byWindow.length}`);
    byWindow.forEach((l) =>
      console.log(
        `    - ${l.createdAt.toISOString()} prod=${l.productId} change=${l.change} reason="${l.reason}"`,
      ),
    );
  }
  console.log("=".repeat(70));
}

withPrisma(main).catch((e) => {
  console.error(e);
  process.exit(2);
});
