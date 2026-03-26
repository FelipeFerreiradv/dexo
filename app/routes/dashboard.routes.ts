import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import prisma from "../lib/prisma";
import { authMiddleware } from "../middlewares/auth.middleware";
import { Platform } from "@prisma/client";

export const dashboardRoutes = async (fastify: FastifyInstance) => {
  /**
   * GET /dashboard/listing-stats
   * Retorna contagem de anúncios por conta e linha do tempo de criação
   */
  fastify.get(
    "/listing-stats",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = request.user?.id;
        if (!userId) {
          return reply.status(401).send({ error: "Usuário não autenticado" });
        }

        const days = Number((request.query as any)?.days) || 180;
        const since = new Date();
        since.setDate(since.getDate() - days);

        const accounts = await prisma.marketplaceAccount.findMany({
          where: { userId },
          select: {
            id: true,
            platform: true,
            accountName: true,
            status: true,
            _count: { select: { listings: true } },
          },
        });

        const totalListings = accounts.reduce(
          (sum, acc) => sum + (acc._count.listings ?? 0),
          0,
        );

        const totalListingsActive = accounts
          .filter((acc) => acc.status === "ACTIVE")
          .reduce((sum, acc) => sum + (acc._count.listings ?? 0), 0);

        const created = await prisma.productListing.findMany({
          where: { createdAt: { gte: since }, marketplaceAccount: { userId } },
          select: { createdAt: true, marketplaceAccountId: true },
          orderBy: { createdAt: "asc" },
        });

        const toDayKey = (d: Date) => d.toISOString().slice(0, 10);
        const globalMap: Record<string, number> = {};
        const perAccountMap: Record<string, Record<string, number>> = {};

        for (const row of created) {
          const day = toDayKey(row.createdAt);
          globalMap[day] = (globalMap[day] ?? 0) + 1;
          const acc = (perAccountMap[row.marketplaceAccountId] ||= {});
          acc[day] = (acc[day] ?? 0) + 1;
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
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.id as string;
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
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = request.user?.id;

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
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.id as string;
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
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.id as string;

        // Single query: fetch stock values and bucket in JS (avoids 5 separate COUNT queries)
        const products = await prisma.product.findMany({
          where: { userId },
          select: { stock: true },
        });

        let zero = 0,
          oneToThree = 0,
          fourToTen = 0,
          elevenToFifty = 0,
          aboveFifty = 0;
        for (const p of products) {
          const s = p.stock;
          if (s === 0) zero++;
          else if (s <= 3) oneToThree++;
          else if (s <= 10) fourToTen++;
          else if (s <= 50) elevenToFifty++;
          else aboveFifty++;
        }

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
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.id as string;
        const daysParam = (request.query as any)?.days;
        const days = daysParam ? parseInt(daysParam, 10) : 30;
        const now = new Date();
        const startDate = new Date(now);
        startDate.setDate(now.getDate() - (isNaN(days) ? 30 : days));

        // Only fetch the minimal fields needed for aggregation
        const orders = await prisma.order.findMany({
          where: {
            createdAt: { gte: startDate },
            marketplaceAccount: { userId },
          },
          select: { createdAt: true, totalAmount: true },
          orderBy: { createdAt: "asc" },
        });

        // Inicializar mapa de dias
        const map: Record<string, { orders: number; totalAmount: number }> = {};
        for (let i = 0; i <= (isNaN(days) ? 30 : days); i++) {
          const d = new Date(startDate);
          d.setDate(startDate.getDate() + i);
          const key = d.toISOString().slice(0, 10);
          map[key] = { orders: 0, totalAmount: 0 };
        }

        for (const o of orders) {
          const key = o.createdAt.toISOString().slice(0, 10);
          if (!map[key]) map[key] = { orders: 0, totalAmount: 0 };
          map[key].orders += 1;
          // totalAmount is Decimal in DB; prisma returns Decimal as Decimal.js-like object
          const total = (o as any).totalAmount;
          const num =
            typeof total === "object" &&
            total !== null &&
            typeof total.toNumber === "function"
              ? total.toNumber()
              : Number(total) || 0;
          map[key].totalAmount += num;
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
  fastify.get(
    "/search",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.id as string;
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
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      // @deprecated Usado somente pelo dashboard antigo. Remover após migração para listing-stats.
      try {
        const userId = (request as any).user?.id as string;
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
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.id as string | undefined;
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
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.id as string | undefined;
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
  fastify.get(
    "/notifications",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.id as string | undefined;
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
};
