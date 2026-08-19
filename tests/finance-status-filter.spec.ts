// BLOCO C — filtro por status da venda.
//
// O vocabulário do cliente NÃO é o dos 4 valores de `FinanceStatus`: "Aberta",
// "Parcelada" e "Faturada" são derivados, e "Vencida" já era derivada só para
// exibição. A regra tem de ser a MESMA no rótulo e na consulta, senão o filtro
// contradiz o badge que a própria linha mostra.
//
// A invariante que mais importa aqui: SEM filtro, o `where` fica byte-idêntico
// ao de hoje — nenhuma chave nova. É o que mantém os specs que casam o objeto
// exato do `where` valendo, e o que garante que a listagem não muda de plano.

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  parseSaleStatusFilters,
  buildSaleStatusWhere,
  needsFiscalLookup,
  saleStatusFilterLabel,
  SALE_STATUS_FILTER_CODES,
} from "../app/lib/finance-status-filters";

const NOW = new Date("2026-08-14T12:00:00.000Z");

describe("Vocabulário e parsing", () => {
  it("aceita lista separada por vírgula, sem repetir", () => {
    expect(parseSaleStatusFilters("ABERTA,RECEBIDA,ABERTA")).toEqual([
      "ABERTA",
      "RECEBIDA",
    ]);
  });

  it("é tolerante a espaço e caixa", () => {
    expect(parseSaleStatusFilters(" aberta , Recebida ")).toEqual([
      "ABERTA",
      "RECEBIDA",
    ]);
  });

  it("descarta código desconhecido em vez de quebrar", () => {
    expect(parseSaleStatusFilters("ABERTA,PIRULITO")).toEqual(["ABERTA"]);
  });

  it("ausente, vazio ou só lixo ⇒ [] (não filtrar)", () => {
    for (const v of [undefined, null, "", "   ", ",,,", "XPTO"]) {
      expect(parseSaleStatusFilters(v as any)).toEqual([]);
    }
  });

  it("todo código tem rótulo", () => {
    for (const c of SALE_STATUS_FILTER_CODES) {
      expect(saleStatusFilterLabel(c)).not.toBe(c);
    }
  });
});

describe("Sem filtro ⇒ nada é acrescentado ao where", () => {
  it("devolve null com lista vazia", () => {
    expect(buildSaleStatusWhere([], { now: NOW })).toBeNull();
  });
});

describe("Tradução dos rótulos derivados", () => {
  it("ABERTA é pendente E ainda no prazo", () => {
    // Sem o recorte de vencimento, "Aberta" traria as vencidas — que a tela
    // pinta de vermelho como VENCIDA. O filtro contradiria o badge.
    const [f] = buildSaleStatusWhere(["ABERTA"], { now: NOW })!;
    expect(f).toEqual({ status: "PENDENTE", dueDate: { gte: NOW } });
  });

  it("VENCIDA cobre o derivado E o literal do legado", () => {
    // `applyOverdueFlag` deriva VENCIDA de (PENDENTE + vencimento passado);
    // a importação de legado grava o literal. Os dois têm de casar.
    const [f] = buildSaleStatusWhere(["VENCIDA"], { now: NOW })!;
    expect(f).toEqual({
      OR: [{ status: "PENDENTE", dueDate: { lt: NOW } }, { status: "VENCIDA" }],
    });
  });

  it("PARCELADA pega os DOIS lados do split", () => {
    // A conta-mãe NÃO recebe `installmentTotal` (só as filhas), então esse
    // campo não serve de discriminador — o vínculo é por parentReceivableId.
    const [f] = buildSaleStatusWhere(["PARCELADA"], { now: NOW })!;
    expect(f).toEqual({
      OR: [{ children: { some: {} } }, { parentReceivableId: { not: null } }],
    });
  });

  it("RECEBIDA e CANCELADA são diretos", () => {
    expect(buildSaleStatusWhere(["RECEBIDA"], { now: NOW })![0]).toEqual({
      status: "PAGA",
    });
    expect(buildSaleStatusWhere(["CANCELADA"], { now: NOW })![0]).toEqual({
      status: "CANCELADA",
    });
  });
});

describe("FATURADA — o único que precisa de pré-consulta", () => {
  it("só ele aciona o lookup fiscal", () => {
    expect(needsFiscalLookup(["FATURADA"])).toBe(true);
    expect(needsFiscalLookup(["ABERTA", "RECEBIDA", "PARCELADA"])).toBe(false);
  });

  it("usa os ids resolvidos", () => {
    const [f] = buildSaleStatusWhere(["FATURADA"], {
      now: NOW,
      faturadaIds: ["r-1", "r-2"],
    })!;
    expect(f).toEqual({ id: { in: ["r-1", "r-2"] } });
  });

  it("sem nota nenhuma, casa ZERO linhas (e não 'todas')", () => {
    // Um `in: []` vazio é a resposta certa para "nenhuma venda faturada".
    // Se isso virasse "sem filtro", o operador veria a lista inteira.
    const [f] = buildSaleStatusWhere(["FATURADA"], { now: NOW })!;
    expect(f).toEqual({ id: { in: [] } });
  });
});

