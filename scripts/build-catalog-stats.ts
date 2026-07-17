/**
 * build-catalog-stats.ts
 *
 * Job (batch noturno) que recalcula a tabela CatalogStat a partir de TODOS os
 * produtos vivos de TODOS os usuários. Alimenta a "sugestão da base interna" no
 * cadastro de produto (endpoint GET /marketplace/internal/suggest).
 *
 * Núcleo é AGREGAÇÃO DETERMINÍSTICA (mediana/moda/união), nunca LLM. Privacidade:
 * o SELECT NUNCA traz costPrice/markup; só persistimos famílias com >= 5 membros
 * (gate em finalizeFamily); a tabela guarda apenas agregados.
 *
 * Agrupamento que NÃO fragmenta: a chave de grupo é (partType, brand, model,
 * version) — SEM ano. O ano de cada produto alimenta a faixa min/max do grupo.
 * Emissão em dois níveis por família base (partType,brand,model):
 *   - 1 linha version-agnóstica (version="*") com TODOS os membros;
 *   - 1 linha por `version` cujo subgrupo tenha >= 5 membros.
 *
 * Idempotência: upsert por matchKey com computedAt=runStartedAt e prune final
 * (deleteMany computedAt < runStartedAt) → tabela 100% reproduzível por execução.
 *
 * Uso:
 *   npx tsx scripts/build-catalog-stats.ts --dry-run
 *   npx tsx scripts/build-catalog-stats.ts --batch=2000
 *   npx tsx scripts/build-catalog-stats.ts --part-type=cubo-de-roda   (debug)
 *
 * Agendamento: ver Fase 7 do plano (cron no host da API). Rodar 1x manual após
 * o deploy para popular a tabela.
 */

import "dotenv/config";
import { Prisma } from "@prisma/client";
import prisma from "../app/lib/prisma";
import {
  buildLookupColumns,
  kebab,
  parseTitleToParts,
  parseYearToNumber,
} from "../app/marketplaces/lib/title-parse";
import {
  finalizeFamily,
  type CatalogStatRow,
  type FamilyInput,
} from "../app/marketplaces/lib/catalog-stats-aggregation";
import type { AttrMap, CompatLike } from "../app/produtos/lib/suggestion-merge";

interface Args {
  dryRun: boolean;
  batch: number;
  partTypeFilter: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false, batch: 1000, partTypeFilter: null };
  for (const a of argv) {
    if (a === "--dry-run") args.dryRun = true;
    else if (a.startsWith("--batch=")) {
      const n = parseInt(a.slice("--batch=".length), 10);
      if (Number.isFinite(n) && n > 0) args.batch = n;
    } else if (a.startsWith("--part-type=")) {
      args.partTypeFilter = a.slice("--part-type=".length).trim() || null;
    }
  }
  return args;
}

/** Acumulador mutável de uma família (vira FamilyInput no finalize). */
function emptyFamily(
  partType: string,
  brand: string,
  model: string,
  version: string,
): FamilyInput {
  return {
    partType,
    brand,
    model,
    version,
    memberCount: 0,
    prices: [],
    weights: [],
    heights: [],
    widths: [],
    lengths: [],
    years: [],
    qualities: [],
    partNumbers: [],
    versions: [],
    sourceVehicles: [],
    mlCategoryIds: [],
    shopeeCategoryIds: [],
    attributesList: [],
    compatibilities: [],
  };
}

// Forma mínima do produto lido (apenas colunas permitidas — sem costPrice/markup).
interface ProductRow {
  id: string;
  name: string;
  price: unknown;
  quality: string | null;
  brand: string | null;
  model: string | null;
  year: string | null;
  version: string | null;
  partNumber: string | null;
  sourceVehicle: string | null;
  weightKg: unknown;
  heightCm: number | null;
  widthCm: number | null;
  lengthCm: number | null;
  attributes: unknown;
  mlCategoryId: string | null;
  shopeeCategoryId: string | null;
  compatibilities: Array<{
    brand: string;
    model: string;
    yearFrom: number | null;
    yearTo: number | null;
    version: string | null;
  }>;
}

