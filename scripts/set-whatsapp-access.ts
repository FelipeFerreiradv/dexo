import "dotenv/config";
import prisma from "../app/lib/prisma";

/**
 * Habilita/desabilita o módulo WhatsApp (plano pago superior) para um cliente.
 * O gate é a coluna User.whatsappEnabledAt (NULL = sem acesso; timestamp =
 * habilitado). Colaboradores herdam do admin pai automaticamente — habilite
 * sempre o usuário ADMIN (dono dos dados), nunca o colaborador.
 *
 * Idempotente: repetir --on mantém o timestamp original; repetir --off é no-op.
 * O backend cacheia o entitlement por 60s — mudanças valem em até 1 minuto.
 *
 * Uso (SEMPRE npx tsx — npm run engole flags):
 *   npx tsx scripts/set-whatsapp-access.ts --email=cliente@exemplo.com --on
 *   npx tsx scripts/set-whatsapp-access.ts --email=cliente@exemplo.com --off
 *
 * SQL equivalente (emergência):
 *   UPDATE "User" SET "whatsappEnabledAt" = NOW() WHERE email = '...';
 *   UPDATE "User" SET "whatsappEnabledAt" = NULL  WHERE email = '...';
 */

function parseArgs(argv: string[]): { email: string; enable: boolean } {
  const emailArg = argv.find((a) => a.startsWith("--email="));
  const on = argv.includes("--on");
  const off = argv.includes("--off");
  if (!emailArg || on === off) {
    throw new Error(
      "Uso: npx tsx scripts/set-whatsapp-access.ts --email=<email> --on|--off",
    );
  }
  return { email: emailArg.slice("--email=".length), enable: on };
}

async function main() {
  const { email, enable } = parseArgs(process.argv.slice(2));

  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      email: true,
      parentUserId: true,
      whatsappEnabledAt: true,
    },
  });
  if (!user) throw new Error(`Usuário não encontrado: ${email}`);
  if (user.parentUserId) {
    throw new Error(
      `${email} é COLABORADOR (parentUserId=${user.parentUserId}). ` +
        "Habilite o admin pai — colaboradores herdam o acesso automaticamente.",
    );
  }

  console.log(
    `Antes:  ${user.email} → whatsappEnabledAt = ${user.whatsappEnabledAt?.toISOString() ?? "NULL (sem acesso)"}`,
  );

  if (enable && user.whatsappEnabledAt) {
    console.log("Já habilitado — nada a fazer (idempotente).");
    return;
  }
  if (!enable && !user.whatsappEnabledAt) {
    console.log("Já desabilitado — nada a fazer (idempotente).");
    return;
  }

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { whatsappEnabledAt: enable ? new Date() : null },
    select: { whatsappEnabledAt: true },
  });
  console.log(
    `Depois: ${user.email} → whatsappEnabledAt = ${updated.whatsappEnabledAt?.toISOString() ?? "NULL (sem acesso)"}`,
  );
  console.log(
    enable
      ? "✅ WhatsApp HABILITADO (UI/rotas liberam em até 60s pelo cache)."
      : "✅ WhatsApp DESABILITADO (UI some e rotas negam em até 60s).",
  );
}

main()
  .catch((err) => {
    console.error(`❌ ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
