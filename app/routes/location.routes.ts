import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { LocationUseCase } from "../usecases/location.usercase";
import { authMiddleware } from "../middlewares/auth.middleware";

export const locationRoutes = async (fastify: FastifyInstance) => {
  const locationUseCase = new LocationUseCase();

  /**
   * GET /locations
   * Lista localizações (raiz por padrão, ou filhas de um parentId)
   */
  fastify.get(
    "/",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.id as string;
        const { search, parentId, page, limit } = request.query as {
          search?: string;
          parentId?: string;
          page?: string;
          limit?: string;
        };

        const data = await locationUseCase.listLocations({
          userId,
          search: search || undefined,
          parentId: parentId || undefined,
          page: page ? parseInt(page) : 1,
          limit: limit ? parseInt(limit) : 50,
        });

        return reply.status(200).send({
          locations: data.locations,
          pagination: {
            page: page ? parseInt(page) : 1,
            limit: limit ? parseInt(limit) : 50,
            total: data.total,
            totalPages: data.totalPages,
          },
        });
      } catch (error) {
        return reply.status(500).send({
          error:
            error instanceof Error
              ? error.message
              : "Erro ao buscar localizações",
        });
      }
    },
  );

  /**
   * GET /locations/select
   * Lista simplificada para selects/dropdowns (com fullPath)
   */
  fastify.get(
    "/select",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.id as string;
        const locations = await locationUseCase.listForSelect(userId);
        return reply.status(200).send({ locations });
      } catch (error) {
        return reply.status(500).send({
          error:
            error instanceof Error
              ? error.message
              : "Erro ao buscar localizações",
        });
      }
    },
  );

  /**
   * GET /locations/:id/products
   * Lista produtos vinculados a uma localização
   */
  fastify.get(
    "/:id/products",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.id as string;
        const { id } = request.params as { id: string };
        const { search, page, limit } = request.query as {
          search?: string;
          page?: string;
          limit?: string;
        };

        const data = await locationUseCase.getLocationProducts(id, userId, {
          search: search || undefined,
          page: page ? parseInt(page) : 1,
          limit: limit ? parseInt(limit) : 50,
        });

        return reply.status(200).send({
          products: data.products,
          pagination: {
            page: page ? parseInt(page) : 1,
            limit: limit ? parseInt(limit) : 50,
            total: data.total,
            totalPages: Math.ceil(data.total / (limit ? parseInt(limit) : 50)),
          },
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Erro ao buscar produtos";
        const status = message.includes("não encontrada") ? 404 : 500;
        return reply.status(status).send({ error: message });
      }
    },
  );

  /**
   * POST /locations/move-products
   * Move produtos entre localizações (ou desvincula)
   */
  fastify.post(
    "/move-products",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.id as string;
        const { productIds, targetLocationId } = request.body as {
          productIds?: string[];
          targetLocationId?: string | null;
        };

        if (
          !productIds ||
          !Array.isArray(productIds) ||
          productIds.length === 0
        ) {
          return reply
            .status(400)
            .send({ error: "Lista de produtos é obrigatória" });
        }

        const result = await locationUseCase.moveProducts(
          productIds,
          targetLocationId ?? null,
          userId,
        );

        return reply.status(200).send({
          message: targetLocationId
            ? `${result.count} produto(s) movido(s) para "${result.targetLocation}"`
            : `${result.count} produto(s) desvinculado(s)`,
          count: result.count,
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Erro ao mover produtos";
        const status = message.includes("não encontrada")
          ? 404
          : message.includes("capacidade")
            ? 422
            : 500;
        return reply.status(status).send({ error: message });
      }
    },
  );

  /**
   * GET /locations/:id
   * Detalhe de uma localização com filhos e ocupação
   */
  fastify.get(
    "/:id",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.id as string;
        const { id } = request.params as { id: string };

        const location = await locationUseCase.findById(id, userId);
        if (!location) {
          return reply.status(404).send({
            error: "Localização não encontrada",
          });
        }

        return reply.status(200).send({ location });
      } catch (error) {
        return reply.status(500).send({
          error:
            error instanceof Error
              ? error.message
              : "Erro ao buscar localização",
        });
      }
    },
  );

  /**
   * POST /locations
   * Cria uma nova localização (raiz ou subtópico)
   */
  fastify.post(
    "/",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.id as string;
        const { code, description, maxCapacity, parentId } = request.body as {
          code?: string;
          description?: string;
          maxCapacity?: number;
          parentId?: string;
        };

        // Validações
        if (!code || typeof code !== "string" || code.trim().length === 0) {
          return reply.status(400).send({ error: "Sigla é obrigatória" });
        }
        if (code.trim().length > 20) {
          return reply.status(400).send({
            error: "Sigla deve ter no máximo 20 caracteres",
          });
        }
        if (description && description.length > 200) {
          return reply.status(400).send({
            error: "Descrição deve ter no máximo 200 caracteres",
          });
        }

        const capacity = maxCapacity !== undefined ? Number(maxCapacity) : 0;
        if (isNaN(capacity) || capacity < 0) {
          return reply.status(400).send({
            error: "Capacidade máxima deve ser um número não negativo",
          });
        }

        const location = await locationUseCase.create({
          userId,
          code: code.trim().toUpperCase(),
          description: description?.trim() || undefined,
          maxCapacity: capacity,
          parentId: parentId || undefined,
        });

        return reply.status(201).send({ location });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Erro ao criar localização";
        const status = message.includes("Já existe") ? 409 : 500;
        return reply.status(status).send({ error: message });
      }
    },
  );

  /**
   * PATCH /locations/:id
   * Atualiza uma localização
   */
  fastify.patch(
    "/:id",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.id as string;
        const { id } = request.params as { id: string };
        const { code, description, maxCapacity, parentId } = request.body as {
          code?: string;
          description?: string;
          maxCapacity?: number;
          parentId?: string | null;
        };

        // Validações
        if (code !== undefined) {
          if (typeof code !== "string" || code.trim().length === 0) {
            return reply.status(400).send({ error: "Sigla é obrigatória" });
          }
          if (code.trim().length > 20) {
            return reply.status(400).send({
              error: "Sigla deve ter no máximo 20 caracteres",
            });
          }
        }
        if (description !== undefined && description.length > 200) {
          return reply.status(400).send({
            error: "Descrição deve ter no máximo 200 caracteres",
          });
        }

        const data: any = {};
        if (code !== undefined) data.code = code.trim().toUpperCase();
        if (description !== undefined) data.description = description.trim();
        if (parentId !== undefined) data.parentId = parentId;
        if (maxCapacity !== undefined) {
          const capacity = Number(maxCapacity);
          if (isNaN(capacity) || capacity < 0) {
            return reply.status(400).send({
              error: "Capacidade máxima deve ser um número não negativo",
            });
          }
          data.maxCapacity = capacity;
        }

        const location = await locationUseCase.update(id, data, userId);
        return reply.status(200).send({ location });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Erro ao atualizar localização";
        const status = message.includes("não encontrada")
          ? 404
          : message.includes("Já existe")
            ? 409
            : message.includes("Capacidade") ||
                message.includes("circular") ||
                message.includes("pai de si")
              ? 422
              : 500;
        return reply.status(status).send({ error: message });
      }
    },
  );

  /**
   * DELETE /locations/:id
   * Remove localização e todas as sublocalizações (desvincula produtos)
   */
  fastify.delete(
    "/:id",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.id as string;
        const { id } = request.params as { id: string };

        await locationUseCase.delete(id, userId);

        return reply.status(200).send({
          message: "Localização excluída com sucesso",
        });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Erro ao excluir localização";
        const status = message.includes("não encontrada") ? 404 : 500;
        return reply.status(status).send({ error: message });
      }
    },
  );
};
