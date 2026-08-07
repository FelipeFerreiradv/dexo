// Tool de leitura de PEDIDOS dos marketplaces.
//
// Embrulha `OrderUseCase.getOrders` — o mesmo ponto de entrada da tela de
// Pedidos. Escolhido em vez de `OrderRepositoryPrisma.findAllForList` porque
// getOrders NÃO aceita `marketplaceAccountId`: no repositório, passar conta E
// tenant faz o tenant ser IGNORADO (order.repository.ts:664-668), e uma tool
// que aceitasse conta do modelo teria aberto essa porta.
//
// Duas coisas que a tool tem obrigação de dizer em voz alta, porque o payload
// não as diz sozinho:
//
//  1. PEDIDO CANCELADO ENTRA. Não existe filtro que os exclua em lugar nenhum
//     da listagem (verificado: nenhum `status: { not: CANCELLED }` no cluster).
//     "Você vendeu X" incluindo cancelado é a resposta da TELA — divergir dela
//     seria pior —, mas o usuário precisa saber.
//
//  2. A BUSCA TEXTUAL SÓ COBRE nome do cliente e número do pedido
//     (order.repository.ts:697-702). Procurar por SKU aqui devolve zero mesmo
//     com o pedido existindo. Está na descrição para o modelo não prometer.

import { z } from "zod";

import { OrderUseCase } from "../../../marketplaces/usecases/order.usercase";
import type { AiTool } from "../registry";
import { data, money, num } from "../serialize";

const MAX_ITENS = 20;

const STATUS = [
  "PENDING",
  "PAID",
  "SHIPPED",
  "DELIVERED",
  "CANCELLED",
] as const;
const PLATAFORMAS = ["MERCADO_LIVRE", "SHOPEE", "MAGALU"] as const;

const ROTULO_STATUS: Record<string, string> = {
  PENDING: "Pendente",
  PAID: "Pago",
  SHIPPED: "Enviado",
  DELIVERED: "Entregue",
  CANCELLED: "Cancelado",
};

/** "YYYY-MM-DD" -> Date no início/fim do dia. Formato inválido vira undefined. */
function dia(valor: string | undefined, fim: boolean): Date | undefined {
  if (!valor || !/^\d{4}-\d{2}-\d{2}$/.test(valor)) return undefined;
  const d = new Date(`${valor}T${fim ? "23:59:59.999" : "00:00:00.000"}Z`);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export const buscarPedido: AiTool = {
  name: "buscar_pedido",
  description:
    "Lista pedidos vindos do Mercado Livre, Shopee e Magalu, com filtro de período, situação e canal. " +
    "A busca por texto só encontra por NOME DO CLIENTE ou NÚMERO DO PEDIDO — não encontra por SKU nem por nome de peça. " +
    "ATENÇÃO: pedidos cancelados entram no resultado por padrão (é o mesmo comportamento da tela de Pedidos); " +
    "para excluí-los, filtre por situação. Venda de balcão NÃO aparece aqui — ela vive no Financeiro.",
  args: z
    .object({
      consulta: z
        .string()
        .max(80)
        .optional()
        .describe("Nome do cliente ou número do pedido no marketplace."),
      situacao: z
        .enum(STATUS)
        .optional()
        .describe("Situação do pedido no marketplace."),
      plataforma: z.enum(PLATAFORMAS).optional().describe("Canal de venda."),
      de: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe("Data inicial, no formato AAAA-MM-DD."),
      ate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe("Data final, no formato AAAA-MM-DD."),
      limite: z.number().int().min(1).max(MAX_ITENS).optional(),
    })
    .strict(),
  kind: "read",
  page: "pedidos",
  keywords: [
    "pedido",
    "venda no ml",
    "mercado livre",
    "shopee",
    "magalu",
    "comprador",
    "entrega",
    "envio",
    "cancelad",
    "marketplace",
  ],
  sourceLabel: "Pedidos dos marketplaces",
  handler: async (args, scope) => {
    const limite = Math.min(args.limite ?? 10, MAX_ITENS);

    const resultado: any = await OrderUseCase.getOrders(scope.dataOwnerId, {
      ...(args.consulta ? { search: args.consulta } : {}),
      ...(args.situacao ? { status: args.situacao } : {}),
      ...(args.plataforma ? { platform: args.plataforma } : {}),
      ...(dia(args.de, false) ? { dateFrom: dia(args.de, false) } : {}),
      ...(dia(args.ate, true) ? { dateTo: dia(args.ate, true) } : {}),
      page: 1,
      limit: limite,
    });

    const pedidos = resultado?.orders ?? [];

    return {
      total: num(resultado?.total) ?? 0,
      exibidos: pedidos.length,
      // A régua de período e a de cancelamento, ditas sempre. Sem isto o modelo
      // apresenta o número como se fosse faturamento líquido.
      criterios: {
        periodoFiltradoPor: "data da venda no marketplace",
        cancelados: args.situacao
          ? `filtrado por situação: ${ROTULO_STATUS[args.situacao]}`
          : "INCLUÍDOS no resultado",
      },
      observacao:
        (resultado?.total ?? 0) > pedidos.length
          ? `Existem ${resultado.total} pedidos no filtro; estes são os ${pedidos.length} primeiros.`
          : undefined,
      itens: pedidos.map((o: any) => ({
        id: o.id,
        numero: o.externalOrderId,
        // ⚠️ `createdAt` é a data em que o Dexo IMPORTOU. `soldAt` (a data real
        // da venda) existe no banco mas NÃO sai do repositório
        // (mapPrismaToOrder, order.repository.ts:137-158). A tela mostra esta
        // mesma data — divergir seria pior que rotular com precisão.
        importadoEm: data(o.createdAt),
        situacao: ROTULO_STATUS[o.status] ?? o.status,
        valor: money(o.totalAmount),
        cliente: o.customerName ?? null,
        canal: o.marketplaceAccount?.platform ?? null,
        conta: o.marketplaceAccount?.accountName ?? null,
        // Conta LINHAS de item, não unidades (order.repository.ts:715-730).
        linhasDeItem: num(o.itemCount),
      })),
    };
  },
};
