import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ──────────────────────────────────────────────────────────────────────────────
// Duas REGRESSÕES que este próprio trabalho introduziu, achadas pela auditoria de
// performance de 30/07/2026 — ambas já estavam em produção.
//
// 1. (CRÍTICA) A `reason` do StockLog é a única âncora de idempotência da baixa.
//    A baixa ORIGINAL grava "Venda ML #id" (linha 1509), "Venda Magalu #id"
//    (2189) e "Venda Shopee #sn" (863) — o tipo canônico está em
//    `processOrderCancellation`: "ML" | "Shopee" | "Magalu".
//    Mas o reconciliador chama `retryStockDeduction` com `issue.platform`, que é
//    o ENUM do Prisma, e o mapeamento tratava só o SHOPEE. Para ML e Magalu o
//    retry procurava "Venda MERCADO_LIVRE #id" / "Venda MAGALU #id", não achava
//    nada, concluía "net zero" e BAIXAVA O PEDIDO INTEIRO DE NOVO.
//    Determinístico, silencioso e irreversível — a mesma classe de defeito que
//    este método acabou de consertar para a Shopee. Ficou live com `a44a0cc`,
//    que foi quando a quarentena de ML/Magalu começou a chamar este caminho.
//
// 2. (ALTA) `retryStockDeduction` devolvia `true` para pedido com ZERO itens
//    (nada a baixar, nenhuma exceção). O reconciliador usa esse retorno para
//    FECHAR a pendência — então toda venda de ML/Magalu sem produto cadastrado
//    desaparecia da aba de Pendências na primeira volta do worker, sem ter sido
//    resolvida. Estado terminal silencioso, exatamente o que o invariante proíbe.
//    Com 173 Order sem itens em produção (R$ 40.303,99), a fila de ML/Magalu
//    zerava em menos de 10 minutos.
// ──────────────────────────────────────────────────────────────────────────────

vi.mock("@/app/marketplaces/services/stock-sync-retry.service", () => ({
  StockSyncRetryService: { runOnce: vi.fn().mockResolvedValue(undefined) },
}));

import { OrderUseCase } from "@/app/marketplaces/usecases/order.usercase";
import { StockDeductionService } from "@/app/marketplaces/services/stock-deduction.service";
import prisma from "@/app/lib/prisma";

const ORDER = {
  id: "order-1",
  status: "SHIPPED",
  stockDeductedAt: null,
  items: [{ productId: "p1", quantity: 2, unitPrice: 10, listingId: null }],
};

function buildTx(net: Array<{ productId: string; change: number }>) {
  return {
    $queryRaw: vi.fn((strings: TemplateStringsArray) => {
      const sql = Array.isArray(strings) ? strings.join("?") : String(strings);
      if (sql.includes('"Order"')) return Promise.resolve([{ status: "SHIPPED" }]);
      return Promise.resolve([{ id: "p1" }]);
    }),
    stockLog: {
      groupBy: vi.fn(() =>
        Promise.resolve(
          net.map((n) => ({ productId: n.productId, _sum: { change: n.change } })),
        ),
      ),
    },
    order: { update: vi.fn().mockResolvedValue({}) },
  };
}

const guarda: Record<string, string | undefined> = {};
const NOMES = ["ORDER_STOCK_RETRY_TX_NET_DISABLED", "ORDER_STOCK_DEDUCTED_AT_DISABLED"];

beforeEach(() => {
  for (const n of NOMES) {
    guarda[n] = process.env[n];
    delete process.env[n];
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const n of NOMES) {
    if (guarda[n] === undefined) delete process.env[n];
    else process.env[n] = guarda[n]!;
  }
});

