import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ──────────────────────────────────────────────────────────────────────────────
// Commit 1 — o loop de sync deixa de ser um ciclo único de horas.
//
// Diagnóstico de 29/07/2026: o log de produção registrou
// `Ciclo concluído em 258962582 ms` (71,9 h) para UM ciclo, com o waitMs caindo
// no piso de 5 s. O import de pedidos da última conta esperava a varredura de
// catálogo (milhares de itens) de todas as anteriores. Como a Shopee não recebe
// push (zero WebhookEventLog com source SHOPEE), esse poll é o único caminho de
// ingestão dela — uma venda ficava até ~3 dias sem virar Order nem baixar
// estoque.
//
// Agora: passada de pedidos separada da passada de catálogo/métricas, com pool
// de concorrência. O kill-switch SYNC_LOOP_SPLIT_DISABLED=1 restaura o ciclo
// único serial.
// ──────────────────────────────────────────────────────────────────────────────

vi.mock("../app/lib/prisma", () => ({
  default: {
    marketplaceAccount: { findMany: vi.fn(), findUnique: vi.fn() },
    $disconnect: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../app/marketplaces/usecases/order.usercase", () => ({
  OrderUseCase: {
    importRecentOrdersForAccount: vi.fn().mockResolvedValue(undefined),
    importRecentShopeeOrdersForAccount: vi.fn().mockResolvedValue(undefined),
    importRecentMagaluOrdersForAccount: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../app/marketplaces/usecases/sync.usercase", () => ({
  SyncUseCase: {
    importNewShopeeItemsForAccount: vi
      .fn()
      .mockResolvedValue({ created: 0, linked: 0, skipped: 0, errors: 0 }),
    importNewMagaluItemsForAccount: vi
      .fn()
      .mockResolvedValue({ created: 0, linked: 0, skipped: 0, errors: 0 }),
  },
}));

vi.mock("../app/marketplaces/usecases/messages.usecase", () => ({
  MessagesUseCase: {
    syncShopeeCommentsForAccount: vi.fn().mockResolvedValue({ comments: 0, errors: 0 }),
    syncMagaluMessagesForAccount: vi.fn().mockResolvedValue({ conversations: 0, errors: 0 }),
  },
}));

vi.mock("../app/services/system-log.service", () => ({
  SystemLogService: {
    logInfo: vi.fn().mockResolvedValue(undefined),
    logWarning: vi.fn().mockResolvedValue(undefined),
    logError: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../scripts/sync-listing-metrics", () => ({
  syncAllListingsMetrics: vi.fn().mockResolvedValue(undefined),
}));

import prisma from "../app/lib/prisma";
import { MessagesUseCase } from "../app/marketplaces/usecases/messages.usecase";
import { OrderUseCase } from "../app/marketplaces/usecases/order.usercase";
import { SyncUseCase } from "../app/marketplaces/usecases/sync.usercase";
import { syncAllListingsMetrics } from "../scripts/sync-listing-metrics";
import { __testing } from "../scripts/sync-orders-and-metrics-loop";

const CONTAS = [
  { id: "ml-1", platform: "MERCADO_LIVRE" },
  { id: "shopee-1", platform: "SHOPEE" },
  { id: "shopee-2", platform: "SHOPEE" },
  { id: "magalu-1", platform: "MAGALU" },
];

beforeEach(() => {
  vi.mocked((prisma as any).marketplaceAccount.findMany).mockResolvedValue(CONTAS as any);
  vi.mocked((prisma as any).marketplaceAccount.findUnique).mockImplementation(
    async ({ where }: any) => ({ id: where.id, shopId: 1, accessToken: "t" }),
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("runOrdersPass — a passada rápida só importa pedidos", () => {
  it("importa pedidos de todas as contas e NÃO toca em catálogo, mensagens ou métricas", async () => {
    const r = await __testing.runOrdersPass();

    expect(r.accounts).toBe(4);
    expect(OrderUseCase.importRecentOrdersForAccount).toHaveBeenCalledTimes(1);
    expect(OrderUseCase.importRecentShopeeOrdersForAccount).toHaveBeenCalledTimes(2);
    expect(OrderUseCase.importRecentMagaluOrdersForAccount).toHaveBeenCalledTimes(1);

    // É isto que derrubava a cadência de horas para minutos.
    expect(SyncUseCase.importNewShopeeItemsForAccount).not.toHaveBeenCalled();
    expect(SyncUseCase.importNewMagaluItemsForAccount).not.toHaveBeenCalled();
    expect(MessagesUseCase.syncShopeeCommentsForAccount).not.toHaveBeenCalled();
    expect(MessagesUseCase.syncMagaluMessagesForAccount).not.toHaveBeenCalled();
    expect(syncAllListingsMetrics).not.toHaveBeenCalled();
  });

  it("uma conta que falha não impede as demais de importar", async () => {
    vi.mocked(OrderUseCase.importRecentShopeeOrdersForAccount).mockRejectedValueOnce(
      new Error("Shopee API 403: Invalid access_token, please have a check."),
    );

    await expect(__testing.runOrdersPass()).resolves.toMatchObject({ accounts: 4 });

    expect(OrderUseCase.importRecentShopeeOrdersForAccount).toHaveBeenCalledTimes(2);
    expect(OrderUseCase.importRecentMagaluOrdersForAccount).toHaveBeenCalledTimes(1);
  });

  it("respeita o teto de concorrência do pool", async () => {
    let emVoo = 0;
    let pico = 0;
    const rastreia = async () => {
      emVoo++;
      pico = Math.max(pico, emVoo);
      await new Promise((r) => setTimeout(r, 5));
      emVoo--;
    };

    const itens = Array.from({ length: 20 }, (_, i) => i);
    await __testing.runPool(itens, 3, rastreia);

    expect(pico).toBeLessThanOrEqual(3);
    expect(pico).toBeGreaterThan(1);
  });

  it("com limite 1 o pool degrada para serial (comportamento anterior)", async () => {
    let emVoo = 0;
    let pico = 0;
    const rastreia = async () => {
      emVoo++;
      pico = Math.max(pico, emVoo);
      await new Promise((r) => setTimeout(r, 1));
      emVoo--;
    };

    await __testing.runPool([1, 2, 3, 4, 5], 1, rastreia);
    expect(pico).toBe(1);
  });
});

describe("runCatalogPass — a passada lenta não importa pedidos", () => {
  it("roda catálogo, mensagens e métricas, e nenhum import de pedido", async () => {
    const r = await __testing.runCatalogPass();

    expect(r.accounts).toBe(4);
    expect(SyncUseCase.importNewShopeeItemsForAccount).toHaveBeenCalledTimes(2);
    expect(MessagesUseCase.syncShopeeCommentsForAccount).toHaveBeenCalledTimes(2);
    expect(SyncUseCase.importNewMagaluItemsForAccount).toHaveBeenCalledTimes(1);
    expect(MessagesUseCase.syncMagaluMessagesForAccount).toHaveBeenCalledTimes(1);
    expect(syncAllListingsMetrics).toHaveBeenCalledTimes(1);

    expect(OrderUseCase.importRecentOrdersForAccount).not.toHaveBeenCalled();
    expect(OrderUseCase.importRecentShopeeOrdersForAccount).not.toHaveBeenCalled();
    expect(OrderUseCase.importRecentMagaluOrdersForAccount).not.toHaveBeenCalled();
  });
});

describe("runOnce — caminho do kill-switch SYNC_LOOP_SPLIT_DISABLED=1", () => {
  it("mantém o ciclo único serial: pedidos + catálogo + métricas na mesma volta", async () => {
    await __testing.runOnce();

    expect(OrderUseCase.importRecentOrdersForAccount).toHaveBeenCalledTimes(1);
    expect(OrderUseCase.importRecentShopeeOrdersForAccount).toHaveBeenCalledTimes(2);
    expect(OrderUseCase.importRecentMagaluOrdersForAccount).toHaveBeenCalledTimes(1);
    expect(SyncUseCase.importNewShopeeItemsForAccount).toHaveBeenCalledTimes(2);
    expect(MessagesUseCase.syncMagaluMessagesForAccount).toHaveBeenCalledTimes(1);
    expect(syncAllListingsMetrics).toHaveBeenCalledTimes(1);
  });

  it("a janela da Shopee continua limitada a 15 dias pela API", async () => {
    await __testing.runOnce();

    for (const chamada of vi.mocked(OrderUseCase.importRecentShopeeOrdersForAccount).mock.calls) {
      expect(chamada[1]).toBeLessThanOrEqual(15);
    }
  });
});
