// EGRESS — a consulta de anúncios do caminho da BAIXA REAL de estoque.
//
// `deductWithinTx` e `restoreWithinTx` rodam em toda baixa e toda devolução de
// estoque: venda de balcão, pedido de marketplace, estorno, cancelamento de
// pedido, promoção de peça avulsa. É o caminho mais recorrente que toca
// `ProductListing`.
//
// Os dois usavam `include` sem `select`, o que carrega as 61 colunas da tabela
// — entre elas o JSON de `compatDiagnostics` e o texto de `lastError` — quando
// o código usa exatamente DOIS campos: `listing.id` e
// `marketplaceAccount.platform`.
//
// MEDIDO em produção (25/08), sobre 402.305 linhas:
//   · linha inteira ........ 280 bytes (média)
//   · campos usados ........  52 bytes
//   · desperdício .......... 5,4×
//
// É a regra "nenhuma leitura sem seleção explícita de campos em caminho
// recorrente" (scripts/docs/doc-ingestao-pedidos.tsx). Este arquivo existe para
// que a volta ao `include` não passe despercebida numa próxima edição — foi
// assim que ela sobreviveu até agora.

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/app/marketplaces/services/stock-sync-retry.service", () => ({
  StockSyncRetryService: { runOnce: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("@/app/usecases/product.usercase", () => ({
  ProductUseCase: class {
    pauseListings = vi.fn();
  },
}));

import { StockDeductionService } from "@/app/marketplaces/services/stock-deduction.service";

/**
 * `tx` de mentira com a superfície exata que os dois métodos usam.
 *
 * `$queryRaw` é o `SELECT ... FOR UPDATE` do produto; `$executeRaw` é o
 * advisory lock. Ambos são chamados como template tag, então precisam ser
 * funções comuns.
 */
function makeTx(produto: { id: string; name: string; stock: number }) {
  return {
    $queryRaw: vi.fn().mockResolvedValue([produto]),
    $executeRaw: vi.fn().mockResolvedValue(1),
    product: { update: vi.fn().mockResolvedValue({}) },
    stockLog: { create: vi.fn().mockResolvedValue({}) },
    productListing: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "listing-1",
          marketplaceAccount: { platform: "MERCADO_LIVRE" },
        },
      ]),
    },
    stockSyncJob: { upsert: vi.fn().mockResolvedValue({}) },
  };
}

const ITEM = { productId: "p-1", quantity: 1 };

// Corpo de bloco, não de expressão: `vi.clearAllMocks()` devolve `VitestUtils`,
// e uma arrow de expressão faria o hook retornar esse objeto onde o tipo espera
// `void` ou uma função de limpeza.
beforeEach(() => {
  vi.clearAllMocks();
});

describe("deductWithinTx — seleção explícita na consulta de anúncios", () => {
  it("pede só os dois campos usados, nunca a linha inteira", async () => {
    const tx = makeTx({ id: "p-1", name: "Peça", stock: 3 });

    await StockDeductionService.deductWithinTx(tx as any, {
      items: [ITEM],
      reason: "teste",
    });

    expect(tx.productListing.findMany).toHaveBeenCalledTimes(1);
    const arg = tx.productListing.findMany.mock.calls[0][0];

    // `include` traria as 61 colunas, com compatDiagnostics (JSON) junto.
    expect(arg.include).toBeUndefined();
    expect(arg.select).toEqual({
      id: true,
      marketplaceAccount: { select: { platform: true } },
    });
  });

  it("o job continua sendo enfileirado com os mesmos dados de sempre", async () => {
    // A seleção enxuta não pode ter custado nenhum campo que o upsert usa: se
    // `platform` ou `id` sumissem do select, o job iria para o banco quebrado.
    const tx = makeTx({ id: "p-1", name: "Peça", stock: 3 });

    await StockDeductionService.deductWithinTx(tx as any, {
      items: [ITEM],
      reason: "teste",
      orderId: "order-9",
    });

    expect(tx.stockSyncJob.upsert).toHaveBeenCalledTimes(1);
    const job = tx.stockSyncJob.upsert.mock.calls[0][0];
    expect(job.where).toEqual({
      listingId_status: { listingId: "listing-1", status: "PENDING" },
    });
    expect(job.create.platform).toBe("MERCADO_LIVRE");
    expect(job.create.listingId).toBe("listing-1");
    expect(job.create.productId).toBe("p-1");
    expect(job.create.targetStock).toBe(2); // 3 − 1
    expect(job.create.orderId).toBe("order-9");
  });

  it("o advisory lock continua vindo ANTES do upsert", async () => {
    const tx = makeTx({ id: "p-1", name: "Peça", stock: 3 });

    await StockDeductionService.deductWithinTx(tx as any, {
      items: [ITEM],
      reason: "teste",
    });

    const lock = tx.$executeRaw.mock.invocationCallOrder[0];
    const upsert = tx.stockSyncJob.upsert.mock.invocationCallOrder[0];
    expect(lock).toBeLessThan(upsert);
  });
});

describe("restoreWithinTx — o mesmo, no caminho da devolução", () => {
  it("pede só os dois campos usados", async () => {
    const tx = makeTx({ id: "p-1", name: "Peça", stock: 0 });

    await StockDeductionService.restoreWithinTx(tx as any, {
      items: [ITEM],
      reason: "estorno",
    });

    const arg = tx.productListing.findMany.mock.calls[0][0];
    expect(arg.include).toBeUndefined();
    expect(arg.select).toEqual({
      id: true,
      marketplaceAccount: { select: { platform: true } },
    });
  });

  it("o job de devolução leva o estoque restaurado", async () => {
    const tx = makeTx({ id: "p-1", name: "Peça", stock: 0 });

    await StockDeductionService.restoreWithinTx(tx as any, {
      items: [ITEM],
      reason: "estorno",
    });

    const job = tx.stockSyncJob.upsert.mock.calls[0][0];
    expect(job.create.targetStock).toBe(1); // 0 + 1
    expect(job.create.platform).toBe("MERCADO_LIVRE");
  });
});
