import "dotenv/config";
import path from "path";
import fs from "fs";
import prisma from "../app/lib/prisma";

/**
 * Limpeza SEGURA dos produtos duplicados criados na corrida de TESTE
 * `--limit=200` (rodada inicial, ANTES da flag --skip-existing-anuncio).
 *
 * Estratégia conservadora:
 *  - Universo = `createdProductIds` do relatório de import do TESTE
 *    (auto-detecta o relatório de menor `totals.created`, que é o teste=124;
 *     ou passe --report=<caminho>).
 *  - Só é candidato a apagar o produto que, AO MESMO TEMPO:
 *      (a) pertence ao userId alvo,
 *      (b) NÃO tem ProductListing (não capturou nenhum anúncio),
 *      (c) NÃO tem OrderItem (não está em pedido),
 *      (d) NÃO tem NfeItem (não está em nota fiscal).
 *    Qualquer produto com algum desses é MANTIDO (tem valor/vínculo).
 *  - Default = DRY-RUN (não apaga nada). Só apaga com `--apply`.
 *  - Idempotente: re-rodar após apagar → ids não encontrados = pulados.
 *  - Cada deleção é uma transação: limpa stockLogs + compatibilities
 *    (cascade do schema, mas explícito por segurança) e então o Product.
 *  - Grava relatório em scripts/out/cleanup-test-dups-<ts>.json.
 *
 * Uso:
 *   npx tsx scripts/cleanup-test-dups-18-05-2026.ts                 # dry-run
 *   npx tsx scripts/cleanup-test-dups-18-05-2026.ts --report=<json> # dry-run
 *   npx tsx scripts/cleanup-test-dups-18-05-2026.ts --apply         # APAGA
 */

const TARGET_USER_ID = "cmn5yc4rn0000vsasmwv9m8nc";
const OUT_DIR = path.resolve(__dirname, "out");

function parseFlags() {
  const argv = process.argv.slice(2);
  const get = (name: string): string | undefined => {
    const flag = `--${name}=`;
    const f = argv.find((a) => a.startsWith(flag));
    return f ? f.slice(flag.length) : undefined;
  };
  return {
    apply: argv.includes("--apply"),
    report: get("report") ?? null,
    userId: get("user-id") ?? TARGET_USER_ID,
  };
}

/** Escolhe o relatório de import do teste = o de MENOR totals.created. */
function findTestReport(): string {
  if (!fs.existsSync(OUT_DIR)) {
    throw new Error(`Diretório não encontrado: ${OUT_DIR}`);
  }
  const files = fs
    .readdirSync(OUT_DIR)
    .filter((f) => /^import-estoque-18-05-2026-.*\.json$/.test(f));
  if (files.length === 0) {
    throw new Error(
      "Nenhum relatório import-estoque-*.json em scripts/out/. Passe --report=<caminho>.",
    );
  }
  let best: { file: string; created: number } | null = null;
  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(OUT_DIR, f), "utf8"));
      const created = Number(j?.totals?.created ?? Number.MAX_SAFE_INTEGER);
      if (best === null || created < best.created) {
        best = { file: f, created };
      }
    } catch {
      /* ignora json inválido */
    }
  }
  if (!best) throw new Error("Não consegui ler nenhum relatório de import.");
  return path.join(OUT_DIR, best.file);
}

interface Row {
  id: string;
  sku: string;
}

async function main(): Promise<void> {
  const flags = parseFlags();
  const reportPath = flags.report
    ? path.resolve(flags.report)
    : findTestReport();
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  const ids: string[] = Array.isArray(report.createdProductIds)
    ? report.createdProductIds
    : [];

  console.log(`[cleanup] relatório do teste: ${reportPath}`);
  console.log(
    `[cleanup] createdProductIds=${ids.length} (totals.created=${report?.totals?.created})`,
  );
  console.log(
    `[cleanup] modo: ${flags.apply ? "APLICAR (VAI APAGAR)" : "DRY-RUN (não apaga nada)"}`,
  );

  const kept: Array<
    Row & { listings: number; orderItems: number; nfeItens: number }
  > = [];
  const deletable: Array<Row & { stockLogs: number; compatibilities: number }> =
    [];
  const skipped: Array<{ id: string; sku?: string; reason: string }> = [];
  const deleted: Row[] = [];

  for (const id of ids) {
    const p = await prisma.product.findUnique({
      where: { id },
      select: {
        id: true,
        sku: true,
        userId: true,
        _count: {
          select: {
            listings: true,
            orderItems: true,
            nfeItens: true,
            stockLogs: true,
            compatibilities: true,
          },
        },
      },
    });

    if (!p) {
      skipped.push({ id, reason: "nao_encontrado (já removido?)" });
      continue;
    }
    if (p.userId !== flags.userId) {
      skipped.push({
        id,
        sku: p.sku,
        reason: `userId_diferente(${p.userId})`,
      });
      continue;
    }
    if (
      p._count.listings > 0 ||
      p._count.orderItems > 0 ||
      p._count.nfeItens > 0
    ) {
      kept.push({
        id: p.id,
        sku: p.sku,
        listings: p._count.listings,
        orderItems: p._count.orderItems,
        nfeItens: p._count.nfeItens,
      });
      continue;
    }
    deletable.push({
      id: p.id,
      sku: p.sku,
      stockLogs: p._count.stockLogs,
      compatibilities: p._count.compatibilities,
    });
  }

  console.log(
    `[cleanup] candidatos a apagar (sem listing/order/nfe): ${deletable.length}`,
  );
  console.log(`[cleanup] mantidos (têm valor/vínculo):           ${kept.length}`);
  console.log(`[cleanup] pulados:                                 ${skipped.length}`);

  if (flags.apply) {
    for (const d of deletable) {
      try {
        await prisma.$transaction([
          prisma.stockLog.deleteMany({ where: { productId: d.id } }),
          prisma.productCompatibility.deleteMany({ where: { productId: d.id } }),
          prisma.product.delete({ where: { id: d.id } }),
        ]);
        deleted.push({ id: d.id, sku: d.sku });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        skipped.push({
          id: d.id,
          sku: d.sku,
          reason: `erro_delete: ${msg.slice(0, 160)}`,
        });
      }
    }
    console.log(`[cleanup] APAGADOS: ${deleted.length}`);
  } else {
    console.log(
      `[cleanup] (dry-run) NADA foi apagado. Rode com --apply para efetivar.`,
    );
  }

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = path.join(OUT_DIR, `cleanup-test-dups-${ts}.json`);
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        reportPath,
        apply: flags.apply,
        userId: flags.userId,
        counts: {
          createdInReport: ids.length,
          deletable: deletable.length,
          kept: kept.length,
          skipped: skipped.length,
          deleted: deleted.length,
        },
        deletable,
        kept,
        skipped,
        deleted,
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log(`[report] ${outPath}`);
}

main()
  .catch((err) => {
    console.error("[fatal]", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
