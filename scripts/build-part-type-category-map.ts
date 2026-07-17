/**
 * build-part-type-category-map.ts
 *
 * Gera o mapa "tipo de peça → categoria por marketplace" a partir das
 * categorias JÁ ESCOLHIDAS na base (moda por partType), com gates de qualidade.
 * Alimenta `app/marketplaces/lib/category-inference/part-type-category-map.data.ts`
 * (Sinal A do motor de inferência de categoria).
 *
 * 100% READ-ONLY no banco. A "escrita" é o arquivo .ts gerado (com --write),
 * cujo diff é revisado em PR — a curadoria é a revisão do diff. Curadoria
 * manual permanente vai em part-type-category-map.overrides.ts (nunca tocado
 * por este script).
 *
 * Gates (lógica pura em category-inference/map-generation.ts; só entra quem
 * passa em TODOS, por chave × marketplace):
 *  - label-base não-ambíguo (AMBIGUOUS_LABELS: "motor", "sensor", "capa"…);
 *  - amostra ≥ 10; moda ≥ 50% da amostra; moda ≥ 1.5× o segundo colocado;
 *  - resolve para FOLHA na árvore local (ensureLeafLocalOnly);
 *  - domínio: ML dentro da raiz veicular (estrito) e fora do ramo Motos;
 *    Shopee automotivo e fora dos ramos Barcos/Pesados/Motocicletas;
 *  - anti "categoria-lixão": mesma categoria como moda de ≥ 3 tipos-base
 *    distintos só sobrevive onde o label bate com o nome da folha.
 *
 * Chaves com posição dobrada ("parachoque-dianteiro") só são emitidas quando a
 * moda difere da chave-base — o lookup cai para a base no caso comum.
 *
 * Uso:
 *   npm run map:part-type-categories                          # preview + rejeições
 *   npm run map:part-type-categories -- --write               # grava o data.ts
 *   npm run map:part-type-categories -- --report=out.json
 *   npm run map:part-type-categories -- --min-sample=10 --batch=2000
 */

import "dotenv/config";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import prisma from "../app/lib/prisma";
import {
  extractPartType,
  extractPosition,
} from "../app/marketplaces/lib/title-parse";
import { basePartTypeKey } from "../app/marketplaces/lib/category-inference/part-type-category-map";
import type { PartTypeCategoryEntry } from "../app/marketplaces/lib/category-inference/part-type-category-map";
import {
  AMBIGUOUS_LABELS,
  ML_BLOCKED_BRANCHES,
  SHOPEE_AUTOMOTIVE_MARKERS,
  SHOPEE_BLOCKED_BRANCHES,
  baseKeyOf,
  dumpCategoryRejects,
  modeOf,
  normalizePath,
  statisticalGate,
} from "../app/marketplaces/lib/category-inference/map-generation";
import { CategoryResolutionService } from "../app/marketplaces/services/category-resolution.service";

const DATA_FILE = resolve(
  __dirname,
  "../app/marketplaces/lib/category-inference/part-type-category-map.data.ts",
);

interface Args {
  write: boolean;
  reportPath: string | null;
  minSample: number;
  batch: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    write: false,
    reportPath: null,
    minSample: 10,
    batch: 2000,
  };
  for (const a of argv) {
    if (a === "--write") args.write = true;
    else if (a.startsWith("--report=")) args.reportPath = a.slice(9);
    else if (a.startsWith("--min-sample=")) {
      const n = parseInt(a.slice(13), 10);
      if (Number.isFinite(n) && n > 0) args.minSample = n;
    } else if (a.startsWith("--batch=")) {
      const n = parseInt(a.slice(8), 10);
      if (Number.isFinite(n) && n > 0) args.batch = n;
    }
  }
  return args;
}

type Counts = Map<string, number>;
/** chave (partType base ou dobrado) → contagem por categoria. */
type KeyAgg = Map<string, { ml: Counts; shopee: Counts; total: number }>;

