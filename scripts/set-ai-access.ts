import "./lib/load-env";
import prisma from "../app/lib/prisma";

/**
 * Habilita/desabilita o módulo Bitz (agente de IA, plano pago superior) para
 * um cliente. O gate é a coluna User.aiEnabledAt (NULL = sem acesso; timestamp
 * = habilitado). Colaboradores herdam do admin pai automaticamente — habilite
 * sempre o usuário ADMIN (dono dos dados), nunca o colaborador.
 *
 * Espelha scripts/set-whatsapp-access.ts linha a linha. A única diferença é o
 * `import "./lib/load-env"` na PRIMEIRA linha (em vez de "dotenv/config"): ele
 * sobe até 8 diretórios procurando o .env, que é o que faz o script funcionar
 * de dentro de um git worktree.
 *
 * Idempotente: repetir --on mantém o timestamp original; repetir --off é no-op.
 * O backend cacheia o entitlement por 60s — mudanças valem em até 1 minuto.
 *
 * Uso (SEMPRE npx tsx — npm run engole flags):
 *   npx tsx scripts/set-ai-access.ts --email=cliente@exemplo.com --on
 *   npx tsx scripts/set-ai-access.ts --email=cliente@exemplo.com --off
 *
 * ⚠️ A flag global NEXT_PUBLIC_AI_MODULE_ENABLED=true também precisa estar
 * ligada, senão o gate continua fechado para todo mundo (dupla camada). Como
 * é NEXT_PUBLIC_*, ligá-la exige REBUILD do front, não só restart.
 *
 * SQL equivalente (emergência):
 *   UPDATE "User" SET "aiEnabledAt" = NOW() WHERE email = '...';
 *   UPDATE "User" SET "aiEnabledAt" = NULL  WHERE email = '...';
 */

function parseArgs(argv: string[]): { email: string; enable: boolean } {
  const emailArg = argv.find((a) => a.startsWith("--email="));
  const on = argv.includes("--on");
  const off = argv.includes("--off");
  if (!emailArg || on === off) {
    throw new Error(
      "Uso: npx tsx scripts/set-ai-access.ts --email=<email> --on|--off",
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
      aiEnabledAt: true,
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
    `Antes:  ${user.email} → aiEnabledAt = ${user.aiEnabledAt?.toISOString() ?? "NULL (sem acesso)"}`,
  );

  if (enable && user.aiEnabledAt) {
    console.log("Já habilitado — nada a fazer (idempotente).");
    return;
  }
  if (!enable && !user.aiEnabledAt) {
    console.log("Já desabilitado — nada a fazer (idempotente).");
    return;
  }

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { aiEnabledAt: enable ? new Date() : null },
    select: { aiEnabledAt: true },
  });
  console.log(
    `Depois: ${user.email} → aiEnabledAt = ${updated.aiEnabledAt?.toISOString() ?? "NULL (sem acesso)"}`,
  );
  console.log(
    enable
      ? "✅ Bitz HABILITADO (UI/rotas liberam em até 60s pelo cache)."
      : "✅ Bitz DESABILITADO (UI some e rotas negam em até 60s).",
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
