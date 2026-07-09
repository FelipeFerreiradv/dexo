import "dotenv/config";
import path from "path";
import fs from "fs";
import prisma from "../app/lib/prisma";

/**
 * Apaga os produtos AUTO-IMPORTADOS de marketplace de um usuário — os que o
 * auto-import (ML/Shopee/Magalu) criou com `createdFromMarketplace=true`, que
 * NÃO têm marcador `attributes.migration` (não são de migração) e que NÃO têm
 * anúncio/venda/NF-e/recebível/orçamento. Usado para limpar a base parcial
 * antes de rodar uma migração autoritativa (ex.: WebDesmonte do K2).
 *
 * SEGURANÇA: nunca apaga produto com `attributes.migration` setado (migração),
 * nem com qualquer vínculo (listing/pedido/nfe/recebível/orçamento). Sem
 * `--apply` não escreve. Apaga stockLogs/compatibilities/listings dependentes
 * numa transação antes do produto. Idempotente.
 *
 *   npx tsx scripts/delete-marketplace-imports.ts --user-id=<ID> --dry-run
 *   npx tsx scripts/delete-marketplace-imports.ts --user-id=<ID> --apply
 */

const OUT_DIR = path.resolve(__dirname, "out");

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const dryRun = argv.includes("--dry-run") || !apply;
  const userId = argv.find((a) => a.startsWith("--user-id="))?.split("=")[1] ?? "";
  const limitRaw = argv.find((a) => a.startsWith("--limit="))?.split("=")[1];
  const limit = limitRaw && /^\d+$/.test(limitRaw) ? parseInt(limitRaw, 10) : null;
  if (!userId) throw new Error("Informe --user-id=<cuid>. Abortando.");

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
  if (!user) throw new Error(`Usuário ${userId} não encontrado`);
  console.log(`[del-imports] user=${user.email} modo=${dryRun ? "DRY-RUN" : "APPLY"}`);

  const products = await prisma.product.findMany({
    where: { userId, createdFromMarketplace: true },
    select: {
      id: true,
      sku: true,
      attributes: true,
      _count: {
        select: {
          listings: true,
          orderItems: true,
          nfeItens: true,
          receivableItems: true,
          budgetItems: true,
        },
      },
    },
    ...(limit ? { take: limit } : {}),
  });

  const sum = {
    createdFromMarketplace: products.length,
    apagados: 0,
    pulados_migration: 0,
    pulados_com_dados: 0,
    erros: 0,
    detalhes: [] as unknown[],
  };

  // Filtra os elegíveis (nunca migração; nunca com vínculo).
  const deletableIds: string[] = [];
  for (const p of products) {
    const a = (p.attributes ?? {}) as Record<string, unknown>;
    if (a.migration != null && a.migration !== "") {
      sum.pulados_migration++;
      continue;
    }
    const c = p._count as unknown as Record<string, number>;
    if (c.listings > 0 || c.orderItems > 0 || c.nfeItens > 0 || c.receivableItems > 0 || c.budgetItems > 0) {
      sum.pulados_com_dados++;
      continue;
    }
    deletableIds.push(p.id);
  }

  if (dryRun) {
    sum.apagados = deletableIds.length;
  } else {
    // Bulk em lotes (deleteMany dependentes + deleteMany produtos) — muito mais
    // rápido que 1 transação por produto.
    const CH = 300;
    for (let i = 0; i < deletableIds.length; i += CH) {
      const ids = deletableIds.slice(i, i + CH);
      try {
        await prisma.$transaction([
          prisma.stockLog.deleteMany({ where: { productId: { in: ids } } }),
          prisma.productCompatibility.deleteMany({ where: { productId: { in: ids } } }),
          prisma.productListing.deleteMany({ where: { productId: { in: ids } } }),
          prisma.product.deleteMany({ where: { id: { in: ids } } }),
        ]);
        sum.apagados += ids.length;
      } catch (err) {
        sum.erros += ids.length;
        if (sum.detalhes.length < 50)
          sum.detalhes.push({ chunkStart: i, error: err instanceof Error ? err.message : String(err) });
      }
      if ((i + CH) % 1500 === 0) console.log(`[del-imports] ${Math.min(i + CH, deletableIds.length)}/${deletableIds.length} apagados=${sum.apagados}`);
    }
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.writeFileSync(
    path.join(OUT_DIR, `delete-mkt-imports-${userId}-${stamp}.json`),
    JSON.stringify({ userId, mode: dryRun ? "dry-run" : "apply", ...sum }, null, 2),
    "utf8",
  );

  console.log("\n===== RESUMO — apagar auto-imports =====");
  console.log(`modo: ${dryRun ? "DRY-RUN (0 exclusões)" : "APPLY"}`);
  console.log(`  createdFromMarketplace:   ${sum.createdFromMarketplace}`);
  console.log(`  ${dryRun ? "a apagar" : "apagados"}:               ${sum.apagados}`);
  console.log(`  pulados (migração):       ${sum.pulados_migration}`);
  console.log(`  pulados (com vínculo):    ${sum.pulados_com_dados}`);
  console.log(`  erros:                    ${sum.erros}`);
  console.log("========================================");

  await prisma.$disconnect();
}
main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
