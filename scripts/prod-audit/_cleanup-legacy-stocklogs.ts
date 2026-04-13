/**
 * Limpeza pontual de artefatos históricos identificados pelo audit:
 *
 *  Item 1 — 4 pedidos PAID (ML JOTABÊ AUTOPEÇAS) sem StockLog.
 *    Causa: catalog re-import em 2026-03-30 02:49 recriou os produtos após
 *    os pedidos serem importados. Os OrderItems foram relinkados para novos
 *    produtos, perdendo a referência da dedução original. Não há bug no código
 *    atual (ver investigação do audit).
 *    Ação: inserir um StockLog de reconciliação retroativa por pedido, com
 *    change=0 (nenhuma movimentação agora) documentando o evento.
 *
 *  Item 2 — 6 StockLog com aritmética inconsistente (prev=0 change=-1 new=0).
 *    Causa: código pré-commit 013bf63 (fix de overselling, 2026-04-13) gravava
 *    change=-quantity sem clamp quando o estoque já estava zerado, enquanto
 *    newStock era clampado a 0. O fix atual usa `decrementBy` consistente.
 *    Ação: normalizar change=0 (representa o que de fato aconteceu — nenhuma
 *    unidade movida), e anexar marcador [corrigido: pre-013bf63] no reason.
 *
 * Rodar uma única vez. Idempotente: detecta se o StockLog retroativo já foi
 * criado (via reason contendo "Reconciliação retroativa") e pula.
 */
import { prisma, withPrisma } from "./shared";

const MISSING_STOCKLOG_ORDERS: Array<{
  orderId: string;
  externalOrderId: string;
  productId: string;
}> = [
  {
    orderId: "cmn9bc7a800dh18opdgtyjrru",
    externalOrderId: "2000015725604248",
    productId: "cmnclaqkd04lxvs1caf57g8cx",
  },
  {
    orderId: "cmncl1pup002h186xk98qg6jj",
    externalOrderId: "2000015756466188",
    productId: "cmnclac7k01l2vs1csyc4u9c3",
  },
  {
    orderId: "cmncl1tz7002n186xeg6algay",
    externalOrderId: "2000015754570522",
    productId: "cmnclaul3059mvs1c4widrdkd",
  },
  {
    orderId: "cmncl2esf003h186xten3pbm2",
    externalOrderId: "2000015750408588",
    productId: "cmnclamec03q7vs1c0g6q8305",
  },
];

async function cleanupItem1() {
  console.log("=== Item 1 — inserindo StockLog retroativo para 4 pedidos ===");
  let inserted = 0;
  let skipped = 0;

  for (const t of MISSING_STOCKLOG_ORDERS) {
    const existing = await prisma.stockLog.findFirst({
      where: {
        productId: t.productId,
        reason: { contains: `retroativa #${t.externalOrderId}` },
      },
      select: { id: true },
    });
    if (existing) {
      console.log(`  ↷ já existe para ${t.externalOrderId}, pulando`);
      skipped++;
      continue;
    }

    const product = await prisma.product.findUnique({
      where: { id: t.productId },
      select: { stock: true },
    });
    if (!product) {
      console.log(`  ❌ produto ${t.productId} não encontrado para ${t.externalOrderId}`);
      continue;
    }

    await prisma.stockLog.create({
      data: {
        productId: t.productId,
        change: 0,
        previousStock: product.stock,
        newStock: product.stock,
        reason: `Reconciliação retroativa #${t.externalOrderId} — pedido importado antes do produto atual existir (catalog re-import 2026-03-30). Dedução original perdida no relinkamento por SKU; sem movimentação de estoque agora.`,
      },
    });
    console.log(`  ✓ inserido para ${t.externalOrderId}`);
    inserted++;
  }
  console.log(`  resumo: ${inserted} inseridos, ${skipped} pulados`);
}

async function cleanupItem2() {
  console.log(
    "\n=== Item 2 — normalizando 6 StockLog com aritmética inconsistente ===",
  );
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const candidates = await prisma.stockLog.findMany({
    where: { createdAt: { gte: thirtyDaysAgo } },
    select: {
      id: true,
      change: true,
      previousStock: true,
      newStock: true,
      reason: true,
    },
  });

  const inconsistent = candidates.filter(
    (r) => r.previousStock + r.change !== r.newStock,
  );

  if (inconsistent.length === 0) {
    console.log("  nenhum StockLog inconsistente encontrado — nada a fazer");
    return;
  }

  let fixed = 0;
  for (const log of inconsistent) {
    // Evita re-processar se já foi marcado
    if (log.reason.includes("[corrigido: pre-013bf63]")) {
      console.log(`  ↷ ${log.id} já marcado, pulando`);
      continue;
    }

    // O clamp correto é change = newStock - previousStock (idempotente e
    // matematicamente consistente). Para o caso prev=0 new=0 isso dá change=0.
    const correctChange = log.newStock - log.previousStock;

    await prisma.stockLog.update({
      where: { id: log.id },
      data: {
        change: correctChange,
        reason: `${log.reason} [corrigido: pre-013bf63]`,
      },
    });
    console.log(
      `  ✓ ${log.id} change=${log.change}→${correctChange} (prev=${log.previousStock} new=${log.newStock})`,
    );
    fixed++;
  }
  console.log(`  resumo: ${fixed} corrigidos de ${inconsistent.length} candidatos`);
}

async function main() {
  await cleanupItem1();
  await cleanupItem2();
  console.log("\n✓ cleanup concluído");
}

withPrisma(main)
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
