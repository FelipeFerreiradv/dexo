import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { BudgetUseCase } from "../usecases/budget.usecase";
import { Budget, BudgetStatus } from "../interfaces/budget.interface";
import { authMiddleware } from "../middlewares/auth.middleware";
import { CompanyFiscalRepository } from "../repositories/company-fiscal.repository";
import { UserRepositoryPrisma } from "../repositories/user.repository";
import {
  renderBudgetReport,
  type BudgetReportData,
} from "../reports/budget-report";
import type { CompanyFiscalConfig } from "../interfaces/company-fiscal.interface";

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
function fmtDateBR(d: Date): string {
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
}
function fmtDateTimeBR(d: Date): string {
  return `${fmtDateBR(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function buildAddressLine(c: CompanyFiscalConfig | null): string | null {
  if (!c) return null;
  const parts: string[] = [];
  if (c.logradouro) parts.push(c.logradouro);
  if (c.numero) parts.push(c.numero);
  if (c.complemento) parts.push(c.complemento);
  if (c.bairro) parts.push(c.bairro);
  const cityUf = [c.municipio, c.uf].filter(Boolean).join("/");
  if (cityUf) parts.push(cityUf);
  if (c.cep) parts.push(`CEP ${c.cep}`);
  return parts.length > 0 ? parts.join(", ") : null;
}

// Monta o payload do PDF a partir do orçamento + config fiscal (mesma fonte do
// cupom). company pode ser null (empresa sem config) → fallback de exibição.
function buildBudgetReportData(
  budget: Budget,
  company: CompanyFiscalConfig | null,
): BudgetReportData {
  const items = (budget.items ?? []).map((it) => {
    const unitPrice = it.unitPrice;
    return {
      label: it.product?.name ?? it.description ?? "Item",
      sku: it.product?.sku ?? null,
      quantity: it.quantity,
      unitPrice,
      subtotal: it.quantity * unitPrice,
    };
  });
  return {
    company: company
      ? {
          razaoSocial: company.razaoSocial ?? null,
          nomeFantasia: company.nomeFantasia ?? null,
          cnpj: company.cnpj ?? null,
          inscricaoEstadual: company.inscricaoEstadual ?? null,
          addressLine: buildAddressLine(company),
        }
      : null,
    companyName:
      company?.nomeFantasia || company?.razaoSocial || "Sua empresa",
    budgetNumber: budget.document || `#${budget.id.slice(-8)}`,
    statusLabel: budget.status,
    client: {
      name: budget.customer?.name ?? "—",
      doc: budget.customer?.cpf ?? null,
      email: budget.customer?.email ?? null,
    },
    items,
    total: budget.totalAmount,
    validUntilLabel: budget.validUntil
      ? fmtDateBR(new Date(budget.validUntil))
      : null,
    notes: budget.notes ?? null,
    vendedor: budget.vendedor
      ? budget.vendedor.name || budget.vendedor.email
      : null,
    generatedAtLabel: fmtDateTimeBR(new Date()),
  };
}

