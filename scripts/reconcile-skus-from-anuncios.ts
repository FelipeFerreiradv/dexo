import "dotenv/config";
import path from "path";
import fs from "fs";
import XLSX from "xlsx";
import { Prisma } from "@prisma/client";
import prisma from "../app/lib/prisma";
import { normalizeSku } from "../app/lib/sku";

/**
 * Reconcilia o `Product.sku` do Dexo com o SKU real dos anúncios do Mercado
 * Livre, a partir do export "Anúncios" do ML (colunas ITEM_ID=MLB, SKU).
 *
 * Match: Product → ProductListing.externalListingId (MLB) → linha da tabela
 * pelo MLB → SKU. Atualiza `Product.sku` + `skuNormalized` (e opcionalmente
 * `ProductListing.externalSku`). Idempotente (só altera se diferente); pula
 * colisões de `@@unique([userId, sku])` (SKU já usado / duplicado na tabela).
 *
 * Escopo padrão: produtos com `attributes.migration=<tag>` (default "704") —
 * os migrados com SKU numérico errado. `--all` = todos os produtos do user.
 *
 * Uso (chame o tsx DIRETO):
 *   npx tsx scripts/reconcile-skus-from-anuncios.ts --dry-run
 *   npx tsx scripts/reconcile-skus-from-anuncios.ts --apply
 *   npx tsx scripts/reconcile-skus-from-anuncios.ts --apply --update-external-sku
 */

type RawRow = Record<string, unknown>;

const DEFAULT_USER_ID = "cmql2zugq0000vs8g376rend5"; // cliente 704
const DEFAULT_FILE = path.resolve(__dirname, "data", "reconcile", "anuncios-704.xlsx");
const OUT_DIR = path.resolve(__dirname, "out");

interface Flags {
  userId: string;
  dryRun: boolean;
  apply: boolean;
  file: string;
  migrationTag: string; // "" = ignora (usa --all)
  all: boolean;
  updateExternalSku: boolean;
  limit: number | null;
}

function parseFlags(argv: string[]): Flags {
  const get = (name: string): string | undefined => {
    const flag = `--${name}=`;
    const found = argv.find((a) => a.startsWith(flag));
    return found ? found.slice(flag.length) : undefined;
  };
  const has = (name: string): boolean => argv.includes(`--${name}`);
  const apply = has("apply");
  const limitRaw = get("limit");
  return {
    userId: get("user-id") ?? DEFAULT_USER_ID,
    apply,
    dryRun: has("dry-run") || !apply,
    file: get("file") ?? DEFAULT_FILE,
    migrationTag: get("migration-tag") ?? "704",
    all: has("all"),
    updateExternalSku: has("update-external-sku"),
    limit: limitRaw && /^\d+$/.test(limitRaw) ? parseInt(limitRaw, 10) : null,
  };
}

function asString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s.length > 0 ? s : null;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002"
  );
}

function pushCap<T>(arr: T[], item: T, cap = 2000): void {
  if (arr.length < cap) arr.push(item);
}

function normMlb(raw: unknown): string | null {
  const s = asString(raw);
  if (!s) return null;
  const t = s.trim().toUpperCase();
  return /^MLB\d+$/.test(t) ? t : null;
}

/**
 * Lê a sheet "Anúncios" do export ML e devolve `MLB → SKU` (só linhas reais:
 * ITEM_ID começa com MLB e SKU preenchido). Também os MLBs sem SKU e os SKUs
 * duplicados (2+ anúncios com o mesmo SKU).
 */
