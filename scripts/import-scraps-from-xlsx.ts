/**
 * Import de sucatas (Scrap) a partir de planilha XLSX.
 *
 * Uso:
 *   npm run import:scraps -- --file=<path> --user=<userId>            # DRY-RUN (default)
 *   npm run import:scraps -- --file=<path> --user=<userId> --apply    # executa de verdade
 *
 * Formato esperado da planilha (1 sheet, header na linha 1):
 *   - "# Codigo Veiculo" (int)  — chave de agrupamento (1 veiculo, N linhas, 1 por imagem)
 *   - "Marca" (str)
 *   - "Modelo" (str)
 *   - "Placa" (str)
 *   - "Chassi" (str)
 *   - "Apelido" (str, opcional → notes)
 *   - "Cor" (str)
 *   - "Ano modelo" (int → string)
 *   - "Valor da compra" (float → Decimal)
 *   - "Link imagem" (str)       — multiplas linhas por veiculo concatenam em imageUrls[]
 *
 * Dedup: (userId, chassis). Se o usuario ja tem Scrap com mesmo chassis, pula.
 * Nao deleta nem atualiza nada — apenas insere os novos. Idempotente.
 */

import "dotenv/config";
import prisma from "@/app/lib/prisma";
import * as XLSX from "xlsx";

interface SheetRow {
  "# Codigo Veiculo": number;
  Marca: string;
  Modelo: string;
  Placa: string;
  Chassi: string;
  Apelido?: string;
  Cor?: string;
  "Ano modelo": number | string;
  "Valor da compra"?: number | string; // xlsx pode entregar string se cell tiver formato de moeda
  "Link imagem": string;
}

function parseArgs(): { file?: string; user?: string; apply: boolean } {
  const out: { file?: string; user?: string; apply: boolean } = { apply: false };
  for (const arg of process.argv.slice(2)) {
    if (arg === "--apply") {
      out.apply = true;
    } else {
      const [k, v] = arg.replace(/^--/, "").split("=");
      if (k === "file" && v) out.file = v;
      else if (k === "user" && v) out.user = v;
    }
  }
  return out;
}

function safeString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

function safeUpper(v: unknown): string | null {
  const s = safeString(v);
  return s ? s.toUpperCase() : null;
}

/**
 * Parseia valor monetario aceitando number direto ou string em multiplos
 * formatos:
 *  - "11000" / "11000.00" (formato US/xlsx-internal — ponto como decimal)
 *  - "R$ 11.000,00" / "11.000,00" (formato pt-BR — virgula como decimal)
 *  - "11000,00" (pt-BR sem milhar)
 *
 * Heuristica: se a string contem virgula, eh pt-BR (vai limpar pontos
 * como milhar e converter virgula em decimal). Sem virgula, eh formato
 * US/internal (ponto eh decimal, mantido).
 *
 * Retorna null se nao conseguir extrair numero finito >= 0.
 */
function parseMoney(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") {
    return Number.isFinite(v) && v >= 0 ? v : null;
  }
  if (typeof v === "string") {
    let cleaned = v.replace(/r\$/gi, "").replace(/\s/g, "");
    if (cleaned.length === 0) return null;
    if (cleaned.includes(",")) {
      // pt-BR: "11.000,00" → "11000.00"
      cleaned = cleaned.replace(/\./g, "").replace(/,/g, ".");
    }
    // Sem virgula: assume ponto como decimal (formato US/xlsx-internal),
    // mantem como esta. "11000.00" → 11000, "11000" → 11000.
    const n = Number(cleaned);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  return null;
}

