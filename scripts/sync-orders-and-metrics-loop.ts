import { Platform } from "@prisma/client";
import prisma from "../app/lib/prisma";
import { OrderUseCase } from "../app/marketplaces/usecases/order.usercase";
import { SyncUseCase } from "../app/marketplaces/usecases/sync.usercase";
import { MessagesUseCase } from "../app/marketplaces/usecases/messages.usecase";
import { SystemLogService } from "../app/services/system-log.service";
import { syncAllListingsMetrics } from "./sync-listing-metrics";

const intervalMinutes = parseInt(process.env.SYNC_FULL_INTERVAL_MINUTES ?? "15", 10);
const syncDays = parseInt(process.env.SYNC_LOOP_DAYS ?? "7", 10);

// ─────────────────────────────────────────────────────────────────────────────
// Por que este arquivo tem DUAS passadas em vez de um ciclo só.
//
// Diagnóstico de 29/07/2026: o ciclo único levava HORAS — o log de produção
// registrou `Ciclo concluído em 258962582 ms` (71,9 h) e o `waitMs` caía no
// piso de 5 s, ou seja, o "intervalo de 15 min" era ficção. Causa: o laço
// percorria as ~79 contas ACTIVE em série e, por conta, fazia muito mais do que
// importar pedidos — auto-detect do catálogo Shopee (milhares de itens por
// conta), polling de comentários, auto-detect e mensagens da Magalu — e só no
// fim as métricas de todos. O import de pedidos da última conta esperava a
// varredura de catálogo de todas as anteriores.
//
// Como a Shopee não recebe push (zero registros em WebhookEventLog com
// source SHOPEE), esse poll é o ÚNICO caminho de ingestão de venda dela: uma
// venda podia ficar até ~3 dias sem virar Order e sem baixar estoque, deixando
// a peça vendável nos outros canais (oversell cross-canal).
//
// Agora: `runOrdersPass` cuida SÓ de pedidos, com pool de concorrência, na
// cadência de SYNC_FULL_INTERVAL_MINUTES; `runCatalogPass` cuida de catálogo,
// mensagens e métricas na sua própria cadência (SYNC_CATALOG_INTERVAL_MINUTES).
//
// KILL-SWITCH: SYNC_LOOP_SPLIT_DISABLED=1 volta ao ciclo único serial de antes
// (`runOnce`), que segue aqui intacto e chama exatamente as mesmas funções, na
// mesma ordem.
// ─────────────────────────────────────────────────────────────────────────────

const splitDisabled = process.env.SYNC_LOOP_SPLIT_DISABLED === "1";
const catalogIntervalMinutes = parseInt(
  process.env.SYNC_CATALOG_INTERVAL_MINUTES ?? "360",
  10,
);
// Conservador de propósito: o pooler do Supabase já derrubou a produção uma vez
// (504 em api/frontend). 1 = serial, idêntico ao comportamento anterior.
const ordersConcurrency = Math.max(
  1,
  parseInt(process.env.SYNC_ORDERS_CONCURRENCY ?? "4", 10),
);

type LoopAccount = { id: string; platform: Platform };

async function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function listActiveAccounts(): Promise<LoopAccount[]> {
  return prisma.marketplaceAccount.findMany({
    select: { id: true, platform: true },
    where: { status: "ACTIVE" },
  });
}

/**
 * Executa `worker` sobre `items` com no máximo `limit` em voo. Com limit <= 1
 * degrada para o laço serial de antes. O worker é responsável por engolir os
 * próprios erros (todos aqui já são try/catch), então nenhuma rejeição escapa.
 */
async function runPool<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (limit <= 1) {
    for (const item of items) {
      await worker(item);
    }
    return;
  }

  let next = 0;
  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (;;) {
        const index = next++;
        if (index >= items.length) return;
        await worker(items[index]);
      }
    },
  );
  await Promise.all(runners);
}

/** Import de pedidos de UMA conta. Erro aqui nunca aborta as demais contas. */
async function importOrdersForAccount(account: LoopAccount): Promise<void> {
  try {
    if (account.platform === Platform.MERCADO_LIVRE) {
      await OrderUseCase.importRecentOrdersForAccount(account.id, syncDays, true);
    } else if (account.platform === Platform.SHOPEE) {
      await OrderUseCase.importRecentShopeeOrdersForAccount(account.id, Math.min(syncDays, 15), true);
    } else if (account.platform === Platform.MAGALU) {
      // Sem este branch, a Magalu nao tinha NENHUM poll de pedidos: o webhook
      // era ponto unico de falha e, como nunca chegou (zero registros em
      // WebhookEventLog com source MAGALU), nenhuma venda Magalu jamais virou
      // Order — nem para contas com centenas de anuncios ativos. Os blocos
      // Magalu mais abaixo neste arquivo tratam apenas anuncios e chat.
      await OrderUseCase.importRecentMagaluOrdersForAccount(account.id, syncDays, true);
    }
  } catch (err) {
    console.error(`[sync-loop] Falha ao importar pedidos para conta ${account.id}:`, err);
  }
}

