import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import prisma from "../lib/prisma";
import { authMiddleware } from "../middlewares/auth.middleware";
// Gate real do bloqueio de Dashboard por colaborador. Sem ele, esconder o item
// no menu e barrar o Server Component não impediria um GET direto nestas rotas,
// que expõem faturamento do período, receita por conta e top produtos.
import { requirePageAccess } from "../middlewares/require-page-access.middleware";
import { Platform, Prisma } from "@prisma/client";
import {
  aggregateTeamProductivity,
  resolveProductivityRange,
} from "../lib/team-productivity";
import { fetchProductivityGroups } from "../lib/team-productivity.query";
import {
  buildCategoryBreakdown,
  buildChannelSplit,
  buildPaymentMethodBreakdown,
  buildPlatformBreakdown,
  parseBooleanFlag,
  parsePlatformFilter,
  parseTopN,
  resolveDashboardRange,
  serializeRange,
} from "../lib/dashboard-breakdowns";
import {
  fetchOrdersByPlatform,
  fetchReceivablesByChannel,
  fetchReceivablesByPaymentMethod,
  fetchRevenueByCategory,
  fetchRevenueByCategoryTotals,
} from "../lib/dashboard-breakdowns.query";
import { renderDashboardReport } from "../reports/dashboard-report";

