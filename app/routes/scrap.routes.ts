import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ScrapUseCase } from "../usecases/scrap.usercase";
import { authMiddleware } from "../middlewares/auth.middleware";
import {
  requireAnyPageAccess,
  requirePageAccess,
} from "../middlewares/require-page-access.middleware";
import { ScrapStatus, LogisticsStatus } from "@prisma/client";

/**
 * ⭐ Os valores que o Prisma aceita nestes dois enums.
 *
 * ⚠️ Sem esta validação `body.status` ia CRU para o `prisma.scrap.create`, e um
 * valor fora do enum estourava em **500** — erro de servidor para o que é erro
 * de quem chamou. O GET já validava (`:117-138`) e o PATCH também
 * (`VALID_LOGISTICS`, scrap.usercase.ts:190); só o POST e o PUT não.
 */
const STATUS_VALIDOS = Object.values(ScrapStatus) as string[];
const LOGISTICA_VALIDOS = Object.values(LogisticsStatus) as string[];

/** Devolve a mensagem de erro, ou `null` quando está tudo certo. */
function conferirEnums(body: any): string | null {
  if (
    body?.status !== undefined &&
    body?.status !== null &&
    !STATUS_VALIDOS.includes(String(body.status))
  ) {
    return `status inválido. Valores aceitos: ${STATUS_VALIDOS.join(", ")}`;
  }
  if (
    body?.logisticsStatus !== undefined &&
    body?.logisticsStatus !== null &&
    !LOGISTICA_VALIDOS.includes(String(body.logisticsStatus))
  ) {
    return `logisticsStatus inválido. Valores aceitos: ${LOGISTICA_VALIDOS.join(", ")}`;
  }
  return null;
}