describe("Múltipla seleção", () => {
  it("gera um fragmento por código, na ordem do vocabulário", () => {
    const fs = buildSaleStatusWhere(["RECEBIDA", "ABERTA"], { now: NOW })!;
    expect(fs).toHaveLength(2);
  });

  it("a ordem do parse é estável, não a de digitação", () => {
    expect(parseSaleStatusFilters("CANCELADA,ABERTA")).toEqual([
      "ABERTA",
      "CANCELADA",
    ]);
  });
});

// ── Integração com o repositório ──

function makePrisma() {
  const fmodel = () => ({
    findMany: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
    groupBy: vi.fn().mockResolvedValue([]),
    findFirst: vi.fn(),
    updateMany: vi.fn(),
    create: vi.fn(),
    createMany: vi.fn(),
    deleteMany: vi.fn(),
  });
  const p: any = {
    receivable: fmodel(),
    payable: fmodel(),
    receivableItem: fmodel(),
    receivablePayment: fmodel(),
    nfeEmitida: { findMany: vi.fn().mockResolvedValue([]) },
  };
  p.$transaction = vi.fn(async (cb: any) => cb(p));
  return p;
}

vi.mock("../app/lib/prisma", () => ({ default: makePrisma() }));
vi.mock("@/app/lib/prisma", () => ({ default: makePrisma() }));

import prismaDefault from "../app/lib/prisma";
import { FinanceRepository } from "../app/repositories/finance.repository";

const prisma = prismaDefault as any;
const USER = "user-owner";

describe("findAll — o where sem filtro é intocado", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.receivable.findMany.mockResolvedValue([]);
    prisma.receivable.count.mockResolvedValue(0);
    prisma.nfeEmitida.findMany.mockResolvedValue([]);
  });

  it("sem statusIn ⇒ nenhuma chave AND (consulta idêntica à de hoje)", async () => {
    await new FinanceRepository().findAll(
      "receivable",
      { page: 1, limit: 20 },
      USER,
    );
    const where = prisma.receivable.findMany.mock.calls[0][0].where;
    expect(where).toEqual({ userId: USER });
    expect(prisma.nfeEmitida.findMany).not.toHaveBeenCalled();
  });

  it("statusIn com lixo ⇒ também não filtra", async () => {
    await new FinanceRepository().findAll(
      "receivable",
      { page: 1, limit: 20, statusIn: "XPTO" },
      USER,
    );
    expect(prisma.receivable.findMany.mock.calls[0][0].where).toEqual({
      userId: USER,
    });
  });

  it("com filtro, entra em AND e NÃO sobrescreve o OR da busca", async () => {
    // O `OR` do `where` é da busca textual. Se o status usasse `OR`, a busca
    // sumiria — os dois precisam coexistir.
    await new FinanceRepository().findAll(
      "receivable",
      { page: 1, limit: 20, statusIn: "RECEBIDA", search: "motor" },
      USER,
    );
    const where = prisma.receivable.findMany.mock.calls[0][0].where;
    expect(where.OR).toHaveLength(3); // document, reason, customer.name
    expect(where.AND).toEqual([{ OR: [{ status: "PAGA" }] }]);
  });

  it("FATURADA consulta as notas e extrai os ids do numeroPedido", async () => {
    prisma.nfeEmitida.findMany.mockResolvedValue([
      { numeroPedido: "receivable:r-1" },
      { numeroPedido: "receivable:r-2" },
      { numeroPedido: null },
    ]);

    await new FinanceRepository().findAll(
      "receivable",
      { page: 1, limit: 20, statusIn: "FATURADA" },
      USER,
    );

    const arg = prisma.nfeEmitida.findMany.mock.calls[0][0];
    expect(arg.where).toEqual({
      userId: USER,
      status: "AUTHORIZED",
      numeroPedido: { startsWith: "receivable:" },
    });
    const where = prisma.receivable.findMany.mock.calls[0][0].where;
    expect(where.AND).toEqual([{ OR: [{ id: { in: ["r-1", "r-2"] } }] }]);
  });

  it("sem FATURADA, a pré-consulta fiscal NÃO roda", async () => {
    await new FinanceRepository().findAll(
      "receivable",
      { page: 1, limit: 20, statusIn: "ABERTA,RECEBIDA" },
      USER,
    );
    expect(prisma.nfeEmitida.findMany).not.toHaveBeenCalled();
  });
});
