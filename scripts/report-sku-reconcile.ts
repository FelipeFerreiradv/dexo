import "dotenv/config";
import path from "path";
import fs from "fs";
import XLSX from "xlsx";
import prisma from "../app/lib/prisma";

/**
 * RELATÓRIO (100% read-only, nunca escreve) da reconciliação de SKU 704 ×
 * anúncios do ML. Recomputa a mesma categorização de
 * `reconcile-skus-from-anuncios.ts` e exporta planilha multi-aba + JSON.
 *
 *   npx tsx scripts/report-sku-reconcile.ts
 */

type RawRow = Record<string, unknown>;

const DEFAULT_USER_ID = "cmql2zugq0000vs8g376rend5"; // 704
const DEFAULT_FILE = path.resolve(__dirname, "data", "reconcile", "anuncios-704.xlsx");
const OUT_DIR = path.resolve(__dirname, "out");
const MIGRATION_TAG = "704";

function asString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}
function normMlb(v: unknown): string | null {
  const s = asString(v);
  if (!s) return null;
  const t = s.trim().toUpperCase();
  return /^MLB\d+$/.test(t) ? t : null;
}

function readAnuncios(filePath: string) {
  const wb = XLSX.readFile(path.resolve(filePath));
  const sheetName =
    wb.SheetNames.find(
      (n) => n.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase() === "anuncios",
    ) ?? wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json<RawRow>(wb.Sheets[sheetName], { defval: null });
  const mlbToSku = new Map<string, string>();
  const noSkuMlbs = new Set<string>();
  const skuCount = new Map<string, number>();
  let total = 0;
  for (const r of rows) {
    const mlb = normMlb(r["ITEM_ID"]);
    if (!mlb) continue;
    total++;
    const sku = asString(r["SKU"]);
    if (!sku) {
      noSkuMlbs.add(mlb);
      continue;
    }
    if (!mlbToSku.has(mlb)) mlbToSku.set(mlb, sku);
    skuCount.set(sku, (skuCount.get(sku) ?? 0) + 1);
  }
  const dupSkus = new Set([...skuCount.entries()].filter(([, c]) => c > 1).map(([s]) => s));
  return { mlbToSku, noSkuMlbs, dupSkus, total };
}

