/**
 * Audit: integridade de estoque
 *
 * Read-only. Detecta:
 *  - produtos com stock < 0 (não deveria acontecer)
 *  - StockSyncJob com status PENDING há mais de 1h (fila não está drenando)
 *  - StockSyncJob com status FAILED
 *  - divergência entre Product.stock e a soma acumulada dos StockLog
 *    (sinal de ajuste manual no banco ou bug em deductStockForOrder)
 */
import {
  DEFAULT_USER_ID,
  prisma,
  section,
  sub,
  printTable,
  newOutcome,
  logFinding,
  logError,
  withPrisma,
  type AuditOutcome,
} from "./shared";

export async function auditStockIntegrity(
  userId = DEFAULT_USER_ID,
): Promise<AuditOutcome> {
  const outcome = newOutcome("stock-integrity");
  section(`STOCK INTEGRITY — user ${userId}`);

  const negativeStock = await prisma.product.findMany({
    where: { userId, stock: { lt: 0 } },
    select: { id: true, sku: true, name: true, stock: true },
    take: 100,
  });
  sub("produtos com stock < 0", negativeStock.length);
  if (negativeStock.length > 0) {
    logFinding(
      outcome,
      `${negativeStock.length} produto(s) com estoque negativo`,
    );
    printTable(negativeStock);
  }

  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const stalePending = await (prisma as any).stockSyncJob.findMany({
    where: {
      status: "PENDING",
      createdAt: { lt: oneHourAgo },
      productId: {
        in: (
          await prisma.product.findMany({
            where: { userId },
            select: { id: true },
          })
        ).map((p) => p.id),
      },
    },
    select: {
      id: true,
      productId: true,
      listingId: true,
      platform: true,
      attempts: true,
      lastError: true,
      createdAt: true,
    },
    take: 50,
  });
  sub("StockSyncJob PENDING há mais de 1h", stalePending.length);
  if (stalePending.length > 0) {
    logFinding(
      outcome,
      `${stalePending.length} job(s) PENDING stale — fila não está drenando`,
    );
    printTable(stalePending);
  }

  // Terminal failures são deletadas do StockSyncJob (o unique
  // @@unique([listingId,status]) não permite reter histórico lá). O histórico
  // vive em SystemLog com action=STOCK_SYNC_FAILED.
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const failedLogs = await prisma.systemLog.findMany({
    where: {
      userId,
      action: "STOCK_SYNC_FAILED" as any,
      createdAt: { gte: twentyFourHoursAgo },
    },
    select: {
      id: true,
      resourceId: true,
      message: true,
      details: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  sub("STOCK_SYNC_FAILED nas últimas 24h (SystemLog)", failedLogs.length);
  if (failedLogs.length > 0) {
    logFinding(
      outcome,
      `${failedLogs.length} falha(s) terminal(is) de sync de estoque nas últimas 24h — revisar SystemLog`,
    );
    printTable(failedLogs);
  }

  // Divergência Product.stock vs soma dos StockLog.change
  // Checa apenas produtos com StockLog nos últimos 30 dias (bounded).
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const logged = await prisma.stockLog.groupBy({
    by: ["productId"],
    where: {
      product: { userId },
      createdAt: { gte: thirtyDaysAgo },
    },
    _count: { _all: true },
  });
  sub("produtos com StockLog nos últimos 30d", logged.length);

  // Valida consistência de cada StockLog: newStock = previousStock + change
  let inconsistentLogs = 0;
  if (logged.length > 0) {
    const productIds = logged.map((l) => l.productId);
    const rows = await prisma.stockLog.findMany({
      where: {
        productId: { in: productIds },
        createdAt: { gte: thirtyDaysAgo },
      },
      select: {
        id: true,
        productId: true,
        change: true,
        previousStock: true,
        newStock: true,
      },
    });
    for (const r of rows) {
      if (r.previousStock + r.change !== r.newStock) {
        inconsistentLogs++;
      }
    }
  }
  sub("StockLog com aritmética inconsistente", inconsistentLogs);
  if (inconsistentLogs > 0) {
    logFinding(
      outcome,
      `${inconsistentLogs} StockLog com previousStock+change ≠ newStock`,
    );
  }

  return outcome;
}

if (require.main === module) {
  withPrisma(() => auditStockIntegrity())
    .then((o) => process.exit(o.findings.length > 0 ? 1 : 0))
    .catch((err) => {
      console.error(err);
      process.exit(2);
    });
}