describe("1. a reason do retry casa com a da baixa original", () => {
  /** Devolve a `reason` que o retry usou para consultar o net. */
  async function reasonUsada(platformLabel: string): Promise<string> {
    const tx = buildTx([]);
    vi.spyOn(prisma.order, "findUnique").mockResolvedValue(ORDER as any);
    vi.spyOn(prisma, "$transaction").mockImplementation(async (cb: any) => cb(tx));
    const deduct = vi
      .spyOn(StockDeductionService, "deductWithinTx")
      .mockResolvedValue({ deductions: [], oversellAlerts: [] } as any);
    vi.spyOn(StockDeductionService, "firePostEffects").mockImplementation(() => {});

    await OrderUseCase.retryStockDeduction("order-1", platformLabel, "123");

    const [, input] = deduct.mock.calls[0] as any[];
    return input.reason;
  }

  it.each([
    ["MERCADO_LIVRE", "Venda ML #123"],
    ["MAGALU", "Venda Magalu #123"],
    ["SHOPEE", "Venda Shopee #123"],
  ])("enum do Prisma %s vira %s", async (enumPrisma, esperada) => {
    // Era ESTE mapeamento que faltava: MERCADO_LIVRE e MAGALU produziam uma
    // reason inexistente no banco, o net vinha zero e a baixa repetia.
    expect(await reasonUsada(enumPrisma)).toBe(esperada);
  });

  it.each([
    ["ML", "Venda ML #123"],
    ["Shopee", "Venda Shopee #123"],
    ["Magalu", "Venda Magalu #123"],
  ])("rótulo já pronto %s continua %s", async (rotulo, esperada) => {
    // Byte-idêntico ao comportamento anterior para estes três: é o que garante
    // que a correção não mexeu no caminho que já funcionava.
    expect(await reasonUsada(rotulo)).toBe(esperada);
  });

  it("plataforma desconhecida preserva o valor recebido", async () => {
    expect(await reasonUsada("TIKTOK")).toBe("Venda TIKTOK #123");
  });

  it("com a reason CERTA, o net encontrado impede a segunda baixa", async () => {
    // O cenário real: baixa original gravou "Venda ML #123" com -2. Antes da
    // correção o retry procurava "Venda MERCADO_LIVRE #123", achava 0 e baixava
    // 2 de novo.
    const tx = buildTx([{ productId: "p1", change: -2 }]);
    vi.spyOn(prisma.order, "findUnique").mockResolvedValue(ORDER as any);
    vi.spyOn(prisma, "$transaction").mockImplementation(async (cb: any) => cb(tx));
    const deduct = vi
      .spyOn(StockDeductionService, "deductWithinTx")
      .mockResolvedValue({ deductions: [], oversellAlerts: [] } as any);
    vi.spyOn(StockDeductionService, "firePostEffects").mockImplementation(() => {});

    const ok = await OrderUseCase.retryStockDeduction(
      "order-1",
      "MERCADO_LIVRE",
      "123",
    );

    expect(ok).toBe(true);
    expect(deduct).not.toHaveBeenCalled();
  });
});

describe("2. pedido sem itens NÃO reporta baixa", () => {
  it("devolve false, sem abrir transação", async () => {
    vi.spyOn(prisma.order, "findUnique").mockResolvedValue({
      ...ORDER,
      items: [],
    } as any);
    const tx$ = vi.spyOn(prisma, "$transaction");

    const ok = await OrderUseCase.retryStockDeduction("order-1", "SHOPEE", "SN-1");

    // `true` aqui fazia o reconciliador FECHAR a pendência de uma venda que não
    // baixou estoque nenhum — estado terminal silencioso.
    expect(ok).toBe(false);
    expect(tx$).not.toHaveBeenCalled();
  });

  it("pedido COM item segue funcionando", async () => {
    const tx = buildTx([]);
    vi.spyOn(prisma.order, "findUnique").mockResolvedValue(ORDER as any);
    vi.spyOn(prisma, "$transaction").mockImplementation(async (cb: any) => cb(tx));
    vi.spyOn(StockDeductionService, "deductWithinTx").mockResolvedValue({
      deductions: [],
      oversellAlerts: [],
    } as any);
    vi.spyOn(StockDeductionService, "firePostEffects").mockImplementation(() => {});

    expect(
      await OrderUseCase.retryStockDeduction("order-1", "SHOPEE", "SN-1"),
    ).toBe(true);
  });

  it("pedido cancelado continua devolvendo true (nada a baixar, e correto)", async () => {
    vi.spyOn(prisma.order, "findUnique").mockResolvedValue({
      ...ORDER,
      status: "CANCELLED",
    } as any);

    expect(
      await OrderUseCase.retryStockDeduction("order-1", "SHOPEE", "SN-1"),
    ).toBe(true);
  });
});
