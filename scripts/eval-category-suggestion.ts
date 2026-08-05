/**
 * eval-category-suggestion.ts — a REGUA da sugestao de categoria.
 *
 * READ-ONLY por construcao: `--dry-run` e o padrao e nao existe caminho de
 * escrita neste arquivo. Roda a sugestao sobre produtos reais e reporta, por
 * marketplace, o quanto ela acerta ANTES e DEPOIS da mudanca em avaliacao.
 *
 * ── Por que este script existe, se ja ha validate-category-inference.ts ──
 * O validate compara os dois lados do kill-switch da INFERENCIA e usa como
 * gabarito qualquer produto com categoria preenchida — inclusive as que a
 * propria sugestao preencheu. Ou seja: parte da "precision@1" que ele reporta e
 * o sistema concordando consigo mesmo. Aqui o gabarito e filtrado por origem.
 *
 * ── O que e gabarito confiavel (medido em 04/08/2026 contra producao) ──
 * `Product.*Source` e uma coluna String livre, nao enum. Valores reais:
 *   mlCategorySource:     IMPORT_RESOLVED 10406 | auto 5226 | null 4899
 *                         ml-orphan-import 3322 | manual 1598 | auto_discovery 353
 *   shopeeCategorySource: manual 6022 | auto_discovery 50
 *   magaluCategorySource: manual 577
 *
 * SO o ML distingue de verdade: create/edit-product-dialog comparam a categoria
 * escolhida com `autoDetectedRef` antes de gravar "manual" ou "auto". Na Shopee
 * e na Magalu o front grava "manual" tambem quando a sugestao automatica foi
 * apenas aceita passivamente, entao "manual" ali NAO significa humano.
 *
 * Consequencia, e este script assume isso explicitamente:
 *   - ML     -> acuracia real, gabarito = mlCategorySource 'manual' (1.598
 *               produtos, 18 tenants, 209 categorias distintas). Enviesado para
 *               baixo: so entram casos em que o humano DISCORDOU da sugestao ou
 *               em que nao havia sugestao. E o subconjunto dificil, de proposito.
 *
 * ── LEIA ISTO ANTES DE CITAR O "top-1 exato" DO ML ──
 * O front grava "manual" exatamente quando a categoria final DIFERE da que ele
 * auto-detectou (create-product-dialog.tsx:2650-2656). Ou seja: neste conjunto,
 * "top-1 exato" ser quase zero e em boa parte DEFINICIONAL, nao uma medida de
 * qualidade — se a sugestao tivesse acertado, a linha teria virado "auto" e
 * saido da amostra. Somam-se a isso os gabaritos NAO-FOLHA (as sugestoes sao
 * sempre folhas, entao nunca casam exatamente com um no intermediario).
 *
 * As metricas que NAO sofrem desse vies, e que sao as que valem aqui:
 *   - "mesmo ramo": a sugestao caiu no mesmo galho da arvore que a escolha
 *     humana (ancestral, descendente ou irma). Um bom sugeridor rejeitado por
 *     uma nuance pontuaria alto aqui. Pontuar baixo significa que ele esta
 *     indo para galhos completamente diferentes — isso e defeito de verdade.
 *   - top-3 / top-5: a escolha do humano aparece em algum lugar da lista?
 *   - autoApply divergente: auto-aplicar categoria errada e pior do que nao
 *     auto-aplicar. Este numero PRECISA cair.
 * O bloco "so folhas" reportado abaixo isola a parcela definicional do nao-folha.
 *   - Shopee -> NAO-REGRESSAO sobre titulos reais (o top-1 que existe hoje nao
 *               pode sumir, "sem sugestao" nao pode crescer, zero auto-aplicacao
 *               fora do dominio automotivo) + fixture curada a parte.
 *   - Magalu -> idem Shopee, e a arvore nem esta em MarketplaceCategory (a
 *               resolucao e por API), entao aqui so entra o que for local.
 *
 * ── Gabarito nao vira folha a forca ──
 * `CategoryResolutionService.ensureLeafLocalOnly` desce para o filho chamado
 * "Outros" ou, na falta dele, para o PRIMEIRO filho — escolha arbitraria. Usar
 * isso no gabarito inventa uma verdade. Aqui a verdade e a categoria que o
 * humano escolheu, como esta, e o nao-folha e contabilizado e reportado.
 *
 * Uso:
 *   npx tsx scripts/eval-category-suggestion.ts
 *   npx tsx scripts/eval-category-suggestion.ts --sample=600 --csv=out.csv
 *   npx tsx scripts/eval-category-suggestion.ts --owner=<userId>
 *   npx tsx scripts/eval-category-suggestion.ts --enriched   (usa o contexto do produto)
 */