function readAnuncios(filePath: string): {
  mlbToSku: Map<string, string>;
  noSku: string[];
  dupSkus: Set<string>;
  totalListings: number;
} {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Arquivo não encontrado: ${resolved}`);
  }
  const wb = XLSX.readFile(resolved);
  const sheetName =
    wb.SheetNames.find(
      (n) => n.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase() === "anuncios",
    ) ?? wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json<RawRow>(wb.Sheets[sheetName], {
    defval: null,
  });

  const mlbToSku = new Map<string, string>();
  const noSku: string[] = [];
  const skuCount = new Map<string, number>();
  let totalListings = 0;
  for (const r of rows) {
    const mlb = normMlb(r["ITEM_ID"]);
    if (!mlb) continue; // pula cabeçalhos/metadados
    totalListings++;
    const sku = asString(r["SKU"]);
    if (!sku) {
      noSku.push(mlb);
      continue;
    }
    // primeira ocorrência do MLB vence (não há variações nesta base)
    if (!mlbToSku.has(mlb)) mlbToSku.set(mlb, sku);
    skuCount.set(sku, (skuCount.get(sku) ?? 0) + 1);
  }
  const dupSkus = new Set(
    [...skuCount.entries()].filter(([, c]) => c > 1).map(([s]) => s),
  );
  console.log(
    `[sheet] '${sheetName}': ${totalListings} anúncios | ${mlbToSku.size} com SKU | ${noSku.length} sem SKU | ${dupSkus.size} SKU(s) duplicado(s)`,
  );
  return { mlbToSku, noSku, dupSkus, totalListings };
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const flags = parseFlags(process.argv.slice(2));
  console.log(
    `[reconcile-skus] userId=${flags.userId} modo=${flags.dryRun ? "DRY-RUN" : "APPLY"} escopo=${flags.all ? "TODOS" : `migration=${flags.migrationTag}`}`,
  );

  const user = await prisma.user.findUnique({
    where: { id: flags.userId },
    select: { id: true, email: true, role: true },
  });
  if (!user) throw new Error(`Usuário ${flags.userId} não encontrado.`);
  console.log(`[preflight] user=${user.email} role=${user.role}`);

  const { mlbToSku, noSku, dupSkus } = readAnuncios(flags.file);

  // Todos os SKUs atuais do user (para detectar colisão de unicidade).
  const allProducts = await prisma.product.findMany({
    where: { userId: flags.userId },
    select: { id: true, sku: true },
  });
  const skuToProductId = new Map<string, string>();
  for (const p of allProducts) skuToProductId.set(p.sku, p.id);

  // Produtos-alvo (com anúncio ML) — escopo migration=tag ou todos.
  const whereScope: Prisma.ProductWhereInput = flags.all
    ? { userId: flags.userId }
    : {
        userId: flags.userId,
        attributes: { path: ["migration"], equals: flags.migrationTag },
      };
  const targets = await prisma.product.findMany({
    where: whereScope,
    select: {
      id: true,
      sku: true,
      listings: {
        where: { externalListingId: { startsWith: "MLB" } },
        select: { id: true, externalListingId: true },
      },
    },
  });
  console.log(`[reconcile-skus] produtos no escopo: ${targets.length}`);

  // Passo 1: computa o SKU desejado (produto → target) via MLB.
  interface Plan {
    productId: string;
    currentSku: string;
    targetSku: string;
    mlb: string;
    listingIds: string[];
  }
  const plans: Plan[] = [];
  const sum = {
    scope: targets.length,
    already_correct: 0,
    no_listing: 0,
    mlb_not_in_table: 0,
    no_sku_in_table: 0,
    to_update: 0,
    updated: 0,
    conflict_dup_target: 0,
    conflict_existing_sku: 0,
    errors: 0,
    details: [] as unknown[],
    conflictDetails: [] as unknown[],
  };

  for (const p of targets) {
    if (p.listings.length === 0) {
      sum.no_listing++;
      continue;
    }
    // acha o 1º MLB do produto que está na tabela (com ou sem SKU).
    let mlb: string | null = null;
    for (const l of p.listings) {
      const m = normMlb(l.externalListingId);
      if (m && (mlbToSku.has(m) || noSku.includes(m))) {
        mlb = m;
        break;
      }
    }
    if (!mlb) {
      sum.mlb_not_in_table++;
      continue;
    }
    const targetSku = mlbToSku.get(mlb);
    if (!targetSku) {
      sum.no_sku_in_table++;
      pushCap(sum.details, { productId: p.id, mlb, reason: "no_sku_in_table" });
      continue;
    }
    if (targetSku === p.sku) {
      sum.already_correct++;
      continue;
    }
    const listingIds = p.listings
      .filter((l) => normMlb(l.externalListingId) === mlb)
      .map((l) => l.id);
    plans.push({
      productId: p.id,
      currentSku: p.sku,
      targetSku,
      mlb,
      listingIds,
    });
  }

  // Passo 2: separa o conflito "duro" — SKU alvo desejado por 2+ produtos, ou
  // duplicado na tabela (ambíguo; não atribui). O resto vai ao loop iterativo.
  const targetCount = new Map<string, number>();
  for (const pl of plans) {
    targetCount.set(pl.targetSku, (targetCount.get(pl.targetSku) ?? 0) + 1);
  }
  const candidates: Plan[] = [];
  for (const pl of plans) {
    if ((targetCount.get(pl.targetSku) ?? 0) > 1 || dupSkus.has(pl.targetSku)) {
      sum.conflict_dup_target++;
      pushCap(sum.conflictDetails, { ...pl, reason: "conflict_dup_target" });
    } else {
      candidates.push(pl);
    }
  }

  // Passo 3: aplica com mapa VIVO de SKU→produto. Ao atualizar, libera o SKU
  // antigo e reserva o novo — resolve cadeias de troca (A libera o SKU que B
  // quer). O que sobra sem nunca liberar = conflito real (SKU de produto que
  // não se move) ou ciclo.
  const liveSku = new Map(skuToProductId);
  const applyCap = flags.limit ?? Infinity;
  let remaining = candidates;
  let progress = true;
  while (remaining.length > 0 && progress && sum.updated < applyCap) {
    progress = false;
    const next: Plan[] = [];
    for (const pl of remaining) {
      if (sum.updated >= applyCap) {
        next.push(pl);
        continue;
      }
      const holder = liveSku.get(pl.targetSku);
      if (holder !== undefined && holder !== pl.productId) {
        next.push(pl); // alvo ainda ocupado por outro; tenta na próxima volta
        continue;
      }
      if (!flags.dryRun) {
        try {
          await prisma.product.update({
            where: { id: pl.productId },
            data: {
              sku: pl.targetSku,
              skuNormalized: normalizeSku(pl.targetSku),
            },
          });
          if (flags.updateExternalSku && pl.listingIds.length) {
            await prisma.productListing.updateMany({
              where: { id: { in: pl.listingIds } },
              data: { externalSku: pl.targetSku },
            });
          }
        } catch (err) {
          if (isUniqueViolation(err)) {
            next.push(pl);
            continue;
          }
          sum.errors++;
          pushCap(sum.details, {
            ...pl,
            error: err instanceof Error ? err.message : String(err),
          });
          continue;
        }
      }
      liveSku.delete(pl.currentSku);
      liveSku.set(pl.targetSku, pl.productId);
      sum.updated++;
      progress = true;
      pushCap(sum.details, {
        productId: pl.productId,
        mlb: pl.mlb,
        de: pl.currentSku,
        para: pl.targetSku,
        reason: flags.dryRun ? "would_update" : "updated",
      });
      if (sum.updated % 500 === 0) {
        console.log(`[reconcile-skus] atualizados=${sum.updated}`);
      }
    }
    remaining = next;
  }
  for (const pl of remaining) {
    sum.conflict_existing_sku++;
    pushCap(sum.conflictDetails, {
      ...pl,
      reason: "conflict_existing_sku",
      holder: liveSku.get(pl.targetSku),
    });
  }
  sum.to_update = sum.updated + remaining.length;

  // Relatório
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = path.join(OUT_DIR, `reconcile-skus-${stamp}.json`);
  fs.writeFileSync(
    reportPath,
    JSON.stringify(
      {
        userId: flags.userId,
        mode: flags.dryRun ? "dry-run" : "apply",
        startedAt,
        finishedAt: new Date().toISOString(),
        flags: {
          scope: flags.all ? "all" : `migration=${flags.migrationTag}`,
          updateExternalSku: flags.updateExternalSku,
          limit: flags.limit,
        },
        summary: sum,
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log(`[report] ${reportPath}`);

  console.log("\n===== RESUMO =====");
  console.log(`modo: ${flags.dryRun ? "DRY-RUN (0 escritas)" : "APPLY"}`);
  console.log(`  SKUs ${flags.dryRun ? "a atualizar" : "atualizados"}: ${sum.updated}`);
  console.log(`  já corretos:              ${sum.already_correct}`);
  console.log(`  sem anúncio:              ${sum.no_listing}`);
  console.log(`  MLB fora da tabela:       ${sum.mlb_not_in_table}`);
  console.log(`  MLB sem SKU na tabela:    ${sum.no_sku_in_table}`);
  console.log(`  conflito SKU duplicado:   ${sum.conflict_dup_target}`);
  console.log(`  conflito SKU já usado:    ${sum.conflict_existing_sku}`);
  console.log(`  erros:                    ${sum.errors}`);
  console.log("==================\n");

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("[reconcile-skus][fatal]", e);
  await prisma.$disconnect();
  process.exit(1);
});