// Rotas de Orçamento (BLOCO 1). ADITIVO e ISOLADO: factories próprias (NÃO
// reusa as do finance, que são curried por FinanceKind). Mesma convenção de
// auth (dataOwnerId) e de mapping de status (substring do Error.message) do
// finance.routes, para manter a casa consistente.
export const budgetRoutes = async (fastify: FastifyInstance) => {
  const useCase = new BudgetUseCase();
  const companyFiscalRepo = new CompanyFiscalRepository();
  const userRepo = new UserRepositoryPrisma();

  // Lista de vendedores selecionáveis = o dono (admin) + seus colaboradores.
  // Escopo por dataOwnerId, então funciona igual p/ admin e colaborador.
  const sellersHandler = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    try {
      const userId = (request as any).user?.dataOwnerId as string;
      const [owner, children] = await Promise.all([
        userRepo.findById(userId),
        userRepo.findChildren(userId),
      ]);
      const sellers = [
        ...(owner
          ? [
              {
                id: owner.id,
                name: owner.name ?? null,
                email: owner.email,
                isOwner: true,
              },
            ]
          : []),
        ...children.map((c) => ({
          id: c.id,
          name: c.name ?? null,
          email: c.email,
          isOwner: false,
        })),
      ];
      return reply.status(200).send({ sellers });
    } catch (error) {
      return reply.status(500).send({
        error:
          error instanceof Error ? error.message : "Erro ao listar vendedores",
      });
    }
  };

  const listHandler = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    try {
      const userId = (request as any).user?.dataOwnerId as string;
      const {
        search,
        status,
        customerId,
        unidadeId,
        vendedorId,
        from,
        to,
        page,
        limit,
      } = request.query as any;
      const data = await useCase.list(
        {
          search: search || undefined,
          status: (status as BudgetStatus) || undefined,
          customerId: customerId || undefined,
          unidadeId: unidadeId || undefined,
          vendedorId: vendedorId || undefined,
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
          error instanceof Error ? error.message : "Erro ao listar orçamentos",
      });
    }
  };

  const getHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const userId = (request as any).user?.dataOwnerId as string;
      const { id } = request.params as { id: string };
      const budget = await useCase.findById(id, userId);
      return reply.status(200).send({ budget });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Erro ao buscar orçamento";
      const status = message.includes("não encontrado") ? 404 : 500;
      return reply.status(status).send({ error: message });
    }
  };

  const createHandler = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    try {
      const userId = (request as any).user?.dataOwnerId as string;
      const body = request.body as any;
      const budget = await useCase.create({ ...body, userId });
      return reply.status(201).send({ budget });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Erro ao criar orçamento";
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

  const updateHandler = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    try {
      const userId = (request as any).user?.dataOwnerId as string;
      const { id } = request.params as { id: string };
      const body = request.body as any;
      const budget = await useCase.update(id, userId, body);
      return reply.status(200).send({ budget });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Erro ao atualizar orçamento";
      // "abertos" => orçamento não-ABERTO (conflito de estado) → 409.
      const status = message.includes("não encontrado")
        ? 404
        : message.includes("abertos")
          ? 409
          : message.includes("obrigatório") || message.includes("inválido")
            ? 400
            : 500;
      return reply.status(status).send({ error: message });
    }
  };

  const cancelHandler = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    try {
      const userId = (request as any).user?.dataOwnerId as string;
      const { id } = request.params as { id: string };
      const budget = await useCase.cancel(id, userId);
      return reply.status(200).send({ budget });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Erro ao cancelar orçamento";
      const status = message.includes("não encontrado")
        ? 404
        : message.includes("convertido")
          ? 409
          : 500;
      return reply.status(status).send({ error: message });
    }
  };

  const deleteHandler = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    try {
      const userId = (request as any).user?.dataOwnerId as string;
      const { id } = request.params as { id: string };
      await useCase.delete(id, userId);
      return reply.status(200).send({ message: "Orçamento excluído" });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Erro ao excluir orçamento";
      const status = message.includes("não encontrado")
        ? 404
        : message.includes("convertido")
          ? 409
          : 500;
      return reply.status(status).send({ error: message });
    }
  };

  // Converte o orçamento em Conta a Receber (venda balcão). Idempotente
  // (CONVERTIDO → 409). Body opcional: { paymentMethod?, dueDate? }.
  const convertHandler = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    try {
      const userId = (request as any).user?.dataOwnerId as string;
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as {
        paymentMethod?: string | null;
        dueDate?: string | null;
      };
      const receivable = await useCase.convert(id, userId, {
        paymentMethod: body.paymentMethod ?? null,
        dueDate: body.dueDate ?? null,
      });
      return reply.status(201).send({ receivable });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Erro ao converter orçamento";
      const status = message.includes("não encontrado")
        ? 404
        : message.includes("já convertido") || message.includes("cancelado")
          ? 409
          : message.includes("inválido")
            ? 400
            : 500;
      return reply.status(status).send({ error: message });
    }
  };

  // PDF do orçamento (identidade DEXO). Mesma fonte de dados da empresa do
  // cupom (CompanyFiscalConfig). Streama como download, igual a /report.pdf.
  const pdfHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const userId = (request as any).user?.dataOwnerId as string;
      const { id } = request.params as { id: string };
      const [budget, company] = await Promise.all([
        useCase.findById(id, userId),
        companyFiscalRepo.findByUserId(userId),
      ]);
      const pdf = await renderBudgetReport(
        buildBudgetReportData(budget, company),
      );
      return reply
        .header("Content-Type", "application/pdf")
        .header(
          "Content-Disposition",
          `attachment; filename="orcamento-${id}.pdf"`,
        )
        .header("Cache-Control", "private, no-store")
        .send(pdf);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Erro ao gerar o PDF";
      const status = message.includes("não encontrado") ? 404 : 500;
      return reply.status(status).send({ error: message });
    }
  };

  fastify.get("/", { preHandler: [authMiddleware] }, listHandler);
  fastify.get("/sellers", { preHandler: [authMiddleware] }, sellersHandler);
  fastify.post("/", { preHandler: [authMiddleware] }, createHandler);
  fastify.get("/:id", { preHandler: [authMiddleware] }, getHandler);
  fastify.put("/:id", { preHandler: [authMiddleware] }, updateHandler);
  fastify.delete("/:id", { preHandler: [authMiddleware] }, deleteHandler);
  fastify.post("/:id/cancel", { preHandler: [authMiddleware] }, cancelHandler);
  fastify.post("/:id/convert", { preHandler: [authMiddleware] }, convertHandler);
  fastify.get("/:id/pdf", { preHandler: [authMiddleware] }, pdfHandler);
};
