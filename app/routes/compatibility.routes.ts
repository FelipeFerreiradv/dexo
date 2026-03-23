import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { CompatibilityUseCase } from "../usecases/compatibility.usercase";
import { ProductCompatibilityRepositoryPrisma } from "../repositories/compatibility.repository";
import { authMiddleware } from "../middlewares/auth.middleware";

const useCase = new CompatibilityUseCase(
  new ProductCompatibilityRepositoryPrisma(),
);

export async function compatibilityRoutes(app: FastifyInstance) {
  /**
   * GET /products/:productId/compatibilities
   */
  app.get<{ Params: { productId: string } }>(
    "/:productId/compatibilities",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { productId } = request.params as { productId: string };
      const items = await useCase.getByProductId(productId);
      return reply.status(200).send({ compatibilities: items });
    },
  );

  /**
   * POST /products/:productId/compatibilities
   * Body: { brand, model, yearFrom?, yearTo?, version? }
   */
  app.post<{ Params: { productId: string } }>(
    "/:productId/compatibilities",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { productId } = request.params as { productId: string };
      const body = request.body as {
        brand?: string;
        model?: string;
        yearFrom?: number;
        yearTo?: number;
        version?: string;
      };

      if (!body.brand || !body.model) {
        return reply.status(400).send({
          error: "Dados incompletos",
          message: "Marca e modelo são obrigatórios",
        });
      }

      const item = await useCase.addOne(productId, {
        brand: body.brand,
        model: body.model,
        yearFrom: body.yearFrom ?? null,
        yearTo: body.yearTo ?? null,
        version: body.version ?? null,
      });
      return reply.status(201).send(item);
    },
  );

  /**
   * POST /products/:productId/compatibilities/batch
   * Body: { items: [{ brand, model, yearFrom?, yearTo?, version? }] }
   */
  app.post<{ Params: { productId: string } }>(
    "/:productId/compatibilities/batch",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { productId } = request.params as { productId: string };
      const body = request.body as {
        items?: Array<{
          brand: string;
          model: string;
          yearFrom?: number;
          yearTo?: number;
          version?: string;
        }>;
      };

      if (!Array.isArray(body.items) || body.items.length === 0) {
        return reply.status(400).send({
          error: "Dados incompletos",
          message: "Informe ao menos uma compatibilidade",
        });
      }

      const valid = body.items.every((i) => i.brand && i.model);
      if (!valid) {
        return reply.status(400).send({
          error: "Dados inválidos",
          message: "Todos os itens devem ter marca e modelo",
        });
      }

      const items = await useCase.addMany(
        productId,
        body.items.map((i) => ({
          brand: i.brand,
          model: i.model,
          yearFrom: i.yearFrom ?? null,
          yearTo: i.yearTo ?? null,
          version: i.version ?? null,
        })),
      );
      return reply.status(201).send({ compatibilities: items });
    },
  );

  /**
   * PUT /products/:productId/compatibilities
   * Substitui todas as compatibilidades do produto
   * Body: { items: [{ brand, model, yearFrom?, yearTo?, version? }] }
   */
  app.put<{ Params: { productId: string } }>(
    "/:productId/compatibilities",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { productId } = request.params as { productId: string };
      const body = request.body as {
        items?: Array<{
          brand: string;
          model: string;
          yearFrom?: number;
          yearTo?: number;
          version?: string;
        }>;
      };

      const items = Array.isArray(body.items) ? body.items : [];
      const valid = items.every((i) => i.brand && i.model);
      if (!valid) {
        return reply.status(400).send({
          error: "Dados inválidos",
          message: "Todos os itens devem ter marca e modelo",
        });
      }

      const result = await useCase.replaceAll(
        productId,
        items.map((i) => ({
          brand: i.brand,
          model: i.model,
          yearFrom: i.yearFrom ?? null,
          yearTo: i.yearTo ?? null,
          version: i.version ?? null,
        })),
      );
      return reply.status(200).send({ compatibilities: result });
    },
  );

  /**
   * DELETE /products/:productId/compatibilities/:id
   */
  app.delete<{ Params: { productId: string; id: string } }>(
    "/:productId/compatibilities/:id",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { productId: string; id: string };
      await useCase.remove(id);
      return reply.status(204).send();
    },
  );

  /**
   * DELETE /products/:productId/compatibilities
   * Remove todas as compatibilidades do produto
   */
  app.delete<{ Params: { productId: string } }>(
    "/:productId/compatibilities",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { productId } = request.params as { productId: string };
      await useCase.removeAll(productId);
      return reply.status(204).send();
    },
  );
}
