/**
 * validate-category-inference.ts
 *
 * Replay READ-ONLY contra a base: compara a sugestão de categoria ANTES
 * (CATEGORY_INFERENCE_DISABLED=1) e DEPOIS (inferência ligada) usando como
 * gabarito a categoria JÁ ESCOLHIDA de produtos reais. Critério de aceite da
 * integração: precision@1 nova >= antiga e zero autoApply cross-domain.
 *
 * Gabarito ML = Product.mlCategoryId (cuid→externalId, resolvido a folha);
 * gabarito Shopee = SHP_<shopeeCategoryId> (idem). Ressalva Shopee: o gabarito
 * histórico contém poluição de imports legados (ex.: tudo em "Barra de
 * Proteção") — uma divergência ali pode ser a sugestão CERTA discordando de um
 * gabarito errado; ler o CSV antes de concluir.
 *
 * Uso:
 *   npx tsx scripts/validate-category-inference.ts --sample=400
 *   npx tsx scripts/validate-category-inference.ts --sample=400 --csv=out.csv
 */

import "dotenv/config";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import prisma from "../app/lib/prisma";
import CategorySuggestionService from "../app/marketplaces/services/category-suggestion.service";
import { CategoryResolutionService } from "../app/marketplaces/services/category-resolution.service";

interface Args {
  sample: number;
  csvPath: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { sample: 400, csvPath: null };
  for (const a of argv) {
    if (a.startsWith("--sample=")) {
      const n = parseInt(a.slice(9), 10);
      if (Number.isFinite(n) && n > 0) args.sample = n;
    } else if (a.startsWith("--csv=")) args.csvPath = a.slice(6);
  }
  return args;
}

interface Case {
  siteId: "MLB" | "SHP";
  name: string;
  /** externalId-folha da categoria escolhida (gabarito). */
  truth: string;
}

interface PassResult {
  top1: string | null;
  top3: string[];
  top1AutoApply: boolean;
  top1FullPath: string | null;
}

async function runPass(cases: Case[]): Promise<Map<Case, PassResult>> {
  const out = new Map<Case, PassResult>();
  for (const c of cases) {
    const res = await CategorySuggestionService.suggestFromTitle(
      c.name,
      c.siteId,
    );
    const top = res.suggestions[0];
    out.set(c, {
      top1: top?.categoryId ?? null,
      top3: res.suggestions.slice(0, 3).map((s) => s.categoryId),
      top1AutoApply: Boolean(top?.autoApply),
      top1FullPath: top?.fullPath ?? null,
    });
  }
  return out;
}

interface Metrics {
  n: number;
  top1: number;
  top3: number;
  autoApply: number;
  autoApplyWrong: number;
  empty: number;
}

function measure(cases: Case[], pass: Map<Case, PassResult>): Metrics {
  const m: Metrics = { n: cases.length, top1: 0, top3: 0, autoApply: 0, autoApplyWrong: 0, empty: 0 };
  for (const c of cases) {
    const r = pass.get(c)!;
    if (!r.top1) m.empty++;
    if (r.top1 === c.truth) m.top1++;
    if (r.top3.includes(c.truth)) m.top3++;
    if (r.top1AutoApply) {
      m.autoApply++;
      if (r.top1 !== c.truth) m.autoApplyWrong++;
    }
  }
  return m;
}

function pct(x: number, n: number): string {
  return n ? `${((100 * x) / n).toFixed(1)}%` : "-";
}

