// Vendas que caíram sobre peça sem estoque, para o aviso na tela de Pedidos.
//
// A baixa de pedido já detecta o caso e grava `OVERSELL_DETECTED` (a quantidade
// vendida era maior que o estoque disponível). Até 17/09/2026 esse registro
// nascia sem `userId` e nenhum lojista o via: 51 de 51 em setembro. Agora ele
// nasce com o dono do tenant (order.usercase.ts), e esta leitura monta a lista.
//
// Lê o próprio SystemLog (índice [action, createdAt]) em vez de criar tabela: é
// só leitura, sem DDL e sem estado novo. Pedido CANCELADO sai da lista — o
// cancelamento é justamente a resolução do problema.
//
// Kill-switch: ORDER_OVERSELL_ALERTS_DISABLED=1.

import prisma from "../../lib/prisma";

export const OVERSELL_ALERT_WINDOW_DAYS = 7;
const MAX_LOGS = 50;

export interface OversellAlertItem {
  productId: string;
  sku: string | null;
  nome: string;
}

export interface OversellAlert {
  id: string;
  orderId: string;
  externalOrderId: string;
  platform: string;
  accountName: string | null;
  createdAt: string;
  itens: OversellAlertItem[];
}

type LogRow = { id: string; createdAt: Date; details: any };

export const OversellAlertsService = {
  async listForOwner(ownerId: string, now: Date = new Date()): Promise<OversellAlert[]> {
    if (process.env.ORDER_OVERSELL_ALERTS_DISABLED === "1") return [];
    if (!ownerId) return [];

    const desde = new Date(
      now.getTime() - OVERSELL_ALERT_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );

    const logs: LogRow[] = await (prisma as any).systemLog.findMany({
      where: {
        action: "OVERSELL_DETECTED",
        userId: ownerId,
        createdAt: { gte: desde },
      },
      orderBy: { createdAt: "desc" },
      take: MAX_LOGS,
      select: { id: true, createdAt: true, details: true },
    });
    if (logs.length === 0) return [];

    // Um aviso por pedido (a re-tentativa de baixa pode registrar de novo): fica
    // o mais recente, que é o primeiro na ordem desc.
    const porPedido = new Map<string, LogRow>();
    for (const log of logs) {
      const orderId = log.details?.orderId;
      if (typeof orderId !== "string" || !orderId) continue;
      if (!porPedido.has(orderId)) porPedido.set(orderId, log);
    }
    if (porPedido.size === 0) return [];

    const productIds = new Set<string>();
    for (const log of porPedido.values()) {
      for (const item of Array.isArray(log.details?.items) ? log.details.items : []) {
        if (typeof item?.productId === "string") productIds.add(item.productId);
      }
    }

    // Escopo de tenant de novo na leitura do pedido: o userId do log vem do
    // próprio sistema, mas o pedido exibido tem de ser de conta do tenant. É o
    // MESMO escopo da tela de Pedidos e de GET /orders/:id — senão o aviso
    // mostraria pedido que o "Ver pedido" não consegue abrir.
    const [orders, products] = await Promise.all([
      (prisma as any).order.findMany({
        where: {
          id: { in: Array.from(porPedido.keys()) },
          marketplaceAccount: { userId: ownerId },
        },
        select: {
          id: true,
          externalOrderId: true,
          status: true,
          marketplaceAccount: { select: { platform: true, accountName: true } },
        },
      }),
      productIds.size > 0
        ? (prisma as any).product.findMany({
            // Só peça da própria empresa: há anúncio ligado a produto de OUTRO
            // tenant em produção, e a baixa pode ter caído nele.
            where: {
              id: { in: Array.from(productIds) },
              user: { OR: [{ id: ownerId }, { parentUserId: ownerId }] },
            },
            select: { id: true, sku: true, name: true },
          })
        : Promise.resolve([]),
    ]);

    const pedidoPorId = new Map<string, any>(orders.map((o: any) => [o.id, o]));
    const produtoPorId = new Map<string, any>(products.map((p: any) => [p.id, p]));

    const alertas: OversellAlert[] = [];
    for (const [orderId, log] of porPedido) {
      const pedido = pedidoPorId.get(orderId);
      if (!pedido || pedido.status === "CANCELLED") continue;
      const itens: OversellAlertItem[] = (
        Array.isArray(log.details?.items) ? log.details.items : []
      )
        .filter((i: any) => typeof i?.productId === "string")
        .map((i: any) => {
          const p = produtoPorId.get(i.productId);
          // Peça fora da empresa (ou apagada): nem nome nem SKU — o nome
          // gravado no alerta pode ser de outro tenant.
          return {
            productId: i.productId,
            sku: p?.sku ?? null,
            nome: p?.name ?? "Peça",
          };
        });
      alertas.push({
        id: log.id,
        orderId,
        externalOrderId: pedido.externalOrderId,
        platform: pedido.marketplaceAccount?.platform ?? log.details?.platform ?? "",
        accountName: pedido.marketplaceAccount?.accountName ?? null,
        createdAt: new Date(log.createdAt).toISOString(),
        itens,
      });
    }
    return alertas;
  },
};
