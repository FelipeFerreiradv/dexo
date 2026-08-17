// BLOCO E — o que ainda pode ser editado depois que a venda foi recebida.
//
// Este é o ÚNICO ponto do projeto em que algo deixa de ser possível, então o
// spec precisa provar as duas metades:
//
//  A. FLAG AUSENTE ⇒ o PUT se comporta EXATAMENTE como hoje, inclusive
//     editando itens de venda paga. É o que garante que nenhum fluxo vivo
//     quebra no deploy — a restrição liga depois, com `pm2 restart`.
//  B. FLAG LIGADA ⇒ venda PAGA recusa itens, valor total, formas e
//     parcelamento com 409 e uma mensagem que diz O QUE FAZER; e continua
//     aceitando documento, cliente, vencimento, encargos e vendedor.
//
// E a terceira coisa, que não é sobre a guarda e vale com a flag desligada:
// o replace de itens PRESERVA `autoCreatedProduct`. Sem essa marca o estorno
// deixa um produto fantasma com estoque positivo de peça que já saiu.

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
    create: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
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
    customer: { findFirst: vi.fn(), create: vi.fn() },
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
import {
  PROTECTED_WHEN_PAID,
  blockedFieldsOnPaidSale,
  isSaleEditGuardEnabled,
  saleEditGuardMessage,
  touchesProtectedFields,
} from "../app/financeiro/lib/sale-edit-guard";

const OWNER = "owner@test.com";
const ORIG = process.env.SALE_EDIT_GUARD_ENABLED;

function buildApp() {
  const app = fastify();
  app.register(financeRoutes, { prefix: "/finance" });
  return app;
}

function conta(status: string, over: Record<string, unknown> = {}) {
  return {
    id: "r-1",
    userId: "user-owner",
    customerId: "c-1",
    unidadeId: null,
    document: null,
    reason: null,
    debtDetails: null,
    totalAmount: "100.00",
    fineAmount: null,
    finePercent: null,
    interestPercent: null,
    toleranceDays: null,
    installments: 1,
    periodDays: null,
    dueDate: new Date("2026-06-01"),
    status,
    paidAt: status === "PAGA" ? new Date("2026-05-22") : null,
    createdAt: new Date(),
    updatedAt: new Date(),
    customer: { id: "c-1", name: "Cliente", cpf: null, email: null },
    unidade: null,
    items: [
      {
        id: "ri-1",
        productId: "p-1",
        listingId: null,
        quantity: 2,
        unitPrice: "50.00",
        createdAt: new Date(),
        product: { id: "p-1", sku: "SKU-1", name: "Produto" },
      },
    ],
    ...over,
  };
}

async function put(status: string, payload: Record<string, unknown>) {
  (prisma as any).receivable.findFirst.mockResolvedValue(conta(status));
  (prisma as any).receivable.findUnique.mockResolvedValue(conta(status));
  const app = buildApp();
  const res = await app.inject({
    method: "PUT",
    url: "/finance/receivables/r-1",
    headers: { email: OWNER, "content-type": "application/json" },
    payload,
  });
  return { res, body: res.json() };
}

beforeEach(() => {
  vi.clearAllMocks();
  (prisma as any).$transaction.mockImplementation(async (cb: any) =>
    cb(prisma),
  );
  (prisma as any).receivable.updateMany.mockResolvedValue({ count: 1 });
  (prisma as any).receivableItem.findMany.mockResolvedValue([]);
  delete process.env.SALE_EDIT_GUARD_ENABLED;
});

afterAll(() => {
  if (ORIG === undefined) delete process.env.SALE_EDIT_GUARD_ENABLED;
  else process.env.SALE_EDIT_GUARD_ENABLED = ORIG;
});

