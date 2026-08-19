// BLOCO A — conta bancária / caixa: onde o dinheiro entra e de onde sai.
//
// O que este spec trava, em ordem de gravidade:
//
//  1. FLAG AUSENTE ⇒ nem uma chave a mais no objeto Prisma. São TRÊS colunas
//     novas em tabelas existentes (Receivable, Payable, ReceivablePayment) —
//     uma chave a mais contra um banco sem elas quebra o INSERT inteiro, não
//     só o vínculo da conta.
//  2. CHAVE AUSENTE NO PUT NÃO É "APAGAR". `undefined` = "não informado, não
//     mexa"; só `null` limpa. Sem isso, um formulário que não conhece o campo
//     apagaria a conta de todo lançamento que editasse.
//  3. VALE PARA OS DOIS KINDS. Ao contrário do vendedor, a coluna existe em
//     Receivable E em Payable — sem a saída, o saldo por conta só cresceria.
//  4. A PRECEDÊNCIA linha → conta, que é o que faz o campo servir às 77 vendas
//     de forma única (medido: só 5 das 82 têm linhas de pagamento).

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import fastify from "fastify";

vi.mock("../app/marketplaces/services/stock-deduction.service", () => ({
  StockDeductionService: {
    deductWithinTx: vi
      .fn()
      .mockResolvedValue({ deductions: [], oversellAlerts: [] }),
    restoreWithinTx: vi.fn(),
    firePostEffects: vi.fn(),
  },
}));
vi.mock("@/app/marketplaces/services/stock-deduction.service", () => ({
  StockDeductionService: {
    deductWithinTx: vi
      .fn()
      .mockResolvedValue({ deductions: [], oversellAlerts: [] }),
    restoreWithinTx: vi.fn(),
    firePostEffects: vi.fn(),
  },
}));

function makePrisma() {
  const fmodel = () => ({
    findMany: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
    create: vi.fn().mockResolvedValue({ id: "r-1" }),
    findUnique: vi.fn().mockResolvedValue({ id: "r-1" }),
    findFirst: vi.fn().mockResolvedValue({ id: "r-1" }),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    update: vi.fn().mockResolvedValue({ id: "b-1" }),
    deleteMany: vi.fn(),
    createMany: vi.fn(),
    groupBy: vi.fn().mockResolvedValue([]),
    aggregate: vi
      .fn()
      .mockResolvedValue({ _sum: { totalAmount: null }, _count: 0 }),
  });
  const prisma: any = {
    receivable: fmodel(),
    payable: fmodel(),
    receivableItem: fmodel(),
    receivablePayment: fmodel(),
    receivableEvent: { create: vi.fn(), findMany: vi.fn() },
    bankAccount: fmodel(),
    customer: {
      findFirst: vi.fn().mockResolvedValue({ id: "c-1", name: "Cliente" }),
      create: vi.fn(),
    },
    unidade: { findFirst: vi.fn() },
    product: fmodel(),
  };
  prisma.$transaction = vi.fn(async (cb: any) => cb(prisma));
  return prisma;
}

vi.mock("../app/lib/prisma", () => ({ default: makePrisma() }));
vi.mock("@/app/lib/prisma", () => ({ default: makePrisma() }));

vi.mock("../app/middlewares/auth.middleware", () => ({
  authMiddleware: async (request: any, reply: any) => {
    const email = request.headers["email"];
    if (!email) return reply.status(401).send({ message: "Email is required" });
    request.user = { id: "u-op", name: "Operador", dataOwnerId: "user-owner" };
  },
}));

import prisma from "../app/lib/prisma";
import { financeRoutes } from "../app/routes/finance.routes";
import { bankAccountRoutes } from "../app/routes/bank-account.routes";
import {
  NO_BANK_ACCOUNT,
  bankAccountKindLabel,
  bankAccountLabel,
  bankAccountSelectValueToId,
  effectiveBankAccountId,
  isBankAccountsEnabled,
  normalizeBankAccountId,
} from "../app/financeiro/lib/bank-accounts";

const OWNER = "owner@test.com";
const ORIG = process.env.BANK_ACCOUNTS_ENABLED;

function buildFinance() {
  const app = fastify();
  app.register(financeRoutes, { prefix: "/finance" });
  return app;
}
function buildContas() {
  const app = fastify();
  app.register(bankAccountRoutes, { prefix: "/bank-accounts" });
  return app;
}

