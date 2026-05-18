import {
  FinanceEntry,
  FinanceEntryCreate,
  FinanceEntryUpdate,
  FinanceKind,
  FinanceListFilters,
  FinanceListResult,
  FinanceSummary,
} from "../interfaces/finance.interface";
import prisma from "../lib/prisma";
import { CustomerRepository } from "../repositories/customer.repository";
import { FinanceRepository } from "../repositories/finance.repository";
import { UnidadeRepository } from "../repositories/unidade.repository";
import { CustomerUseCase } from "./customer.usecase";

export class FinanceUseCase {
  private repo: FinanceRepository;
  private customerRepo: CustomerRepository;
  private unidadeRepo: UnidadeRepository;
  private customerUseCase: CustomerUseCase;

  constructor() {
    this.repo = new FinanceRepository();
    this.customerRepo = new CustomerRepository();
    this.unidadeRepo = new UnidadeRepository();
    this.customerUseCase = new CustomerUseCase();
  }

  private async assertCustomer(customerId: string, userId: string) {
    const c = await this.customerRepo.findById(customerId, userId);
    if (!c) {
      throw new Error("Cliente selecionado não encontrado");
    }
  }

  // Só roda quando uma unidade é informada — fluxo sem unidade é inalterado.
  // Mensagem contém "inválido" para mapear a 400 no error handler de finance
  // já existente (buildCreateHandler), sem alterar a lógica de status.
  private async assertUnidade(unidadeId: string, userId: string) {
    const u = await this.unidadeRepo.findById(unidadeId, userId);
    if (!u) {
      throw new Error("Identificador de unidade inválido");
    }
  }

  // Validações monetárias/parcelas — compartilhadas pelos dois fluxos.
  private validateMonetary(data: FinanceEntryCreate) {
    if (!(typeof data.totalAmount === "number") || data.totalAmount <= 0) {
      throw new Error("Valor total deve ser maior que zero");
    }
    if (!data.dueDate) throw new Error("Data de vencimento é obrigatória");
    if (data.installments !== undefined && data.installments < 1) {
      throw new Error("Número de parcelas deve ser pelo menos 1");
    }
  }

  private validate(data: FinanceEntryCreate) {
    if (!data.customerId) throw new Error("Cliente é obrigatório");
    this.validateMonetary(data);
  }

  async create(
    kind: FinanceKind,
    data: FinanceEntryCreate,
  ): Promise<FinanceEntry> {
    if (!data.userId) throw new Error("Usuário não encontrado");

    // ── Cadastro rápido: cria cliente + conta numa ÚNICA transação ──
    // Se a criação da conta falhar, o cliente também sofre rollback
    // (atômico). Reusa CustomerUseCase (mesma validação CPF/duplicidade).
    if (data.newCustomer) {
      if (
        !data.newCustomer.name ||
        data.newCustomer.name.trim().length < 2
      ) {
        throw new Error("Nome do cliente é obrigatório");
      }
      this.validateMonetary(data);
      if (data.unidadeId)
        await this.assertUnidade(data.unidadeId, data.userId);

      const { newCustomer, ...rest } = data;
      return prisma.$transaction(async (tx) => {
        const customer = await this.customerUseCase.createWithTx(tx, {
          userId: data.userId,
          name: newCustomer.name,
          cpf: newCustomer.cpf ?? null,
        });
        return this.repo.create(
          kind,
          { ...rest, customerId: customer.id },
          tx,
        );
      });
    }

    // ── Fluxo atual — 100% inalterado ──
    this.validate(data);
    await this.assertCustomer(data.customerId, data.userId);
    if (data.unidadeId) await this.assertUnidade(data.unidadeId, data.userId);
    return this.repo.create(kind, data);
  }

  async update(
    kind: FinanceKind,
    id: string,
    userId: string,
    data: FinanceEntryUpdate,
  ): Promise<FinanceEntry> {
    if (data.customerId) {
      await this.assertCustomer(data.customerId, userId);
    }
    if (data.unidadeId) await this.assertUnidade(data.unidadeId, userId);
    return this.repo.update(kind, id, userId, data);
  }

  async markPaid(
    kind: FinanceKind,
    id: string,
    userId: string,
  ): Promise<FinanceEntry> {
    return this.repo.update(kind, id, userId, {
      status: "PAGA",
      paidAt: new Date(),
    });
  }

  async findById(
    kind: FinanceKind,
    id: string,
    userId: string,
  ): Promise<FinanceEntry> {
    const e = await this.repo.findById(kind, id, userId);
    if (!e) throw new Error("Registro financeiro não encontrado");
    return this.applyOverdueFlag(e);
  }

  async list(
    kind: FinanceKind,
    filters: FinanceListFilters,
    userId: string,
  ): Promise<FinanceListResult> {
    const result = await this.repo.findAll(kind, filters, userId);
    return {
      ...result,
      items: result.items.map((i) => this.applyOverdueFlag(i)),
    };
  }

  async delete(kind: FinanceKind, id: string, userId: string): Promise<void> {
    await this.repo.delete(kind, id, userId);
  }

  async summary(
    userId: string,
    unidadeId?: string,
  ): Promise<FinanceSummary> {
    return this.repo.summary(userId, unidadeId);
  }

  private applyOverdueFlag(entry: FinanceEntry): FinanceEntry {
    if (entry.status === "PENDENTE" && entry.dueDate < new Date()) {
      return { ...entry, status: "VENCIDA" };
    }
    return entry;
  }
}
