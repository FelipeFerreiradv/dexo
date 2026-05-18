import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { FinanceUseCase } from "../usecases/finance.usecase";
import { FinanceKind, FinanceStatus } from "../interfaces/finance.interface";
import { authMiddleware } from "../middlewares/auth.middleware";
import { FinanceRepository } from "../repositories/finance.repository";
import { CompanyFiscalRepository } from "../repositories/company-fiscal.repository";
import { ReceiptPdfService } from "../financeiro/generators/receipt-pdf.service";

export const financeRoutes = async (fastify: FastifyInstance) => {
  const useCase = new FinanceUseCase();
  const financeRepo = new FinanceRepository();
  const companyFiscalRepo = new CompanyFiscalRepository();
  const receiptPdf = new ReceiptPdfService();

  fastify.get(
    "/summary",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const { unidadeId } = request.query as { unidadeId?: string };
        const summary = await useCase.summary(userId, unidadeId || undefined);
        return reply.status(200).send({ summary });
      } catch (error) {
        return reply.status(500).send({
          error:
            error instanceof Error ? error.message : "Erro ao obter resumo",
        });
      }
    },
  );

  const buildListHandler =
    (kind: FinanceKind) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const { search, status, customerId, unidadeId, from, to, page, limit } =
          request.query as any;
        const data = await useCase.list(
          kind,
          {
            search: search || undefined,
            status: (status as FinanceStatus) || undefined,
            customerId: customerId || undefined,
            unidadeId: unidadeId || undefined,
            from: from || undefined,
            to: to || undefined,
            page: page ? parseInt(page) : 1,
            limit: limit ? parseInt(limit) : 20,
          },
          userId,
        );
        return reply.status(200).send({
          items: data.items,
          pagination: {
            page: page ? parseInt(page) : 1,
            limit: limit ? parseInt(limit) : 20,
            total: data.total,
            totalPages: data.totalPages,
          },
        });
      } catch (error) {
        return reply.status(500).send({
          error:
            error instanceof Error ? error.message : "Erro ao listar registros",
        });
      }
    };

  const buildCreateHandler =
    (kind: FinanceKind) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const body = request.body as any;
        const entry = await useCase.create(kind, { ...body, userId });
        return reply.status(201).send({ entry });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Erro ao criar registro";
        const status = message.includes("Já existe")
          ? 409
          : message.includes("obrigatório") ||
              message.includes("inválido") ||
              message.includes("maior que")
            ? 400
            : message.includes("não encontrado")
              ? 404
              : 500;
        return reply.status(status).send({ error: message });
      }
    };

  const buildUpdateHandler =
    (kind: FinanceKind) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const { id } = request.params as { id: string };
        const body = request.body as any;
        const entry = await useCase.update(kind, id, userId, body);
        return reply.status(200).send({ entry });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Erro ao atualizar";
        const status = message.includes("não encontrado") ? 404 : 500;
        return reply.status(status).send({ error: message });
      }
    };

  const buildPayHandler =
    (kind: FinanceKind) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const { id } = request.params as { id: string };
        const entry = await useCase.markPaid(kind, id, userId);
        return reply.status(200).send({ entry });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Erro ao marcar como pago";
        const status = message.includes("não encontrado") ? 404 : 500;
        return reply.status(status).send({ error: message });
      }
    };

  const buildDeleteHandler =
    (kind: FinanceKind) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const { id } = request.params as { id: string };
        await useCase.delete(kind, id, userId);
        return reply.status(200).send({ message: "Registro excluído" });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Erro ao excluir";
        const status = message.includes("não encontrado") ? 404 : 500;
        return reply.status(status).send({ error: message });
      }
    };

  // Receivables
  fastify.get(
    "/receivables",
    { preHandler: [authMiddleware] },
    buildListHandler("receivable"),
  );
  fastify.post(
    "/receivables",
    { preHandler: [authMiddleware] },
    buildCreateHandler("receivable"),
  );
  fastify.put(
    "/receivables/:id",
    { preHandler: [authMiddleware] },
    buildUpdateHandler("receivable"),
  );
  fastify.post(
    "/receivables/:id/pay",
    { preHandler: [authMiddleware] },
    buildPayHandler("receivable"),
  );
  fastify.delete(
    "/receivables/:id",
    { preHandler: [authMiddleware] },
    buildDeleteHandler("receivable"),
  );

  // ── Cupom sem validade fiscal (apenas Receivable) ──
  fastify.get(
    "/receivables/:id/receipt",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const { id } = request.params as { id: string };

        // Queries independentes em paralelo — entry (com customer) e
        // company fiscal config são consultas desacopladas.
        const [entry, company] = await Promise.all([
          financeRepo.findById("receivable", id, userId),
          companyFiscalRepo.findByUserId(userId),
        ]);

        if (!entry) {
          return reply
            .status(404)
            .send({ error: "Conta a receber não encontrada" });
        }

        const pdfBytes = await receiptPdf.generate(entry, company);
        const buffer = Buffer.from(pdfBytes);

        return reply
          .header("Content-Type", "application/pdf")
          .header(
            "Content-Disposition",
            `attachment; filename="cupom-${id}.pdf"`,
          )
          .header("Cache-Control", "private, no-store")
          .send(buffer);
      } catch (error) {
        return reply.status(500).send({
          error:
            error instanceof Error
              ? error.message
              : "Erro ao emitir cupom sem validade fiscal",
        });
      }
    },
  );

  // Payables
  fastify.get(
    "/payables",
    { preHandler: [authMiddleware] },
    buildListHandler("payable"),
  );
  fastify.post(
    "/payables",
    { preHandler: [authMiddleware] },
    buildCreateHandler("payable"),
  );
  fastify.put(
    "/payables/:id",
    { preHandler: [authMiddleware] },
    buildUpdateHandler("payable"),
  );
  fastify.post(
    "/payables/:id/pay",
    { preHandler: [authMiddleware] },
    buildPayHandler("payable"),
  );
  fastify.delete(
    "/payables/:id",
    { preHandler: [authMiddleware] },
    buildDeleteHandler("payable"),
  );
};
