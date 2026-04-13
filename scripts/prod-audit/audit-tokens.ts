/**
 * Audit: tokens de marketplace
 *
 * Read-only. Para cada MarketplaceAccount do usuário:
 *  - status da conta
 *  - expiresAt (quanto falta para expirar)
 *  - updatedAt (última vez que refresh rolou)
 *  - falhas recentes de auth nos SystemLogs
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

export async function auditTokens(
  userId = DEFAULT_USER_ID,
): Promise<AuditOutcome> {
  const outcome = newOutcome("tokens");
  section(`MARKETPLACE TOKENS — user ${userId}`);

  const accounts = await prisma.marketplaceAccount.findMany({
    where: { userId },
    select: {
      id: true,
      platform: true,
      accountName: true,
      status: true,
      expiresAt: true,
      updatedAt: true,
      externalUserId: true,
      shopId: true,
    },
    orderBy: { platform: "asc" },
  });

  sub("total de contas", accounts.length);
  if (accounts.length === 0) {
    logFinding(outcome, "nenhuma conta de marketplace cadastrada");
    return outcome;
  }

  const now = Date.now();
  const summary = accounts.map((a) => {
    const msToExp = a.expiresAt.getTime() - now;
    const hoursToExp = Math.round(msToExp / (60 * 60 * 1000));
    return {
      id: a.id,
      platform: a.platform,
      accountName: a.accountName,
      status: a.status,
      hoursToExp,
      lastUpdate: a.updatedAt.toISOString(),
      externalUserId: a.externalUserId,
      shopId: a.shopId,
    };
  });
  printTable(summary);

  const expired = summary.filter((s) => s.hoursToExp <= 0);
  if (expired.length > 0) {
    logFinding(
      outcome,
      `${expired.length} conta(s) com token expirado — refresh deve rodar no próximo uso`,
    );
  }

  const expiringSoon = summary.filter(
    (s) => s.hoursToExp > 0 && s.hoursToExp < 24,
  );
  if (expiringSoon.length > 0) {
    logFinding(
      outcome,
      `${expiringSoon.length} conta(s) expirando em menos de 24h`,
    );
  }

  const inactive = summary.filter((s) => s.status !== "ACTIVE");
  if (inactive.length > 0) {
    logFinding(
      outcome,
      `${inactive.length} conta(s) com status diferente de ACTIVE`,
    );
  }

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const authErrors = await prisma.systemLog.findMany({
    where: {
      userId,
      level: "ERROR",
      createdAt: { gte: sevenDaysAgo },
      OR: [
        { action: "CONNECT_MARKETPLACE" },
        { action: { contains: "TOKEN" } },
        { action: { contains: "AUTH" } },
        { message: { contains: "token" } },
        { message: { contains: "401" } },
        { message: { contains: "unauthorized", mode: "insensitive" } },
      ],
    },
    select: {
      id: true,
      action: true,
      message: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  sub("erros de auth nos últimos 7 dias", authErrors.length);
  if (authErrors.length > 0) {
    logFinding(
      outcome,
      `${authErrors.length} erro(s) de auth nos SystemLogs recentes`,
    );
    printTable(authErrors);
  }

  return outcome;
}

if (require.main === module) {
  withPrisma(() => auditTokens())
    .then((o) => process.exit(o.findings.length > 0 ? 1 : 0))
    .catch((err) => {
      console.error(err);
      process.exit(2);
    });
}
