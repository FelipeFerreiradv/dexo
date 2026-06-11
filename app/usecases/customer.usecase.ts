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

  // Nome efetivo: para PJ o "nome" do registro é a razão social (a coluna
  // `name` é NOT NULL e alimenta listas/busca). PF usa o próprio nome.
  private effectiveName(data: {
    name?: string | null;
    razaoSocial?: string | null;
  }): string {
    return (data.name || data.razaoSocial || "").trim();
  }

  // Validações compartilhadas entre create() e createWithTx() — mesma regra
  // de negócio (nome/razão social, duplicidade), sem duplicar lógica.
  private assertValidNew(data: CustomerCreate) {
    if (!data.userId) throw new Error("Usuário não encontrado");
    if (this.effectiveName(data).length < 2) {
      throw new Error(
        data.personType === "PJ"
          ? "Razão social é obrigatória"
          : "Nome é obrigatório",
      );
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

  private async ensureCnpjUnique(
    cnpj: string,
    userId: string,
    tx?: Prisma.TransactionClient,
  ) {
    const clean = cnpj.replace(/\D/g, "");
    if (clean.length !== 14) {
      throw new Error("CNPJ inválido");
    }
    const existing = await this.repo.findByCnpj(clean, userId, tx);
    if (existing) {
      throw new Error("Já existe um cliente com esse CNPJ");
    }
  }

  // Unicidade pelo documento conforme o tipo de pessoa (PF=CPF, PJ=CNPJ).
  private async ensureIdentifierUnique(
    data: CustomerCreate,
    userId: string,
    tx?: Prisma.TransactionClient,
  ) {
    if (data.personType === "PJ") {
      if (data.cnpj) await this.ensureCnpjUnique(data.cnpj, userId, tx);
    } else if (data.cpf) {
      await this.ensureCpfUnique(data.cpf, userId, tx);
    }
  }

  async create(data: CustomerCreate): Promise<Customer> {
    this.assertValidNew(data);
    await this.ensureIdentifierUnique(data, data.userId);
    return this.repo.create({ ...data, name: this.effectiveName(data) });
  }

  // Mesma validação/criação de create(), mas dentro de uma transação Prisma.
  // Usado pelo cadastro rápido (cliente + conta atômicos no Financeiro).
  async createWithTx(
    tx: Prisma.TransactionClient,
    data: CustomerCreate,
  ): Promise<Customer> {
    this.assertValidNew(data);
    await this.ensureIdentifierUnique(data, data.userId, tx);
    return this.repo.create({ ...data, name: this.effectiveName(data) }, tx);
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
    if (data.cnpj) {
      const clean = data.cnpj.replace(/\D/g, "");
      if (clean.length !== 14) throw new Error("CNPJ inválido");
      const existing = await this.repo.findByCnpj(clean, userId);
      if (existing && existing.id !== id) {
        throw new Error("Já existe um cliente com esse CNPJ");
      }
    }
    // PJ sem nome explícito → sincroniza name = razão social (coluna NOT NULL).
    const patch: CustomerUpdate = { ...data };
    if (
      data.personType === "PJ" &&
      (!data.name || !data.name.trim()) &&
      data.razaoSocial
    ) {
      patch.name = data.razaoSocial.trim();
    }
    return this.repo.update(id, userId, patch);
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
