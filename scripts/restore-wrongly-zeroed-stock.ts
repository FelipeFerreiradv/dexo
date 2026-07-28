// Sobe a árvore até achar o .env — permite rodar de dentro de um git worktree,
// que não tem .env próprio. Precisa vir antes do import do prisma.
import "./lib/load-env";
import prisma from "../app/lib/prisma";

/**
 * restore-wrongly-zeroed-stock.ts
 *
 * Recupera produtos que foram a estoque ZERO num único movimento vindo de um
 * estoque MAIOR QUE UM — o padrão de zeragem indevida.
 *
 * Por que isso existe: a aritmética de venda do Dexo é decremental e correta
 * (`StockDeductionService.deductWithinTx`: 50 − 1 = 49). Quem zerou produto
 * multi-unidade em produção foi `scripts/balcao-stock-fix.ts`, que aplica a
 * heurística de peça única ("anúncio ML fora do ar ⇒ peça vendida no balcão")
 * sem teto de quantidade. Em 21-22/05/2026 isso levou 40 produtos com mais de
 * uma unidade a zero de uma vez.
 *
 * Como o estoque é reconstruído: o `StockLog` guarda `previousStock` de cada
 * movimento. A restauração devolve `previousStock` e, de forma conservadora,
 * DESCONTA as vendas reais que aconteceram depois da zeragem (se o produto
 * voltou a vender, aquelas unidades saíram mesmo). O resultado nunca fica
 * negativo e nunca ultrapassa o `previousStock` original.
 *
 * O que NÃO é restaurado (por design):
 *   - vendas legítimas que consumiram todo o saldo (`reason` = "Venda …"),
 *     salvo se `--incluir-vendas` for passado explicitamente;
 *   - produtos cujo estoque já foi corrigido depois (stock atual > 0), salvo
 *     `--incluir-com-estoque`.
 *
 * DRY-RUN é o padrão. `--apply` exige também `--confirmar`.
 *
 * Uso:
 *   npx tsx scripts/restore-wrongly-zeroed-stock.ts                          # relatório
 *   npx tsx scripts/restore-wrongly-zeroed-stock.ts --user=<userId>
 *   npx tsx scripts/restore-wrongly-zeroed-stock.ts --desde=2026-05-01
 *   npx tsx scripts/restore-wrongly-zeroed-stock.ts --produto=<productId>    # valida em 1
 *   npx tsx scripts/restore-wrongly-zeroed-stock.ts --apply --confirmar
 */

const REASON_PREFIX_SCRIPT = "Venda balcão (inferida)";
const RESTORE_REASON =
  "Correção — estoque zerado indevidamente em um movimento (restaurado por restore-wrongly-zeroed-stock)";

interface Flags {
  userId: string | null;
  productId: string | null;
  desde: Date | null;
  apply: boolean;
  confirmar: boolean;
  incluirVendas: boolean;
  incluirComEstoque: boolean;
  limit: number | null;
}

function parseFlags(argv: string[]): Flags {
  const get = (n: string) => {
    const p = `--${n}=`;
    const f = argv.find((a) => a.startsWith(p));
    return f ? f.slice(p.length) : undefined;
  };
  const has = (n: string) => argv.includes(`--${n}`);
  const desdeRaw = get("desde");
  const limitRaw = get("limit");
  const desde = desdeRaw ? new Date(desdeRaw) : null;
  if (desde && Number.isNaN(desde.getTime())) {
    throw new Error(`--desde inválido: "${desdeRaw}" (use AAAA-MM-DD)`);
  }
  return {
    userId: get("user") ?? null,
    productId: get("produto") ?? null,
    desde,
    // Escrita é OPT-IN: o default seguro é dry-run.
    apply: has("apply"),
    confirmar: has("confirmar"),
    incluirVendas: has("incluir-vendas"),
    incluirComEstoque: has("incluir-com-estoque"),
    limit: limitRaw && /^\d+$/.test(limitRaw) ? parseInt(limitRaw, 10) : null,
  };
}

