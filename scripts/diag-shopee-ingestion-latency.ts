/**
 * diag-shopee-ingestion-latency.ts
 *
 * Responde duas perguntas que o `Order.status` do Dexo NÃO responde:
 *
 *  1. Quanto tempo passa entre a VENDA na Shopee (`Order.soldAt`, que vem do
 *     `create_time`) e a IMPORTAÇÃO no Dexo (`Order.createdAt`)?
 *  2. Em que estado esses pedidos estão AGORA na Shopee?
 *
 * A segunda pergunta existe porque `mapShopeeStatus` colapsa READY_TO_SHIP,
 * PROCESSED, SHIPPED, RETRY_SHIP, TO_RETURN e TO_CONFIRM_RECEIVE todos em
 * `SHIPPED` local. Ou seja: olhar o status do Dexo não diz se a janela de
 * emissão de etiqueta ainda está aberta — só o `order_status` da Shopee diz.
 *
 * READY_TO_SHIP é o estado em que a etiqueta PODE ser gerada. Depois que o
 * envio é arranjado, a Shopee recusa tanto o upload da NF-e quanto o
 * get_shipping_parameter (ver incidente 2026-07-29).
 *
 * SOMENTE LEITURA: consultas no banco + GET get_order_detail na Shopee.
 * Nenhuma escrita, em lugar nenhum.
 *
 * Uso:
 *   npx tsx scripts/diag-shopee-ingestion-latency.ts            # 30 dias
 *   npx tsx scripts/diag-shopee-ingestion-latency.ts --days=90
 *   npx tsx scripts/diag-shopee-ingestion-latency.ts --no-live  # só banco
 */
import "dotenv/config";

import prisma from "../app/lib/prisma";
import { ShopeeApiService } from "../app/marketplaces/services/shopee-api.service";

function arg(name: string, fallback: string): string {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const HOUR = 3_600_000;

function fmtDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < HOUR) return `${Math.round(ms / 60_000)}min`;
  if (ms < 48 * HOUR) return `${(ms / HOUR).toFixed(1)}h`;
  return `${(ms / (24 * HOUR)).toFixed(1)}d`;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

/** Histograma simples em faixas de tempo legíveis. */
function histogram(values: number[]): void {
  const buckets: Array<[string, (ms: number) => boolean]> = [
    ["< 15 min", (ms) => ms < 15 * 60_000],
    ["15-60 min", (ms) => ms >= 15 * 60_000 && ms < HOUR],
    ["1-6 h", (ms) => ms >= HOUR && ms < 6 * HOUR],
    ["6-24 h", (ms) => ms >= 6 * HOUR && ms < 24 * HOUR],
    ["1-3 dias", (ms) => ms >= 24 * HOUR && ms < 72 * HOUR],
    ["> 3 dias", (ms) => ms >= 72 * HOUR],
  ];
  const total = values.length || 1;
  for (const [label, test] of buckets) {
    const n = values.filter(test).length;
    const pct = (n / total) * 100;
    const bar = "█".repeat(Math.round(pct / 2));
    console.log(
      `    ${label.padEnd(11)} ${String(n).padStart(5)}  ${pct.toFixed(1).padStart(5)}%  ${bar}`,
    );
  }
}