function printMetrics(label: string, before: Metrics, after: Metrics) {
  console.log(`\n── ${label} (n=${before.n}) ──`);
  console.log(
    `  precision@1: ${pct(before.top1, before.n)} -> ${pct(after.top1, after.n)}`,
  );
  console.log(
    `  precision@3: ${pct(before.top3, before.n)} -> ${pct(after.top3, after.n)}`,
  );
  console.log(
    `  sem sugestão: ${pct(before.empty, before.n)} -> ${pct(after.empty, after.n)}`,
  );
  console.log(
    `  autoApply no top-1: ${before.autoApply} -> ${after.autoApply} (divergentes do gabarito: ${before.autoApplyWrong} -> ${after.autoApplyWrong})`,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`[validate] amostrando ~${args.sample} casos por marketplace (read-only)`);

  // Amostra determinística: produtos recentes com categoria escolhida.
  const mlRows = await prisma.product.findMany({
    where: { mlCategoryId: { not: null } },
    select: { name: true, mlCategory: { select: { externalId: true } } },
    orderBy: { id: "desc" },
    take: args.sample * 3,
  });
  const shpRows = await prisma.product.findMany({
    where: { shopeeCategoryId: { not: null } },
    select: { name: true, shopeeCategoryId: true },
    orderBy: { id: "desc" },
    take: args.sample * 3,
  });

  // Espaça a amostra (1 a cada 3) p/ diluir lotes de import contíguos e
  // resolve o gabarito a FOLHA (as sugestões são sempre folhas).
  const cases: Case[] = [];
  const truthLeafCache = new Map<string, string | null>();
  async function truthLeaf(externalId: string): Promise<string | null> {
    const hit = truthLeafCache.get(externalId);
    if (hit !== undefined) return hit;
    const leaf = await CategoryResolutionService.ensureLeafLocalOnly(externalId);
    const result = leaf?.externalId ?? null;
    truthLeafCache.set(externalId, result);
    return result;
  }

  for (let i = 0; i < mlRows.length && cases.filter((c) => c.siteId === "MLB").length < args.sample; i += 3) {
    const ext = mlRows[i].mlCategory?.externalId;
    if (!ext || !mlRows[i].name) continue;
    const leaf = await truthLeaf(ext);
    if (!leaf) continue;
    cases.push({ siteId: "MLB", name: mlRows[i].name, truth: leaf });
  }
  for (let i = 0; i < shpRows.length && cases.filter((c) => c.siteId === "SHP").length < args.sample; i += 3) {
    const id = shpRows[i].shopeeCategoryId;
    if (!id || !shpRows[i].name) continue;
    const leaf = await truthLeaf(`SHP_${id}`);
    if (!leaf) continue;
    cases.push({ siteId: "SHP", name: shpRows[i].name, truth: leaf });
  }

  const mlCases = cases.filter((c) => c.siteId === "MLB");
  const shpCases = cases.filter((c) => c.siteId === "SHP");
  console.log(`[validate] casos: ML=${mlCases.length}, Shopee=${shpCases.length}`);

  // Passe ANTES (inferência desligada) — flag lida a cada chamada.
  process.env.CATEGORY_INFERENCE_DISABLED = "1";
  const before = await runPass(cases);

  // Passe DEPOIS — o cache de resultado por título precisa ser limpo.
  (CategorySuggestionService as any).suggestResultCache?.clear?.();
  delete process.env.CATEGORY_INFERENCE_DISABLED;
  const after = await runPass(cases);

  printMetrics("Mercado Livre", measure(mlCases, before), measure(mlCases, after));
  printMetrics("Shopee", measure(shpCases, before), measure(shpCases, after));

  // Divergências novas (mudou de certo p/ errado OU autoApply divergente novo).
  const rows: string[] = [
    "siteId;name;truth;top1_antes;top1_depois;autoApply_depois;fullPath_depois",
  ];
  let regressions = 0;
  for (const c of cases) {
    const b = before.get(c)!;
    const a = after.get(c)!;
    if (b.top1 === c.truth && a.top1 !== c.truth) regressions++;
    if (b.top1 !== a.top1 || (a.top1AutoApply && a.top1 !== c.truth)) {
      rows.push(
        [c.siteId, c.name.replace(/;/g, ","), c.truth, b.top1 ?? "", a.top1 ?? "", a.top1AutoApply ? "1" : "0", (a.top1FullPath ?? "").replace(/;/g, ",")].join(";"),
      );
    }
  }
  console.log(`\n[validate] top-1 que era CERTO e virou errado: ${regressions}`);
  if (args.csvPath) {
    writeFileSync(resolve(args.csvPath), rows.join("\n"), "utf8");
    console.log(`[validate] divergências: ${args.csvPath} (${rows.length - 1} linhas)`);
  }
}

main()
  .catch((err) => {
    console.error("[validate] erro:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