const BASE = { customerId: "c-1", totalAmount: 100, dueDate: "2026-09-01" };

async function criar(
  kind: "receivables" | "payables",
  extra: Record<string, unknown> = {},
) {
  const app = buildFinance();
  const res = await app.inject({
    method: "POST",
    url: `/finance/${kind}`,
    headers: { email: OWNER },
    payload: { ...BASE, ...extra },
  });
  const d =
    kind === "receivables"
      ? (prisma as any).receivable
      : (prisma as any).payable;
  return { res, data: d.create.mock.calls[0]?.[0]?.data };
}

async function editar(
  kind: "receivables" | "payables",
  body: Record<string, unknown>,
) {
  const app = buildFinance();
  const res = await app.inject({
    method: "PUT",
    url: `/finance/${kind}/r-1`,
    headers: { email: OWNER },
    payload: body,
  });
  const d =
    kind === "receivables"
      ? (prisma as any).receivable
      : (prisma as any).payable;
  return { res, data: d.updateMany.mock.calls[0]?.[0]?.data };
}

beforeEach(() => {
  vi.clearAllMocks();
  (prisma as any).$transaction.mockImplementation(async (cb: any) =>
    cb(prisma),
  );
  (prisma as any).customer.findFirst.mockResolvedValue({
    id: "c-1",
    name: "Cliente",
  });
  (prisma as any).receivable.create.mockResolvedValue({ id: "r-1" });
  (prisma as any).payable.create.mockResolvedValue({ id: "p-1" });
  (prisma as any).receivable.findUnique.mockResolvedValue({ id: "r-1" });
  (prisma as any).payable.findUnique.mockResolvedValue({ id: "p-1" });
  delete process.env.BANK_ACCOUNTS_ENABLED;
});

afterAll(() => {
  if (ORIG === undefined) delete process.env.BANK_ACCOUNTS_ENABLED;
  else process.env.BANK_ACCOUNTS_ENABLED = ORIG;
});

