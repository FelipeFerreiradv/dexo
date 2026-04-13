/**
 * Mostra as categorias e títulos que caíram no fallback genérico
 * (sem mapping explícito de categoria E sem match de keyword).
 * Permite decidir quais categorias adicionar antes do mass-fix.
 */
import fs from "node:fs";
import path from "node:path";
import { resolveDim } from "./_ml_dim_defaults";

interface Row {
  itemId: string;
  category: string;
  title: string;
}

const rows: Row[] = JSON.parse(
  fs.readFileSync(path.join("scripts", "out", "ml-dims-audit.json"), "utf-8"),
);

const fallbackRows = rows.filter((r) => resolveDim(r.category, r.title).source.startsWith("fallback"));

console.log(`Total no fallback: ${fallbackRows.length} de ${rows.length}`);

// Agrupar por categoria
const byCat: Record<string, Row[]> = {};
for (const r of fallbackRows) {
  (byCat[r.category] ||= []).push(r);
}
const sorted = Object.entries(byCat).sort((a, b) => b[1].length - a[1].length);
console.log(`Categorias distintas no fallback: ${sorted.length}\n`);

console.log("=== TOP 50 categorias no fallback ===");
console.log("(categoria | qtd | 3 títulos exemplo)\n");
for (const [cat, items] of sorted.slice(0, 50)) {
  console.log(`${cat}  (${items.length})`);
  for (const it of items.slice(0, 3)) {
    console.log(`   - ${it.title.slice(0, 80)}`);
  }
}

const cumulative = sorted.slice(0, 50).reduce((a, [, v]) => a + v.length, 0);
console.log(
  `\nCobertura se mapearmos top 50: +${cumulative} itens (${((cumulative / rows.length) * 100).toFixed(1)}% do total, ${((cumulative / fallbackRows.length) * 100).toFixed(1)}% do fallback)`,
);

const top100 = sorted.slice(0, 100).reduce((a, [, v]) => a + v.length, 0);
console.log(
  `Cobertura se mapearmos top 100: +${top100} itens (${((top100 / rows.length) * 100).toFixed(1)}% do total)`,
);

// Salvar JSON pra inspeção
fs.writeFileSync(
  path.join("scripts", "out", "ml-fallback-by-category.json"),
  JSON.stringify(
    sorted.map(([cat, items]) => ({
      category: cat,
      count: items.length,
      sampleTitles: items.slice(0, 5).map((i) => i.title),
    })),
    null,
    2,
  ),
);
console.log("\nLista completa em scripts/out/ml-fallback-by-category.json");
