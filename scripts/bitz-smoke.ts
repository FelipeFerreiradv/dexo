import "./lib/load-env";
import prisma from "../app/lib/prisma";
import { runTurn } from "../app/ai/agent/orchestrator";
import { scopeFromRequest } from "../app/ai/core/scope";

/** Persistência em memória: o smoke não escreve conversa na conta do cliente. */
function fakeDb() {
  const msgs: any[] = [];
  return {
    msgs,
    db: {
      aiConversation: {
        create: async ({ data }: any) => ({ id: "smoke", summary: null, ...data }),
        findFirst: async () => null,
        update: async () => ({}),
      },
      aiMessage: {
        create: async ({ data }: any) => (msgs.push(data), data),
        // Precisa devolver de VERDADE o que foi gravado: o orquestrador monta a
        // janela de contexto a partir daqui, e uma lista vazia manda ao Gemini
        // um pedido sem nenhuma mensagem (HTTP 400 "contents is not specified").
        findMany: async ({ orderBy }: any) => {
          const rows = msgs
            .filter((m) => m.role !== "tool")
            .map((m) => ({ role: m.role, content: m.content }));
          return orderBy?.createdAt === "desc" ? [...rows].reverse() : rows;
        },
      },
      providerDailyUsage: {
        findUnique: async () => null,
        create: async () => ({ count: 1 }),
        updateMany: async () => ({ count: 1 }),
        upsert: async () => ({ count: 1 }),
      },
    },
  };
}

async function main() {
  const email = process.argv.find((a) => a.startsWith("--email="))?.slice(8);
  const user = await prisma.user.findFirst({
    where: email ? { email } : { aiEnabledAt: { not: null } },
    select: { id: true, email: true, parentUserId: true, pagePermissions: true },
  });
  if (!user) throw new Error("nenhum usuário com Bitz liberado");
  const dataOwnerId = user.parentUserId ?? user.id;
  console.log(`[smoke] ator=${user.email} tenant=${dataOwnerId}`);
  console.log(`[smoke] provedor=${process.env.AI_PROVIDER} modelo=${process.env.AI_MODEL}\n`);

  const perguntas = process.argv.filter((a) => a.startsWith("--p=")).map((a) => a.slice(4));
  for (const pergunta of perguntas.length ? perguntas : ["Quantos produtos eu tenho cadastrados?"]) {
    const espiao = fakeDb();
    const eventos: string[] = [];
    const t0 = Date.now();
    const r = await runTurn({
      dataOwnerId,
      actorUserId: user.id,
      message: pergunta,
      db: espiao.db,
      scope: scopeFromRequest({ user: { ...user, dataOwnerId } } as any) ?? undefined,
      onEvent: (e) => {
        if (e.type === "consultando") eventos.push(`consultou: ${e.tools.join(", ")}`);
      },
    });
    const assistente = espiao.msgs.find((m: any) => m.role === "assistant");
    console.log("─".repeat(70));
    console.log(`PERGUNTA: ${pergunta}`);
    console.log(`degradado: ${r.degraded}${r.degraded ? `  ⚠️  motivo: ${assistente?.errorCode}` : ""}`);
    if (eventos.length) console.log(eventos.map((e) => `  ${e}`).join("\n"));
    console.log(`tokens: ${r.usage.inputTokens} in / ${r.usage.outputTokens} out · ${Date.now() - t0}ms`);
    if (r.sources.length) console.log(`fontes: ${JSON.stringify(r.sources)}`);
    console.log(`\n${r.content}\n`);
  }
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
