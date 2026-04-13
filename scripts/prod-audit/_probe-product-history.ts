import { prisma, withPrisma } from "./shared";

const TARGETS: Array<{ orderId: string; productId: string; externalOrderId: string }> = [
  { orderId: "cmn9bc7a800dh18opdgtyjrru", productId: "cmnclaqkd04lxvs1caf57g8cx", externalOrderId: "2000015725604248" },
  { orderId: "cmncl1pup002h186xk98qg6jj", productId: "cmnclac7k01l2vs1csyc4u9c3", externalOrderId: "2000015756466188" },
  { orderId: "cmncl1tz7002n186xeg6algay", productId: "cmnclaul3059mvs1c4widrdkd", externalOrderId: "2000015754570522" },
  { orderId: "cmncl2esf003h186xten3pbm2", productId: "cmnclamec03q7vs1c0g6q8305", externalOrderId: "2000015750408588" },
];

async function probe() {
  for (const t of TARGETS) {
    console.log(`\n=== Order ${t.externalOrderId} — product ${t.productId} ===`);

    const product = await prisma.product.findUnique({
      where: { id: t.productId },
      select: { id: true, name: true, sku: true, stock: true, createdAt: true, updatedAt: true },
    });
    if (!product) {
      console.log("  ❌ product not found");
      continue;
    }
    console.log(`  name:       ${product.name}`);
    console.log(`  sku:        ${product.sku}`);
    console.log(`  stock:      ${product.stock}`);
    console.log(`  createdAt:  ${product.createdAt.toISOString()}`);
    console.log(`  updatedAt:  ${product.updatedAt.toISOString()}`);

    const order = await prisma.order.findUnique({
      where: { id: t.orderId },
      select: { createdAt: true, updatedAt: true, status: true },
    });
    console.log(`  order.createdAt: ${order?.createdAt.toISOString()}  updatedAt: ${order?.updatedAt.toISOString()}  status: ${order?.status}`);

    const allLogs = await prisma.stockLog.findMany({
      where: { productId: t.productId },
      select: { id: true, change: true, previousStock: true, newStock: true, reason: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });
    console.log(`  total StockLogs: ${allLogs.length}`);
    for (const l of allLogs) {
      console.log(
        `    · ${l.createdAt.toISOString()} change=${l.change} ${l.previousStock}→${l.newStock} "${l.reason}"`,
      );
    }

    // other orders referencing same product
    const otherOrders = await prisma.orderItem.findMany({
      where: { productId: t.productId },
      select: {
        order: {
          select: {
            id: true,
            externalOrderId: true,
            status: true,
            createdAt: true,
            marketplaceAccount: { select: { platform: true } },
          },
        },
        quantity: true,
        listingId: true,
      },
    });
    console.log(`  outros OrderItems desse product: ${otherOrders.length}`);
    for (const oi of otherOrders) {
      console.log(
        `    · ${oi.order.createdAt.toISOString()} ${oi.order.marketplaceAccount.platform} ${oi.order.status} ext=${oi.order.externalOrderId} qty=${oi.quantity} listing=${oi.listingId ?? "null"}`,
      );
    }
  }
}

withPrisma(probe)
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
