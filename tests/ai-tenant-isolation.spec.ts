import { beforeEach, describe, expect, it, vi } from "vitest";

// ===========================================================================
// ⭐ Isolamento entre lojas, provado no ARGUMENTO que cada handler entrega.
//
// Os outros specs provam que o modelo não CONSEGUE pedir outro tenant (schema
// strict, tipo nominal). Este prova o outro lado: que o handler realmente
// REPASSA o tenant do escopo para a camada de dados — e não esquece.
//
// Esquecer é fácil e silencioso: vários repositórios aceitam `userId?`
// OPCIONAL e, sem ele, varrem todos os tenants devolvendo 200
// (product.repository.ts:1291, location.repository.ts:62,
// order.repository.ts:302, scrap.repository.ts:157). Não há exceção, não há
// log — só o dado de outra empresa na tela.
//
// Por isso os usecases são espionados: o que interessa não é o resultado, é o
// argumento.
// ===========================================================================

const TENANT = "TENANT-DO-ATOR";
const OUTRO = "TENANT-DE-OUTRA-LOJA";

const espiao = {
  listProducts: vi.fn(async (..._a: any[]) => ({
    products: [],
    total: 0,
    totalPages: 0,
  })),
  getDetail: vi.fn(async (..._a: any[]) => null),
  listForSelect: vi.fn(async (..._a: any[]) => []),
  customerSearch: vi.fn(async (..._a: any[]) => []),
  getOrders: vi.fn(async (..._a: any[]) => ({ orders: [], total: 0 })),
  listScraps: vi.fn(async (..._a: any[]) => ({
    scraps: [],
    total: 0,
    totalPages: 0,
  })),
  getScrapDetail: vi.fn(async (..._a: any[]) => null),
  financeList: vi.fn(async (..._a: any[]) => ({
    items: [],
    total: 0,
    totalPages: 0,
  })),
  financeSummary: vi.fn(async (..._a: any[]) => ({
    receivables: {
      totalCount: 0,
      totalAmount: 0,
      overdueCount: 0,
      overdueAmount: 0,
      pendingAmount: 0,
      paidAmount: 0,
    },
    payables: {
      totalCount: 0,
      totalAmount: 0,
      overdueCount: 0,
      overdueAmount: 0,
      pendingAmount: 0,
      paidAmount: 0,
    },
  })),
  budgetList: vi.fn(async (..._a: any[]) => ({
    items: [],
    total: 0,
    totalPages: 0,
  })),
  fetchOrdersByPlatform: vi.fn(async (..._a: any[]) => []),
  fetchRevenueByCategory: vi.fn(async (..._a: any[]) => []),
  fetchRevenueByCategoryTotals: vi.fn(async (..._a: any[]) => null),
  fetchReceivablesByPaymentMethod: vi.fn(async (..._a: any[]) => []),
  fetchReceivablesByChannel: vi.fn(async (..._a: any[]) => []),
  productCount: vi.fn(async (..._a: any[]) => 0),
  productAggregate: vi.fn(async (..._a: any[]) => ({ _sum: { stock: 0 } })),
  productFindMany: vi.fn(async (..._a: any[]) => []),
  productGroupBy: vi.fn(async (..._a: any[]) => []),
  listingCount: vi.fn(async (..._a: any[]) => 0),
  listingFindMany: vi.fn(async (..._a: any[]) => []),
  syncLogFindMany: vi.fn(async (..._a: any[]) => []),
  accountFindMany: vi.fn(async (..._a: any[]) => []),
  issueCount: vi.fn(async (..._a: any[]) => 0),
  issueFindMany: vi.fn(async (..._a: any[]) => []),
};

