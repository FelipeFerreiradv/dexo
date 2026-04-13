/**
 * Analisa scripts/out/ml-dims-audit.json:
 *  - distribuição de categorias (top + total)
 *  - listings órfãos (sem ProductListing local)
 *  - sample de títulos por categoria para sanity-check
 */
import fs from "node:fs";
import path from "node:path";
import prisma from "../app/lib/prisma";

interface Row {
  itemId: string;
  account: string;
  status: string;
  title: string;
  category: string;
  permalink?: string;
  issues: string[];
  severity: string;
}

async function main() {
  const jsonPath = path.join("scripts", "out", "ml-dims-audit.json");
  const rows: Row[] = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
  console.log(`Total rows: ${rows.length}`);

  // Distribuição por categoria
  const byCat: Record<string, number> = {};
  for (const r of rows) byCat[r.category] = (byCat[r.category] || 0) + 1;
  const sorted = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  console.log(`\nCategorias distintas: ${sorted.length}`);
  console.log("Top 30 categorias:");
  for (const [c, n] of sorted.slice(0, 30)) {
    const sample = rows.find((r) => r.category === c);
    console.log(`  ${c.padEnd(12)} ${String(n).padStart(6)}  ex: ${sample?.title?.slice(0, 60)}`);
  }

  // Cobertura local
  const itemIds = rows.map((r) => r.itemId);
  console.log(`\nVerificando ProductListing locais para ${itemIds.length} itens…`);
  const linked = await prisma.productListing.findMany({
    where: { externalListingId: { in: itemIds } },
    select: { externalListingId: true, productId: true },
  });
  const linkedSet = new Set(linked.map((l) => l.externalListingId));
  const orphans = rows.filter((r) => !linkedSet.has(r.itemId));
  console.log(`ProductListing encontrados: ${linked.length}`);
  console.log(`Órfãos (ML sem ProductListing local): ${orphans.length}`);

  // Órfãos por conta
  const orphansByAccount: Record<string, number> = {};
  for (const o of orphans) orphansByAccount[o.account] = (orphansByAccount[o.account] || 0) + 1;
  console.log("Órfãos por conta:", orphansByAccount);

  // Órfãos por categoria (top)
  const orphCat: Record<string, number> = {};
  for (const o of orphans) orphCat[o.category] = (orphCat[o.category] || 0) + 1;
  const orphSorted = Object.entries(orphCat).sort((a, b) => b[1] - a[1]);
  console.log("Top 15 categorias entre órfãos:");
  for (const [c, n] of orphSorted.slice(0, 15)) {
    const ex = orphans.find((r) => r.category === c);
    console.log(`  ${c.padEnd(12)} ${String(n).padStart(5)}  ex: ${ex?.title?.slice(0, 60)}`);
  }

  // Salvar lista de órfãos para próxima fase
  const outPath = path.join("scripts", "out", "ml-orphans.json");
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      orphans.map((o) => ({
        itemId: o.itemId,
        account: o.account,
        title: o.title,
        category: o.category,
        permalink: o.permalink,
      })),
      null,
      2,
    ),
  );
  console.log(`Órfãos salvos em ${outPath}`);

  // Salvar lista de categorias presentes
  const catsPath = path.join("scripts", "out", "ml-categories-present.json");
  fs.writeFileSync(
    catsPath,
    JSON.stringify(
      sorted.map(([id, count]) => ({ id, count })),
      null,
      2,
    ),
  );
  console.log(`Categorias salvas em ${catsPath}`);

  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
