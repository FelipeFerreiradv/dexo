/**
 * backfill-orders.ts
 *
 * Script one-shot para importar pedidos retroativamente após período de
 * inatividade das contas de marketplace. Reutiliza o fluxo existente de
 * importação que já inclui deduplicação, desconto de estoque e enfileiramento
 * de StockSyncJob para propagação cross-marketplace.
 *
 * Uso:
 *   npx tsx scripts/backfill-orders.ts [userId] [days]
 *
 * Argumentos:
 *   userId  — ID do usuário (opcional; sem argumento = todas as contas ativas)
 *   days    — Número de dias para trás (padrão: 14)
 *
 * Exemplos:
 *   npx tsx scripts/backfill-orders.ts cmn5yc4rn0000vsasmwv9m8nc 14
 *   npx tsx scripts/backfill-orders.ts                               # todas as contas
 */

import { Platform } from "@prisma/client";
import prisma from "../app/lib/prisma";
import { OrderUseCase } from "../app/marketplaces/usecases/order.usercase";

const userId = process.argv[2] || null;
const days = parseInt(process.argv[3] ?? "14", 10);

async function run() {
  console.log(
    `[backfill-orders] Iniciando backfill: userId=${userId ?? "ALL"}, days=${days}`,
  );

  const whereClause: Record<string, unknown> = { status: "ACTIVE" };
  if (userId) {
    whereClause.userId = userId;
  }

  const accounts = await prisma.marketplaceAccount.findMany({
    select: { id: true, platform: true, accountName: true, userId: true },
    where: whereClause,
  });

  if (accounts.length === 0) {
    console.log("[backfill-orders] Nenhuma conta ativa encontrada.");
    return;
  }

  console.log(`[backfill-orders] ${accounts.length} conta(s) ativa(s) encontrada(s).`);

  let totalImported = 0;
  let totalStockDeductions = 0;
  let totalErrors = 0;

  for (const account of accounts) {
    const label = `${account.platform} "${account.accountName}" (${account.id})`;
    console.log(`\n[backfill-orders] Processando ${label}...`);

    try {
      if (account.platform === Platform.MERCADO_LIVRE) {
        const result = await OrderUseCase.importRecentOrdersForAccount(
          account.id,
          days,
          true,
        );
        console.log(
          `[backfill-orders] ${label}: total=${result.totalOrders}, imported=${result.imported}, alreadyExists=${result.alreadyExists}, stockDeductions=${result.stockDeductions}, errors=${result.errors}`,
        );
        totalImported += result.imported;
        totalStockDeductions += result.stockDeductions;
        totalErrors += result.errors;
      } else if (account.platform === Platform.SHOPEE) {
        const shopeeDays = Math.min(days, 15); // Shopee API limita a 15 dias
        const result = await OrderUseCase.importRecentShopeeOrdersForAccount(
          account.id,
          shopeeDays,
          true,
        );
        console.log(
          `[backfill-orders] ${label}: total=${result.totalOrders}, imported=${result.imported}, alreadyExists=${result.alreadyExists}, stockDeductions=${result.stockDeductions}, errors=${result.errors}`,
        );
        totalImported += result.imported;
        totalStockDeductions += result.stockDeductions;
        totalErrors += result.errors;
      } else {
        console.log(`[backfill-orders] Plataforma ${account.platform} não suportada, pulando.`);
      }
    } catch (err) {
      console.error(`[backfill-orders] ERRO ao processar ${label}:`, err);
      totalErrors++;
    }
  }

  console.log(`\n[backfill-orders] === RESUMO ===`);
  console.log(`  Pedidos importados: ${totalImported}`);
  console.log(`  Descontos de estoque: ${totalStockDeductions}`);
  console.log(`  Erros: ${totalErrors}`);
  console.log(
    `  StockSyncJobs pendentes serão processados pelo StockSyncRetryService (intervalo 30s).`,
  );
}

run()
  .catch((err) => {
    console.error("[backfill-orders] Erro fatal:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