vi.mock("../app/usecases/product.usercase", () => ({
  ProductUseCase: class {
    listProducts = espiao.listProducts;
    getDetail = espiao.getDetail;
  },
}));
vi.mock("../app/usecases/location.usercase", () => ({
  LocationUseCase: class {
    listForSelect = espiao.listForSelect;
  },
}));
vi.mock("../app/usecases/customer.usecase", () => ({
  CustomerUseCase: class {
    search = espiao.customerSearch;
  },
}));
vi.mock("../app/marketplaces/usecases/order.usercase", () => ({
  OrderUseCase: { getOrders: (...a: any[]) => espiao.getOrders(...(a as [])) },
}));
vi.mock("../app/usecases/scrap.usercase", () => ({
  ScrapUseCase: class {
    listScraps = espiao.listScraps;
    getScrapDetail = espiao.getScrapDetail;
  },
}));
vi.mock("../app/usecases/finance.usecase", () => ({
  FinanceUseCase: class {
    list = espiao.financeList;
    summary = espiao.financeSummary;
  },
}));
vi.mock("../app/usecases/budget.usecase", () => ({
  BudgetUseCase: class {
    list = espiao.budgetList;
  },
}));
vi.mock("../app/lib/dashboard-breakdowns.query", () => ({
  fetchOrdersByPlatform: (...a: any[]) =>
    espiao.fetchOrdersByPlatform(...(a as [])),
  fetchRevenueByCategory: (...a: any[]) =>
    espiao.fetchRevenueByCategory(...(a as [])),
  fetchRevenueByCategoryTotals: (...a: any[]) =>
    espiao.fetchRevenueByCategoryTotals(...(a as [])),
  fetchReceivablesByPaymentMethod: (...a: any[]) =>
    espiao.fetchReceivablesByPaymentMethod(...(a as [])),
  fetchReceivablesByChannel: (...a: any[]) =>
    espiao.fetchReceivablesByChannel(...(a as [])),
}));
vi.mock("../app/lib/prisma", () => ({
  default: {
    product: {
      count: (...a: any[]) => espiao.productCount(...(a as [])),
      aggregate: (...a: any[]) => espiao.productAggregate(...(a as [])),
      findMany: (...a: any[]) => espiao.productFindMany(...(a as [])),
      groupBy: (...a: any[]) => espiao.productGroupBy(...(a as [])),
    },
    productListing: {
      count: (...a: any[]) => espiao.listingCount(...(a as [])),
      findMany: (...a: any[]) => espiao.listingFindMany(...(a as [])),
    },
    syncLog: {
      findMany: (...a: any[]) => espiao.syncLogFindMany(...(a as [])),
    },
    marketplaceAccount: {
      findMany: (...a: any[]) => espiao.accountFindMany(...(a as [])),
    },
    orderIngestionIssue: {
      count: (...a: any[]) => espiao.issueCount(...(a as [])),
      findMany: (...a: any[]) => espiao.issueFindMany(...(a as [])),
    },
    systemLog: { create: async () => ({}) },
  },
}));

import { scopeFromRequest } from "../app/ai/core/scope";
import { READ_TOOLS } from "../app/ai/tools/read";

const scope = scopeFromRequest({
  user: { id: "ator", dataOwnerId: TENANT, parentUserId: null },
} as any)!;

const tool = (nome: string) => READ_TOOLS.find((t) => t.name === nome)!;

beforeEach(() => {
  for (const fn of Object.values(espiao)) fn.mockClear();
});

/** Todo valor de string do payload, em qualquer profundidade. */
function stringsDe(valor: unknown, saida: string[] = []): string[] {
  if (typeof valor === "string") saida.push(valor);
  else if (Array.isArray(valor)) valor.forEach((v) => stringsDe(v, saida));
  else if (valor && typeof valor === "object")
    Object.values(valor).forEach((v) => stringsDe(v, saida));
  return saida;
}