async function main() {
  const userId = process.argv.find((a) => a.startsWith("--user-id="))?.split("=")[1] ?? DEFAULT_USER_ID;
  const file = process.argv.find((a) => a.startsWith("--file="))?.split("=")[1] ?? DEFAULT_FILE;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });
  if (!user) throw new Error(`Usuário ${userId} não encontrado`);
  console.log(`[report] user=${user.email}`);

  const { mlbToSku, noSkuMlbs, dupSkus, total } = readAnuncios(file);
  console.log(`[report] anúncios=${total} comSKU=${mlbToSku.size} semSKU=${noSkuMlbs.size} dupSKU=${dupSkus.size}`);

  const allProducts = await prisma.product.findMany({
    where: { userId },
    select: { id: true, sku: true, name: true },
  });
  const skuToId = new Map<string, string>();
  const byId = new Map<string, { sku: string; name: string | null }>();
  for (const p of allProducts) {
    skuToId.set(p.sku, p.id);
    byId.set(p.id, { sku: p.sku, name: p.name });
  }

  const targets = await prisma.product.findMany({
    where: { userId, attributes: { path: ["migration"], equals: MIGRATION_TAG } },
    select: {
      id: true,
      sku: true,
      name: true,
      listings: {
        where: { externalListingId: { startsWith: "MLB" } },
        select: { externalListingId: true },
      },
    },
  });

  const cat = {
    corrigir: [] as Array<{ mlb: string; skuAtual: string; skuNovo: string; produto: string }>,
    duplicatas: [] as Array<{ mlb: string; skuMigrado: string; produtoMigrado: string; skuCorreto: string; holderId: string; produtoDono: string }>,
    dupTabela: [] as Array<{ mlb: string; skuAlvo: string; skuAtual: string; produto: string }>,
    semAnuncio: [] as Array<{ skuAtual: string; produto: string }>,
    mlbForaTabela: [] as Array<{ mlb: string; skuAtual: string; produto: string }>,
    anuncioSemSku: [] as Array<{ mlb: string; skuAtual: string; produto: string }>,
    jaCorreto: 0,
  };

  interface Plan { id: string; currentSku: string; targetSku: string; mlb: string; name: string }
  const plans: Plan[] = [];

  for (const p of targets) {
    const name = p.name ?? "";
    if (p.listings.length === 0) {
      cat.semAnuncio.push({ skuAtual: p.sku, produto: name });
      continue;
    }
    let mlb: string | null = null;
    for (const l of p.listings) {
      const m = normMlb(l.externalListingId);
      if (m && (mlbToSku.has(m) || noSkuMlbs.has(m))) {
        mlb = m;
        break;
      }
    }
    if (!mlb) {
      cat.mlbForaTabela.push({ mlb: p.listings.map((l) => l.externalListingId).join(","), skuAtual: p.sku, produto: name });
      continue;
    }
    const targetSku = mlbToSku.get(mlb);
    if (!targetSku) {
      cat.anuncioSemSku.push({ mlb, skuAtual: p.sku, produto: name });
      continue;
    }
    if (targetSku === p.sku) {
      cat.jaCorreto++;
      continue;
    }
    plans.push({ id: p.id, currentSku: p.sku, targetSku, mlb, name });
  }

  // dup-target (SKU alvo desejado por 2+ ou duplicado na tabela)
  const targetCount = new Map<string, number>();
  for (const pl of plans) targetCount.set(pl.targetSku, (targetCount.get(pl.targetSku) ?? 0) + 1);
  const candidates: Plan[] = [];
  for (const pl of plans) {
    if ((targetCount.get(pl.targetSku) ?? 0) > 1 || dupSkus.has(pl.targetSku)) {
      cat.dupTabela.push({ mlb: pl.mlb, skuAlvo: pl.targetSku, skuAtual: pl.currentSku, produto: pl.name });
    } else {
      candidates.push(pl);
    }
  }

  // simulação iterativa (mapa vivo) → corrigir vs duplicata(conflito real)
  const liveSku = new Map(skuToId);
  let remaining = candidates;
  let progress = true;
  while (remaining.length > 0 && progress) {
    progress = false;
    const next: Plan[] = [];
    for (const pl of remaining) {
      const holder = liveSku.get(pl.targetSku);
      if (holder !== undefined && holder !== pl.id) {
        next.push(pl);
        continue;
      }
      liveSku.delete(pl.currentSku);
      liveSku.set(pl.targetSku, pl.id);
      cat.corrigir.push({ mlb: pl.mlb, skuAtual: pl.currentSku, skuNovo: pl.targetSku, produto: pl.name });
      progress = true;
    }
    remaining = next;
  }
  for (const pl of remaining) {
    const holderId = liveSku.get(pl.targetSku) ?? "";
    cat.duplicatas.push({
      mlb: pl.mlb,
      skuMigrado: pl.currentSku,
      produtoMigrado: pl.name,
      skuCorreto: pl.targetSku,
      holderId,
      produtoDono: byId.get(holderId)?.name ?? "",
    });
  }

  // enriquece as duplicatas: o dono tem anúncio?
  const holderIds = [...new Set(cat.duplicatas.map((d) => d.holderId).filter(Boolean))];
  const holderListingCount = new Map<string, number>();
  if (holderIds.length) {
    const hs = await prisma.product.findMany({
      where: { id: { in: holderIds } },
      select: { id: true, _count: { select: { listings: true } } },
    });
    for (const h of hs) holderListingCount.set(h.id, h._count.listings);
  }

  const resumo = {
    userId,
    email: user.email,
    geradoEm: new Date().toISOString(),
    totalMigrados: targets.length,
    anunciosNaTabela: total,
    corrigir: cat.corrigir.length,
    jaCorreto: cat.jaCorreto,
    duplicatas: cat.duplicatas.length,
    semAnuncio: cat.semAnuncio.length,
    mlbForaTabela: cat.mlbForaTabela.length,
    anuncioSemSku: cat.anuncioSemSku.length,
    dupNaTabelaML: cat.dupTabela.length,
  };
  console.log("[report] RESUMO:", JSON.stringify(resumo, null, 2));

  // Verificação de consistência (deve casar com o reconcile dry-run)
  const soma =
    cat.corrigir.length + cat.jaCorreto + cat.duplicatas.length + cat.semAnuncio.length +
    cat.mlbForaTabela.length + cat.anuncioSemSku.length + cat.dupTabela.length;
  console.log(`[report] soma das categorias = ${soma} (deve ser = ${targets.length} migrados) → ${soma === targets.length ? "OK" : "DIVERGÊNCIA!"}`);

  // Exporta XLSX multi-aba
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const wb = XLSX.utils.book_new();
  const add = (name: string, rows: unknown[]) =>
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows.length ? rows : [{}]), name);

  add("Resumo", [
    { Métrica: "Produtos migrados (704)", Valor: targets.length },
    { Métrica: "Anúncios ativos na tabela", Valor: total },
    { Métrica: "SKUs a CORRIGIR", Valor: cat.corrigir.length },
    { Métrica: "Já corretos", Valor: cat.jaCorreto },
    { Métrica: "DUPLICATAS (produto já existe sem anúncio)", Valor: cat.duplicatas.length },
    { Métrica: "Sem anúncio vinculado", Valor: cat.semAnuncio.length },
    { Métrica: "MLB fora da tabela de ativos", Valor: cat.mlbForaTabela.length },
    { Métrica: "Anúncio sem SKU na tabela", Valor: cat.anuncioSemSku.length },
    { Métrica: "SKU duplicado na tabela do ML", Valor: cat.dupTabela.length },
  ]);
  add("1_Corrigir", cat.corrigir.map((x) => ({ MLB: x.mlb, "SKU atual (errado)": x.skuAtual, "SKU novo (correto)": x.skuNovo, Produto: x.produto })));
  add("2_Duplicatas", cat.duplicatas.map((x) => ({
    MLB: x.mlb,
    "SKU migrado (com anúncio)": x.skuMigrado,
    "Produto migrado": x.produtoMigrado,
    "SKU correto (já usado)": x.skuCorreto,
    "Produto pré-existente (dono do SKU)": x.produtoDono,
    "Dono tem anúncio?": (holderListingCount.get(x.holderId) ?? 0) > 0 ? "SIM" : "NÃO",
    holderId: x.holderId,
  })));
  add("3_SemAnuncio", cat.semAnuncio.map((x) => ({ "SKU atual": x.skuAtual, Produto: x.produto })));
  add("4_MLB_fora_da_tabela", cat.mlbForaTabela.map((x) => ({ MLB: x.mlb, "SKU atual": x.skuAtual, Produto: x.produto })));
  add("5_Anuncio_sem_SKU", cat.anuncioSemSku.map((x) => ({ MLB: x.mlb, "SKU atual": x.skuAtual, Produto: x.produto })));
  add("6_SKU_dup_no_ML", cat.dupTabela.map((x) => ({ MLB: x.mlb, "SKU alvo (duplicado)": x.skuAlvo, "SKU atual": x.skuAtual, Produto: x.produto })));

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const xlsxPath = path.join(OUT_DIR, `relatorio-skus-704-${stamp}.xlsx`);
  XLSX.writeFile(wb, xlsxPath);
  const jsonPath = path.join(OUT_DIR, `relatorio-skus-704-${stamp}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify({ resumo, cat, holderListingCount: Object.fromEntries(holderListingCount) }, null, 2), "utf8");
  console.log(`[report] xlsx: ${xlsxPath}`);
  console.log(`[report] json: ${jsonPath}`);

  await prisma.$disconnect();
}
main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
