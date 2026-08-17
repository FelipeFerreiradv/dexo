import prisma from "../lib/prisma";
import {
  BANK_ACCOUNT_KINDS,
  DEFAULT_BANK_ACCOUNT_KIND,
} from "../financeiro/lib/bank-accounts";

// BLOCO A — CRUD de contas bancárias / caixas.
//
// Espelha `UnidadeUseCase`, que é o precedente da casa para entidade de
// configuração do tenant. As duas diferenças, e ambas têm motivo:
//
//  1. DESATIVAR, NUNCA EXCLUIR. A conta é referenciada por lançamentos
//     históricos; apagá-la responderia "de onde saiu esse dinheiro?" com
//     silêncio. Não existe método de delete aqui, de propósito.
//  2. `isDefault` é EXCLUSIVO por usuário, e a garantia final é um UNIQUE
//     PARCIAL no banco (ver o DDL). O código desmarca a anterior numa
//     transação; o índice é o que impede duas telas simultâneas de deixarem
//     duas contas padrão.

export interface BankAccountRow {
  id: string;
  userId: string;
  name: string;
  bankName: string | null;
  agency: string | null;
  accountNumber: string | null;
  kind: string;
  isDefault: boolean;
  isActive: boolean;
}

export interface BankAccountCreate {
  userId: string;
  name?: string;
  bankName?: string | null;
  agency?: string | null;
  accountNumber?: string | null;
  kind?: string;
  isDefault?: boolean;
}

export type BankAccountUpdate = Omit<Partial<BankAccountCreate>, "userId"> & {
  isActive?: boolean;
};

const KIND_CODES = new Set(BANK_ACCOUNT_KINDS.map((k) => k.code));

function limparTexto(v: string | null | undefined): string | null {
  const t = typeof v === "string" ? v.trim() : "";
  return t ? t : null;
}

export class BankAccountUseCase {
  async list(userId: string, includeInactive: boolean) {
    if (!userId) throw new Error("Usuário não encontrado");
    const accounts = await (prisma as any).bankAccount.findMany({
      where: { userId, ...(includeInactive ? {} : { isActive: true }) },
      // Padrão primeiro, depois alfabética: o seletor abre na resposta mais
      // provável sem o operador precisar procurar.
      orderBy: [{ isDefault: "desc" }, { name: "asc" }],
    });
    return { accounts, total: accounts.length };
  }

  async findById(id: string, userId: string): Promise<BankAccountRow> {
    const c = await (prisma as any).bankAccount.findFirst({
      where: { id, userId },
    });
    if (!c) throw new Error("Conta não encontrada");
    return c;
  }

  async create(data: BankAccountCreate): Promise<BankAccountRow> {
    if (!data.userId) throw new Error("Usuário não encontrado");
    const name = limparTexto(data.name);
    if (!name || name.length < 2) throw new Error("Nome é obrigatório");

    const kind =
      data.kind && KIND_CODES.has(data.kind)
        ? data.kind
        : DEFAULT_BANK_ACCOUNT_KIND;

    return this.comDefaultExclusivo(
      data.userId,
      data.isDefault === true,
      (tx) =>
        tx.bankAccount.create({
          data: {
            userId: data.userId,
            name,
            bankName: limparTexto(data.bankName),
            agency: limparTexto(data.agency),
            accountNumber: limparTexto(data.accountNumber),
            kind,
            isDefault: data.isDefault === true,
            isActive: true,
          },
        }),
    );
  }

  async update(
    id: string,
    userId: string,
    data: BankAccountUpdate,
  ): Promise<BankAccountRow> {
    const atual = await this.findById(id, userId);

    if (data.name !== undefined) {
      const n = limparTexto(data.name);
      if (!n || n.length < 2) throw new Error("Nome é obrigatório");
    }
    if (data.kind !== undefined && !KIND_CODES.has(data.kind)) {
      throw new Error("Tipo de conta inválido");
    }

    // Desativar a conta PADRÃO deixaria o tenant sugerindo uma conta que sumiu
    // do seletor. Tira o padrão junto — sem isso o formulário abriria
    // pré-preenchido com uma conta que o operador não consegue escolher.
    const perdeDefault = data.isActive === false && atual.isDefault;

    const patch: Record<string, unknown> = {};
    if (data.name !== undefined) patch.name = limparTexto(data.name);
    if (data.bankName !== undefined)
      patch.bankName = limparTexto(data.bankName);
    if (data.agency !== undefined) patch.agency = limparTexto(data.agency);
    if (data.accountNumber !== undefined)
      patch.accountNumber = limparTexto(data.accountNumber);
    if (data.kind !== undefined) patch.kind = data.kind;
    if (data.isActive !== undefined) patch.isActive = data.isActive;
    if (data.isDefault !== undefined) patch.isDefault = data.isDefault === true;
    if (perdeDefault) patch.isDefault = false;

    const viraDefault = patch.isDefault === true;
    return this.comDefaultExclusivo(userId, viraDefault, (tx) =>
      tx.bankAccount.update({ where: { id }, data: patch }),
    );
  }

  /**
   * Roda a escrita garantindo "no máximo uma conta padrão por usuário".
   *
   * Quando a operação MARCA um padrão, desmarca as outras na MESMA transação —
   * senão o UNIQUE PARCIAL do banco recusaria a escrita e o operador levaria um
   * erro por ter feito exatamente o que a tela oferecia.
   */
  private async comDefaultExclusivo<T>(
    userId: string,
    viraDefault: boolean,
    escrita: (tx: any) => Promise<T>,
  ): Promise<T> {
    if (!viraDefault) return escrita(prisma as any);
    return (prisma as any).$transaction(async (tx: any) => {
      await tx.bankAccount.updateMany({
        where: { userId, isDefault: true },
        data: { isDefault: false },
      });
      return escrita(tx);
    });
  }
}