describe("Flag desligada — nem uma chave a mais", () => {
  it("criar COM conta no body: a chave não chega ao Prisma", async () => {
    const { res, data } = await criar("receivables", { bankAccountId: "b-1" });
    expect(res.statusCode).toBe(201);
    expect("bankAccountId" in data).toBe(false);
  });

  it("editar COM conta no body: a chave não chega ao Prisma", async () => {
    const { res, data } = await editar("receivables", { bankAccountId: "b-1" });
    expect(res.statusCode).toBe(200);
    expect("bankAccountId" in data).toBe(false);
  });

  it("a listagem de contas devolve VAZIO, não erro", async () => {
    // Quem chama é um seletor: lista vazia o faz sumir sozinho. Erro faria a
    // tela mostrar falha por um recurso que apenas não está ligado.
    const app = buildContas();
    const res = await app.inject({
      method: "GET",
      url: "/bank-accounts",
      headers: { email: OWNER },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ accounts: [], total: 0 });
  });

  it("criar conta responde 403 — escrita não pode passar", async () => {
    const app = buildContas();
    const res = await app.inject({
      method: "POST",
      url: "/bank-accounts",
      headers: { email: OWNER },
      payload: { name: "Itaú" },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("Flag ligada — os DOIS kinds", () => {
  beforeEach(() => {
    process.env.BANK_ACCOUNTS_ENABLED = "1";
  });

  it("conta a RECEBER grava o destino", async () => {
    const { res, data } = await criar("receivables", { bankAccountId: "b-1" });
    expect(res.statusCode).toBe(201);
    expect(data.bankAccountId).toBe("b-1");
  });

  it("conta a PAGAR grava a origem — sem ela o saldo só cresceria", async () => {
    const { res, data } = await criar("payables", { bankAccountId: "b-2" });
    expect(res.statusCode).toBe(201);
    expect(data.bankAccountId).toBe("b-2");
  });

  it("editar troca a conta nos dois kinds", async () => {
    expect(
      (await editar("receivables", { bankAccountId: "b-9" })).data
        .bankAccountId,
    ).toBe("b-9");
    vi.clearAllMocks();
    (prisma as any).payable.updateMany.mockResolvedValue({ count: 1 });
    (prisma as any).payable.findUnique.mockResolvedValue({ id: "p-1" });
    expect(
      (await editar("payables", { bankAccountId: "b-9" })).data.bankAccountId,
    ).toBe("b-9");
  });

  it("PUT SEM a chave NÃO apaga a conta", async () => {
    const { data } = await editar("receivables", { document: "NF 1" });
    expect("bankAccountId" in data).toBe(false);
  });

  it("null LIMPA — é a única forma de desvincular", async () => {
    const { data } = await editar("receivables", { bankAccountId: null });
    expect(data.bankAccountId).toBeNull();
  });

  it("id com formato inválido é descartado, o lançamento continua", async () => {
    const { res, data } = await criar("receivables", {
      bankAccountId: "../../admin",
    });
    expect(res.statusCode).toBe(201);
    expect("bankAccountId" in data).toBe(false);
  });

  it("criar SEM conta não acrescenta a chave", async () => {
    const { data } = await criar("receivables");
    expect("bankAccountId" in data).toBe(false);
  });
});

describe("normalizeBankAccountId — a fronteira", () => {
  const ON = { BANK_ACCOUNTS_ENABLED: "1" };

  it("flag ausente ⇒ undefined mesmo com id válido", () => {
    expect(normalizeBankAccountId("b-1", {})).toBeUndefined();
    expect(isBankAccountsEnabled({})).toBe(false);
  });

  it("só a string exata '1' liga", () => {
    expect(
      normalizeBankAccountId("b-1", { BANK_ACCOUNTS_ENABLED: "true" }),
    ).toBeUndefined();
  });

  it("distingue AUSENTE de LIMPAR", () => {
    expect(normalizeBankAccountId(undefined, ON)).toBeUndefined();
    expect(normalizeBankAccountId(null, ON)).toBeNull();
    expect(normalizeBankAccountId("", ON)).toBeNull();
    expect(normalizeBankAccountId("   ", ON)).toBeNull();
  });

  it("recusa o que não parece um id", () => {
    expect(normalizeBankAccountId("../x", ON)).toBeUndefined();
    expect(normalizeBankAccountId("a b", ON)).toBeUndefined();
    expect(normalizeBankAccountId("a".repeat(65), ON)).toBeUndefined();
    expect(normalizeBankAccountId(42, ON)).toBeUndefined();
  });
});

describe("Precedência linha → conta", () => {
  it("a linha manda quando preenchida", () => {
    // "O PIX caiu no Itaú, o dinheiro ficou no caixa."
    expect(effectiveBankAccountId("b-linha", "b-conta")).toBe("b-linha");
  });

  it("sem linha, vale o da conta — é o que serve às 77 vendas sem linhas", () => {
    expect(effectiveBankAccountId(null, "b-conta")).toBe("b-conta");
    expect(effectiveBankAccountId(undefined, "b-conta")).toBe("b-conta");
  });

  it("nenhum dos dois ⇒ null", () => {
    expect(effectiveBankAccountId(null, null)).toBeNull();
    expect(effectiveBankAccountId(undefined, undefined)).toBeNull();
  });
});

describe("Exibição e sentinela", () => {
  it("o banco entra entre parênteses só quando acrescenta informação", () => {
    expect(
      bankAccountLabel({ id: "b", name: "Conta principal", bankName: "Itaú" }),
    ).toBe("Conta principal (Itaú)");
    // "Itaú da loja" já diz o banco — repetir seria ruído.
    expect(
      bankAccountLabel({ id: "b", name: "Itaú da loja", bankName: "Itaú" }),
    ).toBe("Itaú da loja");
    expect(bankAccountLabel({ id: "b", name: "Caixa", bankName: null })).toBe(
      "Caixa",
    );
    expect(bankAccountLabel(null)).toBe("—");
  });

  it("tipo desconhecido volta cru; ausente cai no padrão", () => {
    expect(bankAccountKindLabel("CAIXA")).toBe("Caixa / dinheiro");
    expect(bankAccountKindLabel("FUTURO")).toBe("FUTURO");
    expect(bankAccountKindLabel("toString")).toBe("toString");
    expect(bankAccountKindLabel(null)).toBe("Conta bancária");
  });

  it("'não informar' vira null, nunca a palavra literal", () => {
    expect(bankAccountSelectValueToId(NO_BANK_ACCOUNT)).toBeNull();
    expect(bankAccountSelectValueToId("")).toBeNull();
    expect(bankAccountSelectValueToId("b-1")).toBe("b-1");
  });
});