describe("Flag desligada — o PUT se comporta como hoje", () => {
  it("editar ITENS de venda PAGA continua passando (comportamento atual)", async () => {
    // Não é o comportamento que queremos; é o que existe. A guarda é a única
    // restrição do projeto, e ela nasce desligada para o deploy não quebrar
    // nenhum fluxo vivo.
    const { res } = await put("PAGA", {
      items: [{ productId: "p-2", quantity: 3, unitPrice: 30 }],
    });
    expect(res.statusCode).toBe(200);
    expect((prisma as any).receivableItem.deleteMany).toHaveBeenCalled();
  });

  it("com a flag desligada nem LÊ a conta para decidir", async () => {
    // Editar o documento não pode custar uma consulta a mais por causa de uma
    // guarda que está desligada.
    await put("PENDENTE", { document: "NF 1" });
    expect((prisma as any).receivable.findFirst).not.toHaveBeenCalled();
  });
});

describe("Flag ligada — venda PAGA recusa o que mexe em estoque e dinheiro", () => {
  beforeEach(() => {
    process.env.SALE_EDIT_GUARD_ENABLED = "1";
  });

  it("itens ⇒ 409 e NADA é escrito", async () => {
    const { res, body } = await put("PAGA", {
      items: [{ productId: "p-2", quantity: 3, unitPrice: 30 }],
    });
    expect(res.statusCode).toBe(409);
    expect((prisma as any).receivableItem.deleteMany).not.toHaveBeenCalled();
    expect((prisma as any).receivable.updateMany).not.toHaveBeenCalled();
  });

  it("items: [] — a remoção total é o caso mais destrutivo, e também é barrada", async () => {
    // É exatamente o que o DELETE já recusa com 409 "Use Estornar".
    const { res } = await put("PAGA", { items: [] });
    expect(res.statusCode).toBe(409);
    expect((prisma as any).receivableItem.deleteMany).not.toHaveBeenCalled();
  });

  it("totalAmount ⇒ 409 (reescreveria o caixa sem contrapartida)", async () => {
    const { res } = await put("PAGA", { totalAmount: 999 });
    expect(res.statusCode).toBe(409);
  });

  it("a mensagem diz O QUE FAZER, não só que não pode", async () => {
    const { body } = await put("PAGA", { items: [], totalAmount: 1 });
    expect(body.error).toContain("Estornar");
    expect(body.error).toContain("itens");
    expect(body.error).toContain("valor total");
    // E diz o que continua possível — senão o operador acha que travou tudo.
    expect(body.error).toContain("editáveis");
  });

  it("campos inofensivos de venda PAGA continuam editáveis", async () => {
    // Corrigir o número de um documento não pode exigir estornar a venda.
    const { res } = await put("PAGA", {
      document: "NF 123",
      reason: "Venda balcão",
      dueDate: "2026-07-01",
    });
    expect(res.statusCode).toBe(200);
    expect((prisma as any).receivable.updateMany).toHaveBeenCalled();
  });

  it("PENDENTE e VENCIDA seguem 100% editáveis — é o 'antes da baixa'", async () => {
    for (const st of ["PENDENTE", "VENCIDA"]) {
      vi.clearAllMocks();
      (prisma as any).receivable.updateMany.mockResolvedValue({ count: 1 });
      (prisma as any).receivableItem.findMany.mockResolvedValue([]);
      const { res } = await put(st, {
        items: [{ productId: "p-2", quantity: 3, unitPrice: 30 }],
      });
      expect(res.statusCode, `status ${st}`).toBe(200);
    }
  });

  it("CANCELADA não bloqueia: o estoque já voltou", async () => {
    const { res } = await put("CANCELADA", { items: [] });
    expect(res.statusCode).toBe(200);
  });
});

