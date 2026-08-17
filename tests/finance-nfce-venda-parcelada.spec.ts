// Bugs E e F — venda PARCELADA e o caminho fiscal.
//
// Numa venda parcelada, `createWithSplit` deixa TODOS os itens na conta-mãe e
// grava em `totalAmount` apenas a ENTRADA; o saldo vive nas contas-filhas.
// Dois pontos do caminho fiscal liam só a mãe:
//
//   F) O guard do limite da NFC-e comparava a ENTRADA. Venda de R$ 12.000 com
//      entrada de R$ 3.000 passava por aqui e só era barrada na emissão, pelo
//      total dos ITENS — erro tardio em vez de roteamento para a NF-e 55.
//      (A proteção fiscal real nunca falhou: nenhuma NFC-e acima do limite foi
//      emitida. O defeito é de roteamento.)
//
//   E) O grupo de PAGAMENTO somava só a entrada, enquanto os itens somavam a
//      venda inteira: o documento dizia que o cliente pagou menos do que a
//      mercadoria vale. A rota do cupom já reconciliava isso com `findChildren`;
//      o caminho fiscal não.
//
// Venda à VISTA não tem filhas ⇒ soma zero ⇒ comportamento byte-idêntico.

import { describe, it, expect, beforeEach, vi } from "vitest";

const createPopulatedMock = vi.fn().mockResolvedValue({ id: "draft-1" });
vi.mock("../app/usecases/nfe-draft.usecase", () => ({
  NfeDraftUseCase: class {
    createPopulatedFromReceivable = createPopulatedMock;
  },
}));
vi.mock("@/app/usecases/nfe-draft.usecase", () => ({
  NfeDraftUseCase: class {
    createPopulatedFromReceivable = createPopulatedMock;
  },
}));

function makePrisma() {
  const fmodel = () => ({
    findFirst: vi.fn(),
    findMany: vi.fn().mockResolvedValue([]),
    findUnique: vi.fn(),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    create: vi.fn(),
    createMany: vi.fn(),
    deleteMany: vi.fn(),
    groupBy: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
  });
  const p: any = {
    receivable: fmodel(),
    payable: fmodel(),
    receivableItem: fmodel(),
    receivablePayment: fmodel(),
    customer: {
      findFirst: vi.fn().mockResolvedValue({
        id: "c-1",
        userId: "user-owner",
        name: "Cliente",
        cpf: "12345678909",
        personType: "FISICA",
        address: null,
      }),
      findUnique: vi.fn(),
    },
  };
  p.$transaction = vi.fn(async (cb: any) => cb(p));
  return p;
}

vi.mock("../app/lib/prisma", () => ({ default: makePrisma() }));
vi.mock("@/app/lib/prisma", () => ({ default: makePrisma() }));

import prismaDefault from "../app/lib/prisma";
import { FinanceUseCase } from "../app/usecases/finance.usecase";

const prisma = prismaDefault as any;
const USER = "user-owner";

/** Conta-mãe: R$ 3.000 de entrada, R$ 12.000 de mercadoria. */
function mae(over: Partial<any> = {}) {
  return {
    id: "r-1",
    userId: USER,
    customerId: "c-1",
    totalAmount: "3000.00",
    status: "PAGA",
    paymentMethod: "PIX",
    dueDate: new Date(),
    installments: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    customer: { id: "c-1", name: "Cliente", cpf: null, email: null },
    unidade: null,
    items: [
      {
        id: "i-1",
        productId: "p-1",
        description: "Motor",
        quantity: 1,
        unitPrice: "12000.00",
        createdAt: new Date(),
      },
    ],
    payments: [],
    ...over,
  };
}

/** Três parcelas de R$ 3.000 = R$ 9.000 de saldo. */
const filhas = [
  { id: "f-1", totalAmount: "3000.00", userId: USER },
  { id: "f-2", totalAmount: "3000.00", userId: USER },
  { id: "f-3", totalAmount: "3000.00", userId: USER },
];

