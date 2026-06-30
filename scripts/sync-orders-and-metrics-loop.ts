import { Platform } from "@prisma/client";
import prisma from "../app/lib/prisma";
import { OrderUseCase } from "../app/marketplaces/usecases/order.usercase";
import { SyncUseCase } from "../app/marketplaces/usecases/sync.usercase";
import { MessagesUseCase } from "../app/marketplaces/usecases/messages.usecase";
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

    // Auto-detecção de anúncios novos da Shopee (polling incremental). Em
    // try/catch próprio: uma falha aqui nunca aborta pedidos nem as métricas.
    if (account.platform === Platform.SHOPEE) {
      try {
        const full = await prisma.marketplaceAccount.findUnique({
          where: { id: account.id },
          // EGRESS: só os campos que o poller usa, não a linha inteira.
          select: {
            id: true,
            userId: true,
            shopId: true,
            accessToken: true,
            refreshToken: true,
            expiresAt: true,
            autoImportListingsSince: true,
            shopeeListingsSyncedThrough: true,
          },
        });
        if (full) {
          const r = await SyncUseCase.importNewShopeeItemsForAccount(full);
          console.log(
            `[sync-loop] Shopee auto-detect conta ${account.id}: criados=${r.created} vinculados=${r.linked} ignorados=${r.skipped} erros=${r.errors}`,
          );
        }
      } catch (err) {
        console.error(
          `[sync-loop] Falha na auto-detecção de anúncios Shopee (conta ${account.id}):`,
          err,
        );
      }
    }

    // Auto-detecção de anúncios novos da Magalu (polling incremental). Try/catch
    // próprio: uma falha aqui nunca aborta pedidos nem métricas.
    if (account.platform === Platform.MAGALU) {
      try {
        const full = await prisma.marketplaceAccount.findUnique({
          where: { id: account.id },
          // EGRESS: só os campos que o poller usa.
          select: {
            id: true,
            userId: true,
            accessToken: true,
            refreshToken: true,
            expiresAt: true,
            autoImportListingsSince: true,
          },
        });
        if (full) {
          const r = await SyncUseCase.importNewMagaluItemsForAccount(full);
          console.log(
            `[sync-loop] Magalu auto-detect conta ${account.id}: criados=${r.created} vinculados=${r.linked} ignorados=${r.skipped} erros=${r.errors}`,
          );
        }
      } catch (err) {
        console.error(
          `[sync-loop] Falha na auto-detecção de anúncios Magalu (conta ${account.id}):`,
          err,
        );
      }

      // Polling de conversas (Chat com Cliente) da Magalu. Try/catch próprio:
      // mantém a lista de Mensagens fresca sem nunca abortar pedidos/métricas.
      try {
        const full = await prisma.marketplaceAccount.findUnique({
          where: { id: account.id },
          // EGRESS: só o que o refresh de token usa.
          select: {
            id: true,
            accessToken: true,
            refreshToken: true,
            expiresAt: true,
          },
        });
        if (full) {
          const r = await MessagesUseCase.syncMagaluMessagesForAccount(full);
          console.log(
            `[sync-loop] Magalu mensagens conta ${account.id}: conversas=${r.conversations} erros=${r.errors}`,
          );
        }
      } catch (err) {
        console.error(
          `[sync-loop] Falha no polling de conversas Magalu (conta ${account.id}):`,
          err,
        );
      }
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
    try {
      await runOnce();
    } catch (err) {
      // Um erro transiente de banco (pool apertado, blip de rede) NAO pode
      // matar o processo: process.exit aqui gera crash-loop no PM2, e cada
      // reinicio vaza as conexoes abertas -> satura o pooler do Supabase ->
      // derruba api/frontend (504). Loga e segue pro proximo ciclo.
      console.error("[sync-loop] Ciclo falhou (loop continua, sem matar o processo):", err);
    } finally {
      // Libera as conexoes durante o intervalo ocioso; reconecta sozinho no
      // proximo ciclo. Protegido pra um disconnect com erro nao escapar.
      try {
        await prisma.$disconnect();
      } catch {
        /* ignore */
      }
    }
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
