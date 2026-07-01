import {
  Budget,
  BudgetCancelOptions,
  BudgetCreate,
  BudgetListFilters,
  BudgetListResult,
  BudgetStage,
  BudgetUpdate,
  OPEN_BUDGET_STAGES,
} from "../interfaces/budget.interface";
import type { FinanceEntry } from "../interfaces/finance.interface";
import prisma from "../lib/prisma";
import { PAYMENT_METHOD_CODES } from "../lib/payment-methods";
import { BudgetRepository } from "../repositories/budget.repository";
import { CustomerRepository } from "../repositories/customer.repository";
import { FinanceRepository } from "../repositories/finance.repository";
import { UnidadeRepository } from "../repositories/unidade.repository";
import { UserRepositoryPrisma } from "../repositories/user.repository";
import { CustomerUseCase } from "./customer.usecase";

// Orçamento (BLOCO 1). Espelha FinanceUseCase no que diz respeito a validação,
// cadastro rápido transacional e flag derivada — mas SEM encargos/parcelas/
// markPaid/estorno (orçamento não movimenta estoque nem dinheiro). A conversão
// em venda (Receivable) vive na Fase D.
export class BudgetUseCase {
  private repo: BudgetRepository;
  private customerRepo: CustomerRepository;
  private unidadeRepo: UnidadeRepository;
  private customerUseCase: CustomerUseCase;
  private financeRepo: FinanceRepository;
  private userRepo: UserRepositoryPrisma;

  constructor() {
    this.repo = new BudgetRepository();
    this.customerRepo = new CustomerRepository();
    this.unidadeRepo = new UnidadeRepository();
    this.customerUseCase = new CustomerUseCase();
    this.financeRepo = new FinanceRepository();
    this.userRepo = new UserRepositoryPrisma();
  }

  private async assertCustomer(customerId: string, userId: string) {
    const c = await this.customerRepo.findById(customerId, userId);
    if (!c) throw new Error("Cliente selecionado não encontrado");
  }

  private async assertUnidade(unidadeId: string, userId: string) {
    const u = await this.unidadeRepo.findById(unidadeId, userId);
    if (!u) throw new Error("Identificador de unidade inválido");
  }

  // Vendedor válido = o PRÓPRIO dono (admin) OU um colaborador (child) do dono.
  // userId aqui é o dataOwnerId (admin). Mensagem com "inválido" mapeia a 400.
  private async assertVendedor(vendedorId: string, userId: string) {
    if (vendedorId === userId) return; // o próprio admin pode ser o vendedor
    const v = await this.userRepo.findById(vendedorId);
    if (!v || v.parentUserId !== userId) {
      throw new Error("Vendedor inválido (não pertence à sua equipe)");
    }
  }

  private validateMonetary(data: BudgetCreate) {
    if (!(typeof data.totalAmount === "number") || data.totalAmount <= 0) {
      throw new Error("Valor total deve ser maior que zero");
    }
  }

  private validate(data: BudgetCreate) {
    if (!data.customerId) throw new Error("Cliente é obrigatório");
    this.validateMonetary(data);
  }

  // Mesma regra do balcão: cada item é CADASTRADO (productId) OU MANUAL
  // (description). Mensagens com "obrigatório"/"inválido" mapeiam a 400.
  private validateItems(data: BudgetCreate | BudgetUpdate) {
    const items = (data as any).items;
    if (items === undefined) return;
    if (!Array.isArray(items)) {
      throw new Error("Itens inválidos: deve ser uma lista");
    }
    for (const [idx, it] of items.entries()) {
      if (!it || typeof it !== "object") {
        throw new Error(`Item ${idx + 1} inválido`);
      }
      const hasProduct =
        typeof it.productId === "string" && it.productId.length > 0;
      const hasDescription =
        typeof it.description === "string" && it.description.trim().length > 0;
      if (!hasProduct && !hasDescription) {
        throw new Error(
          `Item ${idx + 1}: produto cadastrado ou descrição é obrigatório`,
        );
      }
      if (!Number.isInteger(it.quantity) || it.quantity <= 0) {
        throw new Error(
          `Item ${idx + 1} inválido: quantidade deve ser inteiro positivo`,
        );
      }
      if (
        typeof it.unitPrice !== "number" ||
        !Number.isFinite(it.unitPrice) ||
        it.unitPrice < 0
      ) {
        throw new Error(`Item ${idx + 1}: preço unitário inválido`);
      }
    }
  }