describe("Bug F — limite da NFC-e olha a VENDA, não a entrada", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.receivable.findFirst.mockResolvedValue(mae());
  });

  it("venda parcelada de R$ 12.000 é barrada, mesmo com entrada de R$ 3.000", async () => {
    prisma.receivable.findMany.mockResolvedValue(filhas);

    await expect(
      new FinanceUseCase().emitNfceFromReceivable("r-1", USER),
    ).rejects.toThrow(/R\$ 10\.000/);
  });

  it("venda À VISTA acima do limite continua barrada (sem regressão)", async () => {
    prisma.receivable.findFirst.mockResolvedValue(
      mae({ totalAmount: "10000.01" }),
    );
    prisma.receivable.findMany.mockResolvedValue([]);

    await expect(
      new FinanceUseCase().emitNfceFromReceivable("r-1", USER),
    ).rejects.toThrow(/R\$ 10\.000/);
  });

  it("venda parcelada ABAIXO do limite continua emitindo", async () => {
    // Entrada 300 + 3×300 = 1.200, bem abaixo do teto.
    prisma.receivable.findFirst.mockResolvedValue(
      mae({ totalAmount: "300.00" }),
    );
    prisma.receivable.findMany.mockResolvedValue([
      { id: "f-1", totalAmount: "300.00", userId: USER },
      { id: "f-2", totalAmount: "300.00", userId: USER },
      { id: "f-3", totalAmount: "300.00", userId: USER },
    ]);

    // Passa do guard do limite — a emissão em si é outro caminho.
    await expect(
      new FinanceUseCase().emitNfceFromReceivable("r-1", USER),
    ).rejects.not.toThrow(/R\$ 10\.000/);
  });
});

describe("Bug E — grupo de pagamento fecha com o total dos itens", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.receivable.findFirst.mockResolvedValue(mae());
  });

  it("acrescenta o saldo a prazo como CREDITO_LOJA", async () => {
    prisma.receivable.findMany.mockResolvedValue(filhas);

    await new FinanceUseCase().createFiscalDraftFromReceivable("r-1", USER);

    const arg = createPopulatedMock.mock.calls[0][1];
    const somaPagamentos = arg.pagamentos.reduce(
      (a: number, p: any) => a + Number(p.valor),
      0,
    );
    const somaItens = arg.itens.reduce(
      (a: number, i: any) => a + Number(i.valorTotal),
      0,
    );

    // O ponto do bug: sem a reconciliação, 3.000 ≠ 12.000.
    expect(somaPagamentos).toBe(12000);
    expect(somaPagamentos).toBe(somaItens);
    expect(arg.pagamentos).toContainEqual({
      meio: "CREDITO_LOJA",
      valor: 9000,
    });
  });

  it("preserva a forma de pagamento da ENTRADA", async () => {
    prisma.receivable.findMany.mockResolvedValue(filhas);

    await new FinanceUseCase().createFiscalDraftFromReceivable("r-1", USER);

    const arg = createPopulatedMock.mock.calls[0][1];
    // A entrada foi PIX; o saldo é que vira crediário.
    expect(arg.pagamentos[0]).toEqual({ meio: "PIX", valor: 3000 });
  });

  it("venda À VISTA sai byte-idêntica — uma linha só, sem saldo", async () => {
    prisma.receivable.findFirst.mockResolvedValue(
      mae({ totalAmount: "12000.00" }),
    );
    prisma.receivable.findMany.mockResolvedValue([]);

    await new FinanceUseCase().createFiscalDraftFromReceivable("r-1", USER);

    const arg = createPopulatedMock.mock.calls[0][1];
    expect(arg.pagamentos).toEqual([{ meio: "PIX", valor: 12000 }]);
  });

  it("pagamento COMBINADO na entrada + saldo a prazo somam a venda", async () => {
    prisma.receivable.findFirst.mockResolvedValue(
      mae({
        payments: [
          { id: "p1", method: "PIX", amount: "1000.00" },
          { id: "p2", method: "DINHEIRO", amount: "2000.00" },
        ],
      }),
    );
    prisma.receivable.findMany.mockResolvedValue(filhas);

    await new FinanceUseCase().createFiscalDraftFromReceivable("r-1", USER);

    const arg = createPopulatedMock.mock.calls[0][1];
    expect(arg.pagamentos).toHaveLength(3);
    const soma = arg.pagamentos.reduce(
      (a: number, p: any) => a + Number(p.valor),
      0,
    );
    expect(soma).toBe(12000);
  });
});
