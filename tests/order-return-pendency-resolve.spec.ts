import { describe, it, expect, vi, beforeEach } from "vitest";

// ──────────────────────────────────────────────────────────────────────────
// A decisão do operador sobre uma devolução (contrato §5.3 e §5.4).
//
// É o ÚNICO caminho pelo qual o estoque volta depois que a peça saiu do pátio.
// Nem o marketplace dizendo "devolvido" repõe estoque sozinho — decisão do
// dono em 01/09/2026, e o motivo é simples: `date_returned` prova que a
// transportadora entregou de volta, não que a peça está na prateleira.
//
// Prova:
//  3. RECEBIDA  → `+1` com reason PRÓPRIA e anúncio reaberto pela preferência.
//  4. NAO_RECEBIDA → estoque continua 0, anúncio continua fora, desfecho fica
//     registrado.
//  - Idempotência: o claim da pendência acontece na MESMA tx do estorno, então
//    dois cliques repõem uma vez só.
//  - A reason nova NÃO é "Estorno venda ..." — reusá-la envenenaria o net que
//    o cancelamento calcula.
// ──────────────────────────────────────────────────────────────────────────

vi.mock("@/app/marketplaces/services/stock-sync-retry.service", () => ({
  StockSyncRetryService: { runOnce: vi.fn().mockResolvedValue(undefined) },
}));

const PENDENCIA = {
  id: "pend-1",
  status: "OPEN",
  platform: "MERCADO_LIVRE",
};

// `var` (não `const`): as factories de `vi.mock` são içadas para o topo do
// arquivo e rodam antes do corpo do spec — uma `const` cairia em TDZ. O
// singleton garante que os dois specifiers devolvam O MESMO objeto.
var __prisma: any;
function makePrisma() {
  if (!__prisma) {
    const tx = {
      orderReturnPendency: { updateMany: vi.fn() },
      stockLog: { groupBy: vi.fn() },
      $queryRaw: vi.fn().mockResolvedValue([{ id: "p-1" }]),
    };
    __prisma = {
      __tx: tx,
      orderReturnPendency: { findUnique: vi.fn(), updateMany: vi.fn() },
      order: { findFirst: vi.fn() },
      $transaction: vi.fn(async (cb: any) => cb(tx)),
    };
  }
  return __prisma;
}

vi.mock("../app/lib/prisma", () => ({ default: makePrisma() }));
vi.mock("@/app/lib/prisma", () => ({ default: makePrisma() }));

import { OrderUseCase } from "@/app/marketplaces/usecases/order.usercase";
import { StockDeductionService } from "@/app/marketplaces/services/stock-deduction.service";
import { SystemLogService } from "@/app/services/system-log.service";
import { ScrapStatusReconcileService } from "@/app/marketplaces/services/scrap-status-reconcile.service";
import prismaReal from "@/app/lib/prisma";

const prismaMock = prismaReal as any;

const ACCOUNT_ID = "acc-1";
const EXT_ID = "999";

const ORDER = {
  id: "o-1",
  status: "CANCELLED",
  items: [{ productId: "p-1", quantity: 1 }],
  marketplaceAccount: {
    userId: "u-1",
    user: { reopenListingsOnSaleCancel: true, parent: null },
  },
};

let restore: any;
let fire: any;
let scrap: any;

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.orderReturnPendency.findUnique.mockResolvedValue(PENDENCIA);
  prismaMock.orderReturnPendency.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.order.findFirst.mockResolvedValue(ORDER);
  prismaMock.$transaction.mockImplementation(async (cb: any) =>
    cb(prismaMock.__tx),
  );
  prismaMock.__tx.orderReturnPendency.updateMany.mockResolvedValue({ count: 1 });
  // Baixa da venda registrada, nenhum estorno ⇒ net −1 ⇒ repõe 1.
  prismaMock.__tx.stockLog.groupBy.mockResolvedValue([
    { productId: "p-1", _sum: { change: -1 } },
  ]);

  restore = vi
    .spyOn(StockDeductionService, "restoreWithinTx")
    .mockResolvedValue({
      deductions: [
        {
          productId: "p-1",
          productName: "Peça",
          previousStock: 0,
          newStock: 1,
          quantity: 1,
        },
      ],
    });
  fire = vi
    .spyOn(StockDeductionService, "firePostEffects")
    .mockImplementation(() => {});
  scrap = vi
    .spyOn(ScrapStatusReconcileService, "reconcileForProducts")
    .mockImplementation(() => {});
  vi.spyOn(SystemLogService, "logInfo").mockResolvedValue(undefined as any);
});

