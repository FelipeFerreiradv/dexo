import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { CustomerUseCase } from "../usecases/customer.usecase";
import { BudgetRepository } from "../repositories/budget.repository";
import { authMiddleware } from "../middlewares/auth.middleware";
import {
  requireAnyPageAccess,
  requirePageAccess,
} from "../middlewares/require-page-access.middleware";
import { isValidCnpj, isValidCpf, onlyDigits } from "../lib/masks";

/**
 * ⭐ Dígito verificador de CPF/CNPJ — a validação que só existia no NAVEGADOR.
 *
 * `customer-schema.ts` (Zod do formulário) checa o DV; o backend checava só o
 * COMPRIMENTO (`customer.usecase.ts:45-63`). Um POST direto com
 * `cpf: "11111111111"` — 11 dígitos, DV inválido — entrava no banco.
 *
 * ⚠️⚠️ FICA NA ROTA, E NÃO NO USECASE, de propósito. O usecase é o funil de
 * QUATRO caminhos internos que não passam por HTTP: o importador de planilhas,
 * o auto-cliente de pedidos de marketplace, o auto-cliente da NF-e e o cadastro
 * rápido do Financeiro. Nenhum deles controla a qualidade do documento que
 * recebe — planilha de cliente vem como vem, e marketplace devolve o que o
 * comprador digitou. Endurecer o usecase transformaria "linha com CPF torto"
 * em "importação que falha", que é pior que o problema.
 *
 * O buraco relatado era a API pública. É a API pública que fecha.
 */
function conferirDocumento(body: any): string | null {
  const cpf = onlyDigits(body?.cpf);
  if (cpf && !isValidCpf(cpf)) return "CPF inválido";
  const cnpj = onlyDigits(body?.cnpj);
  if (cnpj && !isValidCnpj(cnpj)) return "CNPJ informado é inválido";
  return null;
}

export const customerRoutes = async (fastify: FastifyInstance) => {
  const useCase = new CustomerUseCase();
  // Repo leve (só prisma) p/ o indicador de orçamentos por cliente (CRM).
  const budgetRepo = new BudgetRepository();

  fastify.get(
    "/",
    { preHandler: [authMiddleware, requireAnyPageAccess(["clientes", "financeiro"])] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const { search, page, limit, withBudgetCounts } = request.query as {
          search?: string;
          page?: string;
          limit?: string;
          withBudgetCounts?: string;
        };
        const data = await useCase.list(
          {
            search: search || undefined,
            page: page ? parseInt(page) : 1,
            limit: limit ? parseInt(limit) : 20,
          },
          userId,
        );
        // OPT-IN (CRM): só quando ?withBudgetCounts=true (front atrás da flag).
        // Mescla budgetCount/openBudgetCount SEM tocar os campos existentes.
        // Sem o param, a resposta é byte-a-byte idêntica à de hoje.
        let customers: any[] = data.customers;
        if (withBudgetCounts === "true") {
          const ids = customers.map((c: any) => c.id);
          const counts = await budgetRepo.countByCustomer(userId, ids);
          customers = customers.map((c: any) => ({
            ...c,
            budgetCount: counts[c.id]?.total ?? 0,
            openBudgetCount: counts[c.id]?.open ?? 0,
          }));
        }
        return reply.status(200).send({
          customers,
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
            error instanceof Error ? error.message : "Erro ao listar clientes",
        });
      }
    },
  );

  fastify.get(
    "/search",
    { preHandler: [authMiddleware, requireAnyPageAccess(["clientes", "financeiro"])] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const { q } = request.query as { q?: string };
        if (!q || q.trim().length === 0) {
          return reply.status(200).send({ customers: [] });
        }
        const items = await useCase.search(q, userId);
        return reply.status(200).send({ customers: items });
      } catch (error) {
        return reply.status(500).send({
          error:
            error instanceof Error ? error.message : "Erro ao buscar clientes",
        });
      }
    },
  );

  fastify.get(
    "/:id",
    { preHandler: [authMiddleware, requirePageAccess("clientes")] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const { id } = request.params as { id: string };
        const customer = await useCase.findById(id, userId);
        return reply.status(200).send({ customer });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Erro ao buscar cliente";
        const status = message.includes("não encontrado") ? 404 : 500;
        return reply.status(status).send({ error: message });
      }
    },
  );

  fastify.post(
    "/",
    { preHandler: [authMiddleware, requirePageAccess("clientes")] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const body = request.body as any;

        const docInvalido = conferirDocumento(body);
        if (docInvalido) return reply.status(400).send({ error: docInvalido });

        const customer = await useCase.create({ ...body, userId });
        return reply.status(201).send({ customer });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Erro ao criar cliente";
        const status = message.includes("Já existe")
          ? 409
          : message.includes("obrigat") || message.includes("inválido")
            ? 400
            : 500;
        return reply.status(status).send({ error: message });
      }
    },
  );

  fastify.put(
    "/:id",
    { preHandler: [authMiddleware, requirePageAccess("clientes")] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const { id } = request.params as { id: string };
        const body = request.body as any;

        // ⚠️ Só valida o que ESTÁ SENDO ENVIADO. Um PUT que não mexe no
        // documento não pode ser barrado por um CPF torto que já estava no
        // banco desde uma importação antiga — senão consertar o telefone de um
        // cliente legado vira impossível.
        const docInvalido = conferirDocumento(body);
        if (docInvalido) return reply.status(400).send({ error: docInvalido });

        const customer = await useCase.update(id, userId, body);
        return reply.status(200).send({ customer });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Erro ao atualizar cliente";
        const status = message.includes("não encontrado")
          ? 404
          : message.includes("Já existe")
            ? 409
            : message.includes("inválido")
              ? 400
              : 500;
        return reply.status(status).send({ error: message });
      }
    },
  );

  fastify.delete(
    "/:id",
    { preHandler: [authMiddleware, requirePageAccess("clientes")] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const { id } = request.params as { id: string };
        await useCase.delete(id, userId);
        return reply
          .status(200)
          .send({ message: "Cliente excluído com sucesso" });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Erro ao excluir cliente";
        // Prisma P2003 foreign-key
        const status = /foreign|constraint|referenc/i.test(message)
          ? 409
          : message.includes("não encontrado")
            ? 404
            : 500;
        return reply.status(status).send({
          error: /foreign|constraint|referenc/i.test(message)
            ? "Não é possível excluir: cliente possui contas vinculadas"
            : message,
        });
      }
    },
  );
};