const toNum = (v: unknown): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Acrescenta os valores de um produto a uma família. */
function pushProduct(fam: FamilyInput, p: ProductRow): void {
  fam.memberCount++;

  const price = toNum(p.price);
  if (price != null) fam.prices.push(price);
  const w = toNum(p.weightKg);
  if (w != null) fam.weights.push(w);
  if (p.heightCm != null) fam.heights.push(p.heightCm);
  if (p.widthCm != null) fam.widths.push(p.widthCm);
  if (p.lengthCm != null) fam.lengths.push(p.lengthCm);

  const year = parseYearToNumber(p.year);
  if (year != null) fam.years.push(year);

  if (p.quality && p.quality.trim()) fam.qualities.push(p.quality.trim());
  if (p.partNumber && p.partNumber.trim())
    fam.partNumbers.push(p.partNumber.trim());
  if (p.version && p.version.trim()) fam.versions.push(p.version.trim());
  if (p.sourceVehicle && p.sourceVehicle.trim())
    fam.sourceVehicles.push(p.sourceVehicle.trim());
  if (p.mlCategoryId && p.mlCategoryId.trim())
    fam.mlCategoryIds.push(p.mlCategoryId.trim());
  if (p.shopeeCategoryId && p.shopeeCategoryId.trim())
    fam.shopeeCategoryIds.push(p.shopeeCategoryId.trim());

  if (
    p.attributes &&
    typeof p.attributes === "object" &&
    !Array.isArray(p.attributes)
  ) {
    fam.attributesList.push(p.attributes as AttrMap);
  }
  if (Array.isArray(p.compatibilities) && p.compatibilities.length > 0) {
    for (const c of p.compatibilities)
      fam.compatibilities.push(c as CompatLike);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runStartedAt = new Date();
  console.log(
    JSON.stringify({
      event: "catalog-stats.start",
      dryRun: args.dryRun,
      batch: args.batch,
      partTypeFilter: args.partTypeFilter,
      at: runStartedAt.toISOString(),
    }),
  );

  // Buckets por chave de lookup "partType|brand|model|version".
  const families = new Map<string, FamilyInput>();
  let scanned = 0;
  let contributing = 0;
  let cursor: string | null = null;

  for (;;) {
    const rows: ProductRow[] = (await prisma.product.findMany({
      take: args.batch,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: "asc" },
      select: {
        id: true,
        name: true,
        price: true,
        quality: true,
        brand: true,
        model: true,
        year: true,
        version: true,
        partNumber: true,
        sourceVehicle: true,
        weightKg: true,
        heightCm: true,
        widthCm: true,
        lengthCm: true,
        attributes: true,
        mlCategoryId: true,
        shopeeCategoryId: true,
        // costPrice / markup NUNCA são selecionados (privacidade).
        compatibilities: {
          select: {
            brand: true,
            model: true,
            yearFrom: true,
            yearTo: true,
            version: true,
          },
        },
      },
    })) as unknown as ProductRow[];

    if (rows.length === 0) break;

    for (const p of rows) {
      scanned++;
      // MESMA derivação do endpoint (parseTitleToParts sobre o texto) — garante
      // que a chave gravada aqui case com a consultada na sugestão. Derivamos do
      // `name` (não das colunas) para alinhar com o título que o usuário digita.
      const parts = parseTitleToParts(p.name);
      const partType = parts.partType;
      if (!partType) continue;
      if (args.partTypeFilter && partType !== args.partTypeFilter) continue;

      // Família partType-only (partType|*|*|*): alimenta o Sinal B do motor de
      // inferência de categoria para produtos SEM marca/modelo no título. A
      // cascata do /internal/suggest exige brand+model reais e tem guard
      // explícito contra "*" — estas linhas nunca vazam lá.
      const ptCols = buildLookupColumns({
        partType,
        brand: null,
        model: null,
        version: null,
      });
      const ptKey = `${ptCols.partType}|*|*|*`;
      let ptFam = families.get(ptKey);
      if (!ptFam) {
        ptFam = emptyFamily(ptCols.partType, "*", "*", "*");
        families.set(ptKey, ptFam);
      }
      pushProduct(ptFam, p);

      const brand = kebab(parts.brand);
      const model = kebab(parts.model);
      // Níveis por família exigem partType + brand + model (alinhado à cascata).
      if (!brand || !model) continue;
      contributing++;

      const versionKebab = kebab(p.version);

      // Linha version-agnóstica (sempre).
      const agnosticCols = buildLookupColumns({
        partType,
        brand,
        model,
        version: null,
      });
      const agnosticKey = `${agnosticCols.partType}|${agnosticCols.brand}|${agnosticCols.model}|*`;
      let agnostic = families.get(agnosticKey);
      if (!agnostic) {
        agnostic = emptyFamily(
          agnosticCols.partType,
          agnosticCols.brand,
          agnosticCols.model,
          "*",
        );
        families.set(agnosticKey, agnostic);
      }
      pushProduct(agnostic, p);

      // Linha version-específica (só quando há versão).
      if (versionKebab) {
        const vKey = `${agnosticCols.partType}|${agnosticCols.brand}|${agnosticCols.model}|${versionKebab}`;
        let vFam = families.get(vKey);
        if (!vFam) {
          vFam = emptyFamily(
            agnosticCols.partType,
            agnosticCols.brand,
            agnosticCols.model,
            versionKebab,
          );
          families.set(vKey, vFam);
        }
        pushProduct(vFam, p);
      }
    }

    cursor = rows[rows.length - 1].id;
    if (scanned % (args.batch * 10) === 0) {
      console.log(
        JSON.stringify({
          event: "catalog-stats.progress",
          scanned,
          families: families.size,
        }),
      );
    }
  }

  // Finaliza: aplica gate (>=5), estatística e monta as linhas.
  const targets: CatalogStatRow[] = [];
  for (const fam of families.values()) {
    const row = finalizeFamily(fam);
    if (row) targets.push(row);
  }

  console.log(
    JSON.stringify({
      event: "catalog-stats.finalized",
      scanned,
      contributing,
      families: families.size,
      rows: targets.length,
    }),
  );

  if (args.dryRun) {
    for (const r of targets.slice(0, 20)) {
      console.log(
        JSON.stringify({
          matchKey: r.matchKey,
          sampleSize: r.sampleSize,
          priceMedian: r.priceMedian,
          yearFrom: r.yearFrom,
          yearTo: r.yearTo,
        }),
      );
    }
    console.log(
      JSON.stringify({
        event: "catalog-stats.dry-run.done",
        wouldUpsert: targets.length,
      }),
    );
    return;
  }

  // Upsert idempotente por matchKey.
  let upserted = 0;
  for (const r of targets) {
    const data = {
      ...r,
      attributes:
        r.attributes === null
          ? Prisma.JsonNull
          : (r.attributes as Prisma.InputJsonValue),
      compatibilities:
        r.compatibilities === null
          ? Prisma.JsonNull
          : (r.compatibilities as unknown as Prisma.InputJsonValue),
      computedAt: runStartedAt,
    };
    await prisma.catalogStat.upsert({
      where: { matchKey: r.matchKey },
      create: data,
      update: data,
    });
    upserted++;
    if (upserted % 500 === 0) {
      console.log(
        JSON.stringify({ event: "catalog-stats.upsert.progress", upserted }),
      );
    }
  }

  // Prune: remove tudo que não foi recalculado nesta execução.
  const pruned = await prisma.catalogStat.deleteMany({
    where: { computedAt: { lt: runStartedAt } },
  });

  console.log(
    JSON.stringify({
      event: "catalog-stats.done",
      upserted,
      pruned: pruned.count,
      elapsedMs: Date.now() - runStartedAt.getTime(),
    }),
  );
}

main()
  .catch((err) => {
    console.error("[build-catalog-stats] erro fatal:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
