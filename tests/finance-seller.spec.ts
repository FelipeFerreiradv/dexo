// BLOCO B — vendedor da venda.
//
// QUEM VENDEU não é QUEM OPEROU: no balcão o caixa lança a venda do
// balconista, e a comissão é de quem vendeu. Daí a coluna própria.
//
// O que este spec trava, em ordem de gravidade:
//
//  1. FLAG AUSENTE ⇒ nem uma chave a mais no objeto Prisma. A coluna pode não
//     existir no banco ainda (é coluna nova em tabela existente), e uma chave
//     a mais quebraria o INSERT/UPDATE inteiro — não só o vendedor.
//  2. CHAVE AUSENTE NO PUT NÃO É "APAGAR". `undefined` significa "não
//     informado, não mexa"; só `null` limpa. Sem essa distinção, um formulário
//     que não conhece o campo apagaria o vendedor de toda venda que editasse.
//  3. CONTA A PAGAR NUNCA RECEBE O CAMPO. A coluna só existe em Receivable;
//     mandá-la num payable quebraria o update.

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
    receivableEvent: { create: vi.fn(), findMany: vi.fn() },
    customer: {
      findFirst: vi.fn().mockResolvedValue({ id: "c-1", name: "Cliente" }),
      create: vi.fn(),
    },
    unidade: { findFirst: vi.fn() },
    user: { findUnique: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
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
    request.user = { id: "u-op", name: "Caixa", dataOwnerId: "user-owner" };
  },
}));

import prisma from "../app/lib/prisma";
import { financeRoutes } from "../app/routes/finance.routes";
import {
  NO_SELLER,
  normalizeSellerId,
  sellerLabel,
  sellerSelectValueToId,
} from "../app/financeiro/lib/sale-seller";

const OWNER = "owner@test.com";
const ORIG = process.env.SALE_SELLER_ENABLED;

function buildApp() {
  const app = fastify();
  app.register(financeRoutes, { prefix: "/finance" });
  return app;
}

const CORPO_BASE = {
  customerId: "c-1",
  totalAmount: 100,
  dueDate: "2026-09-01",
};

/** Cria uma conta e devolve o `data` que foi ao create do Prisma. */
async function criar(
  kind: "receivables" | "payables",
  extra: Record<string, unknown> = {},
) {
  const app = buildApp();
  const res = await app.inject({
    method: "POST",
    url: `/finance/${kind}`,
    headers: { email: OWNER },
    payload: { ...CORPO_BASE, ...extra },
  });
  const delegate =
    kind === "receivables"
      ? (prisma as any).receivable
      : (prisma as any).payable;
  return { res, data: delegate.create.mock.calls[0]?.[0]?.data };
}

/** Edita uma conta e devolve o `data` do updateMany. */
async function editar(
  kind: "receivables" | "payables",
  body: Record<string, unknown>,
) {
  const app = buildApp();
  const res = await app.inject({
    method: "PUT",
    url: `/finance/${kind}/r-1`,
    headers: { email: OWNER },
    payload: body,
  });
  const delegate =
    kind === "receivables"
      ? (prisma as any).receivable
      : (prisma as any).payable;
  return { res, data: delegate.updateMany.mock.calls[0]?.[0]?.data };
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
  delete process.env.SALE_SELLER_ENABLED;
});

afterAll(() => {
  if (ORIG === undefined) delete process.env.SALE_SELLER_ENABLED;
  else process.env.SALE_SELLER_ENABLED = ORIG;
});

describe("Flag desligada — nem uma chave a mais", () => {
  it("criar COM vendedor no body: a chave não chega ao Prisma", async () => {
    // A coluna pode nem existir no banco ainda. Uma chave a mais aqui não
    // deixaria o vendedor de fora — quebraria o INSERT inteiro.
    const { res, data } = await criar("receivables", {
      sellerUserId: "u-vendedor",
    });
    expect(res.statusCode).toBe(201);
    expect("sellerUserId" in data).toBe(false);
  });

  it("editar COM vendedor no body: a chave não chega ao Prisma", async () => {
    const { res, data } = await editar("receivables", {
      sellerUserId: "u-vendedor",
    });
    expect(res.statusCode).toBe(200);
    expect("sellerUserId" in data).toBe(false);
  });
});