  async create(data: BudgetCreate): Promise<Budget> {
    if (!data.userId) throw new Error("Usuário não encontrado");
    this.validateItems(data);
    if (data.vendedorId)
      await this.assertVendedor(data.vendedorId, data.userId);

    // Cadastro rápido: cria cliente + orçamento na MESMA transação (atômico),
    // reusando CustomerUseCase.createWithTx (mesma validação CPF/duplicidade).
    if (data.newCustomer) {
      if (!data.newCustomer.name || data.newCustomer.name.trim().length < 2) {
        throw new Error("Nome do cliente é obrigatório");
      }
      this.validateMonetary(data);
      if (data.unidadeId) await this.assertUnidade(data.unidadeId, data.userId);

      const { newCustomer, ...rest } = data;
      return prisma.$transaction(async (tx) => {
        const customer = await this.customerUseCase.createWithTx(tx, {
          userId: data.userId,
          name: newCustomer.name,
          cpf: newCustomer.cpf ?? null,
        });
        return this.repo.create({ ...rest, customerId: customer.id }, tx);
      });
    }

    this.validate(data);
    await this.assertCustomer(data.customerId, data.userId);
    if (data.unidadeId) await this.assertUnidade(data.unidadeId, data.userId);
    return this.repo.create(data);
  }

  async update(
    id: string,
    userId: string,
    data: BudgetUpdate,
  ): Promise<Budget> {
    // Só orçamentos ABERTOS são editáveis (status persistido; EXPIRADO é só um
    // rótulo derivado, então um ABERTO vencido ainda pode ser editado/estendido).
    const current = await this.repo.findById(id, userId);
    if (!current) throw new Error("Orçamento não encontrado");
    if (current.status !== "ABERTO") {
      throw new Error("Apenas orçamentos abertos podem ser editados");
    }
    if (data.customerId) await this.assertCustomer(data.customerId, userId);
    if (data.unidadeId) await this.assertUnidade(data.unidadeId, userId);
    if (data.vendedorId) await this.assertVendedor(data.vendedorId, userId);
    this.validateItems(data);
    return this.repo.update(id, userId, data);
  }

  async findById(id: string, userId: string): Promise<Budget> {
    const b = await this.repo.findById(id, userId);
    if (!b) throw new Error("Orçamento não encontrado");
    return this.applyExpiredFlag(b);
  }

  async list(
    filters: BudgetListFilters,
    userId: string,
  ): Promise<BudgetListResult> {
    const result = await this.repo.findAll(filters, userId);
    return {
      ...result,
      items: result.items.map((b) => this.applyExpiredFlag(b)),
    };
  }

  // Cancela. Backward-compatible: sem `opts` = comportamento atual (repo carimba
  // pipelineStage=CANCELADO por default). Com `opts` (kanban) grava PERDIDO +
  // lostReason. O guard de CONVERTIDO→409 continua no repo.
  async cancel(
    id: string,
    userId: string,
    opts?: BudgetCancelOptions,
  ): Promise<Budget> {
    if (
      opts?.pipelineStage &&
      opts.pipelineStage !== "CANCELADO" &&
      opts.pipelineStage !== "PERDIDO"
    ) {
      throw new Error(
        "Estágio de cancelamento inválido (use CANCELADO ou PERDIDO)",
      );
    }
    const b = await this.repo.cancel(id, userId, opts);
    return this.applyExpiredFlag(b);
  }

  // Move o card entre estágios ABERTOS do funil (só pipelineStage; sem efeito
  // financeiro). Valida que o alvo é um estágio aberto; o guard de status ABERTO
  // (e 404/409) é atômico no repo. Mensagem "inválido" → 400 nas rotas.
  async setStage(
    id: string,
    userId: string,
    stage: BudgetStage,
  ): Promise<Budget> {
    if (!OPEN_BUDGET_STAGES.includes(stage)) {
      // Msg NÃO contém "abertos" de propósito: a rota mapeia "abertos"→409
      // (conflito de estado) e "inválido"→400. Aqui é 400 (payload inválido).
      throw new Error(
        "Estágio inválido: mova apenas entre Novo, Em negociação e Proposta enviada",
      );
    }
    const b = await this.repo.setStage(id, userId, stage);
    return this.applyExpiredFlag(b);
  }