const resolver = (outcome: any) =>
  OrderUseCase.resolveReturnPendency({
    marketplaceAccountId: ACCOUNT_ID,
    externalOrderId: EXT_ID,
    outcome,
    userId: "u-1",
    resolvedByUserId: "colab-1",
  });

describe("§5.3 — o operador confirma que a peça VOLTOU", () => {
  it("repõe +1 com reason própria e reabre o anúncio pela preferência", async () => {
    const res = await resolver("RECEBIDA");

    expect(res.success).toBe(true);
    expect(res.action).toBe("resolved_restocked");
    expect(res.restoredItems).toBe(1);

    expect(restore).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        items: [{ productId: "p-1", quantity: 1 }],
        reason: `Devolução recebida ML #${EXT_ID}`,
        orderId: "o-1",
      }),
    );
    expect(fire).toHaveBeenCalledWith(
      expect.objectContaining({
        reopenOnRefill: { userId: "u-1", force: true },
      }),
    );
    expect(scrap).toHaveBeenCalled();
  });

  it("⭐ a reason NÃO é 'Estorno venda ...' — reusá-la envenenaria o net", async () => {
    await resolver("RECEBIDA");
    const reason = restore.mock.calls[0][1].reason;
    expect(reason).not.toContain("Estorno venda");
    expect(reason).toBe(`Devolução recebida ML #${EXT_ID}`);
  });

  it("o claim da pendência acontece DENTRO da mesma transação do estorno", async () => {
    await resolver("RECEBIDA");
    expect(prismaMock.__tx.orderReturnPendency.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "pend-1",
          status: { in: ["OPEN", "NEEDS_ACTION"] },
        },
        data: expect.objectContaining({
          status: "RESOLVED",
          outcome: "RECEBIDA",
          resolvedByUserId: "colab-1",
        }),
      }),
    );
  });

  it("segundo clique (claim perdido) não repõe de novo", async () => {
    prismaMock.__tx.orderReturnPendency.updateMany.mockResolvedValue({
      count: 0,
    });
    const res = await resolver("RECEBIDA");
    expect(res.action).toBe("already_resolved");
    expect(restore).not.toHaveBeenCalled();
  });

  it("net já zerado (a devolução já foi lançada antes) não repõe em dobro", async () => {
    prismaMock.__tx.stockLog.groupBy.mockResolvedValue([
      { productId: "p-1", _sum: { change: 0 } },
    ]);
    const res = await resolver("RECEBIDA");
    expect(restore).not.toHaveBeenCalled();
    expect(res.restoredItems).toBe(0);
  });

  it("o net soma a reason da devolução — este caminho tem net PRÓPRIO", async () => {
    await resolver("RECEBIDA");
    expect(prismaMock.__tx.stockLog.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          reason: {
            in: [
              `Venda ML #${EXT_ID}`,
              `Estorno venda ML #${EXT_ID}`,
              `Reativação venda ML #${EXT_ID}`,
              `Devolução recebida ML #${EXT_ID}`,
            ],
          },
        }),
      }),
    );
  });

  it("preferência de reabertura DESLIGADA: mantém pausado em todos os canais", async () => {
    prismaMock.order.findFirst.mockResolvedValue({
      ...ORDER,
      marketplaceAccount: {
        userId: "u-1",
        user: { reopenListingsOnSaleCancel: false, parent: null },
      },
    });
    await resolver("RECEBIDA");
    const arg = fire.mock.calls[0][0];
    expect(arg.reopenOnRefill).toBeUndefined();
    expect(arg.keepPausedOnRefill).toEqual({ userId: "u-1" });
  });

  it("conta conectada por COLABORADOR obedece ao admin pai", async () => {
    prismaMock.order.findFirst.mockResolvedValue({
      ...ORDER,
      marketplaceAccount: {
        userId: "u-1",
        user: {
          reopenListingsOnSaleCancel: true,
          parent: { reopenListingsOnSaleCancel: false },
        },
      },
    });
    await resolver("RECEBIDA");
    expect(fire.mock.calls[0][0].reopenOnRefill).toBeUndefined();
  });

  it("registra ORDER_RETURN_RESTOCKED", async () => {
    await resolver("RECEBIDA");
    expect(SystemLogService.logInfo).toHaveBeenCalledWith(
      "ORDER_RETURN_RESTOCKED",
      expect.any(String),
      expect.anything(),
    );
  });
});