/** Auto-detecção de anúncios + comentários da Shopee de UMA conta. */
async function runShopeeCatalogForAccount(accountId: string): Promise<void> {
  // Auto-detecção de anúncios novos da Shopee (polling incremental). Em
  // try/catch próprio: uma falha aqui nunca aborta pedidos nem as métricas.
  try {
    const full = await prisma.marketplaceAccount.findUnique({
      where: { id: accountId },
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
        `[sync-loop] Shopee auto-detect conta ${accountId}: criados=${r.created} vinculados=${r.linked} ignorados=${r.skipped} erros=${r.errors}`,
      );
    }
  } catch (err) {
    console.error(
      `[sync-loop] Falha na auto-detecção de anúncios Shopee (conta ${accountId}):`,
      err,
    );
  }

  // Polling de comentários/perguntas Shopee (Mensagens). Try/catch próprio.
  try {
    const full = await prisma.marketplaceAccount.findUnique({
      where: { id: accountId },
      select: {
        id: true,
        shopId: true,
        accessToken: true,
        refreshToken: true,
        expiresAt: true,
      },
    });
    if (full) {
      const r = await MessagesUseCase.syncShopeeCommentsForAccount(full);
      console.log(
        `[sync-loop] Shopee comentários conta ${accountId}: comentarios=${r.comments} erros=${r.errors}`,
      );
    }
  } catch (err) {
    console.error(
      `[sync-loop] Falha no polling de comentários Shopee (conta ${accountId}):`,
      err,
    );
  }
}

/** Auto-detecção de anúncios + conversas da Magalu de UMA conta. */
async function runMagaluCatalogForAccount(accountId: string): Promise<void> {
  // Auto-detecção de anúncios novos da Magalu (polling incremental). Try/catch
  // próprio: uma falha aqui nunca aborta pedidos nem métricas.
  try {
    const full = await prisma.marketplaceAccount.findUnique({
      where: { id: accountId },
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
        `[sync-loop] Magalu auto-detect conta ${accountId}: criados=${r.created} vinculados=${r.linked} ignorados=${r.skipped} erros=${r.errors}`,
      );
    }
  } catch (err) {
    console.error(
      `[sync-loop] Falha na auto-detecção de anúncios Magalu (conta ${accountId}):`,
      err,
    );
  }

  // Polling de conversas (Chat com Cliente) da Magalu. Try/catch próprio:
  // mantém a lista de Mensagens fresca sem nunca abortar pedidos/métricas.
  try {
    const full = await prisma.marketplaceAccount.findUnique({
      where: { id: accountId },
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
        `[sync-loop] Magalu mensagens conta ${accountId}: conversas=${r.conversations} erros=${r.errors}`,
      );
    }
  } catch (err) {
    console.error(
      `[sync-loop] Falha no polling de conversas Magalu (conta ${accountId}):`,
      err,
    );
  }
}

async function runListingsMetrics(): Promise<void> {
  try {
    await syncAllListingsMetrics();
  } catch (err) {
    console.error(`[sync-loop] Falha ao sincronizar métricas de anúncios:`, err);
  }
}

/**
 * Ciclo único serial — comportamento anterior, preservado para o kill-switch
 * SYNC_LOOP_SPLIT_DISABLED=1. Mesma ordem de chamadas de sempre.
 */
async function runOnce() {
  const accounts = await listActiveAccounts();

  for (const account of accounts) {
    await importOrdersForAccount(account);

    if (account.platform === Platform.SHOPEE) {
      await runShopeeCatalogForAccount(account.id);
    }

    if (account.platform === Platform.MAGALU) {
      await runMagaluCatalogForAccount(account.id);
    }
  }

  await runListingsMetrics();
}

/** Passada rápida: SÓ import de pedidos, com pool de concorrência. */
async function runOrdersPass(): Promise<{ accounts: number; elapsedMs: number }> {
  const started = Date.now();
  const accounts = await listActiveAccounts();
  await runPool(accounts, ordersConcurrency, importOrdersForAccount);
  return { accounts: accounts.length, elapsedMs: Date.now() - started };
}

/** Passada lenta: catálogo, mensagens e métricas. Serial, como antes. */
async function runCatalogPass(): Promise<{ accounts: number; elapsedMs: number }> {
  const started = Date.now();
  const accounts = await listActiveAccounts();

  for (const account of accounts) {
    if (account.platform === Platform.SHOPEE) {
      await runShopeeCatalogForAccount(account.id);
    }
    if (account.platform === Platform.MAGALU) {
      await runMagaluCatalogForAccount(account.id);
    }
  }

  await runListingsMetrics();
  return { accounts: accounts.length, elapsedMs: Date.now() - started };
}

