import {
  FinanceEntry,
  FinanceEntryCreate,
  FinanceEntryUpdate,
  FinanceKind,
  FinanceListFilters,
  FinanceListResult,
  FinanceSummary,
} from "../interfaces/finance.interface";
import type { ProductLookup } from "../interfaces/nfe.interface";
import prisma from "../lib/prisma";
import { CustomerRepository } from "../repositories/customer.repository";
import { FinanceRepository } from "../repositories/finance.repository";
import { UnidadeRepository } from "../repositories/unidade.repository";
import { CustomerUseCase } from "./customer.usecase";
import { NfeDraftUseCase } from "./nfe-draft.usecase";

export class FinanceUseCase {
  private repo: FinanceRepository;
  private customerRepo: CustomerRepository;
  private unidadeRepo: UnidadeRepository;
  private customerUseCase: CustomerUseCase;
  private nfeDraftUseCase: NfeDraftUseCase;

  constructor() {
    this.repo = new FinanceRepository();
    this.customerRepo = new CustomerRepository();
    this.unidadeRepo = new UnidadeRepository();
    this.customerUseCase = new CustomerUseCase();
    this.nfeDraftUseCase = new NfeDraftUseCase();
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

  // Validação de itens (Fase 4 — venda balcão). Só roda quando `items` está
  // presente; ausência preserva 100% o fluxo atual. Mensagens contêm
  // "obrigatório"/"inválido" para mapear a 400 no error handler de finance.
  private validateItems(kind: FinanceKind, data: FinanceEntryCreate | FinanceEntryUpdate) {
    const items = (data as any).items;
    if (items === undefined) return; // sem field => fluxo atual
    if (!Array.isArray(items)) {
      throw new Error("Itens inválidos: deve ser uma lista");
    }
    if (kind !== "receivable") {
      // "inválido" mapeia para 400 no buildCreateHandler de finance.routes
      // (mesma convenção do assertUnidade).
      throw new Error(
        "Itens inválidos: somente contas a receber aceitam itens",
      );
    }
    for (const [idx, it] of items.entries()) {
      if (!it || typeof it !== "object") {
        throw new Error(`Item ${idx + 1} inválido`);
      }
      if (!it.productId || typeof it.productId !== "string") {
        throw new Error(`Item ${idx + 1}: produto é obrigatório`);
      }
      if (
        !Number.isInteger(it.quantity) ||
        it.quantity <= 0
      ) {
        // Estrutura "Item N inválido: ..." garante o substring "inválido"
        // (masculino) que o buildCreateHandler casa para mapear a 400.
        throw new Error(
          `Item ${idx + 1} inválido: quantidade deve ser inteiro positivo`,
        );
      }
      if (
        typeof it.unitPrice !== "number" ||
        !Number.isFinite(it.unitPrice) ||
        it.unitPrice < 0
      ) {
        throw new Error(
          `Item ${idx + 1}: preço unitário inválido`,
        );
      }
    }
  }

  async create(
    kind: FinanceKind,
    data: FinanceEntryCreate,
  ): Promise<FinanceEntry> {
    if (!data.userId) throw new Error("Usuário não encontrado");

    // Validação de itens vale para os DOIS fluxos (quick-create e padrão).
    // Quando `items` ausente, é no-op — preserva 100% o fluxo atual.
    this.validateItems(kind, data);

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
    // Validação de itens — no-op quando `items` ausente; preserva fluxo atual.
    this.validateItems(kind, data);
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

  // Lookup de produto para a UI do financeiro (autocompletar por SKU/nome).
  // Reusa exatamente o mesmo lookup do módulo fiscal (NfeDraftUseCase →
  // NfeRepository: name/sku/partNumber contains, take 20) — query única,
  // sem divergência. Desacopla a UI do financeiro do prefixo /fiscal.
  async lookupProducts(userId: string, query: string): Promise<ProductLookup[]> {
    return this.nfeDraftUseCase.lookupProducts(userId, query);
  }

  private applyOverdueFlag(entry: FinanceEntry): FinanceEntry {
    if (entry.status === "PENDENTE" && entry.dueDate < new Date()) {
      return { ...entry, status: "VENCIDA" };
    }
    return entry;
  }
}