describe("§5.4 — o operador marca que a peça NÃO voltou", () => {
  it("não toca em estoque e registra o desfecho", async () => {
    const res = await resolver("NAO_RECEBIDA");

    expect(res.action).toBe("resolved_written_off");
    expect(res.restoredItems).toBe(0);
    expect(restore).not.toHaveBeenCalled();
    expect(fire).not.toHaveBeenCalled();
    // Nem abre transação: não há nada para escrever em estoque.
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(SystemLogService.logInfo).toHaveBeenCalledWith(
      "ORDER_RETURN_WRITTEN_OFF",
      expect.any(String),
      expect.anything(),
    );
  });

  it("venda mantida pelo marketplace fecha como VENDA_MANTIDA", async () => {
    const res = await resolver("VENDA_MANTIDA");
    expect(res.action).toBe("resolved_written_off");
    expect(restore).not.toHaveBeenCalled();
    expect(SystemLogService.logInfo).toHaveBeenCalledWith(
      "ORDER_RETURN_SALE_REINSTATED",
      expect.any(String),
      expect.anything(),
    );
  });

  it("segundo clique não registra duas vezes", async () => {
    prismaMock.orderReturnPendency.updateMany.mockResolvedValue({ count: 0 });
    const res = await resolver("NAO_RECEBIDA");
    expect(res.action).toBe("already_resolved");
    expect(SystemLogService.logInfo).not.toHaveBeenCalled();
  });
});

describe("guardas", () => {
  it("⭐ pedido REATIVADO no meio-tempo: NÃO repõe estoque", async () => {
    // Sequência real e perigosa: cancelamento retido → alguém reativa o
    // pedido pelo PATCH manual (esse caminho não fecha a pendência) → o
    // operador clica "A peça voltou". Sem esta guarda o net daria −1 (só a
    // baixa da venda) e reporíamos `+1` num pedido que está PAID: estoque
    // fantasma pela porta dos fundos, o mesmo bug que esta entrega mata.
    prismaMock.order.findFirst.mockResolvedValue({ ...ORDER, status: "PAID" });

    const res = await resolver("RECEBIDA");

    expect(res.success).toBe(true);
    expect(res.restoredItems).toBe(0);
    expect(restore).not.toHaveBeenCalled();
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(SystemLogService.logInfo).toHaveBeenCalledWith(
      "ORDER_RETURN_SALE_REINSTATED",
      expect.any(String),
      expect.anything(),
    );
    expect(res.message).toMatch(/venda ativa/);
  });

  it("⭐ pendência de pedido NUNCA importado não vira beco sem saída", async () => {
    // A pendência da Shopee é aberta no laço de importação ANTES de se saber
    // se o pedido vira `Order`. Um `TO_RETURN` de pedido que nunca ingeriu cai
    // aqui: se devolvêssemos `not_found`, a rota responderia 404 para sempre e
    // NADA fecharia a linha. Sem `Order` não há baixa nossa para reverter,
    // então fecha registrando o desfecho, com 0 itens.
    prismaMock.order.findFirst.mockResolvedValue(null);

    const res = await resolver("RECEBIDA");

    expect(res.success).toBe(true);
    expect(res.action).toBe("resolved_written_off");
    expect(res.restoredItems).toBe(0);
    expect(res.message).toMatch(/não chegou a ser importado/);
    expect(restore).not.toHaveBeenCalled();
    // A pendência foi de fato encerrada.
    expect(prismaMock.orderReturnPendency.updateMany).toHaveBeenCalled();
  });

  it("pendência inexistente → not_found, sem tocar em nada", async () => {
    prismaMock.orderReturnPendency.findUnique.mockResolvedValue(null);
    const res = await resolver("RECEBIDA");
    expect(res.action).toBe("not_found");
    expect(restore).not.toHaveBeenCalled();
  });

  it("pendência já RESOLVED → fast-path, sem transação", async () => {
    prismaMock.orderReturnPendency.findUnique.mockResolvedValue({
      ...PENDENCIA,
      status: "RESOLVED",
    });
    const res = await resolver("RECEBIDA");
    expect(res.action).toBe("already_resolved");
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("nunca lança: erro na transação vira { success: false, action: 'error' }", async () => {
    prismaMock.$transaction.mockRejectedValue(new Error("deadlock"));
    const res = await resolver("RECEBIDA");
    expect(res.success).toBe(false);
    expect(res.action).toBe("error");
    expect(res.restoredItems).toBe(0);
  });
});
