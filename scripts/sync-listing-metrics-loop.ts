import prisma from "../app/lib/prisma";
import { syncAllListingsMetrics } from "./sync-listing-metrics";

const intervalMinutes = parseInt(process.env.SYNC_INTERVAL_MINUTES ?? "30", 10);

async function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runLoop() {
  console.log(`[loop] Iniciando loop de métricas. Intervalo: ${intervalMinutes} min`);
  while (true) {
    const started = new Date();
    console.log(`[loop] Sync iniciado às ${started.toISOString()}`);
    try {
      await syncAllListingsMetrics();
    } catch (err) {
      console.error(`[loop] Falha na execução do sync`, err);
    }
    await prisma.$disconnect();

    const elapsed = Date.now() - started.getTime();
    const nextWait = Math.max(intervalMinutes * 60 * 1000 - elapsed, 5000);
    console.log(`[loop] Sync concluído em ${elapsed} ms. Aguardando ${nextWait} ms para próxima execução.`);
    await wait(nextWait);
  }
}

runLoop().catch((err) => {
  console.error(`[loop] Erro fatal no loop`, err);
  process.exit(1);
});
