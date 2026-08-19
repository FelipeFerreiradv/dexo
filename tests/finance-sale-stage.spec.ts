// BLOCO F — estágio operacional da venda.
//
// A decisão que este spec protege é a ORTOGONALIDADE. O estágio é uma segunda
// dimensão: uma venda pode estar PAGA e "em separação"; PENDENTE e já embalada.
// Se ele começar a governar (bloquear recebimento, exigir ordem), vira uma
// trava operacional no caminho que baixa estoque — e ninguém destrava isso num
// sábado de movimento. Decisão de 14/08: é informação, não trava.
//
// E a DERIVAÇÃO: NULL não é "sem estágio", é "está no começo". Sem isso, toda
// venda anterior ao recurso ficaria fora do painel, que passaria a mentir sobre
// o movimento da loja.
//
// Os testes afirmam ESTRUTURA e COMPORTAMENTO, nunca um rótulo literal. É
// deliberado: o vocabulário é operacional e vai mudar quando o processo da loja
// mudar. Renomear "Em separação" não pode deixar a suíte vermelha — só mexer na
// mecânica (derivação, avanço, fronteira do PATCH) deve.

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
  FIRST_SALE_STAGE,
  SALE_STAGES,
  deriveSaleStage,
  isSaleStageEnabled,
  nextSaleStage,
  normalizeSaleStage,
  saleStageIndex,
  saleStageLabel,
} from "../app/financeiro/lib/sale-stage";

const OWNER = "owner@test.com";
const ORIG = process.env.SALE_STAGE_ENABLED;
const ULTIMO = SALE_STAGES[SALE_STAGES.length - 1].code;
const SEGUNDO = SALE_STAGES[1].code;

function buildApp() {
  const app = fastify();
  app.register(financeRoutes, { prefix: "/finance" });
  return app;
}

function conta(over: Record<string, unknown> = {}) {
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
    status: "PENDENTE",
    paidAt: null,
    saleStage: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    customer: { id: "c-1", name: "Cliente", cpf: null, email: null },
    unidade: null,
    items: [],
    ...over,
  };
}

async function patchStage(body: unknown, over: Record<string, unknown> = {}) {
  (prisma as any).receivable.findFirst.mockResolvedValue(conta(over));
  (prisma as any).receivable.findUnique.mockResolvedValue(conta(over));
  const app = buildApp();
  const res = await app.inject({
    method: "PATCH",
    url: "/finance/receivables/r-1/stage",
    headers: { email: OWNER, "content-type": "application/json" },
    payload: body as any,
  });
  return {
    res,
    data: (prisma as any).receivable.updateMany.mock.calls[0]?.[0]?.data,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (prisma as any).$transaction.mockImplementation(async (cb: any) =>
    cb(prisma),
  );
  (prisma as any).receivable.updateMany.mockResolvedValue({ count: 1 });
  delete process.env.SALE_STAGE_ENABLED;
});

afterAll(() => {
  if (ORIG === undefined) delete process.env.SALE_STAGE_ENABLED;
  else process.env.SALE_STAGE_ENABLED = ORIG;
});

describe("Vocabulário — estrutura, não rótulos", () => {
  it("são 11 estágios, com códigos únicos e não vazios", () => {
    expect(SALE_STAGES).toHaveLength(11);
    const codes = SALE_STAGES.map((s) => s.code);
    expect(new Set(codes).size).toBe(11);
    for (const s of SALE_STAGES) {
      expect(s.code.trim()).not.toBe("");
      expect(s.label.trim()).not.toBe("");
    }
  });

  it("o primeiro estágio é o alvo da derivação", () => {
    expect(FIRST_SALE_STAGE).toBe(SALE_STAGES[0].code);
  });
});

describe("deriveSaleStage — NULL é 'no começo', não 'sem estágio'", () => {
  it("null, undefined e vazio derivam para o primeiro", () => {
    // Sem isto, toda venda anterior ao recurso ficaria FORA do painel.
    expect(deriveSaleStage(null)).toBe(FIRST_SALE_STAGE);
    expect(deriveSaleStage(undefined)).toBe(FIRST_SALE_STAGE);
    expect(deriveSaleStage("")).toBe(FIRST_SALE_STAGE);
    expect(deriveSaleStage("   ")).toBe(FIRST_SALE_STAGE);
  });

  it("código GRAVADO fora do vocabulário volta COMO ESTÁ", () => {
    // É o que permite renomear/remover estágio sem apagar histórico: derivar
    // para o começo faria uma venda entregue voltar para a primeira coluna.
    expect(deriveSaleStage("ETAPA_ANTIGA")).toBe("ETAPA_ANTIGA");
    expect(saleStageLabel("ETAPA_ANTIGA")).toBe("ETAPA_ANTIGA");
    expect(saleStageIndex("ETAPA_ANTIGA")).toBe(-1);
  });

  it("nome herdado do Object não vira rótulo-função", () => {
    expect(saleStageLabel("toString")).toBe("toString");
    expect(saleStageLabel("constructor")).toBe("constructor");
  });
});

