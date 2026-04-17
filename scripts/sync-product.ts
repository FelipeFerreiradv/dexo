/**
 * sync-product.ts
 *
 * Força sincronização de estoque de um produto para TODOS os listings
 * vinculados (ML + Shopee, todas as contas). Útil após reconectar uma
 * conta cujo token expirou — não há StockSyncJob pendente, então nada
 * acontece automaticamente.
 *
 * Uso:
 *   npx tsx scripts/sync-product.ts <productId>
 *   npx tsx scripts/sync-product.ts --sku <sku>
 */

import prisma from "../app/lib/prisma";
import { SyncUseCase } from "../app/marketplaces/usecases/sync.usercase";

async function resolveProductId(): Promise<string> {
  const args = process.argv.slice(2);
  if (args[0] === "--sku" && args[1]) {
    const p = await prisma.product.findFirst({ where: { sku: args[1] } });
    if (!p) throw new Error(`Produto com sku=${args[1]} não encontrado`);
    return p.id;
  }
  if (args[0]) return args[0];
  throw new Error("Uso: npx tsx scripts/sync-product.ts <productId>\n       npx tsx scripts/sync-product.ts --sku <sku>");
}

async function run() {
  const productId = await resolveProductId();
  console.log(`[sync-product] Sincronizando produto ${productId}...`);
  const results = await SyncUseCase.syncProductStock(productId);
  for (const r of results) {
    const tag = r.success ? "✓" : "✗";
    console.log(
      `  ${tag} [${r.platform ?? "?"}] listing=${r.externalListingId} ${r.previousStock ?? "?"} → ${r.newStock ?? "?"}${r.error ? " ERROR=" + r.error : ""}`,
    );
  }
}

run()
  .catch((err) => {
    console.error("[sync-product] Erro fatal:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
