/**
 * Audit: vínculo de pedidos ↔ listings ↔ estoque
 *
 * Read-only. Detecta:
 *  - OrderItem sem listingId (legacy ou bug de vínculo)
 *  - OrderItem apontando para productId inexistente (não deveria: FK)
 *  - Pedidos com status inconsistente (ex. PAID sem itens)
 *  - Pedidos pagos/entregues sem StockLog correspondente ao orderId
 *  - Duplicidade de (marketplaceAccountId, externalOrderId) — já é @@unique
 */
import {
  DEFAULT_USER_ID,
  prisma,
  section,
  sub,
  printTable,
  newOutcome,
  logFinding,
  withPrisma,
  type AuditOutcome,
} from "./shared";

export async function auditOrdersLinkage(
  userId = DEFAULT_USER_ID,
): Promise<AuditOutcome> {
  const outcome = newOutcome("orders-linkage");
  section(`ORDERS LINKAGE — user ${userId}`);

  const byStatus = await prisma.order.groupBy({
    by: ["status"],
    where: { marketplaceAccount: { userId } },
    _count: { _all: true },
  });
  sub("pedidos por status", byStatus.length);
  printTable(byStatus);

  const itemsWithoutListing = await prisma.orderItem.findMany({
    where: {
      order: { marketplaceAccount: { userId } },
      listingId: null,
    },
    select: {
      id: true,
      orderId: true,
      productId: true,
      quantity: true,
    },
    take: 50,
  });
  sub("OrderItem sem listingId", itemsWithoutListing.length);
  if (itemsWithoutListing.length > 0) {
    logFinding(
      outcome,
      `${itemsWithoutListing.length} OrderItem(s) sem listingId — fallback legacy ou bug de vínculo`,
    );
    printTable(itemsWithoutListing);
  }

  const emptyOrders = await prisma.order.findMany({
    where: {
      marketplaceAccount: { userId },
      items: { none: {} },
    },
    select: {
      id: true,
      externalOrderId: true,
      status: true,
      createdAt: true,
    },
    take: 30,
  });
  sub("pedidos sem itens", emptyOrders.length);
  if (emptyOrders.length > 0) {
    logFinding(
      outcome,
      `${emptyOrders.length} pedido(s) sem OrderItem — import parcial ou corrompido`,
    );
    printTable(emptyOrders);
  }

  const paidStatuses = ["PAID", "SHIPPED", "DELIVERED"];
  const paidOrders = await prisma.order.findMany({
    where: {
      marketplaceAccount: { userId },
      status: { in: paidStatuses as any },
    },
    select: {
      id: true,
      externalOrderId: true,
      status: true,
      createdAt: true,
      items: {
        select: { productId: true, quantity: true },
      },
    },
    take: 200,
  });
  sub("pedidos PAID/SHIPPED/DELIVERED amostrados", paidOrders.length);

  // Reasons reais gravados em [app/marketplaces/usecases/order.usercase.ts]:
  //   ML     → `Venda ML #${externalOrderId}`
  //   Shopee → "Importação Shopee" (sem id — correlaciona por janela temporal)
  // Por isso: buscar por externalOrderId primeiro, e cair pra janela ±5min
  // em cima do createdAt do pedido quando o reason for genérico.
  let missingStockLog = 0;
  const samplesMissing: Array<Record<string, unknown>> = [];
  for (const order of paidOrders) {
    if (order.items.length === 0) continue;
    const productIds = order.items.map((i) => i.productId);

    const byExternal = await prisma.stockLog.findFirst({
      where: {
        productId: { in: productIds },
        reason: { contains: order.externalOrderId },
      },
      select: { id: true },
    });
    if (byExternal) continue;

    const windowStart = new Date(order.createdAt.getTime() - 5 * 60 * 1000);
    const windowEnd = new Date(order.createdAt.getTime() + 5 * 60 * 1000);
    // change <= 0 cobre dedução normal (change < 0) e oversell clampado
    // a 0 (change=0 quando previousStock já era 0). Oversell é registrado
    // em SystemLog separado, então aceitar change=0 aqui não mascara bug.
    const byWindow = await prisma.stockLog.findFirst({
      where: {
        productId: { in: productIds },
        createdAt: { gte: windowStart, lte: windowEnd },
        change: { lte: 0 },
      },
      select: { id: true },
    });
    if (byWindow) continue;

    missingStockLog++;
    if (samplesMissing.length < 20) {
      samplesMissing.push({
        orderId: order.id,
        externalOrderId: order.externalOrderId,
        status: order.status,
        items: order.items.length,
      });
    }
  }
  sub(
    "pedidos pagos sem StockLog correlacionado (por externalOrderId ou janela)",
    missingStockLog,
  );
  if (missingStockLog > 0) {
    logFinding(
      outcome,
      `${missingStockLog} pedido(s) pago(s) sem StockLog vinculado — dedução pode ter falhado`,
    );
    printTable(samplesMissing);
  }

  return outcome;
}

if (require.main === module) {
  withPrisma(() => auditOrdersLinkage())
    .then((o) => process.exit(o.findings.length > 0 ? 1 : 0))
    .catch((err) => {
      console.error(err);
      process.exit(2);
    });
}
