import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mesmo stub do order-crossmarketplace-sync.test.ts: a baixa dispara runOnce()
// pós-commit, que sem isto vazaria para o prisma real.
vi.mock("@/app/marketplaces/services/stock-sync-retry.service", () => ({
  StockSyncRetryService: { runOnce: vi.fn().mockResolvedValue(undefined) },
}));

import prisma from "@/app/lib/prisma";
import { OrderUseCase } from "@/app/marketplaces/usecases/order.usercase";
import { SystemLogService } from "@/app/services/system-log.service";

/**
 * OVERSELL_DETECTED passa a nascer COM a empresa (dono do tenant).
 *
 * Em setembro/2026, 51 de 51 alertas de venda sobre peça sem estoque foram
 * gravados sem userId — a tela de Logs e o aviso de Pedidos filtram pela
 * empresa, então nenhum lojista os viu. Mensagem e details continuam iguais.
 */

const buildTx = (stock: number) => ({
  $queryRaw: vi.fn().mockResolvedValue([{ id: "prod-1", name: "Paralama", stock }]),
  $executeRaw: vi.fn().mockResolvedValue(1),
  product: { update: vi.fn().mockResolvedValue({}) },
  stockLog: { create: vi.fn().mockResolvedValue({}) },
  productListing: { findMany: vi.fn().mockResolvedValue([]) },
  stockSyncJob: { upsert: vi.fn().mockResolvedValue({}) },
});

const pedido = (extra: Record<string, unknown> = {}) => ({
  id: "order-1",
  marketplaceAccount: { platform: "MERCADO_LIVRE" },
  items: [{ productId: "prod-1", quantity: 1, unitPrice: 100 }],
  ...extra,
});

describe("OVERSELL_DETECTED com a empresa", () => {
  // `any`: o tipo exato do spy do Prisma não é atribuível ao MockInstance
  // genérico (TS2322), e o teste só lê `.mock.calls`.
  let logWarning: any;
  let findConta: any;

  beforeEach(() => {
    vi.spyOn(SystemLogService, "logInfo").mockResolvedValue(undefined as any);
    logWarning = vi.spyOn(SystemLogService, "logWarning").mockResolvedValue(undefined as any);
    vi.spyOn(prisma.syncLog, "create").mockResolvedValue({} as any);
    findConta = vi.spyOn(prisma.marketplaceAccount, "findUnique");
    // A checagem de pausa-ao-zerar lê o dono quando a conta é de colaborador;
    // sem este stub ela tentaria o banco real e o caso levaria ~4 s.
    vi.spyOn(prisma.user, "findUnique").mockResolvedValue({
      pauseListingsOnOrderZero: false,
    } as any);
    // Sem oversell a baixa zera: a checagem de pausa-ao-zerar também lê a conta.
    vi.spyOn(prisma, "$transaction").mockImplementation(async (cb: any) => cb(buildTx(0)));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const oversellCall = () =>
    logWarning.mock.calls.find((c: unknown[]) => c[0] === "OVERSELL_DETECTED");

  it("conta de colaborador: grava o DONO (parentUserId)", async () => {
    findConta.mockResolvedValue({ user: { id: "colab-1", parentUserId: "dono-1" } } as any);

    await (OrderUseCase as any).deductStockForOrder(
      pedido({ marketplaceAccountId: "acc-1" }),
      "Venda ML #1",
    );

    const call = oversellCall();
    expect(call).toBeDefined();
    expect(call![2]).toEqual(
      expect.objectContaining({
        userId: "dono-1",
        resource: "Order",
        resourceId: "order-1",
        details: expect.objectContaining({ orderId: "order-1", platform: "MERCADO_LIVRE" }),
      }),
    );
  });

  it("conta do próprio dono: grava o id dele", async () => {
    findConta.mockResolvedValue({ user: { id: "dono-2", parentUserId: null } } as any);

    await (OrderUseCase as any).deductStockForOrder(
      pedido({ marketplaceAccountId: "acc-2" }),
      "Venda ML #2",
    );

    expect(oversellCall()![2]).toEqual(expect.objectContaining({ userId: "dono-2" }));
  });

  it("falha ao ler a conta: o alerta sai mesmo assim, sem empresa (como antes)", async () => {
    findConta.mockRejectedValue(new Error("banco fora"));

    await (OrderUseCase as any).deductStockForOrder(
      pedido({ marketplaceAccountId: "acc-3" }),
      "Venda ML #3",
    );

    const call = oversellCall();
    expect(call).toBeDefined();
    expect(call![2]).not.toHaveProperty("userId");
  });

  it("pedido sem conta conhecida: não consulta e grava como antes", async () => {
    findConta.mockResolvedValue(null as any);

    await (OrderUseCase as any).deductStockForOrder(pedido(), "Venda ML #4");

    expect(oversellCall()![2]).not.toHaveProperty("userId");
    expect(
      findConta.mock.calls.some(
        (c: any[]) => c[0]?.select?.user?.select?.parentUserId === true,
      ),
    ).toBe(false);
  });
});
