/**
 * Compara formato de externalOrderId entre orders ML e Shopee para detectar
 * se os 4 pedidos "sem StockLog" estão marcados na plataforma errada.
 */
import { prisma, withPrisma } from "./shared";

async function probe() {
  const samples = await prisma.order.findMany({
    select: {
      id: true,
      externalOrderId: true,
      status: true,
      createdAt: true,
      marketplaceAccount: { select: { platform: true, accountName: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 40,
  });

  console.log("últimos 40 pedidos — platform × formato de externalOrderId:");
  for (const o of samples) {
    console.log(
      `  ${o.marketplaceAccount.platform.padEnd(14)} len=${o.externalOrderId.length} ${o.externalOrderId} ${o.status} (${o.marketplaceAccount.accountName})`,
    );
  }

  console.log("\ngroup by platform + length:");
  const byKey = new Map<string, number>();
  const all = await prisma.order.findMany({
    select: {
      externalOrderId: true,
      marketplaceAccount: { select: { platform: true } },
    },
  });
  for (const o of all) {
    const key = `${o.marketplaceAccount.platform}|len=${o.externalOrderId.length}`;
    byKey.set(key, (byKey.get(key) ?? 0) + 1);
  }
  for (const [k, v] of [...byKey.entries()].sort()) {
    console.log(`  ${k}: ${v}`);
  }
}

withPrisma(probe)
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