describe("nextSaleStage — o avanço de um clique", () => {
  it("do primeiro vai para o segundo", () => {
    expect(nextSaleStage(FIRST_SALE_STAGE)).toBe(SEGUNDO);
  });

  it("NULL avança como se estivesse no primeiro", () => {
    expect(nextSaleStage(null)).toBe(SEGUNDO);
  });

  it("no ÚLTIMO devolve null — botão que não faz nada é pior que ausente", () => {
    expect(nextSaleStage(ULTIMO)).toBeNull();
  });

  it("código desconhecido não tem próximo (não há ordem a supor)", () => {
    expect(nextSaleStage("ETAPA_ANTIGA")).toBeNull();
  });

  it("a cadeia percorre os 11 e termina", () => {
    let atual: string | null = FIRST_SALE_STAGE;
    const vistos: string[] = [];
    while (atual) {
      vistos.push(atual);
      atual = nextSaleStage(atual);
    }
    expect(vistos).toEqual(SALE_STAGES.map((s) => s.code));
  });
});

describe("normalizeSaleStage — fronteira do PATCH", () => {
  const ON = { SALE_STAGE_ENABLED: "1" };

  it("flag ausente ⇒ undefined, mesmo com código válido", () => {
    expect(normalizeSaleStage(FIRST_SALE_STAGE, {})).toBeUndefined();
    expect(isSaleStageEnabled({})).toBe(false);
  });

  it("só a string exata '1' liga", () => {
    expect(
      normalizeSaleStage(FIRST_SALE_STAGE, { SALE_STAGE_ENABLED: "true" }),
    ).toBeUndefined();
  });

  it("aceita todos os códigos do vocabulário, aparados", () => {
    for (const s of SALE_STAGES) {
      expect(normalizeSaleStage(` ${s.code} `, ON)).toBe(s.code);
    }
  });

  it("RECUSA o que não está no vocabulário — painel não pode ter coluna 'outros'", () => {
    expect(normalizeSaleStage("QUALQUER_COISA", ON)).toBeUndefined();
    expect(normalizeSaleStage("toString", ON)).toBeUndefined();
    expect(normalizeSaleStage("", ON)).toBeUndefined();
    expect(normalizeSaleStage(42, ON)).toBeUndefined();
    expect(normalizeSaleStage(null, ON)).toBeUndefined();
    expect(normalizeSaleStage({ code: "X" }, ON)).toBeUndefined();
  });
});

describe("PATCH /receivables/:id/stage", () => {
  it("flag desligada ⇒ 400 e NADA é escrito (a coluna pode não existir)", async () => {
    const { res, data } = await patchStage({ saleStage: SEGUNDO });
    expect(res.statusCode).toBe(400);
    expect(data).toBeUndefined();
  });

  describe("com a flag ligada", () => {
    beforeEach(() => {
      process.env.SALE_STAGE_ENABLED = "1";
    });

    it("move o estágio e grava SÓ essa coluna", async () => {
      const { res, data } = await patchStage({ saleStage: SEGUNDO });
      expect(res.statusCode).toBe(200);
      expect(data).toEqual({ saleStage: SEGUNDO });
    });

    it("estágio inválido ⇒ 400, sem escrever", async () => {
      const { res, data } = await patchStage({ saleStage: "NAO_EXISTE" });
      expect(res.statusCode).toBe(400);
      expect(data).toBeUndefined();
    });

    it("body vazio ⇒ 400", async () => {
      const { res } = await patchStage({});
      expect(res.statusCode).toBe(400);
    });

    it("MESMO estágio ⇒ 200 sem escrever (duplo clique não duplica histórico)", async () => {
      const { res, data } = await patchStage(
        { saleStage: SEGUNDO },
        { saleStage: SEGUNDO },
      );
      expect(res.statusCode).toBe(200);
      expect(data).toBeUndefined();
    });

    it("NULL gravado conta como o primeiro: mover para o primeiro é no-op", async () => {
      // A derivação vale também na comparação de idempotência — senão avançar
      // "do começo para o começo" escreveria e registraria evento.
      const { data } = await patchStage(
        { saleStage: FIRST_SALE_STAGE },
        { saleStage: null },
      );
      expect(data).toBeUndefined();
    });

    it("conta inexistente ⇒ 404", async () => {
      (prisma as any).receivable.findFirst.mockResolvedValue(null);
      const app = buildApp();
      const res = await app.inject({
        method: "PATCH",
        url: "/finance/receivables/r-1/stage",
        headers: { email: OWNER, "content-type": "application/json" },
        payload: { saleStage: SEGUNDO },
      });
      expect(res.statusCode).toBe(404);
    });

    it("ORTOGONAL ao financeiro: venda PAGA move de etapa normalmente", async () => {
      // É justamente a venda paga que anda no pátio. Se a guarda de edição do
      // BLOCO E ou o status financeiro barrassem aqui, o pipeline seria
      // inútil — e é por isso que esta rota não passa por nenhum dos dois.
      const { res, data } = await patchStage(
        { saleStage: ULTIMO },
        { status: "PAGA", paidAt: new Date() },
      );
      expect(res.statusCode).toBe(200);
      expect(data).toEqual({ saleStage: ULTIMO });
    });

    it("PULAR etapa é permitido — o estágio não governa ordem", async () => {
      const { res, data } = await patchStage(
        { saleStage: ULTIMO },
        { saleStage: FIRST_SALE_STAGE },
      );
      expect(res.statusCode).toBe(200);
      expect(data).toEqual({ saleStage: ULTIMO });
    });

    it("VOLTAR etapa é permitido — erro de clique tem conserto", async () => {
      const { res, data } = await patchStage(
        { saleStage: FIRST_SALE_STAGE },
        { saleStage: ULTIMO },
      );
      expect(res.statusCode).toBe(200);
      expect(data).toEqual({ saleStage: FIRST_SALE_STAGE });
    });
  });
});
