/**
 * Audit: sumário dos SystemLogs das últimas 24h
 *
 * Read-only. Útil para bater o olho na saúde geral do sistema:
 *  - contagem por level
 *  - contagem por action
 *  - top 20 erros por mensagem
 *  - contagem SYSTEM_ERROR (handler global)
 *  - contagem OVERSELL_DETECTED (risco que já ocorreu)
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

export async function auditSystemLogs(
  userId = DEFAULT_USER_ID,
): Promise<AuditOutcome> {
  const outcome = newOutcome("system-logs");
  section(`SYSTEM LOGS (24h) — user ${userId}`);

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const whereBase = { userId, createdAt: { gte: since } };

  const total = await prisma.systemLog.count({ where: whereBase });
  sub("total de logs nas últimas 24h", total);

  const byLevel = await prisma.systemLog.groupBy({
    by: ["level"],
    where: whereBase,
    _count: { _all: true },
  });
  sub("por level", byLevel.length);
  printTable(byLevel);

  const byAction = await prisma.systemLog.groupBy({
    by: ["action"],
    where: whereBase,
    _count: { _all: true },
    orderBy: { _count: { action: "desc" } },
    take: 25,
  });
  sub("top 25 actions", byAction.length);
  printTable(byAction);

  const errorCount = await prisma.systemLog.count({
    where: { ...whereBase, level: "ERROR" },
  });
  sub("erros nas últimas 24h", errorCount);

  const systemErrorCount = await prisma.systemLog.count({
    where: { ...whereBase, action: "SYSTEM_ERROR" },
  });
  sub("SYSTEM_ERROR nas últimas 24h", systemErrorCount);
  if (systemErrorCount > 0) {
    logFinding(
      outcome,
      `${systemErrorCount} SYSTEM_ERROR — revisar handler global do Fastify`,
    );
  }

  const oversellCount = await prisma.systemLog.count({
    where: { ...whereBase, action: "OVERSELL_DETECTED" },
  });
  sub("OVERSELL_DETECTED nas últimas 24h", oversellCount);
  if (oversellCount > 0) {
    logFinding(
      outcome,
      `${oversellCount} oversell(s) detectado(s) — cross-marketplace precisa de atenção`,
    );
  }

  const topErrors = await prisma.systemLog.findMany({
    where: { ...whereBase, level: "ERROR" },
    select: { action: true, message: true, createdAt: true },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  sub("últimos 20 erros", topErrors.length);
  if (topErrors.length > 0) {
    logFinding(outcome, `${topErrors.length} erro(s) recente(s) — inspecionar`);
    printTable(topErrors);
  }

  return outcome;
}

if (require.main === module) {
  withPrisma(() => auditSystemLogs())
    .then((o) => process.exit(o.findings.length > 0 ? 1 : 0))
    .catch((err) => {
      console.error(err);
      process.exit(2);
    });
}