function fmtDateTimeBR(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(
    d.getHours(),
  )}:${p(d.getMinutes())}`;
}

function canonFromPlatform(p: Platform): "ML" | "SHOPEE" | "MAGALU" | "OUTRO" {
  if (p === "MERCADO_LIVRE") return "ML";
  if (p === "SHOPEE") return "SHOPEE";
  if (p === "MAGALU") return "MAGALU";
  return "OUTRO";
}

export const dashboardRoutes = async (fastify: FastifyInstance) => {
  /**
   * GET /dashboard/listing-stats
   * Retorna contagem de anúncios por conta e linha do tempo de criação
   */
  fastify.get(
    "/listing-stats",
    { preHandler: [authMiddleware, requirePageAccess("dashboard")] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = request.user?.dataOwnerId;
        if (!userId) {
          return reply.status(401).send({ error: "Usuário não autenticado" });
        }

        const days = Number((request.query as any)?.days) || 180;
        const since = new Date();
        since.setDate(since.getDate() - days);

        const [accounts, createdGrouped] = await Promise.all([
          prisma.marketplaceAccount.findMany({
            where: { userId },
            select: {
              id: true,
              platform: true,
              accountName: true,
              status: true,
              _count: { select: { listings: true } },
            },
          }),
          // EGRESS: agrega a contagem por (conta, dia) NO BANCO em vez de puxar
          // TODOS os anúncios de 180 dias para contar em JS. Mesmo resultado:
          // to_char(createdAt,'YYYY-MM-DD') = createdAt.toISOString().slice(0,10)
          // (createdAt é UTC), e COUNT(*) = soma de 1 por linha do código antigo.
          prisma.$queryRaw<
            Array<{ marketplaceAccountId: string; day: string; count: number }>
          >(Prisma.sql`
            SELECT pl."marketplaceAccountId" AS "marketplaceAccountId",
                   to_char(pl."createdAt", 'YYYY-MM-DD') AS "day",
                   COUNT(*)::int AS "count"
            FROM "ProductListing" pl
            JOIN "MarketplaceAccount" ma ON ma."id" = pl."marketplaceAccountId"
            WHERE pl."createdAt" >= ${since} AND ma."userId" = ${userId}
            GROUP BY pl."marketplaceAccountId", to_char(pl."createdAt", 'YYYY-MM-DD')
          `),
        ]);

        const totalListings = accounts.reduce(
          (sum, acc) => sum + (acc._count.listings ?? 0),
          0,
        );

        const totalListingsActive = accounts
          .filter((acc) => acc.status === "ACTIVE")
          .reduce((sum, acc) => sum + (acc._count.listings ?? 0), 0);

        const globalMap: Record<string, number> = {};
        const perAccountMap: Record<string, Record<string, number>> = {};

        for (const row of createdGrouped) {
          const day = row.day;
          const c = Number(row.count);
          globalMap[day] = (globalMap[day] ?? 0) + c;
          const acc = (perAccountMap[row.marketplaceAccountId] ||= {});
          acc[day] = (acc[day] ?? 0) + c;
        }

        const mapToSeries = (m: Record<string, number>) =>
          Object.keys(m)
            .sort()
            .map((date) => ({ date, count: m[date] }));

        const perAccountSeries = Object.fromEntries(
          Object.entries(perAccountMap).map(([accId, m]) => [
            accId,
            mapToSeries(m),
          ]),
        );

        return reply.status(200).send({
          totalListings,
          totalListingsActive,
          perAccount: accounts.map((acc) => ({
            accountId: acc.id,
            accountName: acc.accountName ?? acc.platform,
            platform: acc.platform,
            status: acc.status,
            totalListings: acc._count.listings ?? 0,
          })),
          timeline: {
            global: mapToSeries(globalMap),
            perAccount: perAccountSeries,
          },
        });
      } catch (error) {
        console.error("Erro listing-stats:", error);
        return reply
          .status(500)
          .send({ error: "Erro ao buscar estatísticas de anúncios" });
      }
    },
  );

  /**
   * GET /dashboard/stats
   * Retorna estatísticas gerais do sistema
   */
  fastify.get(
    "/stats",
    { preHandler: [authMiddleware, requirePageAccess("dashboard")] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        // Buscar estatísticas de produtos
        const [totalProducts, totalStock, lowStockProducts] = await Promise.all(
          [
            // Total de produtos
            prisma.product.count({ where: { userId } }),
            // Total de itens em estoque
            prisma.product.aggregate({
              _sum: { stock: true },
              where: { userId },
            }),
            // Produtos com estoque baixo (menos de 10 unidades)
            prisma.product.findMany({
              where: { stock: { lte: 10 }, userId },
              orderBy: { stock: "asc" },
              take: 5,
              select: {
                id: true,
                name: true,
                sku: true,
                stock: true,
              },
            }),
          ],
        );

        return reply.status(200).send({
          totalProducts,
          totalStock: totalStock._sum.stock || 0,
          lowStockProducts,
        });
      } catch (error) {
        console.error("Erro ao buscar estatísticas:", error);
        return reply.status(500).send({
          error: "Erro ao buscar estatísticas",
        });
      }
    },
  );

  /**
   * GET /dashboard/integrations
   * Retorna integrações ativas do usuário
   * Requer autenticação
   */
  fastify.get(
    "/integrations",
    { preHandler: [authMiddleware, requirePageAccess("dashboard")] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = request.user?.dataOwnerId;

        if (!userId) {
          return reply.status(401).send({ error: "Usuário não autenticado" });
        }

        // Buscar todas as contas de marketplace do usuário
        const accounts = await prisma.marketplaceAccount.findMany({
          where: { userId },
          select: {
            id: true,
            platform: true,
            accountName: true,
            status: true,
            updatedAt: true,
          },
          orderBy: { updatedAt: "desc" },
        });

        return reply.status(200).send({ integrations: accounts });
      } catch (error) {
        console.error("Erro ao buscar integrações:", error);
        return reply.status(500).send({
          error: "Erro ao buscar integrações",
        });
      }
    },
  );

  /**
   * GET /dashboard/products-by-category
   * Retorna contagem de produtos por categoria
   */
  fastify.get(
    "/products-by-category",
    { preHandler: [authMiddleware, requirePageAccess("dashboard")] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const rows = await prisma.product.groupBy({
          by: ["category"],
          _count: { _all: true },
          where: { userId },
        });

        const result = rows
          .map((r) => ({
            category: r.category ?? "Sem categoria",
            count: r._count._all,
          }))
          .sort((a, b) => b.count - a.count);

        return reply.status(200).send(result);
      } catch (error) {
        console.error("Erro products-by-category:", error);
        return reply
          .status(500)
          .send({ error: "Erro ao buscar products-by-category" });
      }
    },
  );

  /**
   * GET /dashboard/stock-distribution
   * Retorna contagem de produtos por faixa de estoque
   */
  fastify.get(
    "/stock-distribution",
    { preHandler: [authMiddleware, requirePageAccess("dashboard")] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;

        // EGRESS: conta cada faixa NO BANCO (5 COUNTs) em vez de puxar o stock
        // de TODOS os produtos para o app e bucketizar em JS. Os predicados
        // particionam EXATAMENTE como o if/else anterior (mesmo resultado):
        //   0 | (!=0 e <=3) | (>3 e <=10) | (>10 e <=50) | (>50)
        const [zero, oneToThree, fourToTen, elevenToFifty, aboveFifty] =
          await Promise.all([
            prisma.product.count({ where: { userId, stock: 0 } }),
            prisma.product.count({
              where: { userId, stock: { not: 0, lte: 3 } },
            }),
            prisma.product.count({
              where: { userId, stock: { gt: 3, lte: 10 } },
            }),
            prisma.product.count({
              where: { userId, stock: { gt: 10, lte: 50 } },
            }),
            prisma.product.count({ where: { userId, stock: { gt: 50 } } }),
          ]);

        const distribution = [
          { range: "0", count: zero },
          { range: "1-3", count: oneToThree },
          { range: "4-10", count: fourToTen },
          { range: "11-50", count: elevenToFifty },
          { range: ">50", count: aboveFifty },
        ];

        return reply.status(200).send(distribution);
      } catch (error) {
        console.error("Erro stock-distribution:", error);
        return reply
          .status(500)
          .send({ error: "Erro ao buscar stock-distribution" });
      }
    },
  );

  /**
   * GET /dashboard/orders-over-time?days=30
   * Retorna agregação diária de pedidos e totalAmount nos últimos N dias
   */
  fastify.get(
    "/orders-over-time",
    { preHandler: [authMiddleware, requirePageAccess("dashboard")] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const daysParam = (request.query as any)?.days;
        const days = daysParam ? parseInt(daysParam, 10) : 30;
        const now = new Date();
        const startDate = new Date(now);
        startDate.setDate(now.getDate() - (isNaN(days) ? 30 : days));

        // EGRESS: agrega contagem + soma por dia NO BANCO em vez de puxar todos
        // os pedidos do período para somar em JS. Mesmos dias (UTC) e mesmos
        // valores (COUNT e SUM exatos).
        const grouped = await prisma.$queryRaw<
          Array<{ day: string; orders: number; total: string | null }>
        >(Prisma.sql`
          SELECT to_char(o."createdAt", 'YYYY-MM-DD') AS "day",
                 COUNT(*)::int AS "orders",
                 COALESCE(SUM(o."totalAmount"), 0)::text AS "total"
          FROM "Order" o
          JOIN "MarketplaceAccount" ma ON ma."id" = o."marketplaceAccountId"
          WHERE o."createdAt" >= ${startDate} AND ma."userId" = ${userId}
          GROUP BY to_char(o."createdAt", 'YYYY-MM-DD')
        `);

        // Inicializar mapa de dias
        const map: Record<string, { orders: number; totalAmount: number }> = {};
        for (let i = 0; i <= (isNaN(days) ? 30 : days); i++) {
          const d = new Date(startDate);
          d.setDate(startDate.getDate() + i);
          const key = d.toISOString().slice(0, 10);
          map[key] = { orders: 0, totalAmount: 0 };
        }

        for (const g of grouped) {
          const key = g.day;
          if (!map[key]) map[key] = { orders: 0, totalAmount: 0 };
          map[key].orders += Number(g.orders);
          map[key].totalAmount += Number(g.total) || 0;
        }

        const result = Object.keys(map)
          .sort()
          .map((date) => ({
            date,
            orders: map[date].orders,
            totalAmount: map[date].totalAmount,
          }));

        return reply.status(200).send(result);
      } catch (error) {
        console.error("Erro orders-over-time:", error);
        return reply
          .status(500)
          .send({ error: "Erro ao buscar orders-over-time" });
      }
    },
  );

  /**
   * GET /dashboard/search?q=term&limit=5
   * Busca unificada em produtos, pedidos e anúncios (todas as contas do usuário)
   */
  // SEM requirePageAccess de propósito: apesar do prefixo /dashboard, esta é a
  // BUSCA GLOBAL do menu lateral (components/app-sidebar.tsx), presente em
  // todas as páginas. Bloqueá-la para quem não vê o Dashboard tiraria a busca
  // do colaborador — bem além do que o cliente pediu, que é esconder
  // faturamento e estatística de vendas. Ela devolve produtos, pedidos e
  // anúncios, nenhum número agregado de receita.
  fastify.get(
    "/search",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const q = ((request.query as any)?.q as string | undefined)?.trim();
        const limit =
          parseInt((request.query as any)?.limit as string, 10) || 5;

        if (!q || q.length < 2) {
          return reply.status(200).send({
            products: [],
            orders: [],
            listings: [],
          });
        }

        const [products, orders, listings] = await Promise.all([
          prisma.product.findMany({
            where: {
              userId,
              OR: [
                { name: { contains: q, mode: "insensitive" } },
                { sku: { contains: q, mode: "insensitive" } },
              ],
            },
            select: {
              id: true,
              name: true,
              sku: true,
              price: true,
              stock: true,
            },
            take: limit,
          }),
          prisma.order.findMany({
            where: {
              marketplaceAccount: { userId },
              OR: [
                { externalOrderId: { contains: q, mode: "insensitive" } },
                { customerName: { contains: q, mode: "insensitive" } },
              ],
            },
            select: {
              id: true,
              externalOrderId: true,
              status: true,
              customerName: true,
              createdAt: true,
              marketplaceAccount: {
                select: { platform: true, accountName: true },
              },
            },
            orderBy: { createdAt: "desc" },
            take: limit,
          }),
          prisma.productListing.findMany({
            where: {
              marketplaceAccount: { userId },
              OR: [
                { externalListingId: { contains: q, mode: "insensitive" } },
                { externalSku: { contains: q, mode: "insensitive" } },
                { product: { name: { contains: q, mode: "insensitive" } } },
              ],
            },
            select: {
              id: true,
              externalListingId: true,
              externalSku: true,
              permalink: true,
              status: true,
              marketplaceAccount: {
                select: { platform: true, accountName: true },
              },
              product: { select: { name: true, sku: true } },
            },
            orderBy: { createdAt: "desc" },
            take: limit,
          }),
        ]);

        return reply.status(200).send({ products, orders, listings });
      } catch (error) {
        console.error("Erro unified search:", error);
        return reply.status(500).send({
          error: "Erro ao buscar",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );

  /**
   * GET /dashboard/stock-changes?days=7
   * Retorna alterações de estoque recentes agrupadas por produto (top N)
   */
  fastify.get(
    "/stock-changes",
    { preHandler: [authMiddleware, requirePageAccess("dashboard")] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      // @deprecated Usado somente pelo dashboard antigo. Remover após migração para listing-stats.
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const daysParam = (request.query as any)?.days;
        const days = daysParam ? parseInt(daysParam, 10) : 7;
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - (isNaN(days) ? 7 : days));

        const logs = await prisma.stockLog.findMany({
          where: {
            createdAt: { gte: startDate },
            product: { userId },
          },
          include: {
            product: {
              select: { id: true, name: true, sku: true, imageUrl: true },
            },
          },
          orderBy: { createdAt: "desc" },
        });

        const grouped: Record<string, any> = {};
        for (const l of logs) {
          const pid = l.productId;
          if (!grouped[pid]) {
            grouped[pid] = {
              productId: pid,
              productName: l.product?.name ?? "—",
              productSku: l.product?.sku ?? "—",
              productImageUrl: l.product?.imageUrl ?? null,
              changes: [],
            };
          }
          grouped[pid].changes.push({
            date: l.createdAt.toISOString(),
            change: l.change,
            previousStock: l.previousStock,
            newStock: l.newStock,
            reason: l.reason ?? null,
          });
        }

        const items = Object.values(grouped)
          .sort((a: any, b: any) => b.changes.length - a.changes.length)
          .slice(0, 10);

        return reply.status(200).send(items);
      } catch (error) {
        console.error("Erro stock-changes:", error);
        return reply
          .status(500)
          .send({ error: "Erro ao buscar stock-changes" });
      }
    },
  );

  /**
   * GET /dashboard/product-metrics?days=30&limit=8
   * Retorna métricas por produto (anúncios vinculados a produtos) usando pedidos reais.
   */
  fastify.get(
    "/product-metrics",
    { preHandler: [authMiddleware, requirePageAccess("dashboard")] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string | undefined;
        if (!userId) {
          return reply.status(401).send({ error: "Usuário não autenticado" });
        }

        const { days: daysParam, limit: limitParam } = request.query as any;
        const days = daysParam ? parseInt(daysParam, 10) : 30;
        const limit = limitParam ? parseInt(limitParam, 10) : 8;

        const now = new Date();
        const currentStart = new Date(now);
        currentStart.setDate(now.getDate() - (isNaN(days) ? 30 : days));
        const previousStart = new Date(currentStart);
        previousStart.setDate(
          currentStart.getDate() - (isNaN(days) ? 30 : days),
        );

        const [currentItems, previousItems] = await Promise.all([
          prisma.orderItem.findMany({
            where: {
              listingId: { not: null },
              order: {
                marketplaceAccount: { userId },
                createdAt: { gte: currentStart },
              },
            },
            select: {
              listingId: true,
              quantity: true,
              unitPrice: true,
              listing: {
                select: {
                  id: true,
                  externalListingId: true,
                  viewsCount: true,
                  reviewsCount: true,
                  productId: true,
                  product: {
                    select: { id: true, name: true, sku: true, stock: true },
                  },
                  marketplaceAccount: {
                    select: { platform: true, accountName: true },
                  },
                },
              },
              order: { select: { createdAt: true } },
            },
          }),
          prisma.orderItem.findMany({
            where: {
              listingId: { not: null },
              order: {
                marketplaceAccount: { userId },
                createdAt: { gte: previousStart, lt: currentStart },
              },
            },
            select: {
              listingId: true,
              quantity: true,
              unitPrice: true,
              order: { select: { createdAt: true } },
            },
          }),
        ]);

        const toNumber = (value: any) =>
          typeof value === "object" &&
          value !== null &&
          typeof value.toNumber === "function"
            ? value.toNumber()
            : Number(value) || 0;

        const aggregate = (
          items: any[],
          includeMeta = false,
        ): Record<
          string,
          {
            revenue: number;
            sales: number;
            lastDate: Date | null;
            listing?: any;
          }
        > => {
          const map: Record<
            string,
            {
              revenue: number;
              sales: number;
              lastDate: Date | null;
              listing?: any;
            }
          > = {};
          for (const it of items) {
            const key = it.listingId;
            if (!key) continue;
            if (!map[key]) {
              map[key] = {
                revenue: 0,
                sales: 0,
                lastDate: null,
                listing: includeMeta ? it.listing : undefined,
              };
            }
            map[key].revenue += toNumber(it.unitPrice) * (it.quantity ?? 0);
            map[key].sales += it.quantity ?? 0;
            const date = it.order?.createdAt;
            if (date) {
              map[key].lastDate = map[key].lastDate
                ? new Date(
                    Math.max(map[key].lastDate!.getTime(), date.getTime()),
                  )
                : date;
            }
          }
          return map;
        };

        const currentAgg = aggregate(currentItems, true);
        const previousAgg = aggregate(previousItems, false);

        const rows = Object.entries(currentAgg)
          .map(([listingId, curr]) => {
            const prev = previousAgg[listingId];
            const growth =
              prev && prev.revenue > 0
                ? ((curr.revenue - prev.revenue) / prev.revenue) * 100
                : null;
            const listing = (curr as any).listing;
            const product = listing?.product;
            return {
              listingId,
              productId: product?.id ?? null,
              name: product?.name ?? "—",
              sku: product?.sku ?? "—",
              stock: product?.stock ?? 0,
              sales: curr.sales,
              revenue: curr.revenue,
              growth,
              reviews: listing?.reviewsCount ?? 0,
              views: listing?.viewsCount ?? 0,
              platform: listing?.marketplaceAccount?.platform ?? null,
              accountName: listing?.marketplaceAccount?.accountName ?? null,
              lastDate: curr.lastDate,
            };
          })
          .sort((a, b) => b.revenue - a.revenue)
          .slice(0, limit);

        return reply.status(200).send({ items: rows });
      } catch (error) {
        console.error("Erro ao buscar product-metrics:", error);
        return reply
          .status(500)
          .send({ error: "Erro ao buscar product-metrics" });
      }
    },
  );

  /**
   * GET /dashboard/account-stats
   * Retorna receita e total de pedidos agrupados por conta de marketplace
   */
  fastify.get(
    "/account-stats",
    { preHandler: [authMiddleware, requirePageAccess("dashboard")] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string | undefined;
        if (!userId) {
          return reply.status(401).send({ error: "Usuário não autenticado" });
        }

        const grouped = await prisma.order.groupBy({
          by: ["marketplaceAccountId"],
          _count: { _all: true },
          _sum: { totalAmount: true },
          where: { marketplaceAccount: { userId } },
        });

        const accountStats: Record<
          string,
          { revenue: number; orders: number }
        > = {};
        for (const row of grouped) {
          const rev = row._sum.totalAmount
            ? typeof (row._sum.totalAmount as any).toNumber === "function"
              ? (row._sum.totalAmount as any).toNumber()
              : Number(row._sum.totalAmount)
            : 0;
          accountStats[row.marketplaceAccountId] = {
            revenue: rev,
            orders: row._count._all,
          };
        }

        return reply.status(200).send({ accountStats });
      } catch (error) {
        console.error("Erro account-stats:", error);
        return reply
          .status(500)
          .send({ error: "Erro ao buscar account-stats" });
      }
    },
  );

  /**
   * GET /dashboard/notifications
   * Eventos recentes para o dashboard (pedidos, produtos, integrações, métricas de anúncios)
   */
  // SEM requirePageAccess de propósito: alimenta o SINO de notificações do
  // cabeçalho (components/app-header.tsx), presente em todas as páginas.
  // Devolve eventos recentes com o valor de cada pedido — o mesmo dado que a
  // página de Pedidos já mostra —, nunca receita agregada. Bloquear aqui
  // quebraria o cabeçalho do colaborador sem esconder nada que ele não veja
  // em outro lugar.
  fastify.get(
    "/notifications",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string | undefined;
        if (!userId) {
          return reply.status(401).send({ error: "Usuário não autenticado" });
        }

        const { days: daysParam, limit: limitParam } = request.query as any;
        const days = daysParam ? parseInt(daysParam, 10) : 7;
        const limit = limitParam ? parseInt(limitParam, 10) : 50;
        const since = new Date();
        since.setDate(since.getDate() - (isNaN(days) ? 7 : days));

        const [newOrders, cancelledOrders, products, accounts, listings] =
          await Promise.all([
            prisma.order.findMany({
              where: {
                createdAt: { gte: since },
                marketplaceAccount: { userId },
              },
              select: {
                id: true,
                externalOrderId: true,
                status: true,
                createdAt: true,
                totalAmount: true,
                marketplaceAccount: {
                  select: { platform: true, accountName: true },
                },
              },
              orderBy: { createdAt: "desc" },
              take: limit,
            }),
            prisma.order.findMany({
              where: {
                status: "CANCELLED",
                updatedAt: { gte: since },
                marketplaceAccount: { userId },
              },
              select: {
                id: true,
                externalOrderId: true,
                status: true,
                updatedAt: true,
                marketplaceAccount: {
                  select: { platform: true, accountName: true },
                },
              },
              orderBy: { updatedAt: "desc" },
              take: limit,
            }),
            prisma.product.findMany({
              where: {
                userId,
                OR: [
                  { createdAt: { gte: since } },
                  { updatedAt: { gte: since } },
                ],
              },
              select: {
                id: true,
                name: true,
                sku: true,
                createdAt: true,
                updatedAt: true,
              },
              orderBy: { updatedAt: "desc" },
              take: limit,
            }),
            prisma.marketplaceAccount.findMany({
              where: { userId, createdAt: { gte: since } },
              select: {
                id: true,
                platform: true,
                accountName: true,
                createdAt: true,
              },
              orderBy: { createdAt: "desc" },
              take: limit,
            }),
            prisma.productListing.findMany({
              where: {
                marketplaceAccount: { userId },
                metricsUpdatedAt: { gte: since },
              },
              select: {
                id: true,
                externalListingId: true,
                metricsUpdatedAt: true,
                viewsCount: true,
                reviewsCount: true,
                marketplaceAccount: {
                  select: { platform: true, accountName: true },
                },
                product: { select: { id: true, name: true } },
              },
              orderBy: { metricsUpdatedAt: "desc" },
              take: limit,
            }),
          ]);

        type Event = {
          id: string;
          type: string;
          title: string;
          description: string;
          timestamp: Date;
          meta?: any;
        };

        const events: Event[] = [];

        for (const o of newOrders) {
          events.push({
            id: `order-${o.id}`,
            type: "order_new",
            title: "Novo pedido",
            description: `${o.marketplaceAccount.accountName} (${o.marketplaceAccount.platform}) - ${o.externalOrderId}`,
            timestamp: o.createdAt,
            meta: { orderId: o.id },
          });
        }

        for (const o of cancelledOrders) {
          events.push({
            id: `order-cancel-${o.id}`,
            type: "order_cancelled",
            title: "Pedido cancelado",
            description: `${o.marketplaceAccount.accountName} - ${o.externalOrderId}`,
            timestamp: o.updatedAt,
            meta: { orderId: o.id },
          });
        }

        for (const p of products) {
          const isNew = p.createdAt >= since;
          const isUpdated =
            p.updatedAt >= since &&
            p.updatedAt.getTime() !== p.createdAt.getTime();
          if (isNew) {
            events.push({
              id: `product-${p.id}-new`,
              type: "product_new",
              title: "Novo produto",
              description: `${p.name}${p.sku ? ` · SKU ${p.sku}` : ""}`,
              timestamp: p.createdAt,
            });
          } else if (isUpdated) {
            events.push({
              id: `product-${p.id}-upd`,
              type: "product_updated",
              title: "Produto atualizado",
              description: `${p.name}${p.sku ? ` · SKU ${p.sku}` : ""}`,
              timestamp: p.updatedAt,
            });
          }
        }

        for (const acc of accounts) {
          events.push({
            id: `acc-${acc.id}`,
            type: "integration_added",
            title: "Nova integração",
            description: `${acc.accountName} (${acc.platform}) conectada`,
            timestamp: acc.createdAt,
          });
        }

        for (const l of listings) {
          events.push({
            id: `listing-${l.id}-metrics`,
            type: "listing_metrics",
            title: "Métricas atualizadas",
            description: `${l.product?.name ?? "Anúncio"} · ${l.marketplaceAccount?.accountName ?? ""}`,
            timestamp: l.metricsUpdatedAt ?? new Date(),
            meta: { views: l.viewsCount, reviews: l.reviewsCount },
          });
        }

        const sorted = events
          .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
          .slice(0, limit);

        return reply.status(200).send({ events: sorted });
      } catch (error) {
        console.error("Erro notifications:", error);
        return reply.status(500).send({ error: "Erro ao buscar notificações" });
      }
    },
  );

  /**
   * GET /dashboard/report.pdf
   * Relatório PDF (A4) com a visão de negócio do período + resumo de
   * produtividade da equipe. Escopo de negócio = dono (dataOwnerId), igual aos
   * demais /dashboard/*. Escopo da equipe = tenant inteiro (dono + filhos).
   * Leitura PURA + render @react-pdf; streama como download.
   * Querystring: startDate, endDate (ISO/"YYYY-MM-DD") ou days. Default: 30 dias.
   */
  fastify.get(
    "/report.pdf",
    { preHandler: [authMiddleware, requirePageAccess("dashboard")] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const ownerId = (request as any).user?.dataOwnerId as
          | string
          | undefined;
        if (!ownerId) {
          return reply.status(401).send({ error: "Usuário não autenticado" });
        }

        const q = request.query as Record<string, string | undefined>;
        let startStr = q.startDate;
        const endStr = q.endDate;
        if (!startStr && !endStr && q.days) {
          const n = parseInt(q.days, 10);
          if (Number.isFinite(n)) {
            const sd = new Date();
            sd.setDate(sd.getDate() - n);
            startStr = sd.toISOString();
          }
        }
        const range = resolveProductivityRange(startStr, endStr);
        const rangeOut = {
          startDate: range.startDate.toISOString(),
          endDate: range.endDate.toISOString(),
          label: range.label,
        };

        // Usuários do tenant (dono + filhos) p/ o resumo de produtividade.
        const [owner, children] = await Promise.all([
          prisma.user.findUnique({
            where: { id: ownerId },
            select: { id: true, name: true, email: true },
          }),
          prisma.user.findMany({
            where: { parentUserId: ownerId },
            select: { id: true, name: true, email: true },
          }),
        ]);
        const tenantUsers = [
          ...(owner ? [owner] : [{ id: ownerId, name: null, email: "" }]),
          ...children,
        ];
        const tenantIds = tenantUsers.map((u) => u.id);

        // --- Dados de negócio (escopo dono) ---
        const [
          ordersGrouped,
          accounts,
          accountRevenue,
          produtosTotal,
          produtosCriadosPeriodo,
          anunciosCriadosPeriodo,
          topProdutosRaw,
          teamGroups,
        ] = await Promise.all([
          prisma.$queryRaw<
            Array<{ day: string; orders: number; total: string | null }>
          >(Prisma.sql`
            SELECT to_char(o."createdAt", 'YYYY-MM-DD') AS "day",
                   COUNT(*)::int AS "orders",
                   COALESCE(SUM(o."totalAmount"), 0)::text AS "total"
            FROM "Order" o
            JOIN "MarketplaceAccount" ma ON ma."id" = o."marketplaceAccountId"
            WHERE o."createdAt" >= ${range.startDate} AND o."createdAt" <= ${range.endDate}
              AND ma."userId" = ${ownerId}
            GROUP BY to_char(o."createdAt", 'YYYY-MM-DD')
          `),
          prisma.marketplaceAccount.findMany({
            where: { userId: ownerId },
            select: {
              id: true,
              platform: true,
              accountName: true,
              status: true,
              _count: { select: { listings: true } },
            },
          }),
          prisma.order.groupBy({
            by: ["marketplaceAccountId"],
            _count: { _all: true },
            _sum: { totalAmount: true },
            where: {
              marketplaceAccount: { userId: ownerId },
              createdAt: { gte: range.startDate, lte: range.endDate },
            },
          }),
          prisma.product.count({ where: { userId: ownerId } }),
          prisma.product.count({
            where: {
              userId: ownerId,
              createdAt: { gte: range.startDate, lte: range.endDate },
            },
          }),
          prisma.productListing.count({
            where: {
              marketplaceAccount: { userId: ownerId },
              createdAt: { gte: range.startDate, lte: range.endDate },
            },
          }),
          prisma.product.findMany({
            where: { userId: ownerId },
            select: {
              name: true,
              sku: true,
              _count: { select: { listings: true } },
            },
            orderBy: { listings: { _count: "desc" } },
            take: 5,
          }),
          // EGRESS: produtividade da equipe agregada no banco (GROUP BY+COUNT).
          fetchProductivityGroups(tenantIds, range.startDate, range.endDate),
        ]);

        // Série diária de receita (zeros incluídos).
        const dayMap = new Map<string, { receita: number; pedidos: number }>();
        for (const g of ordersGrouped) {
          dayMap.set(g.day, {
            receita: Number(g.total) || 0,
            pedidos: Number(g.orders) || 0,
          });
        }
        const timeseries: Array<{
          date: string;
          receita: number;
          pedidos: number;
        }> = [];
        {
          const cur = new Date(
            Date.UTC(
              range.startDate.getUTCFullYear(),
              range.startDate.getUTCMonth(),
              range.startDate.getUTCDate(),
            ),
          );
          const last = new Date(
            Date.UTC(
              range.endDate.getUTCFullYear(),
              range.endDate.getUTCMonth(),
              range.endDate.getUTCDate(),
            ),
          );
          let guard = 0;
          while (cur <= last && guard < 800) {
            const key = cur.toISOString().slice(0, 10);
            const v = dayMap.get(key);
            timeseries.push({
              date: key,
              receita: v?.receita ?? 0,
              pedidos: v?.pedidos ?? 0,
            });
            cur.setUTCDate(cur.getUTCDate() + 1);
            guard++;
          }
        }
        const receitaPeriodo = timeseries.reduce(
          (acc, t) => acc + t.receita,
          0,
        );
        const pedidosPeriodo = timeseries.reduce(
          (acc, t) => acc + t.pedidos,
          0,
        );

        const accountRevMap = new Map<
          string,
          { revenue: number; orders: number }
        >();
        for (const r of accountRevenue) {
          const rev = r._sum.totalAmount
            ? typeof (r._sum.totalAmount as any).toNumber === "function"
              ? (r._sum.totalAmount as any).toNumber()
              : Number(r._sum.totalAmount)
            : 0;
          accountRevMap.set(r.marketplaceAccountId, {
            revenue: rev,
            orders: r._count._all,
          });
        }

        const anunciosAtivos = accounts
          .filter((a) => a.status === "ACTIVE")
          .reduce((sum, a) => sum + (a._count.listings ?? 0), 0);

        const contas = accounts
          .map((a) => {
            const rev = accountRevMap.get(a.id);
            return {
              id: a.id,
              nome: a.accountName,
              plataforma: canonFromPlatform(a.platform),
              receita: rev?.revenue ?? 0,
              pedidos: rev?.orders ?? 0,
              anuncios: a._count.listings ?? 0,
            };
          })
          .sort((x, y) => y.receita - x.receita);

        const topProdutos = topProdutosRaw
          .filter((p) => (p._count.listings ?? 0) > 0)
          .map((p) => ({
            nome: p.name,
            sku: p.sku ?? null,
            anuncios: p._count.listings ?? 0,
          }));

        // --- Resumo de produtividade da equipe (tenant) ---
        const team = aggregateTeamProductivity(teamGroups, tenantUsers, range);

        const pdf = await renderDashboardReport({
          company: owner?.name || owner?.email || "Sua empresa",
          generatedAtLabel: fmtDateTimeBR(new Date()),
          range: rangeOut,
          business: {
            receita: receitaPeriodo,
            pedidos: pedidosPeriodo,
            anunciosAtivos,
            anunciosCriadosPeriodo,
            produtosTotal,
            produtosCriadosPeriodo,
            timeseries,
            contas,
            topProdutos,
          },
          equipe: {
            produtos: team.totals.produtos,
            anuncios: team.totals.anuncios,
            top: team.byCollaborator
              .filter((c) => c.produtos > 0 || c.anuncios.total > 0)
              .slice(0, 3)
              .map((c) => ({
                nome: c.name || c.email,
                produtos: c.produtos,
                anuncios: c.anuncios.total,
              })),
          },
        });

        return reply
          .header("Content-Type", "application/pdf")
          .header(
            "Content-Disposition",
            'attachment; filename="relatorio-geral-dexo.pdf"',
          )
          .send(pdf);
      } catch (error) {
        console.error("Erro dashboard report:", error);
        return reply.status(500).send({ error: "Erro ao gerar o relatório" });
      }
    },
  );

  /**
   * GET /dashboard/sales-by-platform?startDate&endDate&days&platform&excludeCancelled
   * Pedidos e receita por marketplace (ML / Shopee / Magalu) no período.
   * Cancelados ENTRAM por padrão, igual ao resto do Dashboard; vêm também
   * separados em `cancelledOrders`/`cancelledRevenue`.
   */
  fastify.get(
    "/sales-by-platform",
    { preHandler: [authMiddleware, requirePageAccess("dashboard")] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = request.user?.dataOwnerId;
        if (!userId) {
          return reply.status(401).send({ error: "Usuário não autenticado" });
        }

        const q = request.query as Record<string, string | undefined>;
        const range = resolveDashboardRange(q);
        const platforms = parsePlatformFilter(q.platform);
        const excludeCancelled = parseBooleanFlag(q.excludeCancelled);

        const rows = await fetchOrdersByPlatform(
          userId,
          range.startDate,
          range.endDate,
          platforms,
          excludeCancelled,
        );

        return reply.status(200).send({
          range: serializeRange(range),
          platform: platforms,
          excludeCancelled,
          ...buildPlatformBreakdown(rows),
        });
      } catch (error) {
        console.error("Erro sales-by-platform:", error);
        return reply
          .status(500)
          .send({ error: "Erro ao buscar vendas por plataforma" });
      }
    },
  );

  /**
   * GET /dashboard/sales-by-category?startDate&endDate&days&platform&limit&excludeCancelled
   * Receita e unidades vendidas por categoria de produto no período, com filtro
   * opcional de plataforma. Top-N + linha "Outras" derivada dos totais exatos.
   */
  fastify.get(
    "/sales-by-category",
    { preHandler: [authMiddleware, requirePageAccess("dashboard")] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = request.user?.dataOwnerId;
        if (!userId) {
          return reply.status(401).send({ error: "Usuário não autenticado" });
        }

        const q = request.query as Record<string, string | undefined>;
        const range = resolveDashboardRange(q);
        const platforms = parsePlatformFilter(q.platform);
        const excludeCancelled = parseBooleanFlag(q.excludeCancelled);
        const limit = parseTopN(q.limit, 10, 50);

        const [rows, totals] = await Promise.all([
          fetchRevenueByCategory(
            userId,
            range.startDate,
            range.endDate,
            platforms,
            excludeCancelled,
          ),
          fetchRevenueByCategoryTotals(
            userId,
            range.startDate,
            range.endDate,
            platforms,
            excludeCancelled,
          ),
        ]);

        return reply.status(200).send({
          range: serializeRange(range),
          platform: platforms,
          excludeCancelled,
          limit,
          ...buildCategoryBreakdown(rows, totals, limit),
        });
      } catch (error) {
        console.error("Erro sales-by-category:", error);
        return reply
          .status(500)
          .send({ error: "Erro ao buscar vendas por categoria" });
      }
    },
  );

  /**
   * GET /dashboard/sales-by-payment-method?startDate&endDate&days&unidadeId
   * Contas a receber lançadas no período, por forma de pagamento. Domínio
   * FINANCEIRO (Receivable), não marketplace: CANCELADA fica de fora.
   */
  fastify.get(
    "/sales-by-payment-method",
    { preHandler: [authMiddleware, requirePageAccess("dashboard")] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = request.user?.dataOwnerId;
        if (!userId) {
          return reply.status(401).send({ error: "Usuário não autenticado" });
        }

        const q = request.query as Record<string, string | undefined>;
        const range = resolveDashboardRange(q);
        const unidadeId = q.unidadeId || undefined;

        const rows = await fetchReceivablesByPaymentMethod(
          userId,
          range.startDate,
          range.endDate,
          new Date(),
          unidadeId,
        );

        return reply.status(200).send({
          range: serializeRange(range),
          ...buildPaymentMethodBreakdown(rows),
        });
      } catch (error) {
        console.error("Erro sales-by-payment-method:", error);
        return reply
          .status(500)
          .send({ error: "Erro ao buscar formas de pagamento" });
      }
    },
  );

  /**
   * GET /dashboard/sales-by-channel?startDate&endDate&days&unidadeId
   * Divisão por forma de venda: balcão (conta a receber COM itens) × avulso.
   * Mesmo critério do relatório financeiro em PDF.
   */
  fastify.get(
    "/sales-by-channel",
    { preHandler: [authMiddleware, requirePageAccess("dashboard")] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = request.user?.dataOwnerId;
        if (!userId) {
          return reply.status(401).send({ error: "Usuário não autenticado" });
        }

        const q = request.query as Record<string, string | undefined>;
        const range = resolveDashboardRange(q);
        const unidadeId = q.unidadeId || undefined;

        const rows = await fetchReceivablesByChannel(
          userId,
          range.startDate,
          range.endDate,
          new Date(),
          unidadeId,
        );

        return reply.status(200).send({
          range: serializeRange(range),
          ...buildChannelSplit(rows),
        });
      } catch (error) {
        console.error("Erro sales-by-channel:", error);
        return reply
          .status(500)
          .send({ error: "Erro ao buscar formas de venda" });
      }
    },
  );
};
