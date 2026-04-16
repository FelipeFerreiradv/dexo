import { Platform } from "@prisma/client";
import prisma from "../app/lib/prisma";
import { OrderUseCase } from "../app/marketplaces/usecases/order.usercase";
import { syncAllListingsMetrics } from "./sync-listing-metrics";

const intervalMinutes = parseInt(process.env.SYNC_FULL_INTERVAL_MINUTES ?? "15", 10);
const syncDays = parseInt(process.env.SYNC_LOOP_DAYS ?? "7", 10);

async function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runOnce() {
  const accounts = await prisma.marketplaceAccount.findMany({
    select: { id: true, platform: true },
    where: { status: "ACTIVE" },
  });

  for (const account of accounts) {
    try {
      if (account.platform === Platform.MERCADO_LIVRE) {
        await OrderUseCase.importRecentOrdersForAccount(account.id, syncDays, true);
      } else if (account.platform === Platform.SHOPEE) {
        await OrderUseCase.importRecentShopeeOrdersForAccount(account.id, Math.min(syncDays, 15), true);
      }
    } catch (err) {
      console.error(`[sync-loop] Falha ao importar pedidos para conta ${account.id}:`, err);
    }
  }

  try {
    await syncAllListingsMetrics();
  } catch (err) {
    console.error(`[sync-loop] Falha ao sincronizar m�tricas de an�ncios:`, err);
  }
}

async function main() {
  console.log(`[sync-loop] Iniciando loop completo (pedidos + métricas). Intervalo ${intervalMinutes} min, janela ${syncDays} dias`);
  while (true) {
    const started = Date.now();
    await runOnce();
    await prisma.$disconnect();
    const elapsed = Date.now() - started;
    const waitMs = Math.max(intervalMinutes * 60 * 1000 - elapsed, 5000);
    console.log(`[sync-loop] Ciclo conclu�do em ${elapsed} ms. Pr�ximo em ${waitMs} ms.`);
    await wait(waitMs);
  }
}

main().catch((err) => {
  console.error(`[sync-loop] Erro fatal`, err);
  process.exit(1);
});
