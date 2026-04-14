import {
  FinanceEntry,
  FinanceEntryCreate,
  FinanceEntryUpdate,
  FinanceKind,
  FinanceListFilters,
  FinanceListResult,
  FinanceSummary,
} from "../interfaces/finance.interface";
import { CustomerRepository } from "../repositories/customer.repository";
import { FinanceRepository } from "../repositories/finance.repository";

export class FinanceUseCase {
  private repo: FinanceRepository;
  private customerRepo: CustomerRepository;

  constructor() {
    this.repo = new FinanceRepository();
    this.customerRepo = new CustomerRepository();
  }

  private async assertCustomer(customerId: string, userId: string) {
    const c = await this.customerRepo.findById(customerId, userId);
    if (!c) {
      throw new Error("Cliente selecionado não encontrado");
    }
  }

  private validate(data: FinanceEntryCreate) {
    if (!data.customerId) throw new Error("Cliente é obrigatório");
    if (!(typeof data.totalAmount === "number") || data.totalAmount <= 0) {
      throw new Error("Valor total deve ser maior que zero");
    }
    if (!data.dueDate) throw new Error("Data de vencimento é obrigatória");
    if (data.installments !== undefined && data.installments < 1) {
      throw new Error("Número de parcelas deve ser pelo menos 1");
    }
  }

  async create(
    kind: FinanceKind,
    data: FinanceEntryCreate,
  ): Promise<FinanceEntry> {
    if (!data.userId) throw new Error("Usuário não encontrado");
    this.validate(data);
    await this.assertCustomer(data.customerId, data.userId);
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

  async summary(userId: string): Promise<FinanceSummary> {
    return this.repo.summary(userId);
  }

  private applyOverdueFlag(entry: FinanceEntry): FinanceEntry {
    if (entry.status === "PENDENTE" && entry.dueDate < new Date()) {
      return { ...entry, status: "VENCIDA" };
    }
    return entry;
  }
}