import "dotenv/config";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import prisma from "../app/lib/prisma";
import CategorySuggestionService from "../app/marketplaces/services/category-suggestion.service";
import CategoryRepository from "../app/marketplaces/repositories/category.repository";

// ─────────────────────────────────────────────────────────────────────────────
// Args
// ─────────────────────────────────────────────────────────────────────────────

interface Args {
  sample: number;
  csvPath: string | null;
  ownerId: string | null;
  enriched: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    sample: 400,
    csvPath: null,
    ownerId: null,
    enriched: false,
  };
  for (const a of argv) {
    if (a.startsWith("--sample=")) {
      const n = parseInt(a.slice(9), 10);
      if (Number.isFinite(n) && n > 0) args.sample = n;
    } else if (a.startsWith("--csv=")) args.csvPath = a.slice(6);
    else if (a.startsWith("--owner=")) args.ownerId = a.slice(8);
    else if (a === "--enriched") args.enriched = true;
  }
  return args;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tipos
// ─────────────────────────────────────────────────────────────────────────────

/** Contexto que o formulario ja tem em maos no momento em que pede a sugestao. */
export interface ProductContext {
  title: string;
  description?: string | null;
  brand?: string | null;
  model?: string | null;
  year?: string | null;
  version?: string | null;
  partNumber?: string | null;
  internalCategory?: string | null;
  sourceVehicle?: string | null;
  quality?: string | null;
  heightCm?: number | null;
  widthCm?: number | null;
  lengthCm?: number | null;
  weightKg?: number | null;
}

interface Case {
  productId: string;
  ownerId: string;
  siteId: "MLB" | "SHP";
  ctx: ProductContext;
  /** externalId da categoria escolhida, no namespace da arvore local. */
  truth: string;
  truthPath: string;
  /** true quando a categoria escolhida tem filhos (nao e folha). */
  truthIsBranch: boolean;
}

