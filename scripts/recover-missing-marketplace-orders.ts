import "./lib/load-env";
import fs from "node:fs";
import path from "node:path";
import prisma from "../app/lib/prisma";
import { OrderUseCase } from "../app/marketplaces/usecases/order.usercase";
import { ShopeeApiService } from "../app/marketplaces/services/shopee-api.service";
import { ShopeeOAuthService } from "../app/marketplaces/services/shopee-oauth.service";
import { MarketplaceRepository } from "../app/marketplaces/repositories/marketplace.repository";
import { normalizeSku } from "../app/lib/sku";

/**
 * Reconcilia os pedidos que o marketplace TEM com os `Order` que o Dexo tem, e
 * recupera os que faltam.
 *
 * Uso:
 *   npx tsx scripts/recover-missing-marketplace-orders.ts \
 *     --user=<dataOwnerId> --platform=shopee --days=60 [--order-sn=<sn>] [--apply]
 *
 * DRY-RUN E O PADRAO. Sem `--apply` o script so LE: nao cria pedido, nao baixa
 * estoque, nao grava nada. Ele relata o que faria, incluindo a qual produto
 * cada item vincularia e qual seria o estoque antes/depois.
 *
 * Com `--apply`, ingere pelo caminho CANONICO de producao
 * (`OrderUseCase.ingestShopeeOrder`) — mesma validacao, mesma idempotencia,
 * mesma baixa, mesmo StockLog. Nada de INSERT manual.
 *
 * Idempotente: rodar duas vezes nao cria pedido duplicado nem baixa duas
 * vezes. As ancoras sao o `@@unique([marketplaceAccountId, externalOrderId])`
 * do Order e o net do StockLog por `reason`.
 *
 * ATENCAO: a Shopee exige IP na whitelist — este script so funciona da VPS.
 */

/**
 * Status sem venda concretizada — espelha ShopeeApiService.NON_SALE_STATUSES.
 * Duplicado aqui (e nao importado) para que o script rode tambem contra uma
 * instalacao que ainda nao subiu o service novo.
 */
const NON_SALE_STATUSES = new Set(["UNPAID", "CANCELLED", "IN_CANCEL"]);

interface Flags {
  userId: string | null;
  platform: string;
  days: number;
  orderSn: string | null;
  apply: boolean;
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
    userId: get("user") ?? null,
    platform: (get("platform") ?? "shopee").toLowerCase(),
    days: daysRaw && /^\d+$/.test(daysRaw) ? parseInt(daysRaw, 10) : 60,
    orderSn: get("order-sn") ?? null,
    // Escrita e OPT-IN.
    apply: has("apply"),
  };
}

interface ItemPlano {
  itemId: string;
  sku: string | null;
  quantidade: number;
  produtoId: string | null;
  produtoSku: string | null;
  estoqueAtual: number | null;
  estoqueDepois: number | null;
  resolucao: "listing" | "sku" | "part_number" | "NAO_RESOLVE";
}

interface PedidoPlano {
  orderSn: string;
  status: string;
  criadoEm: string;
  contaId: string;
  existeNoDexo: boolean;
  temBaixa: boolean | null;
  itens: ItemPlano[];
  acao: "nada_a_fazer" | "criar_pedido" | "so_baixa" | "sem_vinculo";
  aplicado?: string;
}

const brt = (epochSec?: number) =>
  epochSec
    ? new Date(epochSec * 1000).toLocaleString("pt-BR", {
        timeZone: "America/Sao_Paulo",
      })
    : "";

/** Token valido para a conta, refrescando (e persistindo) se preciso. */
async function tokenValido(account: any): Promise<string> {
  const expiraEm = account.expiresAt
    ? new Date(account.expiresAt).getTime()
    : 0;
  if (expiraEm - Date.now() > 60_000) return account.accessToken;

  const refreshed = await ShopeeOAuthService.refreshAccessToken(
    account.refreshToken,
    account.shopId,
  );
  await MarketplaceRepository.updateTokens(account.id, {
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token,
    expiresAt: ShopeeOAuthService.calculateExpiryDate(refreshed.expire_in),
  });
  return refreshed.access_token;
}