  async delete(id: string, userId: string): Promise<void> {
    await this.repo.delete(id, userId);
  }

  /**
   * Converte um orçamento ABERTO em Conta a Receber (venda balcão).
   *
   * Atômico e idempotente, numa ÚNICA `$transaction`:
   *  1. carrega o orçamento + itens (scoped por userId);
   *  2. cria o `Receivable` (PENDENTE) pelo MESMO caminho do balcão
   *     (`financeRepo.create("receivable", …, tx)`), copiando cliente, unidade
   *     e TODOS os itens — `unitPrice` é snapshot, copiado verbatim;
   *  3. seta `Receivable.budgetId` (vínculo, sem poluir o DTO de finance);
   *  4. marca o orçamento como `CONVERTIDO`.
   *
   * A partir daí vale o fluxo existente: `markPaid` na conta gerada baixa o
   * estoque dos itens cadastrados, emite cupom, etc. — NÃO é reescrito aqui.
   *
   * Idempotência: orçamento já CONVERTIDO → erro (409). Sob corrida, o
   * `@unique` em `Receivable.budgetId` garante no nível do banco que um
   * orçamento gere no máximo uma conta (a 2ª tx sofre rollback).
   */
  async convert(
    id: string,
    userId: string,
    opts?: { paymentMethod?: string | null; dueDate?: string | Date | null },
  ): Promise<FinanceEntry> {
    const paymentMethod = opts?.paymentMethod ?? null;
    if (paymentMethod && !PAYMENT_METHOD_CODES.includes(paymentMethod)) {
      throw new Error("Método de pagamento inválido");
    }
    // Orçamento não tem dueDate; a venda balcão é finalizada "agora".
    const dueDate = opts?.dueDate ? new Date(opts.dueDate) : new Date();

    return prisma.$transaction(async (tx) => {
      const budget: any = await (tx as any).budget.findFirst({
        where: { id, userId },
        include: { items: true },
      });
      if (!budget) throw new Error("Orçamento não encontrado");
      if (budget.status === "CONVERTIDO") {
        throw new Error("Orçamento já convertido em venda");
      }
      if (budget.status === "CANCELADO") {
        throw new Error("Orçamento cancelado não pode ser convertido");
      }

      const receivable = await this.financeRepo.create(
        "receivable",
        {
          userId,
          customerId: budget.customerId,
          unidadeId: budget.unidadeId ?? null,
          document: budget.document ?? null,
          reason: budget.reason ?? null,
          totalAmount: Number(budget.totalAmount),
          dueDate,
          status: "PENDENTE",
          paymentMethod,
          items: (budget.items ?? []).map((it: any) => ({
            productId: it.productId ?? null,
            description: it.description ?? null,
            scrapId: it.scrapId ?? null,
            listingId: it.listingId ?? null,
            quantity: it.quantity,
            unitPrice: Number(it.unitPrice),
          })),
        },
        tx,
      );

      // Vínculo bidirecional na MESMA tx (budgetId só é setado por aqui).
      await (tx as any).receivable.update({
        where: { id: receivable.id },
        data: { budgetId: budget.id },
      });
      await (tx as any).budget.update({
        where: { id: budget.id },
        // pipelineStage=GANHO é ADITIVO: a coluna Fechado deriva de
        // status=CONVERTIDO (o GANHO só torna o dado do funil explícito).
        data: { status: "CONVERTIDO", pipelineStage: "GANHO" },
      });

      return receivable;
    });
  }

  // EXPIRADO derivado de validUntil em read-time (igual ao VENCIDA do finance):
  // nunca persistido. Só um ABERTO com validade vencida vira EXPIRADO no display.
  private applyExpiredFlag(b: Budget): Budget {
    if (b.status === "ABERTO" && b.validUntil && b.validUntil < new Date()) {
      return { ...b, status: "EXPIRADO" };
    }
    return b;
  }
}