async function main() {
  const days = Number(arg("days", "30"));
  const live = !process.argv.includes("--no-live");
  const since = new Date(Date.now() - days * 24 * HOUR);

  console.log("=".repeat(76));
  console.log(`LATÊNCIA DE INGESTÃO — pedidos Shopee dos últimos ${days} dias`);
  console.log("=".repeat(76));

  const orders = await prisma.order.findMany({
    where: {
      marketplaceAccount: { platform: "SHOPEE" },
      createdAt: { gte: since },
    },
    select: {
      id: true,
      externalOrderId: true,
      status: true,
      soldAt: true,
      createdAt: true,
      marketplaceAccount: {
        select: { id: true, accountName: true, shopId: true, accessToken: true },
      },
      shipmentLabel: { select: { labelStatus: true } },
      nfesEmitidas: {
        where: { status: "AUTHORIZED", ambiente: "PRODUCAO", modelo: "55" },
        select: { id: true, dataAutorizacao: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  console.log(`\nTotal de pedidos Shopee no período: ${orders.length}`);

  // ---- 1. latência venda -> import ----------------------------------------
  const comSoldAt = orders.filter((o) => o.soldAt);
  console.log(
    `Com soldAt preenchido: ${comSoldAt.length} (${orders.length - comSoldAt.length} sem — anteriores à migração)`,
  );

  if (comSoldAt.length > 0) {
    const lat = comSoldAt
      .map((o) => o.createdAt.getTime() - o.soldAt!.getTime())
      .filter((ms) => ms >= 0)
      .sort((a, b) => a - b);

    console.log("\n--- LATÊNCIA venda (soldAt) → import (createdAt) ---");
    console.log(`    mínimo   ${fmtDuration(lat[0])}`);
    console.log(`    p50      ${fmtDuration(percentile(lat, 50))}`);
    console.log(`    p90      ${fmtDuration(percentile(lat, 90))}`);
    console.log(`    p99      ${fmtDuration(percentile(lat, 99))}`);
    console.log(`    máximo   ${fmtDuration(lat[lat.length - 1])}`);
    console.log("\n    distribuição:");
    histogram(lat);

    // A distribuição acima é BIMODAL e por isso o p50 global engana: mistura o
    // regime normal (pedido novo entrando pelo poll/webhook) com o backfill dos
    // pedidos órfãos recuperados em 29/07, que foram VENDIDOS semanas antes e
    // importados de uma vez. Separar por data da VENDA isola os dois.
    const corte = new Date("2026-07-30T00:00:00Z");

    const reportar = (rotulo: string, subset: typeof comSoldAt) => {
      const l = subset
        .map((o) => o.createdAt.getTime() - o.soldAt!.getTime())
        .filter((ms) => ms >= 0)
        .sort((a, b) => a - b);
      if (l.length === 0) {
        console.log(`\n    ${rotulo}: nenhum pedido`);
        return;
      }
      console.log(`\n    ${rotulo}: ${l.length} pedidos`);
      console.log(
        `      p50 ${fmtDuration(percentile(l, 50))} | p90 ${fmtDuration(percentile(l, 90))} | p99 ${fmtDuration(percentile(l, 99))} | máx ${fmtDuration(l[l.length - 1])}`,
      );
      const rapidos = l.filter((ms) => ms < 15 * 60_000).length;
      console.log(
        `      abaixo de 15 min: ${rapidos}/${l.length} (${((rapidos / l.length) * 100).toFixed(1)}%)`,
      );
      histogram(l);
    };

    // REGIME ATUAL: vendas que aconteceram depois do conserto do sync.
    reportar(
      "REGIME ATUAL — vendidos a partir de 30/07",
      comSoldAt.filter((o) => o.soldAt! >= corte),
    );
    // BACKFILL: vendas antigas importadas depois; contaminam a média global.
    reportar(
      "BACKFILL — vendidos ANTES de 30/07",
      comSoldAt.filter((o) => o.soldAt! < corte),
    );
  }

  // ---- 2. status REAL na Shopee agora --------------------------------------
  if (!live) {
    console.log("\n(--no-live: pulando a consulta de status na Shopee)");
    await prisma.$disconnect();
    return;
  }

  console.log("\n--- STATUS REAL NA SHOPEE (get_order_detail, somente leitura) ---");
  console.log(
    "    Necessário porque mapShopeeStatus colapsa 6 status da Shopee em 'SHIPPED' local.",
  );

  const porConta = new Map<string, typeof orders>();
  for (const o of orders) {
    const k = o.marketplaceAccount.id;
    if (!porConta.has(k)) porConta.set(k, []);
    porConta.get(k)!.push(o);
  }

  const statusCount = new Map<string, number>();
  const readyToShip: Array<{
    id: string;
    sn: string;
    temNfe: boolean;
    conta: string;
    idadeH: number;
  }> = [];
  let consultados = 0;
  let falhas = 0;

  for (const [, lista] of porConta) {
    const acc = lista[0].marketplaceAccount;
    if (acc.shopId == null) continue;
    // get_order_detail aceita até 50 order_sn por chamada.
    for (let i = 0; i < lista.length; i += 50) {
      const lote = lista.slice(i, i + 50);
      try {
        // getOrderDetails já devolve o `order_list` desempacotado (array),
        // não o envelope { error, message, response }.
        const detalhes = await ShopeeApiService.getOrderDetails(
          acc.accessToken,
          acc.shopId,
          lote.map((o) => o.externalOrderId),
        );
        for (const d of detalhes) {
          consultados++;
          const st = String(d.order_status ?? "?");
          statusCount.set(st, (statusCount.get(st) ?? 0) + 1);
          if (st === "READY_TO_SHIP" || st === "PROCESSED") {
            const local = lote.find((o) => o.externalOrderId === d.order_sn);
            if (local) {
              readyToShip.push({
                id: local.id,
                sn: local.externalOrderId,
                temNfe: local.nfesEmitidas.length > 0,
                conta: acc.accountName,
                idadeH:
                  (Date.now() - (local.soldAt ?? local.createdAt).getTime()) /
                  HOUR,
              });
            }
          }
        }
      } catch (e) {
        falhas++;
        const msg = e instanceof Error ? e.message : String(e);
        console.log(
          `    ✗ ${acc.accountName} (${lote.length} pedidos): ${msg}`,
        );
        // Token vencido derruba a conta inteira — não adianta tentar os
        // próximos lotes dela.
        if (/invalid access_token|token expired/i.test(msg)) break;
      }
    }
  }

  console.log(`\n    Consultados na Shopee: ${consultados} (lotes com falha: ${falhas})`);
  for (const [st, n] of [...statusCount].sort((a, b) => b[1] - a[1])) {
    const janela =
      st === "READY_TO_SHIP" || st === "PROCESSED"
        ? "  ← ETIQUETA PODE SER GERADA"
        : "";
    console.log(`      ${st.padEnd(20)} ${String(n).padStart(5)}${janela}`);
  }

  console.log(
    `\n==> Pedidos com a JANELA DE ETIQUETA ABERTA agora: ${readyToShip.length}`,
  );
  const comNfe = readyToShip.filter((r) => r.temNfe);
  console.log(`    destes, com NF-e 55 autorizada: ${comNfe.length}`);
  console.log("");
  for (const r of readyToShip.sort((a, b) => a.idadeH - b.idadeH)) {
    const marca = r.temNfe ? "PRONTO p/ ETIQUETA" : "falta emitir a NF-e";
    console.log(
      `      ${r.sn.padEnd(16)} ${r.conta.padEnd(26)} ha ${r.idadeH.toFixed(1).padStart(6)}h   ${marca}`,
    );
    if (r.temNfe) console.log(`        orderId=${r.id}`);
  }
  if (comNfe.length === 0 && readyToShip.length > 0) {
    console.log(
      "\n    Nenhum com NF-e autorizada: a janela está aberta, mas falta o passo fiscal.",
    );
    console.log(
      "    Emitir a NF-e de um deles deixa o pedido pronto para validar a etiqueta ponta a ponta.",
    );
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("erro:", e);
  await prisma.$disconnect();
  process.exit(1);
});
