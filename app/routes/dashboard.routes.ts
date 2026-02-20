import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import prisma from "../lib/prisma";
import { authMiddleware } from "../middlewares/auth.middleware";

export const dashboardRoutes = async (fastify: FastifyInstance) => {
  /**
   * GET /dashboard/stats
   * Retorna estatísticas gerais do sistema
   */
  fastify.get(
    "/stats",
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        // Buscar estatísticas de produtos
        const [totalProducts, totalStock, lowStockProducts] = await Promise.all(
          [
            // Total de produtos
            prisma.product.count(),
            // Total de itens em estoque
            prisma.product.aggregate({
              _sum: { stock: true },
            }),
            // Produtos com estoque baixo (menos de 10 unidades)
            prisma.product.findMany({
              where: { stock: { lte: 10 } },
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
    { preHandler: authMiddleware },
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
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const rows = await prisma.product.groupBy({
          by: ["category"],
          _count: { _all: true },
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
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const [zero, oneToThree, fourToTen, elevenToFifty, aboveFifty] =
          await Promise.all([
            prisma.product.count({ where: { stock: 0 } }),
            prisma.product.count({ where: { stock: { gte: 1, lte: 3 } } }),
            prisma.product.count({ where: { stock: { gte: 4, lte: 10 } } }),
            prisma.product.count({ where: { stock: { gte: 11, lte: 50 } } }),
            prisma.product.count({ where: { stock: { gt: 50 } } }),
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
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const daysParam = (request.query as any)?.days;
        const days = daysParam ? parseInt(daysParam, 10) : 30;
        const now = new Date();
        const startDate = new Date(now);
        startDate.setDate(now.getDate() - (isNaN(days) ? 30 : days));

        const orders = await prisma.order.findMany({
          where: { createdAt: { gte: startDate } },
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
   * GET /dashboard/stock-changes?days=7
   * Retorna alterações de estoque recentes agrupadas por produto (top N)
   */
  fastify.get(
    "/stock-changes",
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const daysParam = (request.query as any)?.days;
        const days = daysParam ? parseInt(daysParam, 10) : 7;
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - (isNaN(days) ? 7 : days));

        const logs = await prisma.stockLog.findMany({
          where: { createdAt: { gte: startDate } },
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
};
