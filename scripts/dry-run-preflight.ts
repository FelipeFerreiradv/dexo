/**
 * Dry-run do ListingPreflightService contra todos os produtos com mlCategoryId.
 *
 * O que faz:
 *  - Itera produtos (somente ML por enquanto) que tenham mlCategoryId setado.
 *  - Roda ListingPreflightService.checkML() com currentAttributes=[] (pior caso:
 *    simula o que aconteceria se fôssemos publicar o produto agora do zero).
 *  - Agrega resultados por issue_code / categoria e gera CSV para curadoria.
 *  - NÃO escreve nada no banco nem faz chamadas de listing reais à API do ML.
 *    (Atributos do catálogo são lidos via cache ou endpoint público; seguro.)
 *
 * Uso: `npx tsx scripts/dry-run-preflight.ts`
 * Saída: `scripts/out/preflight-dryrun.csv` + `preflight-dryrun-summary.json`
 */
import fs from "node:fs";
import path from "node:path";
import prisma from "../app/lib/prisma";
import { ListingPreflightService } from "../app/marketplaces/services/listing-preflight.service";

interface RowOut {
  productId: string;
  sku: string;
  name: string;
  categoryId: string;
  ok: "yes" | "no";
  enriched: number;
  missingCount: number;
  missingIds: string;
  issueCodes: string;
  blockHints: string;
}

async function main() {
  const outDir = path.join("scripts", "out");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  console.log("[dry-run-preflight] querying products with mlCategoryId...");
  const products = await prisma.product.findMany({
    where: { mlCategoryId: { not: null } },
    select: {
      id: true,
      sku: true,
      name: true,
      brand: true,
      model: true,
      year: true,
      partNumber: true,
      quality: true,
      heightCm: true,
      widthCm: true,
      lengthCm: true,
      weightKg: true,
      imageUrl: true,
      mlCategoryId: true,
      mlCategory: { select: { externalId: true } },
    },
  });
  console.log(`[dry-run-preflight] ${products.length} products to check`);

  const rows: RowOut[] = [];
  const byIssue: Record<string, number> = {};
  const byMissingAttr: Record<string, number> = {};
  const byCategory: Record<
    string,
    { total: number; blocked: number; sampleMissing: Set<string> }
  > = {};
  let okCount = 0;
  let blockedCount = 0;
  let processed = 0;

  for (const p of products) {
    processed++;
    if (processed % 50 === 0) {
      console.log(
        `[dry-run-preflight] progress ${processed}/${products.length}`,
      );
    }
    try {
      const result = await ListingPreflightService.checkML({
        product: {
          id: p.id,
          name: p.name,
          brand: p.brand,
          model: p.model,
          year: p.year,
          partNumber: p.partNumber,
          sku: p.sku,
          heightCm: p.heightCm,
          widthCm: p.widthCm,
          lengthCm: p.lengthCm,
          weightKg: p.weightKg,
          imageUrl: p.imageUrl,
          quality: p.quality,
        },
        categoryId: p.mlCategory?.externalId || p.mlCategoryId!,
        currentAttributes: [],
      });

      const blocks = result.issues.filter((i) => i.severity === "block");
      const row: RowOut = {
        productId: p.id,
        sku: p.sku,
        name: p.name,
        categoryId: p.mlCategory?.externalId || p.mlCategoryId!,
        ok: result.ok ? "yes" : "no",
        enriched: result.enrichedAttributes.length,
        missingCount: result.missingRequired.length,
        missingIds: result.missingRequired.join("|"),
        issueCodes: result.issues.map((i) => i.code).join("|"),
        blockHints: blocks
          .map((b) => b.fixHint || b.message)
          .join(" || ")
          .replace(/[\r\n]+/g, " "),
      };
      rows.push(row);

      if (result.ok) okCount++;
      else blockedCount++;

      for (const code of new Set(result.issues.map((i) => i.code))) {
        byIssue[code] = (byIssue[code] || 0) + 1;
      }
      for (const id of result.missingRequired) {
        byMissingAttr[id] = (byMissingAttr[id] || 0) + 1;
      }
      const cat = (byCategory[p.mlCategoryId!] ||= {
        total: 0,
        blocked: 0,
        sampleMissing: new Set(),
      });
      cat.total++;
      if (!result.ok) cat.blocked++;
      for (const m of result.missingRequired) cat.sampleMissing.add(m);
    } catch (err) {
      console.warn(
        `[dry-run-preflight] error on product ${p.id}:`,
        err instanceof Error ? err.message : String(err),
      );
      rows.push({
        productId: p.id,
        sku: p.sku,
        name: p.name,
        categoryId: p.mlCategory?.externalId || p.mlCategoryId!,
        ok: "no",
        enriched: 0,
        missingCount: 0,
        missingIds: "",
        issueCodes: "dryrun_error",
        blockHints: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const csvHeader =
    "productId,sku,name,categoryId,ok,enriched,missingCount,missingIds,issueCodes,blockHints";
  const esc = (v: string) => `"${String(v).replace(/"/g, '""')}"`;
  const csvBody = rows
    .map((r) =>
      [
        r.productId,
        r.sku,
        r.name,
        r.categoryId,
        r.ok,
        r.enriched,
        r.missingCount,
        r.missingIds,
        r.issueCodes,
        r.blockHints,
      ]
        .map((v) => esc(String(v)))
        .join(","),
    )
    .join("\n");
  const csvPath = path.join(outDir, "preflight-dryrun.csv");
  fs.writeFileSync(csvPath, csvHeader + "\n" + csvBody, "utf-8");

  const summary = {
    total: products.length,
    ok: okCount,
    blocked: blockedCount,
    okRate: products.length ? okCount / products.length : 0,
    byIssueCode: byIssue,
    byMissingAttribute: byMissingAttr,
    topBlockedCategories: Object.entries(byCategory)
      .map(([categoryId, v]) => ({
        categoryId,
        total: v.total,
        blocked: v.blocked,
        blockedRate: v.blocked / v.total,
        missingSample: [...v.sampleMissing],
      }))
      .filter((c) => c.blocked > 0)
      .sort((a, b) => b.blocked - a.blocked)
      .slice(0, 20),
  };
  const summaryPath = path.join(outDir, "preflight-dryrun-summary.json");
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf-8");

  console.log("\n=== dry-run-preflight summary ===");
  console.log(`total:   ${summary.total}`);
  console.log(
    `ok:      ${summary.ok} (${(summary.okRate * 100).toFixed(1)}%)`,
  );
  console.log(`blocked: ${summary.blocked}`);
  console.log("\ntop missing attributes:");
  for (const [id, n] of Object.entries(byMissingAttr)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)) {
    console.log(`  ${id.padEnd(20)} ${n}`);
  }
  console.log("\nissue code counts:");
  for (const [code, n] of Object.entries(byIssue).sort(
    (a, b) => b[1] - a[1],
  )) {
    console.log(`  ${code.padEnd(26)} ${n}`);
  }
  console.log("\ntop blocked categories:");
  for (const c of summary.topBlockedCategories.slice(0, 10)) {
    console.log(
      `  ${c.categoryId.padEnd(12)} blocked ${c.blocked}/${c.total} (${(
        c.blockedRate * 100
      ).toFixed(0)}%) missing=${c.missingSample.join(",")}`,
    );
  }
  console.log(`\ncsv:     ${csvPath}`);
  console.log(`summary: ${summaryPath}`);
}

main()
  .catch((err) => {
    console.error("[dry-run-preflight] fatal:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
