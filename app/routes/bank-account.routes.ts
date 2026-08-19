import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { BankAccountUseCase } from "../usecases/bank-account.usecase";
import { authMiddleware } from "../middlewares/auth.middleware";
import { isBankAccountsEnabled } from "../financeiro/lib/bank-accounts";

// BLOCO A — CRUD de contas bancárias / caixas.
//
// Espelha `unidade.routes.ts`, que é o desenho da casa para configuração do
// tenant: mesmas rotas, mesmo mapeamento de erro por substring, mesmo
// `dataOwnerId` (colaborador enxerga as contas do admin — ele precisa
// escolher onde o dinheiro entrou).
//
// NÃO EXISTE DELETE, de propósito: a conta é referenciada por lançamentos
// históricos. Desativar é `PATCH { isActive: false }`.
//
// Flag de backend em TODAS as rotas: a tabela pode não existir no banco ainda,
// e uma consulta a tabela inexistente é erro 500 feio em vez de recurso
// desligado.
export const bankAccountRoutes = async (fastify: FastifyInstance) => {
  const useCase = new BankAccountUseCase();

  const desativado = (reply: FastifyReply) =>
    reply.status(403).send({ error: "Contas bancárias desativadas" });

  fastify.get(
    "/",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        if (!isBankAccountsEnabled()) {
          // Lista VAZIA em vez de 403: quem chama é um seletor, e uma lista
          // vazia o faz sumir sozinho. Erro faria a tela mostrar falha por um
          // recurso que apenas não está ligado.
          return reply.status(200).send({ accounts: [], total: 0 });
        }
        const userId = (request as any).user?.dataOwnerId as string;
        const { all } = request.query as { all?: string };
        const includeInactive = all === "1" || all === "true";
        const data = await useCase.list(userId, includeInactive);
        return reply
          .status(200)
          .send({ accounts: data.accounts, total: data.total });
      } catch (error) {
        return reply.status(500).send({
          error:
            error instanceof Error ? error.message : "Erro ao listar contas",
        });
      }
    },
  );

  fastify.get(
    "/:id",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        if (!isBankAccountsEnabled()) return desativado(reply);
        const userId = (request as any).user?.dataOwnerId as string;
        const { id } = request.params as { id: string };
        const account = await useCase.findById(id, userId);
        return reply.status(200).send({ account });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Erro ao buscar conta";
        const status = message.includes("não encontrada") ? 404 : 500;
        return reply.status(status).send({ error: message });
      }
    },
  );

  fastify.post(
    "/",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        if (!isBankAccountsEnabled()) return desativado(reply);
        const userId = (request as any).user?.dataOwnerId as string;
        const body = request.body as any;
        const account = await useCase.create({ ...body, userId });
        return reply.status(201).send({ account });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Erro ao criar conta";
        const status =
          message.includes("obrigatório") || message.includes("inválido")
            ? 400
            : 500;
        return reply.status(status).send({ error: message });
      }
    },
  );

  const updateHandler = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    try {
      if (!isBankAccountsEnabled()) return desativado(reply);
      const userId = (request as any).user?.dataOwnerId as string;
      const { id } = request.params as { id: string };
      const body = request.body as any;
      const account = await useCase.update(id, userId, body);
      return reply.status(200).send({ account });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Erro ao atualizar conta";
      const status = message.includes("não encontrada")
        ? 404
        : message.includes("obrigatório") || message.includes("inválido")
          ? 400
          : 500;
      return reply.status(status).send({ error: message });
    }
  };

  // PUT (edição completa) e PATCH (parcial / desativar via { isActive: false }).
  fastify.put("/:id", { preHandler: [authMiddleware] }, updateHandler);
  fastify.patch("/:id", { preHandler: [authMiddleware] }, updateHandler);
};
