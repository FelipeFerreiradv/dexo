import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ScrapUseCase } from "../usecases/scrap.usercase";
import { authMiddleware } from "../middlewares/auth.middleware";
import { ScrapStatus } from "@prisma/client";

export const scrapRoutes = async (fastify: FastifyInstance) => {
  const scrapUseCase = new ScrapUseCase();

  /**
   * POST /scraps
   * Cria uma nova sucata
   */
  fastify.post(
    "/",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as any;
      const user = (request as any).user;

      if (!body.brand || typeof body.brand !== "string")
        return reply.status(400).send({ error: "Marca é obrigatória" });
      if (!body.model || typeof body.model !== "string")
        return reply.status(400).send({ error: "Modelo é obrigatório" });

      try {
        const data = await scrapUseCase.create({
          userId: user?.id,
          brand: body.brand,
          model: body.model,
          year: body.year ?? undefined,
          version: body.version ?? undefined,
          color: body.color ?? undefined,
          plate: body.plate ?? undefined,
          chassis: body.chassis ?? undefined,
          engineNumber: body.engineNumber ?? undefined,
          renavam: body.renavam ?? undefined,
          lot: body.lot ?? undefined,
          deregistrationCert: body.deregistrationCert ?? undefined,
          cost: body.cost !== undefined ? Number(body.cost) : undefined,
          paymentMethod: body.paymentMethod ?? undefined,
          locationId: body.locationId ?? undefined,
          ncm: body.ncm ?? undefined,
          supplierCnpj: body.supplierCnpj ?? undefined,
          accessKey: body.accessKey ?? undefined,
          issueDate: body.issueDate ? new Date(body.issueDate) : undefined,
          entryDate: body.entryDate ? new Date(body.entryDate) : undefined,
          nfeNumber: body.nfeNumber ?? undefined,
          nfeProtocol: body.nfeProtocol ?? undefined,
          operationNature: body.operationNature ?? undefined,
          nfeSeries: body.nfeSeries ?? undefined,
          fiscalModel: body.fiscalModel ?? undefined,
          icmsValue:
            body.icmsValue !== undefined ? Number(body.icmsValue) : undefined,
          icmsCtValue:
            body.icmsCtValue !== undefined
              ? Number(body.icmsCtValue)
              : undefined,
          freightMode: body.freightMode ?? undefined,
          issuePurpose: body.issuePurpose ?? undefined,
          imageUrls: Array.isArray(body.imageUrls)
            ? body.imageUrls.filter(
                (u: any) => typeof u === "string" && u.trim(),
              )
            : undefined,
          status: body.status ?? undefined,
          notes: body.notes ?? undefined,
        });

        return reply.status(201).send(data);
      } catch (error: any) {
        console.error("Erro ao criar sucata:", error);
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes("Usuário não encontrado"))
          return reply.status(401).send({ error: msg });
        if (msg.includes("obrigat"))
          return reply.status(400).send({ error: msg });
        return reply.status(500).send({ error: msg || "Erro ao criar sucata" });
      }
    },
  );

  /**
   * GET /scraps
   * Lista sucatas com busca e paginação
   */
  fastify.get<{
    Querystring: {
      search?: string;
      status?: string;
      page?: string;
      limit?: string;
    };
  }>(
    "/",
    { preHandler: [authMiddleware] },
    async (
      request: FastifyRequest<{
        Querystring: {
          search?: string;
          status?: string;
          page?: string;
          limit?: string;
        };
      }>,
      reply: FastifyReply,
    ) => {
      try {
        const { search, status, page, limit } = request.query;
        const userId = (request as any).user?.id as string;

        const validStatuses: ScrapStatus[] = [
          "AVAILABLE",
          "IN_USE",
          "DEPLETED",
          "ARCHIVED",
        ];
        const statusFilter =
          status && validStatuses.includes(status as ScrapStatus)
            ? (status as ScrapStatus)
            : undefined;

        const data = await scrapUseCase.listScraps({
          search: search || "",
          status: statusFilter,
          page: page ? parseInt(page) : 1,
          limit: limit ? parseInt(limit) : 10,
          userId,
        });

        return reply.status(200).send({
          scraps: data.scraps,
          pagination: {
            page: page ? parseInt(page) : 1,
            limit: limit ? parseInt(limit) : 10,
            total: data.total,
            totalPages: data.totalPages,
          },
        });
      } catch (error) {
        reply.status(500).send({
          error:
            error instanceof Error ? error.message : "Erro ao listar sucatas",
        });
      }
    },
  );

  /**
   * GET /scraps/:id
   * Busca sucata por ID
   */
  fastify.get(
    "/:id",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { id } = request.params as { id: string };
        const userId = (request as any).user?.id as string;

        const scrap = await scrapUseCase.findById(id, userId);
        if (!scrap) {
          return reply.status(404).send({ error: "Sucata não encontrada" });
        }

        return reply.status(200).send(scrap);
      } catch (error) {
        return reply.status(500).send({
          error:
            error instanceof Error ? error.message : "Erro ao buscar sucata",
        });
      }
    },
  );

  /**
   * PUT /scraps/:id
   * Atualiza sucata
   */
  fastify.put(
    "/:id",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { id } = request.params as { id: string };
        const body = request.body as any;
        const userId = (request as any).user?.id as string;

        const updated = await scrapUseCase.update(
          id,
          {
            brand: body.brand,
            model: body.model,
            year: body.year,
            version: body.version,
            color: body.color,
            plate: body.plate,
            chassis: body.chassis,
            engineNumber: body.engineNumber,
            renavam: body.renavam,
            lot: body.lot,
            deregistrationCert: body.deregistrationCert,
            cost: body.cost !== undefined ? Number(body.cost) : undefined,
            paymentMethod: body.paymentMethod,
            locationId: body.locationId,
            ncm: body.ncm,
            supplierCnpj: body.supplierCnpj,
            accessKey: body.accessKey,
            issueDate: body.issueDate ? new Date(body.issueDate) : undefined,
            entryDate: body.entryDate ? new Date(body.entryDate) : undefined,
            nfeNumber: body.nfeNumber,
            nfeProtocol: body.nfeProtocol,
            operationNature: body.operationNature,
            nfeSeries: body.nfeSeries,
            fiscalModel: body.fiscalModel,
            icmsValue:
              body.icmsValue !== undefined ? Number(body.icmsValue) : undefined,
            icmsCtValue:
              body.icmsCtValue !== undefined
                ? Number(body.icmsCtValue)
                : undefined,
            freightMode: body.freightMode,
            issuePurpose: body.issuePurpose,
            imageUrls: Array.isArray(body.imageUrls)
              ? body.imageUrls
              : undefined,
            status: body.status,
            notes: body.notes,
          },
          userId,
        );

        return reply.status(200).send(updated);
      } catch (error) {
        const msg =
          error instanceof Error ? error.message : "Erro ao atualizar sucata";
        if (msg.includes("não encontrada"))
          return reply.status(404).send({ error: msg });
        return reply.status(500).send({ error: msg });
      }
    },
  );

  /**
   * DELETE /scraps/:id
   * Exclui sucata (desvincula produtos automaticamente)
   */
  fastify.delete(
    "/:id",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { id } = request.params as { id: string };
        const userId = (request as any).user?.id as string;

        await scrapUseCase.delete(id, userId);

        return reply
          .status(200)
          .send({ message: "Sucata excluída com sucesso" });
      } catch (error) {
        const msg =
          error instanceof Error ? error.message : "Erro ao excluir sucata";
        if (msg.includes("não encontrada"))
          return reply.status(404).send({ error: msg });
        return reply.status(500).send({ error: msg });
      }
    },
  );
};