describe("⭐ cada tool entrega o tenant do escopo à camada de dados", () => {
  it("buscar_produto", async () => {
    await tool("buscar_produto").handler({ consulta: "farol" }, scope);
    expect(espiao.listProducts).toHaveBeenCalledWith(
      expect.objectContaining({ userId: TENANT }),
    );
  });

  it("detalhe_produto (resolução por SKU e detalhe)", async () => {
    espiao.listProducts.mockResolvedValueOnce({
      products: [{ id: "p1", sku: "001" }],
      total: 1,
      totalPages: 1,
    } as any);
    await tool("detalhe_produto").handler({ sku: "001" }, scope);
    expect(espiao.listProducts).toHaveBeenCalledWith(
      expect.objectContaining({ userId: TENANT }),
    );
    expect(espiao.getDetail).toHaveBeenCalledWith("p1", TENANT);
  });

  it("buscar_localizacao", async () => {
    await tool("buscar_localizacao").handler({}, scope);
    expect(espiao.listForSelect).toHaveBeenCalledWith(TENANT);
  });

  it("buscar_cliente", async () => {
    await tool("buscar_cliente").handler({ consulta: "joao" }, scope);
    expect(espiao.customerSearch).toHaveBeenCalledWith("joao", TENANT);
  });

  it("buscar_pedido", async () => {
    await tool("buscar_pedido").handler({}, scope);
    // O tenant é o PRIMEIRO argumento posicional de OrderUseCase.getOrders.
    expect(espiao.getOrders.mock.calls[0][0]).toBe(TENANT);
  });

  it("buscar_sucata", async () => {
    await tool("buscar_sucata").handler({}, scope);
    expect(espiao.listScraps).toHaveBeenCalledWith(
      expect.objectContaining({ userId: TENANT }),
    );
  });

  it("detalhe_sucata", async () => {
    await tool("detalhe_sucata").handler({ id: "s1" }, scope);
    expect(espiao.getScrapDetail.mock.calls[0][1]).toBe(TENANT);
  });

  it("contas_a_receber", async () => {
    await tool("contas_a_receber").handler({}, scope);
    expect(espiao.financeList.mock.calls[0][0]).toBe("receivable");
    expect(espiao.financeList.mock.calls[0][2]).toBe(TENANT);
    expect(espiao.financeSummary).toHaveBeenCalledWith(TENANT);
  });

  it("contas_a_pagar", async () => {
    await tool("contas_a_pagar").handler({}, scope);
    expect(espiao.financeList.mock.calls[0][0]).toBe("payable");
    expect(espiao.financeList.mock.calls[0][2]).toBe(TENANT);
  });

  it("buscar_orcamento", async () => {
    await tool("buscar_orcamento").handler({}, scope);
    expect(espiao.budgetList.mock.calls[0][1]).toBe(TENANT);
  });

  it.each([
    ["plataforma", "fetchOrdersByPlatform"],
    ["categoria", "fetchRevenueByCategory"],
    ["forma-de-pagamento", "fetchReceivablesByPaymentMethod"],
    ["canal", "fetchReceivablesByChannel"],
  ])("relatorio_vendas / %s", async (dimensao, fn) => {
    await tool("relatorio_vendas").handler({ dimensao }, scope);
    // O tenant é o PRIMEIRO posicional em todas as 5 funções de query.
    expect((espiao as any)[fn].mock.calls[0][0]).toBe(TENANT);
  });

  it("relatorio_estoque", async () => {
    await tool("relatorio_estoque").handler({}, scope);
    for (const fn of [
      espiao.productCount,
      espiao.productAggregate,
      espiao.productFindMany,
      espiao.productGroupBy,
    ]) {
      expect(fn).toHaveBeenCalled();
      for (const [arg] of fn.mock.calls) {
        expect((arg as any).where.userId).toBe(TENANT);
      }
    }
  });

  it("diagnostico_operacional", async () => {
    await tool("diagnostico_operacional").handler({}, scope);
    // Pendências e sincronização penduram o tenant na conta de marketplace —
    // Order/OrderIngestionIssue/SyncLog não têm coluna de dono.
    for (const [arg] of espiao.issueFindMany.mock.calls) {
      expect((arg as any).where.marketplaceAccount.userId).toBe(TENANT);
    }
    for (const [arg] of espiao.listingFindMany.mock.calls) {
      expect((arg as any).where.marketplaceAccount.userId).toBe(TENANT);
    }
    for (const [arg] of espiao.syncLogFindMany.mock.calls) {
      expect((arg as any).where.marketplaceAccount.userId).toBe(TENANT);
    }
    for (const [arg] of espiao.accountFindMany.mock.calls) {
      expect((arg as any).where.userId).toBe(TENANT);
    }
  });
});

describe("⭐ nenhum argumento do modelo troca a loja", () => {
  it.each(READ_TOOLS.map((t) => [t.name, t] as const))(
    "%s ignora um tenant injetado nos argumentos",
    async (_nome, t) => {
      // Chamada DIRETA no handler, pulando o zod de propósito: o `.strict()` já
      // é provado em ai-tool-runner.spec.ts. O que este teste prova é o passo
      // seguinte — que mesmo se um argumento desses chegasse, ele não é lido.
      const args: any = {
        userId: OUTRO,
        dataOwnerId: OUTRO,
        // Argumentos mínimos válidos para cada tool.
        consulta: "x",
        sku: "001",
        id: "x1",
        dimensao: "plataforma",
      };
      espiao.listProducts.mockResolvedValue({
        products: [{ id: "p1", sku: "001" }],
        total: 1,
        totalPages: 1,
      } as any);

      const resultado = await t.handler(args, scope);

      const chamadas = Object.values(espiao).flatMap((fn) => fn.mock.calls);
      const serializado = JSON.stringify(chamadas);
      expect(serializado, `${t.name} vazou o tenant do modelo`).not.toContain(
        OUTRO,
      );
      // E o payload de volta também não pode citar a outra loja.
      expect(stringsDe(resultado)).not.toContain(OUTRO);
    },
  );
});