describe("Flag ligada", () => {
  beforeEach(() => {
    process.env.SALE_SELLER_ENABLED = "1";
  });

  it("criar grava o vendedor", async () => {
    const { res, data } = await criar("receivables", {
      sellerUserId: "u-vendedor",
    });
    expect(res.statusCode).toBe(201);
    expect(data.sellerUserId).toBe("u-vendedor");
  });

  it("criar SEM vendedor não acrescenta a chave", async () => {
    const { data } = await criar("receivables");
    expect("sellerUserId" in data).toBe(false);
  });

  it("editar trocando o vendedor grava o novo", async () => {
    const { data } = await editar("receivables", {
      sellerUserId: "u-outro",
    });
    expect(data.sellerUserId).toBe("u-outro");
  });

  it("PUT SEM a chave NÃO apaga o vendedor", async () => {
    // É o caso real: formulário antigo, ou edição de um campo qualquer que não
    // conhece o vendedor. `undefined` é "não mexa", não "limpe".
    const { data } = await editar("receivables", { document: "NF 123" });
    expect("sellerUserId" in data).toBe(false);
  });

  it("null LIMPA o vendedor — é a única forma de desatribuir", async () => {
    const { data } = await editar("receivables", { sellerUserId: null });
    expect(data.sellerUserId).toBeNull();
  });

  it("CONTA A PAGAR nunca recebe o campo (a coluna não existe lá)", async () => {
    const criado = await criar("payables", { sellerUserId: "u-vendedor" });
    expect("sellerUserId" in criado.data).toBe(false);
    vi.clearAllMocks();
    (prisma as any).payable.updateMany.mockResolvedValue({ count: 1 });
    (prisma as any).payable.findUnique.mockResolvedValue({ id: "p-1" });
    const editado = await editar("payables", { sellerUserId: "u-vendedor" });
    expect("sellerUserId" in (editado.data ?? {})).toBe(false);
  });

  it("id com formato inválido é descartado, a venda continua", async () => {
    // Nunca gravar lixo numa coluna de onde sai comissão — mas o descarte é
    // silencioso: o vendedor é opcional e não pode impedir uma venda.
    const { res, data } = await criar("receivables", {
      sellerUserId: "../../admin",
    });
    expect(res.statusCode).toBe(201);
    expect("sellerUserId" in data).toBe(false);
  });
});

describe("normalizeSellerId — a fronteira", () => {
  const ON = { SALE_SELLER_ENABLED: "1" };

  it("flag ausente ⇒ undefined, mesmo com id válido", () => {
    expect(normalizeSellerId("u-1", {})).toBeUndefined();
  });

  it("só a string exata '1' liga", () => {
    expect(
      normalizeSellerId("u-1", { SALE_SELLER_ENABLED: "true" }),
    ).toBeUndefined();
  });

  it("distingue AUSENTE de LIMPAR — é o que protege o vendedor gravado", () => {
    expect(normalizeSellerId(undefined, ON)).toBeUndefined();
    expect(normalizeSellerId(null, ON)).toBeNull();
    expect(normalizeSellerId("", ON)).toBeNull();
    expect(normalizeSellerId("   ", ON)).toBeNull();
  });

  it("recusa o que não parece um id", () => {
    expect(normalizeSellerId("../x", ON)).toBeUndefined();
    expect(normalizeSellerId("a b", ON)).toBeUndefined();
    expect(normalizeSellerId("a".repeat(65), ON)).toBeUndefined();
    expect(normalizeSellerId(42, ON)).toBeUndefined();
    expect(normalizeSellerId({ id: "u-1" }, ON)).toBeUndefined();
  });

  it("aceita id de verdade, aparado", () => {
    expect(normalizeSellerId(" cm3x9k2p10000abcd ", ON)).toBe(
      "cm3x9k2p10000abcd",
    );
  });
});

describe("Exibição e sentinela", () => {
  it("nome quando existe; e-mail como recurso; '—' quando não há nada", () => {
    // Colaborador recém-convidado pode ainda não ter nome, e vazio faria a
    // lista parecer quebrada.
    expect(sellerLabel({ id: "u", name: "Maria", email: "m@x.com" })).toBe(
      "Maria",
    );
    expect(sellerLabel({ id: "u", name: "  ", email: "m@x.com" })).toBe(
      "m@x.com",
    );
    expect(sellerLabel({ id: "u", name: null, email: null })).toBe("—");
    expect(sellerLabel(null)).toBe("—");
  });

  it("'sem vendedor' vira null, nunca a palavra literal", () => {
    expect(sellerSelectValueToId(NO_SELLER)).toBeNull();
    expect(sellerSelectValueToId("")).toBeNull();
    expect(sellerSelectValueToId("u-1")).toBe("u-1");
  });
});