export const scrapRoutes = async (fastify: FastifyInstance) => {
  const scrapUseCase = new ScrapUseCase();

  /**
   * POST /scraps
   * Cria uma nova sucata
   */
  fastify.post(
    "/",
    { preHandler: [authMiddleware, requirePageAccess("sucatas")] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as any;
      const user = (request as any).user;

      if (!body.brand || typeof body.brand !== "string")
        return reply.status(400).send({ error: "Marca é obrigatória" });
      if (!body.model || typeof body.model !== "string")
        return reply.status(400).send({ error: "Modelo é obrigatório" });

      const enumInvalido = conferirEnums(body);
      if (enumInvalido) return reply.status(400).send({ error: enumInvalido });

      try {
        const data = await scrapUseCase.create({
          // ⚠️ O ATOR, não o tenant. `dataOwnerId` é o admin pai para todo
          // colaborador — gravá-lo aqui diria que o dono cadastrou tudo.
          createdByUserId: user?.id ?? null,
          userId: user?.dataOwnerId,
          brand: body.brand,
          model: body.model,
          nickname: body.nickname ?? undefined,
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
          extraCosts:
            body.extraCosts !== undefined ? Number(body.extraCosts) : undefined,
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
          logisticsStatus: body.logisticsStatus ?? undefined,
          notes: body.notes ?? undefined,
        });

        return reply.status(201).send(data);
      } catch (error: any) {
        console.error("Erro ao criar sucata:", error);
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes("Usuário não encontrado"))
          return reply.status(401).send({ error: msg });
        // "Localização inválida" e "Chassi deve conter…" são erro de QUEM
        // CHAMOU, não do servidor: 400, nunca 500.
        if (msg.includes("obrigat") || msg.includes("inválid"))
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
      logisticsStatus?: string;
      page?: string;
      limit?: string;
    };
  }>(
    "/",
    { preHandler: [authMiddleware, requireAnyPageAccess(["sucatas", "produtos", "financeiro"])] },
    async (
      request: FastifyRequest<{
        Querystring: {
          search?: string;
          status?: string;
          logisticsStatus?: string;
          page?: string;
          limit?: string;
        };
      }>,
      reply: FastifyReply,
    ) => {
      try {
        const { search, status, logisticsStatus, page, limit } = request.query;
        const userId = (request as any).user?.dataOwnerId as string;

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

        const validLogistics: LogisticsStatus[] = [
          "IN_TRANSIT",
          "IN_YARD",
          "ON_LIFT",
          "DISMANTLED",
        ];
        const logisticsFilter =
          logisticsStatus &&
          validLogistics.includes(logisticsStatus as LogisticsStatus)
            ? (logisticsStatus as LogisticsStatus)
            : undefined;

        const data = await scrapUseCase.listScraps({
          search: search || "",
          status: statusFilter,
          logisticsStatus: logisticsFilter,
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
   * GET /scraps/pipeline
   * Visão de pipeline (Kanban): contadores + amostra de cards por estágio
   * logístico, num único request. Definido antes de /:id por clareza.
   */
  fastify.get(
    "/pipeline",
    { preHandler: [authMiddleware, requirePageAccess("sucatas")] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const stages = await scrapUseCase.getPipeline(userId);
        return reply.status(200).send({ stages });
      } catch (error) {
        return reply.status(500).send({
          error:
            error instanceof Error
              ? error.message
              : "Erro ao montar pipeline de sucatas",
        });
      }
    },
  );

  /**
   * GET /scraps/balcao
   * Visão de Balcão: busca peça-cêntrica (reusa o ranking de produtos) e
   * devolve cada peça com o lote de origem e seu estágio logístico.
   * Endpoint NOVO; estático (vem antes de /:id).
   */
  fastify.get<{ Querystring: { q?: string; limit?: string } }>(
    "/balcao",
    { preHandler: [authMiddleware, requirePageAccess("sucatas")] },
    async (
      request: FastifyRequest<{ Querystring: { q?: string; limit?: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        const { q, limit } = request.query;
        const userId = (request as any).user?.dataOwnerId as string;
        const data = await scrapUseCase.balcaoSearch(
          q ?? "",
          userId,
          limit ? parseInt(limit) : 12,
        );
        return reply.status(200).send(data);
      } catch (error) {
        return reply.status(500).send({
          error:
            error instanceof Error ? error.message : "Erro na busca de balcão",
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
    { preHandler: [authMiddleware, requirePageAccess("sucatas")] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { id } = request.params as { id: string };
        const { include } = request.query as { include?: string };
        const userId = (request as any).user?.dataOwnerId as string;

        // ?include=financials,products — opt-in e aditivo. Sem o parâmetro a
        // resposta é exatamente a de hoje (e nenhuma query extra é executada).
        const wants = (include ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);

        const scrap = await scrapUseCase.getScrapDetail(id, userId, {
          financials: wants.includes("financials"),
          products: wants.includes("products"),
          history: wants.includes("history"),
          manualSales: wants.includes("manualSales"),
        });
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
    { preHandler: [authMiddleware, requirePageAccess("sucatas")] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { id } = request.params as { id: string };
        const body = request.body as any;
        const userId = (request as any).user?.dataOwnerId as string;

        const enumInvalido = conferirEnums(body);
        if (enumInvalido) return reply.status(400).send({ error: enumInvalido });

        const updated = await scrapUseCase.update(
          id,
          {
            brand: body.brand,
            model: body.model,
            nickname: body.nickname,
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
            extraCosts:
              body.extraCosts !== undefined
                ? Number(body.extraCosts)
                : undefined,
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
            logisticsStatus: body.logisticsStatus,
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
        // Localização de outro dono, chassi de 17, chave de 44 — erro de quem
        // chamou. 500 aqui mandava o cliente procurar problema no servidor.
        if (msg.includes("inválid") || msg.includes("deve conter"))
          return reply.status(400).send({ error: msg });
        return reply.status(500).send({ error: msg });
      }
    },
  );

  /**
   * PATCH /scraps/:id/logistics-status
   * Transição de estágio logístico do veículo no pátio. Endpoint NOVO e
   * retrocompatível — não altera nenhum contrato existente.
   */
  fastify.patch(
    "/:id/logistics-status",
    { preHandler: [authMiddleware, requirePageAccess("sucatas")] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { id } = request.params as { id: string };
        const body = request.body as any;
        const userId = (request as any).user?.dataOwnerId as string;

        const updated = await scrapUseCase.transitionLogistics(
          id,
          body?.logisticsStatus,
          userId,
        );

        return reply.status(200).send(updated);
      } catch (error) {
        const msg =
          error instanceof Error
            ? error.message
            : "Erro ao atualizar status logístico";
        if (msg.includes("não encontrada"))
          return reply.status(404).send({ error: msg });
        if (msg.includes("inválido"))
          return reply.status(400).send({ error: msg });
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
    { preHandler: [authMiddleware, requirePageAccess("sucatas")] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { id } = request.params as { id: string };
        const userId = (request as any).user?.dataOwnerId as string;

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
