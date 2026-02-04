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
};
