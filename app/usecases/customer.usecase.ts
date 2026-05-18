import { Prisma } from "@prisma/client";
import {
  Customer,
  CustomerCreate,
  CustomerListFilters,
  CustomerListResult,
  CustomerUpdate,
} from "../interfaces/customer.interface";
import { CustomerRepository } from "../repositories/customer.repository";

export class CustomerUseCase {
  private repo: CustomerRepository;

  constructor() {
    this.repo = new CustomerRepository();
  }

  // Validações compartilhadas entre create() e createWithTx() — mesma regra
  // de negócio (nome, CPF, duplicidade), sem duplicar lógica.
  private assertValidNew(data: CustomerCreate) {
    if (!data.userId) throw new Error("Usuário não encontrado");
    if (!data.name || data.name.trim().length < 2) {
      throw new Error("Nome é obrigatório");
    }
  }

  private async ensureCpfUnique(
    cpf: string,
    userId: string,
    tx?: Prisma.TransactionClient,
  ) {
    const clean = cpf.replace(/\D/g, "");
    if (clean.length !== 11) {
      throw new Error("CPF inválido");
    }
    const existing = await this.repo.findByCpf(clean, userId, tx);
    if (existing) {
      throw new Error("Já existe um cliente com esse CPF");
    }
  }

  async create(data: CustomerCreate): Promise<Customer> {
    this.assertValidNew(data);
    if (data.cpf) await this.ensureCpfUnique(data.cpf, data.userId);
    return this.repo.create({ ...data, name: data.name.trim() });
  }

  // Mesma validação/criação de create(), mas dentro de uma transação Prisma.
  // Usado pelo cadastro rápido (cliente + conta atômicos no Financeiro).
  async createWithTx(
    tx: Prisma.TransactionClient,
    data: CustomerCreate,
  ): Promise<Customer> {
    this.assertValidNew(data);
    if (data.cpf) await this.ensureCpfUnique(data.cpf, data.userId, tx);
    return this.repo.create({ ...data, name: data.name.trim() }, tx);
  }

  async update(
    id: string,
    userId: string,
    data: CustomerUpdate,
  ): Promise<Customer> {
    if (data.cpf) {
      const clean = data.cpf.replace(/\D/g, "");
      if (clean.length !== 11) throw new Error("CPF inválido");
      const existing = await this.repo.findByCpf(clean, userId);
      if (existing && existing.id !== id) {
        throw new Error("Já existe um cliente com esse CPF");
      }
    }
    return this.repo.update(id, userId, data);
  }

  async findById(id: string, userId: string): Promise<Customer> {
    const c = await this.repo.findById(id, userId);
    if (!c) throw new Error("Cliente não encontrado");
    return c;
  }

  async list(
    filters: CustomerListFilters,
    userId: string,
  ): Promise<CustomerListResult> {
    return this.repo.findAll(filters, userId);
  }

  async search(q: string, userId: string): Promise<Customer[]> {
    return this.repo.search(q, userId, 10);
  }

  async delete(id: string, userId: string): Promise<void> {
    await this.repo.delete(id, userId);
  }
}
