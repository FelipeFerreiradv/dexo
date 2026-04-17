/**
 * backfill-shopee-stock.ts
 *
 * Re-sincroniza estoque de todos os produtos com listing Shopee que tiveram
 * atividade nos últimos N dias (default 14). Útil para corrigir divergências
 * causadas pelo bug do endpoint update_item (corrigido em 81550e4), onde
 * sync reportava SUCCESS mas a Shopee descartava a atualização.
 *
 * Uso:
 *   npx tsx scripts/backfill-shopee-stock.ts            # últimos 14 dias
 *   npx tsx scripts/backfill-shopee-stock.ts --days 30  # janela custom
 *   npx tsx scripts/backfill-shopee-stock.ts --dry-run  # só lista produtos
 */

import { Platform } from "@prisma/client";
import prisma from "../app/lib/prisma";
import { SyncUseCase } from "../app/marketplaces/usecases/sync.usercase";

function parseArgs() {
  const args = process.argv.slice(2);
  let days = 14;
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--days" && args[i + 1]) {
      days = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === "--dry-run") {
      dryRun = true;
    }
  }
  return { days, dryRun };
}

async function run() {
  const { days, dryRun } = parseArgs();
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  console.log(
    `[backfill] Janela: ${days} dias (desde ${since.toISOString()}). dryRun=${dryRun}`,
  );

  const products = await prisma.product.findMany({
    where: {
      updatedAt: { gte: since },
      listings: {
        some: {
          marketplaceAccount: { platform: Platform.SHOPEE },
        },
      },
    },
    select: { id: true, sku: true, name: true, stock: true },
    orderBy: { updatedAt: "desc" },
  });

  console.log(`[backfill] ${products.length} produtos candidatos.`);

  if (dryRun) {
    for (const p of products) {
      console.log(`  • ${p.sku ?? "(sem sku)"} — ${p.name} (stock=${p.stock})`);
    }
    return;
  }

  let totalListings = 0;
  let applied = 0;
  let noop = 0;
  let skipped = 0;
  let failed = 0;
  const errors: Array<{ sku: string | null; listing: string; error: string }> = [];

  for (let i = 0; i < products.length; i++) {
    const p = products[i];
    process.stdout.write(
      `[${i + 1}/${products.length}] ${p.sku ?? p.id} (stock=${p.stock}) ... `,
    );
    try {
      const results = await SyncUseCase.syncProductStock(p.id);
      const shopeeResults = results.filter((r) => r.platform === Platform.SHOPEE);
      let productApplied = 0;
      let productNoop = 0;
      for (const r of shopeeResults) {
        totalListings++;
        if (!r.success) {
          failed++;
          errors.push({
            sku: p.sku,
            listing: r.externalListingId,
            error: r.error ?? "unknown",
          });
        } else if (r.skipped) {
          skipped++;
        } else if (r.previousStock !== r.newStock) {
          applied++;
          productApplied++;
        } else {
          noop++;
          productNoop++;
        }
      }
      console.log(
        `shopee: ${productApplied} aplicado, ${productNoop} no-op${
          shopeeResults.some((r) => !r.success) ? " ⚠ com erro" : ""
        }`,
      );
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ sku: p.sku, listing: "(product-level)", error: msg });
      console.log(`ERRO: ${msg}`);
    }
  }

  console.log("\n[backfill] Resumo:");
  console.log(`  Produtos processados: ${products.length}`);
  console.log(`  Listings Shopee tocados: ${totalListings}`);
  console.log(`  ✓ Aplicado (stock mudou): ${applied}`);
  console.log(`  · No-op (já batia): ${noop}`);
  console.log(`  ⚠ Skipped: ${skipped}`);
  console.log(`  ✗ Falhas: ${failed}`);

  if (errors.length > 0) {
    console.log("\n[backfill] Erros detalhados:");
    for (const e of errors) {
      console.log(`  • sku=${e.sku ?? "?"} listing=${e.listing}: ${e.error}`);
    }
  }
}

run()
  .catch((err) => {
    console.error("[backfill] Erro fatal:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