describe("O replace PRESERVA a marca da peça avulsa", () => {
  it("item que era autoCreatedProduct volta com a marca", async () => {
    // Sem isto, o `reverse` seguinte devolve +qty sem a saída compensatória e
    // sobra um produto fantasma com estoque de peça que já saiu da loja.
    // O fixture diz EXPLICITAMENTE que a linha era auto-criada. Antes ele
    // dependia de o `where` da consulta já ter filtrado — acoplamento ao
    // "como", não ao "o quê". Com o BLOCO G a mesma leitura passou a servir
    // também à reserva (precisa de TODAS as linhas), então o filtro virou JS
    // e o fixture ficou explícito. A asserção abaixo é a mesma.
    (prisma as any).receivableItem.findMany.mockResolvedValue([
      { productId: "p-1", autoCreatedProduct: true },
    ]);
    await put("PENDENTE", {
      items: [{ productId: "p-1", quantity: 2, unitPrice: 50 }],
    });
    const data = (prisma as any).receivableItem.createMany.mock.calls[0][0]
      .data;
    expect(data[0].autoCreatedProduct).toBe(true);
  });

  it("item comum NÃO ganha a chave — o objeto sai byte-idêntico ao de antes", async () => {
    (prisma as any).receivableItem.findMany.mockResolvedValue([]);
    await put("PENDENTE", {
      items: [{ productId: "p-2", quantity: 1, unitPrice: 10 }],
    });
    const data = (prisma as any).receivableItem.createMany.mock.calls[0][0]
      .data;
    expect("autoCreatedProduct" in data[0]).toBe(false);
  });

  it("a marca segue o PRODUTO, não a posição na lista", async () => {
    // O operador pode reordenar ou acrescentar itens; o que identifica a peça
    // promovida é o produto.
    (prisma as any).receivableItem.findMany.mockResolvedValue([
      { productId: "p-9", autoCreatedProduct: true },
    ]);
    await put("PENDENTE", {
      items: [
        { productId: "p-2", quantity: 1, unitPrice: 10 },
        { productId: "p-9", quantity: 1, unitPrice: 20 },
      ],
    });
    const data = (prisma as any).receivableItem.createMany.mock.calls[0][0]
      .data;
    expect("autoCreatedProduct" in data[0]).toBe(false);
    expect(data[1].autoCreatedProduct).toBe(true);
  });
});

describe("Tabela pura da guarda", () => {
  const ON = { SALE_EDIT_GUARD_ENABLED: "1" };

  it("flag ausente ⇒ nunca bloqueia", () => {
    expect(isSaleEditGuardEnabled({})).toBe(false);
    expect(blockedFieldsOnPaidSale({ items: [] }, "PAGA", {})).toEqual([]);
  });

  it("só a string exata '1' liga", () => {
    expect(isSaleEditGuardEnabled({ SALE_EDIT_GUARD_ENABLED: "true" })).toBe(
      false,
    );
  });

  it("bloqueia exatamente os quatro campos, e só em PAGA", () => {
    const tudo = {
      items: [],
      totalAmount: 1,
      payments: [],
      installmentPlan: {},
    };
    expect(blockedFieldsOnPaidSale(tudo, "PAGA", ON)).toEqual([
      ...PROTECTED_WHEN_PAID,
    ]);
    for (const st of ["PENDENTE", "VENCIDA", "CANCELADA", null, undefined]) {
      expect(blockedFieldsOnPaidSale(tudo, st as any, ON)).toEqual([]);
    }
  });

  it("CHAVE PRESENTE conta, mesmo valendo null ou vazio", () => {
    // `items: []` é a remoção total — o caso mais destrutivo. Testar por valor
    // truthy deixaria justamente ele passar.
    expect(blockedFieldsOnPaidSale({ items: [] }, "PAGA", ON)).toEqual([
      "items",
    ]);
    expect(blockedFieldsOnPaidSale({ totalAmount: 0 }, "PAGA", ON)).toEqual([
      "totalAmount",
    ]);
    expect(blockedFieldsOnPaidSale({ payments: null }, "PAGA", ON)).toEqual([
      "payments",
    ]);
  });

  it("payload sem campo vigiado não dispara leitura nem bloqueio", () => {
    expect(touchesProtectedFields({ document: "x", reason: "y" })).toBe(false);
    expect(touchesProtectedFields({ items: [] })).toBe(true);
    expect(touchesProtectedFields(null)).toBe(false);
    expect(touchesProtectedFields(undefined)).toBe(false);
  });

  it("a mensagem lista os campos em português, com 'e' antes do último", () => {
    expect(saleEditGuardMessage(["items"])).toContain("alterar itens.");
    expect(saleEditGuardMessage(["items", "totalAmount"])).toContain(
      "itens e valor total",
    );
    expect(
      saleEditGuardMessage(["items", "totalAmount", "payments"]),
    ).toContain("itens, valor total e formas de pagamento");
  });
});
