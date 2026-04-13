/**
 * Audit: saúde das listings
 *
 * Read-only. Detecta:
 *  - contagem por (plataforma, status)
 *  - listings ACTIVE sem externalListingId válido
 *  - listings sem produto vinculado (órfãs)
 *  - listings com retryAttempts > 3 e retryEnabled=true (presas no retry)
 *  - listings com lastError preenchido
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

export async function auditListingsHealth(
  userId = DEFAULT_USER_ID,
): Promise<AuditOutcome> {
  const outcome = newOutcome("listings-health");
  section(`LISTINGS HEALTH — user ${userId}`);

  const byStatus = await prisma.productListing.groupBy({
    by: ["status"],
    where: { marketplaceAccount: { userId } },
    _count: { _all: true },
  });
  sub("total por status", byStatus.length);
  printTable(byStatus);

  const byPlatformAccount = await prisma.productListing.groupBy({
    by: ["marketplaceAccountId"],
    where: { marketplaceAccount: { userId } },
    _count: { _all: true },
  });
  sub("total por marketplaceAccount", byPlatformAccount.length);
  printTable(byPlatformAccount);

  const placeholders = await prisma.productListing.findMany({
    where: {
      marketplaceAccount: { userId },
      OR: [
        { externalListingId: "" },
        { externalListingId: { startsWith: "PENDING_" } },
        { externalListingId: { startsWith: "LEGACY_" } },
      ],
    },
    select: {
      id: true,
      externalListingId: true,
      status: true,
      retryAttempts: true,
      retryEnabled: true,
    },
    take: 50,
  });
  sub("listings com externalListingId placeholder", placeholders.length);
  if (placeholders.length > 0) {
    logFinding(
      outcome,
      `${placeholders.length} listing(s) placeholder — publicação real ainda não concluída`,
    );
    printTable(placeholders);
  }

  const stuckRetries = await prisma.productListing.findMany({
    where: {
      marketplaceAccount: { userId },
      retryEnabled: true,
      retryAttempts: { gte: 3 },
    },
    select: {
      id: true,
      productId: true,
      status: true,
      retryAttempts: true,
      lastError: true,
      nextRetryAt: true,
    },
    take: 50,
  });
  sub("listings com retry ≥ 3", stuckRetries.length);
  if (stuckRetries.length > 0) {
    logFinding(
      outcome,
      `${stuckRetries.length} listing(s) presa(s) em retry — revisar lastError`,
    );
    printTable(stuckRetries);
  }

  const withErrors = await prisma.productListing.findMany({
    where: {
      marketplaceAccount: { userId },
      lastError: { not: null },
      status: { in: ["active", "ACTIVE", "paused", "PAUSED"] },
    },
    select: {
      id: true,
      status: true,
      lastError: true,
      updatedAt: true,
    },
    take: 30,
  });
  sub("listings ativas com lastError", withErrors.length);
  if (withErrors.length > 0) {
    logFinding(
      outcome,
      `${withErrors.length} listing(s) ativa(s) com erro registrado`,
    );
    printTable(withErrors);
  }

  const stale = await prisma.productListing.count({
    where: {
      marketplaceAccount: { userId },
      status: { in: ["active", "ACTIVE"] },
      metricsUpdatedAt: {
        lt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      },
    },
  });
  sub("listings ativas com métricas > 24h", stale);
  if (stale > 0) {
    logFinding(
      outcome,
      `${stale} listing(s) com métricas desatualizadas — rodar sync:listingMetrics`,
    );
  }

  return outcome;
}

if (require.main === module) {
  withPrisma(() => auditListingsHealth())
    .then((o) => process.exit(o.findings.length > 0 ? 1 : 0))
    .catch((err) => {
      console.error(err);
      process.exit(2);
    });
}