interface PassResult {
  top1: string | null;
  top1Path: string | null;
  top1AutoApply: boolean;
  topN: string[];
  elapsedMs: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Arvore local: ancestrais, para o credito parcial de "caminho pai"
// ─────────────────────────────────────────────────────────────────────────────

interface TreeIndex {
  parentOf: Map<string, string | null>;
  pathOf: Map<string, string>;
  hasChildren: Set<string>;
}

async function loadTree(siteId: string): Promise<TreeIndex> {
  const cats = await CategoryRepository.listWithParents(siteId);
  const parentOf = new Map<string, string | null>();
  const pathOf = new Map<string, string>();
  const hasChildren = new Set<string>();
  for (const c of cats) {
    parentOf.set(c.externalId, c.parentExternalId ?? null);
    pathOf.set(c.externalId, c.fullPath ?? c.name ?? c.externalId);
    if (c.parentExternalId) hasChildren.add(c.parentExternalId);
  }
  return { parentOf, pathOf, hasChildren };
}

function ancestorsOf(tree: TreeIndex, id: string): string[] {
  const out: string[] = [];
  let cur = tree.parentOf.get(id) ?? null;
  let guard = 0;
  while (cur && guard++ < 32) {
    out.push(cur);
    cur = tree.parentOf.get(cur) ?? null;
  }
  return out;
}

/**
 * Credito parcial: a sugestao esta no MESMO RAMO da verdade?
 * Conta como acerto de caminho quando a sugestao e a propria verdade, um
 * ancestral dela, um descendente dela, ou uma IRMA (mesmo pai) — que e o caso
 * que o enunciado pediu ("categoria irma conta como acerto parcial").
 */
function samePath(tree: TreeIndex, suggested: string, truth: string): boolean {
  if (suggested === truth) return true;
  if (ancestorsOf(tree, suggested).includes(truth)) return true;
  if (ancestorsOf(tree, truth).includes(suggested)) return true;
  const pa = tree.parentOf.get(suggested) ?? null;
  const pb = tree.parentOf.get(truth) ?? null;
  return Boolean(pa && pb && pa === pb);
}

// ─────────────────────────────────────────────────────────────────────────────
// Execucao de um passe
// ─────────────────────────────────────────────────────────────────────────────

const svc = CategorySuggestionService as any;

function clearSuggestCache() {
  svc.suggestResultCache?.clear?.();
}

async function runPass(
  cases: Case[],
  enriched: boolean,
): Promise<Map<Case, PassResult>> {
  const out = new Map<Case, PassResult>();
  for (const c of cases) {
    const t0 = Date.now();
    // `suggestFromProduct` so existe depois da etapa (b) do bloco. Enquanto nao
    // existir, o passe enriquecido cai no caminho por titulo — assim a regua
    // roda desde o primeiro dia e o baseline e comparavel.
    const res =
      enriched && typeof svc.suggestFromProduct === "function"
        ? await svc.suggestFromProduct(c.ctx, c.siteId)
        : await CategorySuggestionService.suggestFromTitle(
            c.ctx.title,
            c.siteId,
          );
    const elapsedMs = Date.now() - t0;
    const top = res.suggestions[0];
    out.set(c, {
      top1: top?.categoryId ?? null,
      top1Path: top?.fullPath ?? null,
      top1AutoApply: Boolean(top?.autoApply),
      topN: res.suggestions.slice(0, 5).map((s: any) => s.categoryId),
      elapsedMs,
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Metricas
// ─────────────────────────────────────────────────────────────────────────────

interface Metrics {
  n: number;
  top1: number;
  top3: number;
  top5: number;
  pathHit: number;
  empty: number;
  autoApply: number;
  autoApplyWrong: number;
  p50: number;
  p95: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.floor((p / 100) * sorted.length),
  );
  return sorted[idx];
}

function measure(
  cases: Case[],
  pass: Map<Case, PassResult>,
  tree: TreeIndex,
): Metrics {
  const m: Metrics = {
    n: cases.length,
    top1: 0,
    top3: 0,
    top5: 0,
    pathHit: 0,
    empty: 0,
    autoApply: 0,
    autoApplyWrong: 0,
    p50: 0,
    p95: 0,
  };
  const lat: number[] = [];
  for (const c of cases) {
    const r = pass.get(c)!;
    lat.push(r.elapsedMs);
    if (!r.top1) {
      m.empty++;
      continue;
    }
    if (r.top1 === c.truth) m.top1++;
    if (r.topN.slice(0, 3).includes(c.truth)) m.top3++;
    if (r.topN.slice(0, 5).includes(c.truth)) m.top5++;
    if (samePath(tree, r.top1, c.truth)) m.pathHit++;
    if (r.top1AutoApply) {
      m.autoApply++;
      if (r.top1 !== c.truth) m.autoApplyWrong++;
    }
  }
  lat.sort((a, b) => a - b);
  m.p50 = percentile(lat, 50);
  m.p95 = percentile(lat, 95);
  return m;
}

const pct = (x: number, n: number) =>
  n ? `${((100 * x) / n).toFixed(1)}%` : "-";

function printMetrics(label: string, before: Metrics, after: Metrics) {
  console.log(`\n── ${label} (n=${before.n}) ──`);
  const line = (name: string, b: number, a: number) => {
    const delta = a - b;
    const sinal = delta > 0 ? `+${delta}` : `${delta}`;
    console.log(
      `  ${name.padEnd(22)} ${pct(b, before.n).padStart(7)} -> ${pct(a, after.n).padStart(7)}  (${sinal})`,
    );
  };
  line("top-1 exato", before.top1, after.top1);
  line("top-3", before.top3, after.top3);
  line("top-5", before.top5, after.top5);
  line("mesmo ramo (parcial)", before.pathHit, after.pathHit);
  line("sem sugestao", before.empty, after.empty);
  console.log(
    `  ${"autoApply no top-1".padEnd(22)} ${before.autoApply} -> ${after.autoApply}` +
      `  (divergentes do gabarito: ${before.autoApplyWrong} -> ${after.autoApplyWrong})`,
  );
  console.log(
    `  ${"latencia p50/p95".padEnd(22)} ${before.p50}/${before.p95} ms -> ${after.p50}/${after.p95} ms`,
  );
}

/** Matriz dos 20 pares (esperado x sugerido) mais frequentes entre os erros. */
function printErrorMatrix(
  label: string,
  cases: Case[],
  pass: Map<Case, PassResult>,
) {
  const counter = new Map<string, { n: number; truth: string; got: string }>();
  for (const c of cases) {
    const r = pass.get(c)!;
    if (r.top1 === c.truth) continue;
    const got = r.top1Path ?? "(sem sugestao)";
    const key = `${c.truthPath} ${got}`;
    const hit = counter.get(key);
    if (hit) hit.n++;
    else counter.set(key, { n: 1, truth: c.truthPath, got });
  }
  const top = [...counter.values()].sort((a, b) => b.n - a.n).slice(0, 20);
  if (top.length === 0) return;
  console.log(
    `\n── ${label}: 20 erros mais frequentes (esperado -> sugerido) ──`,
  );
  const curto = (s: string) => (s.length > 62 ? `…${s.slice(-61)}` : s);
  for (const e of top) {
    console.log(`  ${String(e.n).padStart(4)}  ${curto(e.truth)}`);
    console.log(`        ->  ${curto(e.got)}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Montagem do conjunto de avaliacao
// ─────────────────────────────────────────────────────────────────────────────

const SELECT_CTX = {
  id: true,
  userId: true,
  name: true,
  description: true,
  brand: true,
  model: true,
  year: true,
  version: true,
  partNumber: true,
  category: true,
  sourceVehicle: true,
  quality: true,
  heightCm: true,
  widthCm: true,
  lengthCm: true,
  weightKg: true,
} as const;

function toCtx(row: any): ProductContext {
  return {
    title: row.name as string,
    description: row.description,
    brand: row.brand,
    model: row.model,
    year: row.year,
    version: row.version,
    partNumber: row.partNumber,
    internalCategory: row.category,
    sourceVehicle: row.sourceVehicle,
    quality: row.quality,
    heightCm: row.heightCm,
    widthCm: row.widthCm,
    lengthCm: row.lengthCm,
    weightKg: row.weightKg ? Number(row.weightKg) : null,
  };
}

async function buildMlCases(args: Args, tree: TreeIndex): Promise<Case[]> {
  const rows = await prisma.product.findMany({
    where: {
      mlCategorySource: "manual",
      mlCategoryId: { not: null },
      ...(args.ownerId ? { userId: args.ownerId } : {}),
    },
    select: {
      ...SELECT_CTX,
      mlCategory: { select: { externalId: true, fullPath: true, name: true } },
    },
    orderBy: { id: "desc" },
    take: args.sample * 3,
  });

  const cases: Case[] = [];
  // Espaca a amostra (1 a cada 3) para diluir lotes de import contiguos, mesma
  // tecnica do validate-category-inference.
  for (let i = 0; i < rows.length && cases.length < args.sample; i += 3) {
    const r = rows[i];
    const ext = r.mlCategory?.externalId;
    if (!ext || !r.name) continue;
    cases.push({
      productId: r.id,
      // Product.userId e String? no schema (existem produtos orfaos de import).
      ownerId: r.userId ?? "(sem dono)",
      siteId: "MLB",
      ctx: toCtx(r),
      truth: ext,
      truthPath: r.mlCategory?.fullPath ?? r.mlCategory?.name ?? ext,
      truthIsBranch: tree.hasChildren.has(ext),
    });
  }
  return cases;
}

/**
 * Shopee: o gabarito NAO e confiavel (ver cabecalho). Os casos entram apenas
 * para medir nao-regressao e latencia; a acuracia reportada vem com ressalva.
 */
async function buildShopeeCases(args: Args, tree: TreeIndex): Promise<Case[]> {
  const rows = await prisma.product.findMany({
    where: {
      shopeeCategoryId: { not: null },
      ...(args.ownerId ? { userId: args.ownerId } : {}),
    },
    select: { ...SELECT_CTX, shopeeCategoryId: true },
    orderBy: { id: "desc" },
    take: args.sample * 3,
  });

  const cases: Case[] = [];
  for (let i = 0; i < rows.length && cases.length < args.sample; i += 3) {
    const r = rows[i];
    if (!r.shopeeCategoryId || !r.name) continue;
    const ext = `SHP_${r.shopeeCategoryId}`;
    if (!tree.pathOf.has(ext)) continue; // categoria fora da arvore sincronizada
    cases.push({
      productId: r.id,
      // Product.userId e String? no schema (existem produtos orfaos de import).
      ownerId: r.userId ?? "(sem dono)",
      siteId: "SHP",
      ctx: toCtx(r),
      truth: ext,
      truthPath: tree.pathOf.get(ext)!,
      truthIsBranch: tree.hasChildren.has(ext),
    });
  }
  return cases;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const host = (process.env.DATABASE_URL ?? "").match(/@([^/:]+)/)?.[1] ?? "?";
  console.log(
    `[eval] READ-ONLY | host=${host} | amostra alvo=${args.sample}/marketplace` +
      `${args.ownerId ? ` | owner=${args.ownerId}` : ""}` +
      `${args.enriched ? " | contexto ENRIQUECIDO" : ""}`,
  );

  const [mlbTree, shpTree] = await Promise.all([
    loadTree("MLB"),
    loadTree("SHP"),
  ]);
  const mlCases = await buildMlCases(args, mlbTree);
  const shpCases = await buildShopeeCases(args, shpTree);

  const tenantsMl = new Set(mlCases.map((c) => c.ownerId)).size;
  const branchesMl = mlCases.filter((c) => c.truthIsBranch).length;
  console.log(
    `[eval] ML: ${mlCases.length} casos (gabarito humano) | ${tenantsMl} tenants | ` +
      `${new Set(mlCases.map((c) => c.truth)).size} categorias | ${branchesMl} gabaritos NAO-folha`,
  );
  console.log(
    `[eval] Shopee: ${shpCases.length} casos (gabarito CONTAMINADO — so nao-regressao)`,
  );
  console.log(
    `[eval] Magalu: 0 casos — a arvore nao vive em MarketplaceCategory ` +
      `(resolucao por API) e magaluCategorySource grava "manual" para sugestao aceita`,
  );

  const all = [...mlCases, ...shpCases];
  if (all.length === 0) {
    console.log("[eval] nenhum caso — nada a medir.");
    return;
  }

  // Passe ANTES: comportamento atual.
  process.env.CATEGORY_SUGGEST_V2_DISABLED = "1";
  clearSuggestCache();
  const before = await runPass(all, false);

  // Passe DEPOIS: com a mudanca em avaliacao ligada.
  delete process.env.CATEGORY_SUGGEST_V2_DISABLED;
  clearSuggestCache();
  const after = await runPass(all, args.enriched);

  printMetrics(
    "Mercado Livre (gabarito humano)",
    measure(mlCases, before, mlbTree),
    measure(mlCases, after, mlbTree),
  );

  // Subconjunto so-folha: tira a parcela de erro que e definicional (sugestao e
  // sempre folha, entao gabarito nao-folha nunca casa exato).
  const mlLeaf = mlCases.filter((c) => !c.truthIsBranch);
  if (mlLeaf.length > 0) {
    printMetrics(
      "Mercado Livre — so gabaritos FOLHA",
      measure(mlLeaf, before, mlbTree),
      measure(mlLeaf, after, mlbTree),
    );
  }
  printMetrics(
    "Shopee (gabarito contaminado — leia como nao-regressao)",
    measure(shpCases, before, shpTree),
    measure(shpCases, after, shpTree),
  );

  printErrorMatrix("Mercado Livre", mlCases, after);

  // Regressoes: o que era CERTO e virou errado. E o numero que veta a mudanca.
  let regrediu = 0;
  let melhorou = 0;
  const rows: string[] = [
    "siteId;productId;titulo;esperado;top1_antes;top1_depois;autoApply_depois;path_depois",
  ];
  for (const c of all) {
    const b = before.get(c)!;
    const a = after.get(c)!;
    if (b.top1 === c.truth && a.top1 !== c.truth) regrediu++;
    if (b.top1 !== c.truth && a.top1 === c.truth) melhorou++;
    if (b.top1 !== a.top1) {
      rows.push(
        [
          c.siteId,
          c.productId,
          c.ctx.title.replace(/;/g, ","),
          c.truth,
          b.top1 ?? "",
          a.top1 ?? "",
          a.top1AutoApply ? "1" : "0",
          (a.top1Path ?? "").replace(/;/g, ","),
        ].join(";"),
      );
    }
  }
  console.log(
    `\n[eval] top-1 que era CERTO e virou errado: ${regrediu} | que era errado e virou certo: ${melhorou}`,
  );

  if (args.csvPath) {
    writeFileSync(resolve(args.csvPath), rows.join("\n"), "utf8");
    console.log(
      `[eval] divergencias: ${args.csvPath} (${rows.length - 1} linhas)`,
    );
  }
}

main()
  .catch((err) => {
    console.error("[eval] erro:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