/**
 * Simula a cadeia de vinculo do import, SEM gravar nada. Espelha a ordem de
 * `mapShopeeOrderItems`; se divergir, o dry-run mente — por isso a resolucao
 * fica explicita no relatorio.
 */
async function planejarItens(
  detalhe: any,
  contaId: string,
  ownerId: string,
): Promise<ItemPlano[]> {
  const planos: ItemPlano[] = [];

  for (const item of detalhe.item_list ?? []) {
    const itemId = String(item.item_id);
    const sku = item.model_sku || item.item_sku || null;
    const quantidade = item.model_quantity_purchased ?? 0;

    let produtoId: string | null = null;
    let resolucao: ItemPlano["resolucao"] = "NAO_RESOLVE";

    const listing = await prisma.productListing.findFirst({
      where: {
        externalListingId: itemId,
        marketplaceAccount: { platform: "SHOPEE", userId: ownerId },
      },
      select: { productId: true, marketplaceAccountId: true },
    });
    if (listing) {
      produtoId = listing.productId;
      resolucao = "listing";
    }

    if (!produtoId && sku) {
      const norm = normalizeSku(sku);
      if (norm) {
        const p = await prisma.product.findFirst({
          where: { skuNormalized: norm, userId: ownerId },
          select: { id: true },
        });
        if (p) {
          produtoId = p.id;
          resolucao = "sku";
        } else {
          const cands = await prisma.product.findMany({
            where: { userId: ownerId, partNumberNormalized: norm },
            select: { id: true },
            take: 2,
          });
          if (cands.length === 1) {
            produtoId = cands[0].id;
            resolucao = "part_number";
          }
        }
      }
    }

    const produto = produtoId
      ? await prisma.product.findUnique({
          where: { id: produtoId },
          select: { sku: true, stock: true },
        })
      : null;

    planos.push({
      itemId,
      sku,
      quantidade,
      produtoId,
      produtoSku: produto?.sku ?? null,
      estoqueAtual: produto?.stock ?? null,
      estoqueDepois:
        produto != null ? Math.max(0, produto.stock - quantidade) : null,
      resolucao,
    });
  }

  return planos;
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const isDry = !flags.apply;

  if (!flags.userId) {
    console.error(
      "Uso: --user=<dataOwnerId> [--platform=shopee] [--days=60] [--order-sn=SN] [--apply]",
    );
    process.exit(2);
  }
  if (flags.platform !== "shopee") {
    console.error(
      `Plataforma "${flags.platform}" ainda nao suportada por este script (so shopee).`,
    );
    process.exit(2);
  }

  console.log(
    `[recover] modo=${isDry ? "DRY-RUN (nada gravado)" : "APPLY"} user=${flags.userId} platform=${flags.platform} days=${flags.days}${flags.orderSn ? ` order-sn=${flags.orderSn}` : ""}`,
  );

  const contas = await prisma.marketplaceAccount.findMany({
    where: { userId: flags.userId, platform: "SHOPEE" },
    select: {
      id: true,
      accountName: true,
      shopId: true,
      status: true,
      userId: true,
      accessToken: true,
      refreshToken: true,
      expiresAt: true,
    },
  });

  if (!contas.length) {
    console.log("Nenhuma conta Shopee para este usuario.");
    return;
  }

  const relatorio: PedidoPlano[] = [];

  for (const conta of contas) {
    console.log(
      `\n=== conta ${conta.accountName} (shopId=${conta.shopId}, status=${conta.status}) ===`,
    );
    if (!conta.accessToken || !conta.shopId) {
      console.log("  sem credenciais — pulando");
      continue;
    }

    let token: string;
    try {
      token = await tokenValido(conta);
    } catch (err) {
      console.error(
        "  falha ao obter token:",
        err instanceof Error ? err.message : err,
      );
      continue;
    }

    // A janela do get_order_list tem teto de 15 dias na API, entao fatiamos
    // `days` em blocos — e por isso que `--days=60` funciona.
    const agora = Math.floor(Date.now() / 1000);
    const BLOCO = 14 * 86400;
    const sns = new Set<string>();

    if (flags.orderSn) {
      sns.add(flags.orderSn);
    } else {
      for (let fim = agora; fim > agora - flags.days * 86400; fim -= BLOCO) {
        const ini = Math.max(fim - BLOCO, agora - flags.days * 86400);
        for (const campo of ["create_time", "update_time"] as const) {
          let cursor: string | undefined;
          do {
            const r: any = await ShopeeApiService.getOrderList(
              token,
              conta.shopId,
              {
                time_from: ini,
                time_to: fim,
                page_size: 50,
                cursor,
                time_range_field: campo,
              },
            );
            for (const o of r.order_list ?? []) sns.add(o.order_sn);
            cursor = r.more ? r.next_cursor : undefined;
          } while (cursor);
        }
      }
    }

    console.log(`  ${sns.size} pedido(s) na Shopee na janela`);

    const detalhes: any[] = [];
    const lista = [...sns];
    for (let i = 0; i < lista.length; i += 50) {
      detalhes.push(
        ...(await ShopeeApiService.getOrderDetails(
          token,
          conta.shopId,
          lista.slice(i, i + 50),
        )),
      );
    }

    // Mesmo criterio de status do import. Aplicado LOCALMENTE de proposito:
    // assim o script tambem roda contra uma instalacao que ainda nao subiu o
    // ShopeeApiService novo — que e exatamente a situacao enquanto o PR nao foi
    // deployado. A lista espelha ShopeeApiService.NON_SALE_STATUSES.
    const vendas = detalhes.filter((o: any) => {
      if (!NON_SALE_STATUSES.has(o?.order_status)) return true;
      console.log(
        `  - ${o?.order_sn}: status ${o?.order_status} (sem venda concretizada) — ignorado`,
      );
      return false;
    });

    const locais = await prisma.order.findMany({
      where: {
        marketplaceAccountId: conta.id,
        externalOrderId: { in: vendas.map((v: any) => v.order_sn) },
      },
      select: { id: true, externalOrderId: true, status: true },
    });
    const localPorSn = new Map(locais.map((o) => [o.externalOrderId, o]));

    for (const detalhe of vendas) {
      const sn = detalhe.order_sn;
      const local = localPorSn.get(sn);

      let temBaixa: boolean | null = null;
      if (local) {
        const logs = await prisma.stockLog.count({
          where: { reason: `Venda Shopee #${sn}` },
        });
        temBaixa = logs > 0;
      }

      const itens = await planejarItens(detalhe, conta.id, conta.userId);
      const vinculaveis = itens.filter((i) => i.produtoId).length;

      let acao: PedidoPlano["acao"];
      if (local && temBaixa) acao = "nada_a_fazer";
      else if (local && !temBaixa) acao = "so_baixa";
      else if (vinculaveis === 0) acao = "sem_vinculo";
      else acao = "criar_pedido";

      const plano: PedidoPlano = {
        orderSn: sn,
        status: detalhe.order_status,
        criadoEm: brt(detalhe.create_time),
        contaId: conta.id,
        existeNoDexo: Boolean(local),
        temBaixa,
        itens,
        acao,
      };

      if (acao !== "nada_a_fazer") {
        console.log(
          `  * ${sn} [${detalhe.order_status}] criado ${plano.criadoEm} -> ${acao} (${vinculaveis}/${itens.length} itens vinculam)`,
        );
        for (const i of itens) {
          console.log(
            `      item ${i.itemId} sku="${i.sku ?? ""}" x${i.quantidade} -> ${
              i.produtoId
                ? `produto ${i.produtoSku} (${i.resolucao}) estoque ${i.estoqueAtual} -> ${i.estoqueDepois}`
                : "NAO RESOLVE"
            }`,
          );
        }
      }

      if (!isDry && (acao === "criar_pedido" || acao === "so_baixa")) {
        try {
          if (acao === "so_baixa" && local) {
            const ok = await OrderUseCase.retryStockDeduction(
              local.id,
              "SHOPEE",
              sn,
            );
            plano.aplicado = ok ? "baixa_efetivada" : "baixa_falhou";
          } else {
            const r = await OrderUseCase.ingestShopeeOrder(conta.id, detalhe, {
              userId: conta.userId,
              deductStock: true,
              alreadyExists: false,
            });
            plano.aplicado = `${r.status}${r.stockDeducted ? "+baixa" : ""}`;
          }
          console.log(`      APLICADO: ${plano.aplicado}`);
        } catch (err) {
          plano.aplicado = `erro: ${err instanceof Error ? err.message : String(err)}`;
          console.error(`      ERRO: ${plano.aplicado}`);
        }
      }

      relatorio.push(plano);
    }
  }

  // ── Relatorio ───────────────────────────────────────────────────────────
  const outDir = path.join("scripts", "out");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = path.join(outDir, `recover-orders-${flags.userId}-${stamp}`);

  const resumo = {
    modo: isDry ? "DRY-RUN" : "APPLY",
    userId: flags.userId,
    platform: flags.platform,
    days: flags.days,
    totalNaShopee: relatorio.length,
    nadaAFazer: relatorio.filter((r) => r.acao === "nada_a_fazer").length,
    criarPedido: relatorio.filter((r) => r.acao === "criar_pedido").length,
    soBaixa: relatorio.filter((r) => r.acao === "so_baixa").length,
    semVinculo: relatorio.filter((r) => r.acao === "sem_vinculo").length,
  };

  fs.writeFileSync(
    `${base}.json`,
    JSON.stringify({ resumo, pedidos: relatorio }, null, 2),
    "utf8",
  );

  const md: string[] = [
    `# Recuperacao de pedidos — ${flags.platform}`,
    "",
    `- Modo: **${resumo.modo}**`,
    `- Tenant: \`${flags.userId}\``,
    `- Janela: ${flags.days} dias`,
    `- Pedidos com venda concretizada na Shopee: ${resumo.totalNaShopee}`,
    `- Ja corretos no Dexo: ${resumo.nadaAFazer}`,
    `- **Faltando (criar pedido): ${resumo.criarPedido}**`,
    `- **Existem sem baixa de estoque: ${resumo.soBaixa}**`,
    `- Sem nenhum item vinculavel: ${resumo.semVinculo}`,
    "",
  ];
  const pendentes = relatorio.filter((r) => r.acao !== "nada_a_fazer");
  if (pendentes.length) {
    md.push("## Pedidos a tratar", "");
    for (const p of pendentes) {
      md.push(
        `### ${p.orderSn} — ${p.acao}`,
        "",
        `- Status Shopee: ${p.status}`,
        `- Criado: ${p.criadoEm}`,
        `- Existe no Dexo: ${p.existeNoDexo ? "sim" : "NAO"}`,
        `- Tem baixa: ${p.temBaixa === null ? "n/a" : p.temBaixa ? "sim" : "NAO"}`,
        ...(p.aplicado ? [`- Aplicado: ${p.aplicado}`] : []),
        "",
        "| item_id | SKU | qtd | produto | resolucao | estoque antes | depois |",
        "|---|---|---|---|---|---|---|",
        ...p.itens.map(
          (i) =>
            `| ${i.itemId} | ${i.sku ?? ""} | ${i.quantidade} | ${i.produtoSku ?? "—"} | ${i.resolucao} | ${i.estoqueAtual ?? "—"} | ${i.estoqueDepois ?? "—"} |`,
        ),
        "",
      );
    }
  } else {
    md.push("Nenhum pedido pendente: o Dexo esta em dia com a Shopee.", "");
  }
  fs.writeFileSync(`${base}.md`, md.join("\n"), "utf8");

  console.log(`\n=== RESUMO ===`);
  console.log(JSON.stringify(resumo, null, 2));
  console.log(`Relatorio: ${base}.json / ${base}.md`);
  if (isDry && (resumo.criarPedido > 0 || resumo.soBaixa > 0)) {
    console.log(
      `\nPara aplicar: repita o comando com --apply (autorize antes de rodar).`,
    );
  }
}

main()
  .catch((err) => {
    console.error("[recover] erro fatal:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });
