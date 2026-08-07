// Tools de RELATÓRIO: vendas por dimensão e panorama de estoque.
//
// ⭐ ESTE ARQUIVO É O QUE DECIDE SE O BITZ MENTE SOBRE DINHEIRO.
//
// Ele reusa as MESMAS funções que os gráficos do Dashboard usam: as `fetch*`
// (SQL) e as `build*` (agregação pura). Nada de query nova — query nova é
// número novo, e número novo que diverge da tela é o pior defeito possível
// aqui.
//
// Três divergências REAIS do sistema, que existem de propósito e que a tool
// carimba em toda resposta em vez de tentar "corrigir":
//
//  1. CANCELAMENTO. Pedido de marketplace INCLUI cancelados por padrão
//     (dashboard-breakdowns.query.ts:44-48); conta a receber EXCLUI sempre,
//     sem opt-out (:187). São dois domínios com regras opostas, e há spec de
//     reconciliação travando isso. Somar os dois como se fossem a mesma base é
//     o erro clássico.
//
//  2. BASE DE DATA. Marketplace filtra por COALESCE(soldAt, createdAt) — a
//     data da VENDA. Financeiro filtra por createdAt — a data do LANÇAMENTO.
//     "Recebido no mês" não existe: não há nenhuma leitura por `paidAt`.
//
//  3. BASE DE VALOR. Plataforma soma `Order.totalAmount` (com frete e ajustes
//     do marketplace); categoria soma `OrderItem.quantity × unitPrice` (só
//     mercadoria). Os dois totais NÃO batem no mesmo período, por construção.
//
// E a venda de BALCÃO não vira `Order` (o modelo exige conta de marketplace),
// então ela não aparece nas dimensões de marketplace — só nas financeiras.

import { z } from "zod";

import {
  buildCategoryBreakdown,
  buildChannelSplit,
  buildPaymentMethodBreakdown,
  buildPlatformBreakdown,
  resolveDashboardRange,
  serializeRange,
  type PlatformEnumValue,
} from "../../../lib/dashboard-breakdowns";
import {
  fetchOrdersByPlatform,
  fetchReceivablesByChannel,
  fetchReceivablesByPaymentMethod,
  fetchRevenueByCategory,
  fetchRevenueByCategoryTotals,
} from "../../../lib/dashboard-breakdowns.query";
import prisma from "../../../lib/prisma";
import type { AiTool } from "../registry";
import { money, num } from "../serialize";

/**
 * Limiar de estoque baixo.
 *
 * O valor 10 está HARDCODED em dois lugares independentes hoje
 * (product.repository.ts:27, não exportado; e dashboard.routes.ts:173, literal
 * cru). Repetir o número aqui criaria uma TERCEIRA cópia — mas importar a
 * constante não é possível: ela é privada de módulo. Fica declarada com o
 * ponteiro para as duas origens, e um teste pina o valor.
 *
 * `<= 10` INCLUI estoque zero, igual ao Dashboard.
 */
export const LIMIAR_ESTOQUE_BAIXO = 10;

const DIMENSOES = [
  "plataforma",
  "categoria",
  "forma-de-pagamento",
  "canal",
] as const;

export const relatorioVendas: AiTool = {
  name: "relatorio_vendas",
  description:
    "Relatório de vendas de um período, em uma de quatro dimensões: " +
    "'plataforma' (faturamento por marketplace), 'categoria' (faturamento por categoria de peça), " +
    "'forma-de-pagamento' (contas a receber por forma) e 'canal' (balcão × avulso). " +
    "As duas primeiras são de pedidos de marketplace; as duas últimas são do financeiro — são bases DIFERENTES e não somam entre si. " +
    "Sempre repasse ao usuário as ressalvas que vierem no campo 'comoLer'.",
  args: z
    .object({
      dimensao: z.enum(DIMENSOES).describe("Em que eixo abrir o faturamento."),
      inicio: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe(
          "Data inicial AAAA-MM-DD. Sem período, usa os últimos 30 dias.",
        ),
      fim: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe("Data final AAAA-MM-DD."),
      dias: z
        .number()
        .int()
        .min(1)
        .max(730)
        .optional()
        .describe(
          "Alternativa ao par início/fim: os últimos N dias. Ignorado se início ou fim vier.",
        ),
      excluirCancelados: z
        .boolean()
        .optional()
        .describe(
          "Só para as dimensões de marketplace: tira os pedidos cancelados da conta.",
        ),
      limite: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe("Só para 'categoria': quantas categorias listar. Padrão 10."),
    })
    .strict(),
  kind: "read",
  page: "dashboard",
  keywords: [
    "vendi",
    "vendeu",
    "vendemos",
    "faturou",
    "faturament",
    "faturei",
    "receita",
    "relatorio",
    "vendas",
    "por plataforma",
    "por categoria",
    "forma de pagamento",
    "canal",
    "balanco",
    "resumo do mes",
    "mais vendid",
  ],
  sourceLabel: "Relatório de vendas do Dashboard",
  handler: async (args, scope) => {
    // resolveDashboardRange é o resolvedor CANÔNICO (o mesmo das rotas):
    // interpreta as datas em UTC, aplica o clamp de borda de fuso e limita a
    // janela em 730 dias. Uma tool que resolvesse período por conta própria
    // divergiria da tela justamente na virada do dia.
    const range = resolveDashboardRange({
      startDate: args.inicio,
      endDate: args.fim,
      days: args.dias ? String(args.dias) : undefined,
    });
    const periodo: any = serializeRange(range);

    // ⭐ O resolvedor da casa ESTICA o fim do período até agora quando o fim
    // pedido está a menos de 24h no passado (team-productivity.ts:158). Existe
    // para não perder registro recém-criado na borda de fuso — e tem um efeito
    // colateral que morde justamente a pergunta mais provável do agente:
    // "quanto vendi ONTEM" passa a incluir HOJE.
    //
    // Não dá para corrigir aqui sem divergir da tela (dois specs pinam esse
    // comportamento). O que dá é DETECTAR e dizer, para o modelo não afirmar
    // um recorte que não foi o executado.
    if (args.fim) {
      const fimPedido = new Date(`${args.fim}T23:59:59.999Z`);
      if (range.endDate.getTime() > fimPedido.getTime() + 1000) {
        periodo.avisoDePeriodo =
          `O período foi ESTENDIDO até agora. Você pediu até ${args.fim}, mas o sistema inclui também o que aconteceu depois disso, ` +
          `porque a data pedida está a menos de 24 horas no passado. Diga isso ao usuário: o número inclui o dia de hoje.`;
      }
    }

    periodo.corteDoDia =
      "O corte de dia e de mês é em UTC. Na prática, uma venda feita depois das 21h no horário de Brasília conta no dia seguinte — é assim também nas telas do Dashboard.";

    const excluirCancelados = Boolean(args.excluirCancelados);
    const plataformas: PlatformEnumValue[] = [];
    const agora = new Date();

    if (args.dimensao === "plataforma") {
      const rows = await fetchOrdersByPlatform(
        scope.dataOwnerId,
        range.startDate,
        range.endDate,
        plataformas,
        excluirCancelados,
      );
      const b = buildPlatformBreakdown(rows);
      return {
        dimensao: "plataforma",
        periodo,
        base: "pedidos dos marketplaces",
        comoLer: {
          cancelados: excluirCancelados
            ? "excluídos do cálculo"
            : "INCLUÍDOS no faturamento — diga isso ao usuário",
          receitaCancelada:
            "`canceladoValor` é um SUBCONJUNTO de `valor`, não uma parcela adicional. Receita líquida = valor − canceladoValor.",
          data: "período pela data da venda no marketplace",
          balcao: "venda de balcão NÃO entra aqui",
          // O valor do pedido vem do marketplace já com frete embutido.
          oQueOValorInclui:
            "`valor` é o valor do PEDIDO, que inclui frete e ajustes do marketplace. Não é só a mercadoria — para isso, use a dimensão 'categoria'.",
        },
        totais: {
          pedidos: num(b.totals.orders),
          valor: money(b.totals.revenue),
          canceladoPedidos: num(b.totals.cancelledOrders),
          canceladoValor: money(b.totals.cancelledRevenue),
        },
        itens: b.byPlatform.map((i) => ({
          canal: i.label,
          pedidos: num(i.orders),
          valor: money(i.revenue),
          canceladoPedidos: num(i.cancelledOrders),
          canceladoValor: money(i.cancelledRevenue),
          participacaoPercentual: Math.round(i.share * 10) / 10,
        })),
      };
    }

    if (args.dimensao === "categoria") {
      const limite = Math.min(args.limite ?? 10, 20);
      const [rows, totals] = await Promise.all([
        fetchRevenueByCategory(
          scope.dataOwnerId,
          range.startDate,
          range.endDate,
          plataformas,
          excluirCancelados,
        ),
        fetchRevenueByCategoryTotals(
          scope.dataOwnerId,
          range.startDate,
          range.endDate,
          plataformas,
          excluirCancelados,
        ),
      ]);
      const b = buildCategoryBreakdown(rows, totals, limite);
      return {
        dimensao: "categoria",
        periodo,
        base: "itens de pedido dos marketplaces",
        comoLer: {
          cancelados: excluirCancelados
            ? "excluídos do cálculo"
            : "INCLUÍDOS no faturamento",
          valor:
            "soma de quantidade × preço unitário dos ITENS. NÃO bate com o relatório por plataforma, que soma o valor do pedido (com frete e ajustes).",
          pedidosPorCategoria:
            "não existe: um pedido com peças de duas categorias contaria nas duas. O número de pedidos só aparece no total.",
          data: "período pela data da venda no marketplace",
        },
        totais: {
          valor: money(b.totals.revenue),
          unidades: num(b.totals.units),
          pedidos: num(b.totals.orders),
          categorias: num(b.totals.categories),
        },
        listaTruncada: b.truncated,
        itens: b.items.map((i) => ({
          categoria: i.category,
          valor: money(i.revenue),
          unidades: num(i.units),
          participacaoPercentual: Math.round(i.share * 10) / 10,
          agrupaOResto: i.isOther,
        })),
      };
    }

    // Dimensões financeiras. `now` é BINDADO (não é o now() do Postgres) para o
    // corte pendente/vencido bater com o da tela.
    const rows =
      args.dimensao === "forma-de-pagamento"
        ? await fetchReceivablesByPaymentMethod(
            scope.dataOwnerId,
            range.startDate,
            range.endDate,
            agora,
          )
        : await fetchReceivablesByChannel(
            scope.dataOwnerId,
            range.startDate,
            range.endDate,
            agora,
          );

    const b: any =
      args.dimensao === "forma-de-pagamento"
        ? buildPaymentMethodBreakdown(rows)
        : buildChannelSplit(rows);

    return {
      dimensao: args.dimensao,
      periodo,
      base: "contas a receber",
      comoLer: {
        canceladas:
          "contas CANCELADAS ficam sempre fora — não há como incluí-las",
        data: "período pela data de LANÇAMENTO da conta, não pela data do recebimento",
        pago: "`pago` é: do que foi lançado neste período, quanto já está pago. NÃO é quanto entrou no caixa no período.",
        marketplace:
          "pedido de marketplace NÃO entra aqui — este é o lado financeiro",
      },
      totais: {
        total: money(b.totals.total),
        pago: money(b.totals.pago),
        pendente: money(b.totals.pendente),
        vencido: money(b.totals.vencido),
        contas: num(b.totals.count),
      },
      itens: b.items.map((i: any) => ({
        rotulo: i.label,
        total: money(i.total),
        pago: money(i.pago),
        pendente: money(i.pendente),
        vencido: money(i.vencido),
        contas: num(i.count),
        participacaoPercentual: Math.round(i.share * 10) / 10,
      })),
    };
  },
};

export const relatorioEstoque: AiTool = {
  name: "relatorio_estoque",
  description:
    "Panorama do estoque: quantas peças cadastradas, quantas unidades no total, " +
    "a distribuição por faixa de estoque, as peças com estoque baixo e as categorias com mais peças. " +
    "É uma fotografia de agora — não aceita período.",
  args: z
    .object({
      topCategorias: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe("Quantas categorias listar. Padrão 10."),
    })
    .strict(),
  kind: "read",
  page: "dashboard",
  keywords: [
    "estoque",
    "quantos produtos",
    "quantas pecas",
    "estoque baixo",
    "acabando",
    "inventario",
    "por categoria",
    "distribuicao",
  ],
  sourceLabel: "Panorama de estoque do Dashboard",
  handler: async (args, scope) => {
    const userId = scope.dataOwnerId;
    const topCategorias = Math.min(args.topCategorias ?? 10, 20);

    // As MESMAS chamadas de /dashboard/stats, /stock-distribution e
    // /products-by-category (dashboard.routes.ts:162-184, :287-300, :249-260).
    // Prisma tipado, sem $queryRaw — então não há BigInt aqui, e o
    // `product.stock` é Int, então `_sum.stock` já vem como number.
    const [
      totalProdutos,
      somaEstoque,
      estoqueBaixo,
      zerados,
      ate3,
      ate10,
      ate50,
      acima50,
      porCategoria,
    ] = await Promise.all([
      prisma.product.count({ where: { userId } }),
      prisma.product.aggregate({ where: { userId }, _sum: { stock: true } }),
      prisma.product.findMany({
        where: { userId, stock: { lte: LIMIAR_ESTOQUE_BAIXO } },
        orderBy: { stock: "asc" },
        take: 10,
        select: { id: true, name: true, sku: true, stock: true },
      }),
      prisma.product.count({ where: { userId, stock: 0 } }),
      prisma.product.count({ where: { userId, stock: { not: 0, lte: 3 } } }),
      prisma.product.count({ where: { userId, stock: { gt: 3, lte: 10 } } }),
      prisma.product.count({ where: { userId, stock: { gt: 10, lte: 50 } } }),
      prisma.product.count({ where: { userId, stock: { gt: 50 } } }),
      prisma.product.groupBy({
        by: ["category"],
        where: { userId },
        _count: { _all: true },
      }),
    ]);

    const categorias = porCategoria
      .map((c) => ({
        categoria: c.category ?? "Sem categoria",
        pecas: c._count._all,
      }))
      .sort((a, b) => b.pecas - a.pecas);

    return {
      pecasCadastradas: totalProdutos,
      unidadesEmEstoque: num(somaEstoque._sum.stock) ?? 0,
      estoqueBaixo: {
        criterio: `estoque menor ou igual a ${LIMIAR_ESTOQUE_BAIXO} unidades`,
        atencao:
          "O critério INCLUI peças com estoque zero — normalmente são elas que aparecem no topo desta lista.",
        itens: estoqueBaixo.map((p) => ({
          sku: p.sku,
          nome: p.name,
          estoque: p.stock,
        })),
      },
      distribuicao: [
        { faixa: "0", pecas: zerados },
        { faixa: "1-3", pecas: ate3 },
        { faixa: "4-10", pecas: ate10 },
        { faixa: "11-50", pecas: ate50 },
        { faixa: ">50", pecas: acima50 },
      ],
      categorias: {
        total: categorias.length,
        exibidas: Math.min(categorias.length, topCategorias),
        itens: categorias.slice(0, topCategorias),
      },
    };
  },
};