/**
 * Registra a duração da passada. Sem `userId` de propósito: a tela /logs do
 * cliente filtra por `userId IN (...)`, e NULL nunca casa — então este log fica
 * visível só para nós, e não polui (nem vaza) a tela do cliente.
 */
async function logPassOutcome(
  label: "orders" | "catalog",
  accounts: number,
  elapsedMs: number,
  budgetMs: number,
): Promise<void> {
  const details = { pass: label, accounts, elapsedMs, budgetMs };
  const message = `[sync-loop] passada ${label}: ${accounts} contas em ${elapsedMs} ms`;
  try {
    if (elapsedMs > budgetMs * 2) {
      await SystemLogService.logWarning("SYNC_ORDERS", `${message} (acima de 2x o intervalo)`, {
        resource: "SyncLoop",
        resourceId: label,
        details,
      });
    } else {
      await SystemLogService.logInfo("SYNC_ORDERS", message, {
        resource: "SyncLoop",
        resourceId: label,
        details,
      });
    }
  } catch {
    /* observabilidade nunca derruba o loop */
  }
}

/** Laço genérico: roda `pass` a cada `intervalMin`, sem nunca matar o processo. */
async function runLoop(
  label: "orders" | "catalog",
  intervalMin: number,
  pass: () => Promise<{ accounts: number; elapsedMs: number }>,
): Promise<never> {
  const budgetMs = intervalMin * 60 * 1000;
  for (;;) {
    const started = Date.now();
    try {
      const { accounts, elapsedMs } = await pass();
      console.log(
        `[sync-loop] Passada ${label} concluída em ${elapsedMs} ms (${accounts} contas).`,
      );
      await logPassOutcome(label, accounts, elapsedMs, budgetMs);
    } catch (err) {
      // Um erro transiente de banco (pool apertado, blip de rede) NAO pode
      // matar o processo: process.exit aqui gera crash-loop no PM2, e cada
      // reinicio vaza as conexoes abertas -> satura o pooler do Supabase ->
      // derruba api/frontend (504). Loga e segue pro proximo ciclo.
      console.error(`[sync-loop] Passada ${label} falhou (loop continua):`, err);
    }
    const waitMs = Math.max(budgetMs - (Date.now() - started), 5000);
    console.log(`[sync-loop] Próxima passada ${label} em ${waitMs} ms.`);
    await wait(waitMs);
  }
}

/** Caminho legado (kill-switch ligado): ciclo único serial. */
async function runLegacyLoop(): Promise<never> {
  for (;;) {
    const started = Date.now();
    try {
      await runOnce();
    } catch (err) {
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
    console.log(`[sync-loop] Ciclo concluído em ${elapsed} ms. Próximo em ${waitMs} ms.`);
    await wait(waitMs);
  }
}

async function main() {
  if (splitDisabled) {
    console.log(
      `[sync-loop] Iniciando loop completo (pedidos + métricas). Intervalo ${intervalMinutes} min, janela ${syncDays} dias`,
    );
    await runLegacyLoop();
    return;
  }

  console.log(
    `[sync-loop] Iniciando loops separados — pedidos a cada ${intervalMinutes} min (concorrência ${ordersConcurrency}, janela ${syncDays} dias); catálogo/métricas a cada ${catalogIntervalMinutes} min`,
  );

  // As duas passadas compartilham o mesmo PrismaClient e correm em paralelo.
  // Por isso NÃO há `$disconnect()` entre ciclos aqui: desconectar durante a
  // passada de pedidos (que roda a cada poucos minutos) derrubaria as queries
  // da passada de catálogo em voo, e vice-versa. O client fica quente o tempo
  // todo — o disconnect existia só para soltar conexões no ocioso longo do
  // ciclo único, ocioso que deixa de existir com a passada rápida.
  await Promise.all([
    runLoop("orders", intervalMinutes, runOrdersPass),
    runLoop("catalog", catalogIntervalMinutes, runCatalogPass),
  ]);
}

// Só executa quando rodado direto (`npx tsx scripts/sync-orders-and-metrics-loop.ts`).
// Sem esta guarda, importar o módulo no vitest dispararia o loop infinito.
// Mesmo padrão de scripts/prod-audit/*.
if (require.main === module) {
  main().catch((err) => {
    console.error(`[sync-loop] Erro fatal`, err);
    process.exit(1);
  });
}

// Exportado só para teste (vitest). Não usar em produção.
export const __testing = {
  runPool,
  runOrdersPass,
  runCatalogPass,
  runOnce,
};
