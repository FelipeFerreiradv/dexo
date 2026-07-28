// Sobe a árvore até achar o .env — permite rodar de dentro de um git worktree,
// que não tem .env próprio. Precisa vir antes do import do prisma.
import "./lib/load-env";
import { Platform } from "@prisma/client";
import prisma from "../app/lib/prisma";
import { OrderUseCase } from "../app/marketplaces/usecases/order.usercase";
import {
  extractMagaluOrderItems,
  magaluMoneyToNumber,
} from "../app/marketplaces/types/magalu-order.types";

/**
 * backfill-magalu-orders.ts
 *
 * Reimporta pedidos da Magalu de uma janela e dá a baixa de estoque que ficou
 * faltando.
 *
 * Por que existe: até este bloco, a Magalu não tinha NENHUM poll de pedidos no
 * loop de produção (`scripts/sync-orders-and-metrics-loop.ts` cobria só ML e
 * Shopee). O webhook era o único caminho — e nunca chegou: zero registros em
 * `WebhookEventLog` com `source = "MAGALU"`. Resultado: nenhuma venda Magalu
 * jamais virou `Order`, mesmo em contas com centenas de anúncios ativos. Este
 * script recupera o passado; o loop cuida do futuro.
 *
 * A importação é idempotente: o unique `(marketplaceAccountId,
 * externalOrderId)` do `Order` e o tratamento de P2002 impedem duplicata, e
 * pedido já existente não desconta estoque de novo.
 *
 * DRY-RUN é o padrão (`--apply` para importar de verdade). No dry-run nenhum
 * pedido é criado e nenhum estoque é tocado: o script só lista o que a API da
 * Magalu devolve e o que já existe no banco.
 *
 * Uso:
 *   npx tsx scripts/backfill-magalu-orders.ts                          # todas as contas, 7 dias
 *   npx tsx scripts/backfill-magalu-orders.ts --days=30
 *   npx tsx scripts/backfill-magalu-orders.ts --account=<accountId>
 *   npx tsx scripts/backfill-magalu-orders.ts --pedido=<externalOrderId>
 *   npx tsx scripts/backfill-magalu-orders.ts --apply --days=30
 *   npx tsx scripts/backfill-magalu-orders.ts --apply --sem-estoque   # cria Order sem baixar
 */

interface Flags {
  accountId: string | null;
  orderIds: string[];
  days: number;
  apply: boolean;
  deductStock: boolean;
}