function bump(counts: Counts, key: string) {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function aggFor(agg: KeyAgg, key: string) {
  let entry = agg.get(key);
  if (!entry) {
    entry = { ml: new Map(), shopee: new Map(), total: 0 };
    agg.set(key, entry);
  }
  return entry;
}

interface Rejection {
  key: string;
  marketplace: "ml" | "shopee";
  reason: string;
  mode?: string;
  fullPath?: string;
  count?: number;
  sample?: number;
  runnerUp?: { value: string; count: number } | null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `[map] varrendo produtos (batch=${args.batch}, minSample=${args.minSample}, write=${args.write})`,
  );

  const agg: KeyAgg = new Map();
  let scanned = 0;
  let cursor: string | null = null;

  // Varredura por cursor — select mínimo, nunca traz preço/custo.
  for (;;) {
    const rows: Array<{
      id: string;
      name: string;
      mlCategoryId: string | null;
      shopeeCategoryId: string | null;
    }> = await prisma.product.findMany({
      select: { id: true, name: true, mlCategoryId: true, shopeeCategoryId: true },
      orderBy: { id: "asc" },
      take: args.batch,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (!rows.length) break;
    cursor = rows[rows.length - 1].id;
    scanned += rows.length;

    for (const row of rows) {
      const folded = extractPartType(row.name);
      if (!folded) continue;
      const position = extractPosition(row.name);
      const base = basePartTypeKey(folded, position);
      if (AMBIGUOUS_LABELS.has(base)) continue;

      const keys = folded === base ? [base] : [base, folded];
      for (const key of keys) {
        const entry = aggFor(agg, key);
        entry.total += 1;
        if (row.mlCategoryId) bump(entry.ml, row.mlCategoryId);
        if (row.shopeeCategoryId) bump(entry.shopee, row.shopeeCategoryId);
      }
    }
    if (scanned % 20000 < args.batch) {
      console.log(`[map] ${scanned} produtos varridos, ${agg.size} chaves`);
    }
  }
  console.log(`[map] varredura completa: ${scanned} produtos, ${agg.size} chaves`);

  // cuids ML → externalId/fullPath (um único IN por lote de 500).
  const mlCuids = new Set<string>();
  for (const entry of agg.values()) {
    for (const cuid of entry.ml.keys()) mlCuids.add(cuid);
  }
  const cuidToCategory = new Map<
    string,
    { externalId: string | null; fullPath: string | null }
  >();
  const cuidList = Array.from(mlCuids);
  for (let i = 0; i < cuidList.length; i += 500) {
    const chunk = cuidList.slice(i, i + 500);
    const cats = await prisma.marketplaceCategory.findMany({
      where: { id: { in: chunk } },
      select: { id: true, externalId: true, fullPath: true },
    });
    for (const c of cats) {
      cuidToCategory.set(c.id, {
        externalId: c.externalId,
        fullPath: c.fullPath,
      });
    }
  }

  // Shopee: fullPath das categorias candidatas (externalId = SHP_<id>).
  const shopeeIds = new Set<string>();
  for (const entry of agg.values()) {
    for (const id of entry.shopee.keys()) shopeeIds.add(id);
  }
  const shopeeIdToPath = new Map<string, string | null>();
  const shopeeList = Array.from(shopeeIds);
  for (let i = 0; i < shopeeList.length; i += 500) {
    const chunk = shopeeList.slice(i, i + 500);
    const cats = await prisma.marketplaceCategory.findMany({
      where: { externalId: { in: chunk.map((id) => `SHP_${id}`) } },
      select: { externalId: true, fullPath: true },
    });
    for (const c of cats) {
      shopeeIdToPath.set(c.externalId.slice(4), c.fullPath);
    }
  }

  // ── Fase 1: gates por chave × marketplace → candidatos ──
  interface Candidate {
    key: string;
    baseKey: string;
    marketplace: "ml" | "shopee";
    /** ml: externalId MLB; shopee: id puro sem prefixo. */
    value: string;
    /** id no namespace da árvore (p/ contagem de lixão). */
    treeId: string;
    leafPath: string;
    sample: number;
  }

  const candidates: Candidate[] = [];
  const rejections: Rejection[] = [];
  const gaps: string[] = [];

  const sortedKeys = Array.from(agg.keys()).sort();
  for (const key of sortedKeys) {
    const entry = agg.get(key)!;
    let any = false;

    // ── ML ──
    const mlMode = modeOf(entry.ml);
    if (mlMode && mlMode.sample >= args.minSample) {
      any = true;
      const cat = cuidToCategory.get(mlMode.value);
      const reject = (reason: string) =>
        rejections.push({
          key,
          marketplace: "ml",
          reason,
          mode: cat?.externalId ?? mlMode.value,
          fullPath: cat?.fullPath ?? undefined,
          count: mlMode.count,
          sample: mlMode.sample,
          runnerUp: mlMode.runnerUp,
        });

      const statReason = statisticalGate(mlMode, args.minSample);
      if (statReason) reject(statReason);
      else if (!cat?.externalId) reject("cuid sem categoria na árvore");
      else if (
        ML_BLOCKED_BRANCHES.some((b) =>
          normalizePath(cat.fullPath ?? "").includes(b),
        )
      )
        reject("ramo bloqueado (motos)");
      else {
        const leaf = await CategoryResolutionService.ensureLeafLocalOnly(
          cat.externalId,
        );
        if (!leaf?.externalId) reject("não resolve para folha");
        else {
          const domain = await CategoryResolutionService.assertWithinVehicleRoot(
            leaf.externalId,
          );
          // Estrito: not_in_tree (fail-open no publish) REPROVA aqui.
          if (!domain.ok || domain.reason)
            reject(`domínio: ${domain.reason ?? "fora da raiz"}`);
          else
            candidates.push({
              key,
              baseKey: baseKeyOf(key),
              marketplace: "ml",
              value: leaf.externalId,
              treeId: leaf.externalId,
              leafPath: leaf.fullPath ?? cat.fullPath ?? "",
              sample: mlMode.sample,
            });
        }
      }
    }

    // ── Shopee ──
    const shopeeMode = modeOf(entry.shopee);
    if (shopeeMode && shopeeMode.sample >= args.minSample) {
      any = true;
      const path = shopeeIdToPath.get(shopeeMode.value);
      const reject = (reason: string) =>
        rejections.push({
          key,
          marketplace: "shopee",
          reason,
          mode: shopeeMode.value,
          fullPath: path ?? undefined,
          count: shopeeMode.count,
          sample: shopeeMode.sample,
          runnerUp: shopeeMode.runnerUp,
        });

      const statReason = statisticalGate(shopeeMode, args.minSample);
      if (statReason) reject(statReason);
      else if (!path) reject("categoria fora da árvore local");
      else if (
        !SHOPEE_AUTOMOTIVE_MARKERS.some((m) => normalizePath(path).includes(m))
      )
        reject("fullPath sem marcador automotivo");
      else if (
        SHOPEE_BLOCKED_BRANCHES.some((b) => normalizePath(path).includes(b))
      )
        reject("ramo bloqueado (barcos/pesados/motos)");
      else {
        const leaf = await CategoryResolutionService.ensureLeafLocalOnly(
          `SHP_${shopeeMode.value}`,
        );
        if (!leaf?.externalId) reject("não resolve para folha");
        else {
          const id = leaf.externalId.startsWith("SHP_")
            ? leaf.externalId.slice(4)
            : leaf.externalId;
          candidates.push({
            key,
            baseKey: baseKeyOf(key),
            marketplace: "shopee",
            value: id,
            treeId: leaf.externalId,
            leafPath: leaf.fullPath ?? path,
            sample: shopeeMode.sample,
          });
        }
      }
    }

    if (!any) gaps.push(key);
  }

  // ── Fase 2: anti "categoria-lixão" ──
  const dumped = dumpCategoryRejects(candidates);
  const surviving = candidates.filter((c) => {
    if (!dumped.has(c)) return true;
    rejections.push({
      key: c.key,
      marketplace: c.marketplace,
      reason: "categoria-lixão (moda de vários tipos distintos, label não bate com a folha)",
      mode: c.value,
      fullPath: c.leafPath,
      sample: c.sample,
    });
    return false;
  });

  // ── Fase 3: montagem final ──
  const generated: Record<string, PartTypeCategoryEntry> = {};
  for (const c of surviving) {
    const out = (generated[c.key] ??= { source: "prod-mode" });
    if (c.marketplace === "ml") out.ml = c.value;
    else out.shopee = c.value;
    out.sampleSize = Math.max(out.sampleSize ?? 0, c.sample);
  }

  // Chave dobrada só fica quando difere da base em ALGUM marketplace mapeado.
  for (const key of Object.keys(generated)) {
    const base = baseKeyOf(key);
    if (base === key) continue;
    const baseEntry = generated[base];
    if (!baseEntry) continue;
    const sameMl = !generated[key].ml || generated[key].ml === baseEntry.ml;
    const sameShopee =
      !generated[key].shopee || generated[key].shopee === baseEntry.shopee;
    if (sameMl && sameShopee) delete generated[key];
  }

  // ── Saída ──
  const keys = Object.keys(generated).sort();
  const lines: string[] = [];
  lines.push("/**");
  lines.push(
    " * GERADO por `scripts/build-part-type-category-map.ts` — NÃO editar à mão.",
  );
  lines.push(
    " * Curadoria manual vai em `part-type-category-map.overrides.ts` (merge por",
  );
  lines.push(" * cima deste arquivo; nunca é clobberada pelo gerador).");
  lines.push(" *");
  lines.push(
    " * Cada entrada mapeia um tipo de peça canônico (label do PART_TYPES de",
  );
  lines.push(
    " * title-parse.ts, com posição dobrada opcional) para a categoria-FOLHA de cada",
  );
  lines.push(
    " * marketplace. Origem `prod-mode` = moda das categorias escolhidas manualmente",
  );
  lines.push(
    " * na base, aprovada nos gates do gerador (amostra, dominância, folha, domínio).",
  );
  lines.push(" *");
  lines.push(
    " * Processo de atualização: rodar o gerador, revisar o DIFF deste arquivo em PR",
  );
  lines.push(" * próprio (a curadoria é a revisão do diff).");
  lines.push(" */");
  lines.push("");
  lines.push('import type { PartTypeCategoryMap } from "./part-type-category-map";');
  lines.push("");
  lines.push(
    "export const GENERATED_PART_TYPE_CATEGORY_MAP: PartTypeCategoryMap = {",
  );
  for (const key of keys) {
    const e = generated[key];
    const fields: string[] = [];
    if (e.ml) fields.push(`ml: ${JSON.stringify(e.ml)}`);
    if (e.shopee) fields.push(`shopee: ${JSON.stringify(e.shopee)}`);
    if (e.magaluId) fields.push(`magaluId: ${JSON.stringify(e.magaluId)}`);
    if (e.magaluTerm) fields.push(`magaluTerm: ${JSON.stringify(e.magaluTerm)}`);
    fields.push(`source: ${JSON.stringify(e.source)}`);
    if (e.sampleSize) fields.push(`sampleSize: ${e.sampleSize}`);
    lines.push(`  ${JSON.stringify(key)}: { ${fields.join(", ")} },`);
  }
  lines.push("};");
  lines.push("");
  const content = lines.join("\n");

  console.log(
    `[map] geradas ${keys.length} chaves (${
      keys.filter((k) => generated[k].ml).length
    } com ML, ${keys.filter((k) => generated[k].shopee).length} com Shopee); ` +
      `${rejections.length} rejeições; ${gaps.length} gaps sem amostra`,
  );

  if (args.write) {
    writeFileSync(DATA_FILE, content, "utf8");
    console.log(`[map] escrito: ${DATA_FILE}`);
  } else {
    console.log("[map] preview (use --write para gravar):");
    console.log(content.split("\n").slice(14, 44).join("\n"));
  }

  if (args.reportPath) {
    writeFileSync(
      resolve(args.reportPath),
      JSON.stringify({ scanned, keys: keys.length, rejections, gaps }, null, 2),
      "utf8",
    );
    console.log(`[map] relatório: ${args.reportPath}`);
  } else if (rejections.length) {
    console.log("[map] rejeições (curadoria manual em overrides se fizer sentido):");
    for (const r of rejections.slice(0, 40)) {
      console.log(
        `  - ${r.key} [${r.marketplace}] ${r.reason} (moda=${r.mode} ${r.count}/${r.sample}${
          r.runnerUp ? `, 2º=${r.runnerUp.value} ${r.runnerUp.count}` : ""
        })${r.fullPath ? ` :: ${r.fullPath}` : ""}`,
      );
    }
    if (rejections.length > 40)
      console.log(`  … +${rejections.length - 40} (use --report=arquivo.json)`);
  }
}

main()
  .catch((err) => {
    console.error("[map] erro:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
