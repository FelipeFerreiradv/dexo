/**
 * READ-ONLY: exporta listas amigáveis p/ o cliente revisar a limpeza Vaapt→IBR.
 *
 * Gera 2 CSVs (BOM + ; → abre direto no Excel BR) em scripts/out/:
 *   revisao-EXCLUIR-<ts>.csv   → tudo que casa a regra de exclusão (status EXCLUIDO = já apagado | PENDENTE)
 *   revisao-MANTIDOS-<ts>.csv  → anomalias mantidas (ML/dash/359/letra/lixo) p/ o cliente confirmar
 *
 * Reconstrói o conjunto ORIGINAL completo: produtos ainda no banco (PENDENTE) +
 * produtos já apagados lidos dos backups legacy-cleanup-backup-*.json (EXCLUIDO).
 *
 * Rodar:  npx tsx scripts/export-legacy-cleanup-review.ts
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import prisma from "@/app/lib/prisma";
import {
  bucketOf,
  isCaixaNumericaSimples,
  matchConverted,
  matchRawVaapt,
} from "./lib/legacy-cleanup-rules";

const TARGET_EMAIL = "leonardo.lima.borges@outlook.com.br";
const OUT_DIR = path.resolve(__dirname, "out");

const LETRA_POR_CENTENA: Record<number, string> = { 100: "H", 200: "J", 300: "Y" };

function ruleInfo(sku: string): { regra: string; chave: string; origem: string } {
  const c = matchConverted(sku);
  if (c) {
    const letra = LETRA_POR_CENTENA[c.prefix];
    return {
      regra: "convertido",
      chave: String(c.prefix),
      origem: letra ? `letra ${letra} → ${c.prefix}` : `centena ${c.prefix} (outra letra Vaapt)`,
    };
  }
  const r = matchRawVaapt(sku);
  if (r) return { regra: "cru", chave: r.letter, origem: `letra ${r.letter} (não convertido)` };
  return { regra: "?", chave: "", origem: "" };
}

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function writeCsv(file: string, header: string[], rows: string[][]) {
  const lines = [header.join(";"), ...rows.map((r) => r.map(csvEscape).join(";"))];
  fs.writeFileSync(file, "﻿" + lines.join("\n"), "utf-8");
}
function ts(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function main() {
  const user = await prisma.user.findFirst({ where: { email: TARGET_EMAIL }, select: { id: true } });
  if (!user) throw new Error(`Usuário não encontrado: ${TARGET_EMAIL}`);
  const userId = user.id;

  const locs = await prisma.location.findMany({ where: { userId }, select: { id: true, code: true } });
  const codeById = new Map(locs.map((l) => [l.id, l.code]));
  const scopeIds = locs.filter((l) => isCaixaNumericaSimples(l.code)).map((l) => l.id);

  const prods = await prisma.product.findMany({
    where: { userId, locationId: { in: scopeIds } },
    select: {
      id: true, sku: true, name: true, location: true, locationId: true,
      _count: { select: { orderItems: true, nfeItens: true, receivableItems: true, listings: true } },
    },
  });

  type Out = { status: string; regra: string; chave: string; origem: string; sku: string; nome: string; caixa: string; anuncios: string };
  const excluir: Out[] = [];
  const mantidos: { motivo: string; sku: string; nome: string; caixa: string }[] = [];

  for (const p of prods) {
    const b = bucketOf(p.sku, {
      inScope: true,
      hasOrderItem: p._count.orderItems > 0,
      hasNfeItem: p._count.nfeItens > 0,
      hasReceivableItem: p._count.receivableItems > 0,
    });
    const caixa = (p.locationId && codeById.get(p.locationId)) || p.location || "";
    if (b.bucket === "a_excluir") {
      const ri = ruleInfo(p.sku);
      excluir.push({ status: "PENDENTE", ...ri, sku: p.sku, nome: p.name ?? "", caixa, anuncios: String(p._count.listings) });
    } else if (b.bucket === "revisar") {
      mantidos.push({ motivo: b.detail ?? "", sku: p.sku, nome: p.name ?? "", caixa });
    }
    // preservado/protegido_historico ficam de fora desta revisão (não excluídos)
  }

  // Produtos já EXCLUÍDOS: ler dos backups
  const backupFiles = fs.readdirSync(OUT_DIR).filter((f) => f.startsWith("legacy-cleanup-backup-") && f.endsWith(".json"));
  const seen = new Set<string>();
  for (const bf of backupFiles) {
    const data = JSON.parse(fs.readFileSync(path.join(OUT_DIR, bf), "utf-8")) as {
      products: { id: string; sku: string; name?: string; location?: string; locationId?: string; listings?: unknown[] }[];
    };
    for (const p of data.products ?? []) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      const ri = ruleInfo(p.sku);
      const caixa = (p.locationId && codeById.get(p.locationId)) || p.location || "";
      excluir.push({ status: "EXCLUIDO", ...ri, sku: p.sku, nome: p.name ?? "", caixa, anuncios: String(p.listings?.length ?? 0) });
    }
  }

  // Ordenar: regra, chave, sku
  excluir.sort((a, b) => a.regra.localeCompare(b.regra) || a.chave.localeCompare(b.chave) || a.sku.localeCompare(b.sku));
  mantidos.sort((a, b) => a.motivo.localeCompare(b.motivo) || a.sku.localeCompare(b.sku));

  const stamp = ts();
  const fExcluir = path.join(OUT_DIR, `revisao-EXCLUIR-${stamp}.csv`);
  const fMantidos = path.join(OUT_DIR, `revisao-MANTIDOS-${stamp}.csv`);
  writeCsv(
    fExcluir,
    ["status", "regra", "chave", "origem_vaapt", "sku", "nome", "caixa", "qtd_anuncios"],
    excluir.map((r) => [r.status, r.regra, r.chave, r.origem, r.sku, r.nome, r.caixa, r.anuncios]),
  );
  writeCsv(
    fMantidos,
    ["motivo", "sku", "nome", "caixa"],
    mantidos.map((r) => [r.motivo, r.sku, r.nome, r.caixa]),
  );

  // Resumo
  const porStatus: Record<string, number> = {};
  const porRegra: Record<string, number> = {};
  for (const r of excluir) {
    porStatus[r.status] = (porStatus[r.status] ?? 0) + 1;
    const k = r.regra === "convertido" ? `convertido_${r.chave}` : `cru_${r.chave}`;
    porRegra[k] = (porRegra[k] ?? 0) + 1;
  }
  console.log(`\n=== EXPORT PARA REVISÃO DO CLIENTE ===`);
  console.log(`A EXCLUIR (total ${excluir.length}):`);
  console.table(porStatus);
  console.table(porRegra);
  console.log(`MANTIDOS / anomalias a confirmar: ${mantidos.length}`);
  console.log(`\nArquivos:`);
  console.log(`  ${fExcluir}`);
  console.log(`  ${fMantidos}`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