interface Candidato {
  productId: string;
  sku: string;
  name: string;
  /** `Product.userId` é opcional no schema (registro legado). */
  userId: string | null;
  stockAtual: number;
  zeragem: {
    logId: string;
    previousStock: number;
    change: number;
    reason: string;
    createdAt: Date;
  };
  /** Unidades que saíram por venda DEPOIS da zeragem (não devem voltar). */
  vendidoDepois: number;
  /** Estoque que o produto passará a ter. */
  stockAlvo: number;
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const isDry = !flags.apply;
  console.log(
    `[restore] modo=${isDry ? "DRY-RUN (nada gravado)" : "APPLY"}` +
      `${flags.userId ? ` user=${flags.userId}` : ""}` +
      `${flags.productId ? ` produto=${flags.productId}` : ""}` +
      `${flags.desde ? ` desde=${flags.desde.toISOString().slice(0, 10)}` : ""}`,
  );

  // 1) Movimentos que zeraram produto multi-unidade de uma vez.
  const zeragens = await prisma.stockLog.findMany({
    where: {
      newStock: 0,
      previousStock: { gt: 1 },
      ...(flags.desde ? { createdAt: { gte: flags.desde } } : {}),
      ...(flags.productId ? { productId: flags.productId } : {}),
      ...(flags.userId ? { product: { userId: flags.userId } } : {}),
    },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      productId: true,
      previousStock: true,
      change: true,
      reason: true,
      createdAt: true,
      product: {
        select: { id: true, sku: true, name: true, stock: true, userId: true },
      },
    },
  });
  console.log(
    `[restore] movimentos de zeragem em um passo (previousStock>1): ${zeragens.length}`,
  );

  // 2) Classifica. Um produto pode ter mais de uma zeragem no histórico —
  //    interessa a MAIS RECENTE, que é a que determina o estoque de hoje.
  const ultimaPorProduto = new Map<string, (typeof zeragens)[number]>();
  for (const z of zeragens) ultimaPorProduto.set(z.productId, z);

  const candidatos: Candidato[] = [];
  let puladoPorVenda = 0;
  let puladoComEstoque = 0;

  for (const z of ultimaPorProduto.values()) {
    const p = z.product;
    if (!p) continue;

    const isScript = z.reason.startsWith(REASON_PREFIX_SCRIPT);
    if (!isScript && !flags.incluirVendas) {
      // Venda que consumiu todo o saldo é legítima por padrão.
      puladoPorVenda++;
      continue;
    }

    if (p.stock > 0 && !flags.incluirComEstoque) {
      // Já foi corrigido (manualmente ou por reposição) — não mexer.
      puladoComEstoque++;
      continue;
    }

    // Vendas reais posteriores à zeragem: essas unidades saíram de verdade e
    // NÃO devem ser devolvidas. `change` de venda é negativo.
    const posteriores = await prisma.stockLog.findMany({
      where: {
        productId: z.productId,
        createdAt: { gt: z.createdAt },
        change: { lt: 0 },
      },
      select: { change: true, reason: true },
    });
    const vendidoDepois = posteriores
      .filter((l) => l.reason.startsWith("Venda"))
      .reduce((acc, l) => acc + Math.abs(l.change), 0);

    const stockAlvo = Math.max(
      0,
      Math.min(z.previousStock, z.previousStock - vendidoDepois),
    );
    if (stockAlvo <= p.stock) continue; // nada a restaurar

    candidatos.push({
      productId: z.productId,
      sku: p.sku,
      name: p.name,
      userId: p.userId,
      stockAtual: p.stock,
      zeragem: {
        logId: z.id,
        previousStock: z.previousStock,
        change: z.change,
        reason: z.reason,
        createdAt: z.createdAt,
      },
      vendidoDepois,
      stockAlvo,
    });
  }

  const alvos =
    flags.limit !== null ? candidatos.slice(0, flags.limit) : candidatos;

  console.log(`\n========== PRODUTOS A RESTAURAR ==========`);
  console.log(`Pulados (zeragem foi venda real):  ${puladoPorVenda}`);
  console.log(`Pulados (já têm estoque hoje):     ${puladoComEstoque}`);
  console.log(`A restaurar:                       ${alvos.length}`);
  console.log(`Unidades devolvidas ao catálogo:   ${alvos.reduce((a, c) => a + (c.stockAlvo - c.stockAtual), 0)}`);
  console.log(`------------------------------------------`);
  for (const c of alvos) {
    console.log(
      `  sku=${c.sku} ${c.stockAtual} → ${c.stockAlvo}` +
        `${c.vendidoDepois > 0 ? ` (descontadas ${c.vendidoDepois} vendidas depois)` : ""}` +
        `  [${c.zeragem.createdAt.toISOString().slice(0, 10)}] "${c.name.slice(0, 40)}"`,
    );
  }
  console.log(`==========================================`);

  if (isDry) {
    console.log(
      `\n[restore] DRY-RUN. Para aplicar:\n  npx tsx scripts/restore-wrongly-zeroed-stock.ts --apply --confirmar` +
        `${flags.userId ? ` --user=${flags.userId}` : ""}` +
        `${flags.desde ? ` --desde=${flags.desde.toISOString().slice(0, 10)}` : ""}`,
    );
    await prisma.$disconnect();
    return;
  }

  if (!flags.confirmar) {
    console.error(
      `\n[restore] ABORTADO: --apply exige também --confirmar.` +
        `\n[restore] Confira a lista acima antes de repetir com --confirmar.`,
    );
    await prisma.$disconnect();
    process.exitCode = 1;
    return;
  }

  // 3) Apply — mesma estrutura do StockDeductionService: FOR UPDATE, update,
  //    StockLog de correção e StockSyncJob por listing (repropaga aos anúncios).
  let aplicados = 0;
  let falhas = 0;
  for (const c of alvos) {
    try {
      await prisma.$transaction(
        async (tx) => {
          const locked = await tx.$queryRaw<
            { id: string; stock: number }[]
          >`SELECT id, stock FROM "Product" WHERE id = ${c.productId} FOR UPDATE`;
          const cur = locked[0];
          if (!cur) return;
          // Re-checa sob o lock: se alguém já corrigiu, não sobrescreve.
          if (cur.stock >= c.stockAlvo) return;

          const previous = cur.stock;
          await tx.product.update({
            where: { id: c.productId },
            data: { stock: c.stockAlvo },
          });
          await tx.stockLog.create({
            data: {
              productId: c.productId,
              change: c.stockAlvo - previous,
              reason: RESTORE_REASON,
              previousStock: previous,
              newStock: c.stockAlvo,
            },
          });

          const listings = await tx.productListing.findMany({
            where: { productId: c.productId },
            include: { marketplaceAccount: { select: { platform: true } } },
          });
          for (const listing of listings) {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"stock_sync_job:" + listing.id}))`;
            await tx.stockSyncJob.upsert({
              where: {
                listingId_status: { listingId: listing.id, status: "PENDING" },
              },
              create: {
                productId: c.productId,
                listingId: listing.id,
                platform: listing.marketplaceAccount.platform,
                targetStock: c.stockAlvo,
                status: "PENDING",
              },
              update: {
                targetStock: c.stockAlvo,
                attempts: 0,
                nextRunAt: new Date(),
                lastError: null,
              },
            });
          }
        },
        { timeout: 60_000, maxWait: 20_000 },
      );
      aplicados++;
      console.log(`  [ok] sku=${c.sku} ${c.stockAtual} → ${c.stockAlvo}`);
    } catch (err) {
      falhas++;
      const m = err instanceof Error ? err.message : String(err);
      console.error(`  [FALHA] sku=${c.sku}: ${m.slice(0, 160)}`);
    }
  }

  console.log(`\n========== RESUMO ==========`);
  console.log(`Restaurados: ${aplicados}`);
  console.log(`Falhas:      ${falhas}`);
  console.log(`============================`);

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("[fatal]", err);
  await prisma.$disconnect().catch(() => {});
  process.exitCode = 1;
});
