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

  // Lookup de produto para a UI do financeiro (Fase 4 — venda balcão).
  // Mesmo contrato { results: ProductLookup[] } da rota fiscal de lookup;
  // delega ao FinanceUseCase.lookupProducts (que reusa NfeDraftUseCase) para
  // não duplicar a query e desacoplar a UI do prefixo /fiscal.
  fastify.get(
    "/products/lookup",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const { q } = request.query as { q?: string };
        const results = await useCase.lookupProducts(userId, q || "");
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

  const buildListHandler =
    (kind: FinanceKind) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const {
          search,
          status,
          customerId,
          unidadeId,
          paymentMethod,
          from,
          to,
          page,
          limit,
        } = request.query as any;
        const data = await useCase.list(
          kind,
          {
            search: search || undefined,
            status: (status as FinanceStatus) || undefined,
            customerId: customerId || undefined,
            unidadeId: unidadeId || undefined,
            paymentMethod: paymentMethod || undefined,
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
        // Fase 9: "Estornar" sinaliza guard de conta-paga-com-itens — 409.
        // Caminhos pré-existentes ("não encontrado" → 404, resto → 500)
        // permanecem.
        const status = message.includes("Estornar")
          ? 409
          : message.includes("não encontrado")
            ? 404
            : 500;
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

  // ── Fase 9 — Estorno explícito (apenas receivable PAGA com itens) ──
  // Devolve o estoque (contra-lançamento) e reabre anúncios best-effort.
  // Idempotente: já CANCELADA → no-op. Atômico via $transaction com os
  // mesmos opts do markPaid ({timeout:60_000, maxWait:20_000}).
  fastify.post(
    "/receivables/:id/reverse",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const { id } = request.params as { id: string };
        const entry = await useCase.reverse(id, userId);
        return reply.status(200).send({ entry });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Erro ao estornar";
        // "não encontrada" → 404; "inválida"/"inválido" (não-PAGA OU sem
        // itens) → 400; resto → 500.
        const status = message.includes("não encontrada")
          ? 404
          : message.includes("inválida") || message.includes("inválido")
            ? 400
            : 500;
        return reply.status(status).send({ error: message });
      }
    },
  );

  // ── Fase 8: Cupom fiscal real (NF-e modelo 55) — Opção A ──
  // Cria um rascunho de NF-e pré-preenchido a partir da Conta a Receber
  // (destinatário do customer, itens com defaults CFOP 5102 / origem 0 /
  // unidade UN / NCM em branco, pagamento DINHEIRO com valor total).
  // O cupom-PDF-sem-validade-fiscal abaixo continua intacto — esta é uma
  // operação adicional, não substituição.
  fastify.post(
    "/receivables/:id/fiscal-draft",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const { id } = request.params as { id: string };
        const draft = await useCase.createFiscalDraftFromReceivable(
          id,
          userId,
        );
        return reply.status(201).send({ draft });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Erro ao criar rascunho fiscal";
        // Mesma convenção de mapping do buildCreateHandler: "não encontrado"
        // → 404, "inválido"/"obrigatório" → 400, resto → 500.
        const status = message.includes("não encontrada")
          ? 404
          : message.includes("não encontrado")
            ? 404
            : message.includes("inválida") || message.includes("inválido")
              ? 400
              : 500;
        return reply.status(status).send({ error: message });
      }
    },
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
