/**
 * Dump dos StockLog com aritmética inconsistente (previousStock + change ≠ newStock).
 */
import { prisma, withPrisma, DEFAULT_USER_ID } from "./shared";

async function probe() {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const rows = await prisma.stockLog.findMany({
    where: {
      product: { userId: DEFAULT_USER_ID },
      createdAt: { gte: thirtyDaysAgo },
    },
    select: {
      id: true,
      productId: true,
      change: true,
      previousStock: true,
      newStock: true,
      reason: true,
      createdAt: true,
      product: { select: { name: true, sku: true, stock: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  const bad = rows.filter(
    (r) => r.previousStock + r.change !== r.newStock,
  );
  console.log(`inconsistentes: ${bad.length} / total: ${rows.length}`);
  for (const r of bad) {
    console.log(
      `\n  · ${r.createdAt.toISOString()} id=${r.id}\n    product: ${r.product.name} [sku=${r.product.sku}] stockAtual=${r.product.stock}\n    prev=${r.previousStock} change=${r.change} new=${r.newStock}  (esperado=${r.previousStock + r.change})\n    reason: "${r.reason}"`,
    );

    // Busca logs adjacentes do mesmo produto (±5 min) para entender ordem
    const windowStart = new Date(r.createdAt.getTime() - 5 * 60 * 1000);
    const windowEnd = new Date(r.createdAt.getTime() + 5 * 60 * 1000);
    const neighbors = await prisma.stockLog.findMany({
      where: {
        productId: r.productId,
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
    if (neighbors.length > 1) {
      console.log("    vizinhos ±5min:");
      for (const n of neighbors) {
        const marker = n.id === r.id ? " ← ESTE" : "";
        console.log(
          `      ${n.createdAt.toISOString()} prev=${n.previousStock} change=${n.change} new=${n.newStock} "${n.reason}"${marker}`,
        );
      }
    }
  }
}

withPrisma(probe)
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
