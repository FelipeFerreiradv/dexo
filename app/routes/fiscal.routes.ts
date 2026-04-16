import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { authMiddleware } from "../middlewares/auth.middleware";
import { CompanyFiscalUseCase } from "../usecases/company-fiscal.usecase";
import { NfeDraftUseCase } from "../usecases/nfe-draft.usecase";
import { FiscalCalculatorService } from "../fiscal/calculators/fiscal-calculator.service";
import { CompanyFiscalRepository } from "../repositories/company-fiscal.repository";
import { NfeRepository } from "../repositories/nfe.repository";
import type { NfeItemInput, RegimeTributario } from "../fiscal/domain/nfe.types";

export const fiscalRoutes = async (fastify: FastifyInstance) => {
  const companyFiscal = new CompanyFiscalUseCase();
  const nfeDraft = new NfeDraftUseCase();
  const calculator = new FiscalCalculatorService();
  const configRepo = new CompanyFiscalRepository();
  const nfeRepo = new NfeRepository();

  // ── Configuração ──

  fastify.get(
    "/config",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.id as string;
        const config = await companyFiscal.getByUserId(userId);
        return reply.status(200).send({ config });
      } catch (error) {
        return reply.status(500).send({
          error:
            error instanceof Error
              ? error.message
              : "Erro ao buscar configuração fiscal",
        });
      }
    },
  );

  fastify.put(
    "/config",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.id as string;
        const body = request.body as any;
        const config = await companyFiscal.upsert(userId, body);
        return reply.status(200).send({ config });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Erro ao salvar configuração fiscal";
        const status =
          message.includes("inválid") ||
          message.includes("obrigat") ||
          message.includes("bloqueado") ||
          message.includes("dígitos")
            ? 400
            : 500;
        return reply.status(status).send({ error: message });
      }
    },
  );

  // ── Rascunho NFe ──

  fastify.post(
    "/nfe/draft",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.id as string;
        const body = (request.body as any) ?? {};
        const draft = await nfeDraft.create(userId, {
          orderId: body.orderId ?? null,
          customerId: body.customerId ?? null,
        });
        return reply.status(201).send({ draft });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Erro ao criar rascunho";
        const status = message.includes("Configuração fiscal") ? 400 : 500;
        return reply.status(status).send({ error: message });
      }
    },
  );

  fastify.get(
    "/nfe/draft/:id",
    { preHandler: [authMiddleware] },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        const userId = (request as any).user?.id as string;
        const { id } = request.params;
        const draft = await nfeDraft.getById(userId, id);
        return reply.status(200).send({ draft });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Erro ao buscar rascunho";
        const status = message.includes("não encontrado") ? 404 : 500;
        return reply.status(status).send({ error: message });
      }
    },
  );

  fastify.put(
    "/nfe/draft/:id",
    { preHandler: [authMiddleware] },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        const userId = (request as any).user?.id as string;
        const { id } = request.params;
        const body = request.body as any;
        const draft = await nfeDraft.update(userId, id, body);
        return reply.status(200).send({ draft });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Erro ao atualizar rascunho";
        const status = message.includes("não encontrado") ? 404 : 500;
        return reply.status(status).send({ error: message });
      }
    },
  );

  fastify.delete(
    "/nfe/draft/:id",
    { preHandler: [authMiddleware] },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        const userId = (request as any).user?.id as string;
        const { id } = request.params;
        await nfeDraft.delete(userId, id);
        return reply.status(204).send();
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Erro ao excluir rascunho";
        const status = message.includes("não encontrado") ? 404 : 500;
        return reply.status(status).send({ error: message });
      }
    },
  );

  // ── Calculate ──

  fastify.post(
    "/nfe/draft/:id/calculate",
    { preHandler: [authMiddleware] },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        const userId = (request as any).user?.id as string;
        const { id } = request.params;

        // Load draft with items
        const draft = await nfeDraft.getById(userId, id);
        if (!draft.itens || draft.itens.length === 0) {
          return reply
            .status(400)
            .send({ error: "Adicione pelo menos um produto antes de calcular" });
        }

        // Get regime from fiscal config
        const config = await configRepo.findByUserId(userId);
        if (!config) {
          return reply
            .status(400)
            .send({ error: "Configuracao fiscal nao encontrada" });
        }

        const regime = config.regimeTributario as RegimeTributario;

        // Map draft items to calculator input
        const itensInput: NfeItemInput[] = draft.itens.map((item) => ({
          quantidade: Number(item.quantidade),
          valorUnitario: Number(item.valorUnitario),
          desconto: Number(item.desconto ?? 0),
          ncm: item.ncm,
          cfop: item.cfop,
          origem: (item.origem ?? 0) as any,
          cstIcms: item.cstIcms ?? (regime === "SIMPLES" ? "102" : "00"),
          cstPis: (item.cstPis ?? (regime === "SIMPLES" ? "49" : "01")) as any,
          cstCofins: (item.cstCofins ?? (regime === "SIMPLES" ? "49" : "01")) as any,
          aliquotaIcms: item.aliquotaIcms ?? null,
          aliquotaIpi: item.aliquotaIpi ?? null,
          aliquotaPis: item.aliquotaPis ?? null,
          aliquotaCofins: item.aliquotaCofins ?? null,
          reducaoBcIcms: item.reducaoBcIcms ?? null,
        }));

        const result = calculator.calcular(regime, itensInput);

        // Persist totais to the draft
        await nfeRepo.updateDraft(userId, id, {
          totaisJson: result.totais,
        });

        return reply.status(200).send({ totais: result.totais, itens: result.itens });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Erro ao calcular impostos";
        return reply.status(500).send({ error: message });
      }
    },
  );

  // ── Lookups ──

  fastify.get(
    "/lookup/customers",
    { preHandler: [authMiddleware] },
    async (
      request: FastifyRequest<{ Querystring: { q?: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        const userId = (request as any).user?.id as string;
        const q = (request.query as any).q || "";
        const results = await nfeDraft.lookupCustomers(userId, q);
        return reply.status(200).send({ results });
      } catch (error) {
        return reply.status(500).send({
          error:
            error instanceof Error
              ? error.message
              : "Erro ao buscar clientes",
        });
      }
    },
  );

  fastify.get(
    "/lookup/products",
    { preHandler: [authMiddleware] },
    async (
      request: FastifyRequest<{ Querystring: { q?: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        const userId = (request as any).user?.id as string;
        const q = (request.query as any).q || "";
        const results = await nfeDraft.lookupProducts(userId, q);
        return reply.status(200).send({ results });
      } catch (error) {
        return reply.status(500).send({
          error:
            error instanceof Error
              ? error.message
              : "Erro ao buscar produtos",
        });
      }
    },
  );
};