function parseFlags(argv: string[]): Flags {
  const get = (n: string) => {
    const p = `--${n}=`;
    const f = argv.find((a) => a.startsWith(p));
    return f ? f.slice(p.length) : undefined;
  };
  const has = (n: string) => argv.includes(`--${n}`);
  const daysRaw = get("days");
  return {
    accountId: get("account") ?? null,
    orderIds: (get("pedido") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    days: daysRaw && /^\d+$/.test(daysRaw) ? parseInt(daysRaw, 10) : 7,
    // Escrita é OPT-IN.
    apply: has("apply"),
    deductStock: !has("sem-estoque"),
  };
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const isDry = !flags.apply;
  console.log(
    `[backfill-magalu] modo=${isDry ? "DRY-RUN (nada gravado)" : "APPLY"} days=${flags.days} deductStock=${flags.deductStock}` +
      `${flags.accountId ? ` account=${flags.accountId}` : ""}` +
      `${flags.orderIds.length ? ` pedidos=${flags.orderIds.join(",")}` : ""}`,
  );

  const accounts = await prisma.marketplaceAccount.findMany({
    where: {
      platform: Platform.MAGALU,
      status: "ACTIVE",
      ...(flags.accountId ? { id: flags.accountId } : {}),
    },
    select: { id: true, accountName: true, userId: true },
  });

  if (accounts.length === 0) {
    console.log("[backfill-magalu] nenhuma conta Magalu ACTIVE encontrada.");
    await prisma.$disconnect();
    return;
  }
  console.log(`[backfill-magalu] contas: ${accounts.length}`);

  let totalImportado = 0;
  let totalBaixas = 0;
  let totalJaExistia = 0;
  let totalSemProduto = 0;
  let totalPuladoStatus = 0;
  const statusDesconhecidos = new Set<string>();

  for (const acc of accounts) {
    const antes = await prisma.order.count({
      where: { marketplaceAccountId: acc.id },
    });
    console.log(
      `\n[backfill-magalu] conta ${acc.accountName} (${acc.id}) — pedidos no banco ANTES: ${antes}`,
    );

    try {
      // No dry-run passamos deductStock=false E não chamamos o import: a
      // importação cria Order, que é escrita. O dry-run se limita a mostrar o
      // estado atual e o que a API devolveria.
      if (isDry) {
        const { MagaluApiService } = await import(
          "../app/marketplaces/services/magalu-api.service"
        );
        const full = await prisma.marketplaceAccount.findUnique({
          where: { id: acc.id },
          select: { accessToken: true },
        });
        if (!full?.accessToken) {
          console.log(`  [skip] conta sem accessToken`);
          continue;
        }
        const pedidos = await MagaluApiService.getRecentOrders(
          full.accessToken,
          flags.days,
        );
        const ids = pedidos
          .map((o) => String(o.id ?? o.code ?? o.order_id ?? ""))
          .filter(Boolean);
        const existentes = await prisma.order.findMany({
          where: {
            marketplaceAccountId: acc.id,
            externalOrderId: { in: ids },
          },
          select: { externalOrderId: true },
        });
        const existentesSet = new Set(
          existentes.map((o) => o.externalOrderId),
        );
        const novos = pedidos.filter(
          (o) =>
            !existentesSet.has(String(o.id ?? o.code ?? o.order_id ?? "")),
        );
        console.log(
          `  API devolveu ${pedidos.length} pedido(s) na janela de ${flags.days} dias; ${novos.length} ainda NAO estao no banco.`,
        );
        for (const o of novos.slice(0, 20)) {
          const id = String(o.id ?? o.code ?? o.order_id ?? "");
          const st = OrderUseCase.normalizeMagaluStatus(o.status);
          if (st) statusDesconhecidos.add(st);
          // Os itens vêm em deliveries[].items[] — ler `o.items` mostraria 0
          // em todo pedido, que é exatamente o bug que o import tinha.
          const itens = extractMagaluOrderItems(o);
          const resumo = itens
            .map(
              (it) =>
                `${it.info?.sku ?? it.sku ?? "?"}x${it.quantity ?? 0} (R$ ${magaluMoneyToNumber(it.unit_price).toFixed(2)})`,
            )
            .join(", ");
          console.log(
            `    - #${id} code=${o.code ?? "-"} status="${st || "(vazio)"}" total=R$ ${magaluMoneyToNumber(o.amounts).toFixed(2)} itens=${itens.length}${resumo ? ` [${resumo}]` : ""}`,
          );
        }
        if (novos.length > 20) {
          console.log(`    … e mais ${novos.length - 20}`);
        }
        continue;
      }

      const r = await OrderUseCase.importRecentMagaluOrdersForAccount(
        acc.id,
        flags.days,
        flags.deductStock,
        flags.orderIds.length ? { orderIds: flags.orderIds } : undefined,
      );

      totalImportado += r.imported;
      totalBaixas += r.stockDeductions;
      totalJaExistia += r.alreadyExists;
      totalSemProduto += r.noProducts;
      totalPuladoStatus += r.skippedByStatus ?? 0;
      for (const s of r.skippedStatuses ?? []) statusDesconhecidos.add(s);

      const depois = await prisma.order.count({
        where: { marketplaceAccountId: acc.id },
      });
      console.log(
        `  importados=${r.imported} baixas=${r.stockDeductions} jaExistiam=${r.alreadyExists}` +
          ` semProduto=${r.noProducts} puladosPorStatus=${r.skippedByStatus ?? 0} erros=${r.errors}`,
      );
      console.log(`  pedidos no banco DEPOIS: ${depois} (antes: ${antes})`);

      for (const item of r.results.filter((x) => x.status === "no_products")) {
        console.warn(
          `  [SEM VINCULO] pedido #${item.externalOrderId} — ${item.itemsTotal} item(ns) e nenhum casou com produto`,
        );
      }
    } catch (err) {
      console.error(
        `  [FALHA] conta ${acc.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  console.log(`\n========== RESUMO BACKFILL MAGALU ==========`);
  if (isDry) {
    console.log(`DRY-RUN — nenhum pedido foi criado, nenhum estoque tocado.`);
    if (statusDesconhecidos.size > 0) {
      console.log(
        `Status vistos na API: ${Array.from(statusDesconhecidos).join(", ")}`,
      );
      console.log(
        `(confira se todos estao mapeados em OrderUseCase.mapMagaluStatus)`,
      );
    }
    console.log(
      `Para aplicar:\n  npx tsx scripts/backfill-magalu-orders.ts --apply --days=${flags.days}` +
        `${flags.accountId ? ` --account=${flags.accountId}` : ""}`,
    );
  } else {
    console.log(`Pedidos importados:      ${totalImportado}`);
    console.log(`Baixas de estoque:       ${totalBaixas}`);
    console.log(`Ja existiam:             ${totalJaExistia}`);
    console.log(`Sem produto vinculado:   ${totalSemProduto}`);
    console.log(`Pulados por status:      ${totalPuladoStatus}`);
    if (statusDesconhecidos.size > 0) {
      console.log(
        `Status descartados:      ${Array.from(statusDesconhecidos).join(", ")}`,
      );
    }
  }
  console.log(`============================================`);

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("[fatal]", err);
  await prisma.$disconnect().catch(() => {});
  process.exitCode = 1;
});
