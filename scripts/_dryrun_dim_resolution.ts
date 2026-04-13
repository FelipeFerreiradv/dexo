/**
 * Dry-run: aplica resolveDim() em todas as linhas da auditoria e mostra estatísticas.
 * NÃO escreve nada no DB nem chama o ML.
 */
import fs from "node:fs";
import path from "node:path";
import { resolveDim } from "./_ml_dim_defaults";

interface Row {
  itemId: string;
  account: string;
  title: string;
  category: string;
  permalink?: string;
}

const rows: Row[] = JSON.parse(fs.readFileSync(path.join("scripts", "out", "ml-dims-audit.json"), "utf-8"));

const bySource: Record<string, number> = {};
const byTier: Record<string, number> = {};
const sampleByTier: Record<string, string[]> = {};

for (const r of rows) {
  const dim = resolveDim(r.category, r.title);
  bySource[dim.source.split(":")[0]] = (bySource[dim.source.split(":")[0]] || 0) + 1;
  const tier = dim.source.split(":").pop()!;
  byTier[tier] = (byTier[tier] || 0) + 1;
  if (!sampleByTier[tier]) sampleByTier[tier] = [];
  if (sampleByTier[tier].length < 3) sampleByTier[tier].push(`${r.category} | ${r.title.slice(0, 60)}`);
}

console.log("=== Origem da resolução ===");
for (const [k, v] of Object.entries(bySource).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(10)} ${String(v).padStart(6)}  (${((v / rows.length) * 100).toFixed(1)}%)`);
}

console.log("\n=== Distribuição por tier ===");
for (const [k, v] of Object.entries(byTier).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(12)} ${String(v).padStart(6)}  (${((v / rows.length) * 100).toFixed(1)}%)`);
  for (const s of sampleByTier[k] || []) console.log(`     - ${s}`);
}

const out = rows.map((r) => {
  const d = resolveDim(r.category, r.title);
  return { itemId: r.itemId, category: r.category, title: r.title, ...d };
});
fs.writeFileSync(path.join("scripts", "out", "ml-dim-resolution.json"), JSON.stringify(out, null, 2));
console.log(`\nResolução completa salva em scripts/out/ml-dim-resolution.json (${out.length} linhas)`);
