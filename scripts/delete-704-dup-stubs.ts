import "dotenv/config";
import path from "path";
import fs from "fs";
import prisma from "../app/lib/prisma";

/**
 * Opção A da reconciliação de SKU do 704: apaga os cadastros ORIGINAIS
 * duplicados que estão VAZIOS (o produto real, sem anúncio, que a migração
 * gemelou). Depois disso, `reconcile-skus-from-anuncios.ts --apply` faz a
 * cópia migrada (com o anúncio) assumir o SKU correto.
 *
 * SEGURANÇA: lê os holderIds do relatório e RE-VERIFICA cada um em runtime;
 * só apaga se NÃO tiver anúncio/pedido/NF-e/recebível/orçamento. Qualquer um
 * com dados é PULADO e listado. Sem `--apply` não escreve. Apaga stockLogs e
 * compatibilities dependentes numa transação antes do produto.
 *
 *   npx tsx scripts/delete-704-dup-stubs.ts --dry-run
 *   npx tsx scripts/delete-704-dup-stubs.ts --apply
 */

const DEFAULT_USER_ID = "cmql2zugq0000vs8g376rend5";
const OUT_DIR = path.resolve(__dirname, "out");

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const dryRun = argv.includes("--dry-run") || !apply;
  const userId = argv.find((a) => a.startsWith("--user-id="))?.split("=")[1] ?? DEFAULT_USER_ID;

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
  if (!user) throw new Error(`Usuário ${userId} não encontrado`);
  console.log(`[del-stubs] user=${user.email} modo=${dryRun ? "DRY-RUN" : "APPLY"}`);

  const f = fs
    .readdirSync(OUT_DIR)
    .filter((x) => x.startsWith("relatorio-skus-704-") && x.endsWith(".json"))
    .sort()
    .pop();
  if (!f) throw new Error("Relatório relatorio-skus-704-*.json não encontrado. Rode report-sku-reconcile.ts antes.");
  const report = JSON.parse(fs.readFileSync(path.join(OUT_DIR, f), "utf8"));
  const dups = (report.cat.duplicatas ?? []) as Array<{ holderId: string; skuCorreto: string }>;
  const holderIds = [...new Set(dups.map((d) => d.holderId).filter(Boolean))];
  console.log(`[del-stubs] originais candidatos (do relatório): ${holderIds.length}`);

  const sum = { candidatos: holderIds.length, apagados: 0, pulados_com_dados: 0, nao_encontrados: 0, erros: 0, detalhes: [] as unknown[] };

  for (const id of holderIds) {
    const p = await prisma.product.findUnique({
      where: { id },
      select: {
        id: true,
        sku: true,
        name: true,
        _count: {
          select: {
            listings: true,
            orderItems: true,
            nfeItens: true,
            receivableItems: true,
            budgetItems: true,
          },
        },
      },
    });
    if (!p) {
      sum.nao_encontrados++;
      continue;
    }
    const c = p._count as unknown as Record<string, number>;
    const temDados =
      c.listings > 0 || c.orderItems > 0 || c.nfeItens > 0 || c.receivableItems > 0 || c.budgetItems > 0;
    if (temDados) {
      sum.pulados_com_dados++;
      sum.detalhes.push({ id: p.id, sku: p.sku, name: p.name, reason: "tem_dados", counts: c });
      console.log(`  ⊘ PULADO ${p.id} sku="${p.sku}" (list=${c.listings} ped=${c.orderItems} nfe=${c.nfeItens})`);
      continue;
    }
    if (dryRun) {
      sum.apagados++;
      continue;
    }
    try {
      await prisma.$transaction([
        prisma.stockLog.deleteMany({ where: { productId: p.id } }),
        prisma.productCompatibility.deleteMany({ where: { productId: p.id } }),
        prisma.product.delete({ where: { id: p.id } }),
      ]);
      sum.apagados++;
    } catch (err) {
      sum.erros++;
      sum.detalhes.push({ id: p.id, sku: p.sku, error: err instanceof Error ? err.message : String(err) });
      console.log(`  ✗ ERRO ${p.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.writeFileSync(path.join(OUT_DIR, `delete-704-stubs-${stamp}.json`), JSON.stringify(sum, null, 2), "utf8");

  console.log("\n===== RESUMO =====");
  console.log(`modo: ${dryRun ? "DRY-RUN (0 exclusões)" : "APPLY"}`);
  console.log(`  ${dryRun ? "a apagar" : "apagados"}:        ${sum.apagados}`);
  console.log(`  pulados (com dados):  ${sum.pulados_com_dados}`);
  console.log(`  não encontrados:      ${sum.nao_encontrados}`);
  console.log(`  erros:                ${sum.erros}`);
  console.log("==================");

  await prisma.$disconnect();
}
main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
