/**
 * Limpeza de produtos legados Vaapt → IBR nas caixas numéricas (tenant IBR).
 *
 * SEGURANÇA:
 *  - DRY-RUN é o DEFAULT. Excluir exige `--execute`.
 *  - Em dry-run NADA é escrito no banco; só gera relatório (CSV/JSON) em scripts/out/.
 *  - Antes de excluir: backup JSON completo + recontagem de histórico (TOCTOU) + confirmação digitada.
 *  - Deleção via ProductUseCase.bulkDelete (encerra anúncios, política estrita) em lotes <=50.
 *  - Só são passados ao bulkDelete os ids do bucket `a_excluir` recalculados do zero.
 *
 * Uso:
 *   npx tsx scripts/cleanup-legacy-vaapt-ibr.ts                 # dry-run (default)
 *   npx tsx scripts/cleanup-legacy-vaapt-ibr.ts --execute --expected=3741
 *   flags: --user-email=<email>  --expected=<N>  --max=<N>  --execute
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import readline from "readline";
import prisma from "@/app/lib/prisma";
import { ProductUseCase } from "@/app/usecases/product.usercase";
import { chunk } from "@/app/lib/chunk";
import { bucketOf, isCaixaNumericaSimples, type Bucket } from "./lib/legacy-cleanup-rules";

const DEFAULT_EMAIL = "leonardo.lima.borges@outlook.com.br";
const OUT_DIR = path.resolve(__dirname, "out");
const BATCH = 50; // = BULK_DELETE_MAX_IDS

interface Flags {
  execute: boolean;
  email: string;
  expected: number | null;
  max: number | null;
}

function parseArgs(): Flags {
  const args = process.argv.slice(2);
  const get = (name: string): string | null => {
    const m = args.find((a) => a.startsWith(`--${name}=`));
    return m ? m.split("=").slice(1).join("=") : null;
  };
  const expected = get("expected");
  const max = get("max");
  return {
    execute: args.includes("--execute"),
    email: get("user-email") ?? DEFAULT_EMAIL,
    expected: expected != null ? Number(expected) : null,
    max: max != null ? Number(max) : null,
  };
}

function readLine(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(prompt, (a) => { rl.close(); resolve(a.trim()); }));
}

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const jsonReplacer = (_k: string, v: unknown) =>
  typeof v === "bigint" ? v.toString() : v;

function ts(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

interface Row {
  bucket: Bucket;
  rule: string;
  detail: string;
  productId: string;
  sku: string;
  locationCode: string;
  locationPath: string;
  name: string;
  hasOrder: boolean;
  hasNfe: boolean;
  hasReceivable: boolean;
  listings: number;
}

async function main() {
  const flags = parseArgs();
  const mode = flags.execute ? "EXECUTE" : "DRY-RUN";
  console.log(`\n=== cleanup-legacy-vaapt-ibr [${mode}] ===`);
  console.log(`tenant=${flags.email}${flags.expected != null ? `  expected=${flags.expected}` : ""}${flags.max != null ? `  max=${flags.max}` : ""}`);

  const user = await prisma.user.findFirst({ where: { email: flags.email }, select: { id: true, email: true } });
  if (!user) {
    console.error(`Usuário não encontrado: ${flags.email}`);
    process.exit(1);
  }
  const userId = user.id;

  // 1) Escopo (Location.code = caixa numérica simples) -------------------------
  const locations = await prisma.location.findMany({ where: { userId }, select: { id: true, code: true } });
  const scope = locations.filter((l) => isCaixaNumericaSimples(l.code));
  const codeById = new Map(scope.map((l) => [l.id, l.code]));
  const scopeIds = scope.map((l) => l.id);
  if (scopeIds.length === 0) {
    console.error("Nenhuma caixa numérica simples para este tenant. Abortando.");
    return;
  }

  // 2) Produtos em escopo + contagem de relações -------------------------------
  const prods = await prisma.product.findMany({
    where: { userId, locationId: { in: scopeIds } },
    select: {
      id: true,
      sku: true,
      name: true,
      location: true,
      locationId: true,
      _count: { select: { orderItems: true, nfeItens: true, receivableItems: true, listings: true } },
    },
  });

  // 3) Classificação -----------------------------------------------------------
  const rows: Row[] = prods.map((p) => {
    const hasOrder = p._count.orderItems > 0;
    const hasNfe = p._count.nfeItens > 0;
    const hasReceivable = p._count.receivableItems > 0;
    const r = bucketOf(p.sku, { inScope: true, hasOrderItem: hasOrder, hasNfeItem: hasNfe, hasReceivableItem: hasReceivable });
    return {
      bucket: r.bucket,
      rule: r.rule ?? "",
      detail: r.detail ?? "",
      productId: p.id,
      sku: p.sku,
      locationCode: (p.locationId && codeById.get(p.locationId)) || "",
      locationPath: p.location ?? "",
      name: p.name ?? "",
      hasOrder,
      hasNfe,
      hasReceivable,
      listings: p._count.listings,
    };
  });

  const byBucket = new Map<Bucket, Row[]>();
  for (const row of rows) {
    const arr = byBucket.get(row.bucket) ?? [];
    arr.push(row);
    byBucket.set(row.bucket, arr);
  }
  const aExcluir = byBucket.get("a_excluir") ?? [];

  // 4) Persistir relatório -----------------------------------------------------
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = ts();
  const csvPath = path.join(OUT_DIR, `legacy-cleanup-${stamp}.csv`);
  const jsonPath = path.join(OUT_DIR, `legacy-cleanup-${stamp}.json`);
  const header = [
    "bucket", "rule", "detail", "productId", "sku", "locationCode", "locationPath", "name",
    "hasOrder", "hasNfe", "hasReceivable", "listings",
  ].join(";");
  const lines = [header];
  for (const r of rows) {
    lines.push([
      r.bucket, r.rule, r.detail, r.productId, r.sku, r.locationCode, r.locationPath, r.name,
      r.hasOrder, r.hasNfe, r.hasReceivable, r.listings,
    ].map(csvEscape).join(";"));
  }
  fs.writeFileSync(csvPath, "﻿" + lines.join("\n"), "utf-8");

  const totals: Record<string, number> = {};
  for (const [b, arr] of byBucket.entries()) totals[b] = arr.length;
  fs.writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        tenant: user.email,
        userId,
        scopeLocations: scopeIds.length,
        totalProducts: prods.length,
        totals,
        aExcluirIds: aExcluir.map((r) => r.productId),
      },
      jsonReplacer,
      2,
    ),
    "utf-8",
  );

  // 5) Resumo no console -------------------------------------------------------
  const exActive = await countActiveListings(aExcluir.map((r) => r.productId));
  console.log(`\nEscopo: ${scopeIds.length} caixas, ${prods.length} produtos.`);
  console.log(`Totais por bucket:`);
  console.table(totals);

  // detalhamento de A_EXCLUIR (regra + prefixo/letra)
  const exclBreak: Record<string, number> = {};
  for (const r of aExcluir) {
    const k = r.rule === "convertido" ? `convertido_${r.detail}` : `cru_${r.detail}`;
    exclBreak[k] = (exclBreak[k] ?? 0) + 1;
  }
  console.log(`A_EXCLUIR por regra:`);
  console.table(exclBreak);

  // detalhamento de REVISAR e PROTEGIDO
  const revBreak: Record<string, number> = {};
  for (const r of byBucket.get("revisar") ?? []) revBreak[r.detail || "?"] = (revBreak[r.detail || "?"] ?? 0) + 1;
  console.log(`REVISAR por motivo (não excluídos):`);
  console.table(revBreak);

  console.log(`\n>>> A_EXCLUIR = ${aExcluir.length} produtos  (com anúncio ATIVO: ${exActive})`);
  console.log(`Relatório: ${csvPath}`);
  console.log(`           ${jsonPath}`);

  if (!flags.execute) {
    console.log(`\n[DRY-RUN] Nada foi alterado. Para executar: --execute --expected=${aExcluir.length}\n`);
    return;
  }

  // ===== EXECUÇÃO (somente com --execute) =====================================
  if (flags.expected != null && flags.expected !== aExcluir.length) {
    console.error(`\n[ABORT] N de A_EXCLUIR (${aExcluir.length}) difere do --expected (${flags.expected}). Rode novo dry-run e reaprove.`);
    process.exit(1);
  }

  let idsToDelete = aExcluir.map((r) => r.productId);
  if (flags.max != null && flags.max > 0 && flags.max < idsToDelete.length) {
    console.log(`\n[--max] limitando esta execução aos primeiros ${flags.max} de ${idsToDelete.length}.`);
    idsToDelete = idsToDelete.slice(0, flags.max);
  }
  if (idsToDelete.length === 0) {
    console.log("\nNada a excluir.");
    return;
  }

  // 6) Recontagem defensiva (TOCTOU): nenhum alvo pode ter histórico -----------
  const comHistorico = await countWithHistory(idsToDelete);
  if (comHistorico > 0) {
    console.error(`\n[ABORT] ${comHistorico} alvo(s) passaram a ter histórico (Order/Nfe/Receivable) desde o dry-run. Reexecute o dry-run.`);
    process.exit(1);
  }

  // 7) Backup completo ANTES de qualquer deleção -------------------------------
  const backupPath = path.join(OUT_DIR, `legacy-cleanup-backup-${stamp}.json`);
  await writeBackup(idsToDelete, backupPath, { userId, email: user.email });
  console.log(`\nBackup salvo: ${backupPath}`);

  // 8) Confirmação digitada ----------------------------------------------------
  const phrase = `EXCLUIR ${idsToDelete.length} PRODUTOS`;
  console.log(`\n⚠️  Isto vai EXCLUIR ${idsToDelete.length} produtos e ENCERRAR seus anúncios no ML/Shopee.`);
  const typed = await readLine(`Digite exatamente:  ${phrase}\n> `);
  if (typed !== phrase) {
    console.error(`\n[ABORT] Confirmação não confere. Nada foi excluído.`);
    process.exit(1);
  }

  // 9) Deleção em lotes <=50 via caminho de produção ---------------------------
  const uc = new ProductUseCase();
  const batches = chunk(idsToDelete, BATCH);
  let deleted = 0;
  let failed = 0;
  const failures: { productId: string; message: string }[] = [];
  const progressPath = path.join(OUT_DIR, `legacy-cleanup-progress-${stamp}.jsonl`);
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const resp = await uc.bulkDelete(batch, userId);
    deleted += resp.summary.deleted;
    failed += resp.summary.failed;
    for (const r of resp.results) {
      if (!r.deleted) failures.push({ productId: r.productId, message: r.message });
      fs.appendFileSync(progressPath, JSON.stringify({ batch: i, ...r }, jsonReplacer) + "\n");
    }
    console.log(`  lote ${i + 1}/${batches.length}: deleted=${resp.summary.deleted} failed=${resp.summary.failed} (acum ${deleted}/${idsToDelete.length})`);
  }

  // 10) Relatório final --------------------------------------------------------
  console.log(`\n=== RESULTADO ===`);
  console.table({ alvo: idsToDelete.length, deleted, failed });
  if (failures.length) {
    console.log(`Falhas (${failures.length}) — ex.:`);
    for (const f of failures.slice(0, 20)) console.log(`  ${f.productId}: ${f.message}`);
  }
  console.log(`\nBackup: ${backupPath}`);
  console.log(`Progresso: ${progressPath}`);
  console.log(`Rollback (DB): restaurar produtos a partir do backup via prisma.product.create aninhado (cuids preservados).`);
  console.log(`Atenção: anúncios encerrados no ML/Shopee NÃO revertem automaticamente (externalListingId está no backup).`);
}

async function countActiveListings(ids: string[]): Promise<number> {
  let total = 0;
  for (const slice of chunk(ids, 1000)) {
    total += await prisma.product.count({ where: { id: { in: slice }, listings: { some: { status: "active" } } } });
  }
  return total;
}

async function countWithHistory(ids: string[]): Promise<number> {
  let total = 0;
  for (const slice of chunk(ids, 1000)) {
    total += await prisma.product.count({
      where: {
        id: { in: slice },
        OR: [
          { orderItems: { some: {} } },
          { nfeItens: { some: {} } },
          { receivableItems: { some: {} } },
        ],
      },
    });
  }
  return total;
}

async function writeBackup(ids: string[], filePath: string, meta: { userId: string; email: string }) {
  const all: unknown[] = [];
  for (const slice of chunk(ids, 500)) {
    const batch = await prisma.product.findMany({
      where: { id: { in: slice } },
      include: { listings: true, stockLogs: true, compatibilities: true },
    });
    all.push(...batch);
  }
  fs.writeFileSync(
    filePath,
    JSON.stringify(
      { generatedAt: new Date().toISOString(), ...meta, count: all.length, ids, products: all },
      jsonReplacer,
      2,
    ),
    "utf-8",
  );
}

main()
  .catch((err) => {
    console.error("[fatal]", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