async function main() {
  const { file, user: userId, apply } = parseArgs();

  if (!file || !userId) {
    console.error(
      "Usage: npm run import:scraps -- --file=<path> --user=<userId> [--apply]\n" +
        "       Sem --apply roda como DRY-RUN (mostra o que seria criado).",
    );
    process.exit(1);
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    console.error(`User ${userId} nao encontrado`);
    process.exit(1);
  }
  console.log(`[import:scraps] user=${user.id} (${user.name ?? user.email ?? "sem nome"})`);
  console.log(`[import:scraps] modo=${apply ? "APPLY (real)" : "DRY-RUN (preview)"}`);
  console.log(`[import:scraps] arquivo=${file}`);
  console.log("");

  const wb = XLSX.readFile(file);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<SheetRow>(sheet);

  console.log(`[import:scraps] ${rows.length} linhas lidas da planilha`);

  // Agrupa por # Codigo Veiculo (chassis e placa devem coincidir)
  const grouped = new Map<number, SheetRow[]>();
  for (const r of rows) {
    const codigo = r["# Codigo Veiculo"];
    if (codigo === undefined || codigo === null) continue;
    if (!grouped.has(codigo)) grouped.set(codigo, []);
    grouped.get(codigo)!.push(r);
  }

  console.log(`[import:scraps] ${grouped.size} veiculos unicos\n`);

  let toCreate = 0;
  let skipped = 0;
  let errors = 0;
  const codigos = [...grouped.keys()].sort((a, b) => a - b);

  for (const codigo of codigos) {
    const vehicleRows = grouped.get(codigo)!;
    const first = vehicleRows[0];
    const chassis = safeUpper(first.Chassi);
    const plate = safeUpper(first.Placa);
    const brand = safeString(first.Marca);
    const model = safeString(first.Modelo);

    if (!chassis || !brand || !model) {
      console.warn(
        `  ! ${codigo} — campo obrigatorio vazio (brand=${brand}, model=${model}, chassis=${chassis}). Pulando.`,
      );
      errors++;
      continue;
    }

    // Dedup por (userId, chassis) — mesma loja nao deve ter o mesmo chassis 2x
    const existing = await prisma.scrap.findFirst({
      where: { userId, chassis },
      select: { id: true, plate: true },
    });
    if (existing) {
      console.log(
        `  ⊘ ${codigo} ${brand} ${model} chassis=${chassis} → ja existe (id=${existing.id}, plate=${existing.plate}). Pulando.`,
      );
      skipped++;
      continue;
    }

    const imageUrls = vehicleRows
      .map((r) => safeString(r["Link imagem"]))
      .filter((u): u is string => u !== null);

    const data = {
      userId,
      brand,
      model,
      year: first["Ano modelo"] !== undefined ? String(first["Ano modelo"]) : null,
      color: safeString(first.Cor),
      plate,
      chassis,
      cost: parseMoney(first["Valor da compra"]),
      notes: safeString(first.Apelido),
      imageUrls,
    };

    if (!apply) {
      console.log(
        `  → [DRY] ${codigo} ${data.brand} ${data.model} ${data.year ?? ""} (${data.plate}/${data.chassis}) — R$${data.cost ?? "?"} — ${imageUrls.length} imagens`,
      );
      toCreate++;
      continue;
    }

    try {
      const scrap = await prisma.scrap.create({ data });
      console.log(
        `  ✓ ${codigo} ${data.brand} ${data.model} (${data.plate}) → id=${scrap.id} (${imageUrls.length} imagens)`,
      );
      toCreate++;
    } catch (err) {
      console.error(
        `  ✗ ${codigo} ${data.brand} ${data.model}:`,
        err instanceof Error ? err.message : err,
      );
      errors++;
    }
  }

  console.log("");
  if (apply) {
    console.log(
      `[import:scraps] DONE — ${toCreate} criados, ${skipped} pulados (ja existiam), ${errors} erros`,
    );
  } else {
    console.log(
      `[import:scraps] DRY-RUN — ${toCreate} seriam criados, ${skipped} pulados (ja existiam), ${errors} erros.`,
    );
    console.log(`[import:scraps] Para executar de verdade adicione --apply.`);
  }

  if (errors > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error("[import:scraps] erro fatal:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
