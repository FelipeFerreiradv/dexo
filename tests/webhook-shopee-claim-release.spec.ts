import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ──────────────────────────────────────────────────────────────────────────────
// Commit 2 — o webhook da Shopee deixa de queimar o evento em caso de falha.
//
// O claim é gravado ANTES do processamento (é o que garante idempotência sob
// entrega concorrente). Até 29/07/2026 o caminho Shopee NUNCA liberava esse
// claim: `releaseWebhookEvent` só era chamado no caminho MAGALU. Qualquer falha
// depois do claim — conta não encontrada, conta inativa, múltiplas contas, erro
// de rede, exceção no importador — devolvia `{success:false}` com o claim
// gravado. Quando a Shopee reentregava o MESMO evento, caía em
// `duplicate_ignored` com `success:true` e o pedido se perdia em definitivo:
// a reentrega, que é o mecanismo de segurança do marketplace, passava a
// trabalhar contra o sistema.
// ──────────────────────────────────────────────────────────────────────────────

vi.mock("../app/marketplaces/repositories/marketplace.repository", () => ({
  MarketplaceRepository: {
    findAllShopeeByShopId: vi.fn(),
    findAllByExternalUserId: vi.fn(),
    updateTokens: vi.fn(),
  },
}));

vi.mock("../app/marketplaces/usecases/order.usercase", () => ({
  OrderUseCase: {
    importRecentShopeeOrdersForAccount: vi.fn(),
    processOrderCancellation: vi.fn(),
  },
}));

vi.mock("../app/lib/prisma", () => ({
  default: {
    webhookEventLog: { create: vi.fn(), deleteMany: vi.fn() },
    order: { findFirst: vi.fn() },
    marketplaceAccount: { findUnique: vi.fn() },
  },
}));

vi.mock("../app/services/system-log.service", () => ({
  SystemLogService: {
    logWarning: vi.fn().mockResolvedValue(undefined),
    logError: vi.fn().mockResolvedValue(undefined),
    logInfo: vi.fn().mockResolvedValue(undefined),
  },
}));

import prisma from "../app/lib/prisma";
import { MarketplaceRepository } from "../app/marketplaces/repositories/marketplace.repository";
import { OrderUseCase } from "../app/marketplaces/usecases/order.usercase";
import { WebhookUseCase } from "../app/marketplaces/usecases/webhook.usercase";

const PAYLOAD = {
  shop_id: 1814202747,
  code: 4,
  timestamp: 1785337639,
  data: { ordersn: "260729129UM6AS", status: "SHIPPED" },
};

const CONTA_ATIVA = [
  { id: "acc-1", userId: "owner-1", status: "ACTIVE", shopId: 1814202747 },
];

const IMPORT_OK = {
  totalOrders: 1,
  imported: 1,
  alreadyExists: 0,
  noProducts: 0,
  errors: 0,
  stockDeductions: 1,
  results: [
    {
      success: true,
      orderId: "o1",
      externalOrderId: "260729129UM6AS",
      status: "imported",
      message: "ok",
      stockDeducted: true,
      itemsLinked: 1,
      itemsTotal: 1,
    },
  ],
};

beforeEach(() => {
  vi.mocked((prisma as any).webhookEventLog.create).mockResolvedValue({});
  vi.mocked((prisma as any).webhookEventLog.deleteMany).mockResolvedValue({
    count: 1,
  });
  vi.mocked((prisma as any).order.findFirst).mockResolvedValue(null);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("processShopeeOrderWebhook — liberação do claim", () => {
  it("conta não encontrada libera o claim (a reentrega volta a ser processável)", async () => {
    vi.mocked(MarketplaceRepository.findAllShopeeByShopId).mockResolvedValue(
      [] as any,
    );

    const r = await WebhookUseCase.processShopeeOrderWebhook(PAYLOAD as any);

    expect(r.success).toBe(false);
    expect((prisma as any).webhookEventLog.deleteMany).toHaveBeenCalledWith({
      where: {
        source: "SHOPEE",
        externalId: "1814202747:4:260729129UM6AS:1785337639",
      },
    });
  });

  it("múltiplas contas para o mesmo shop_id libera o claim", async () => {
    vi.mocked(MarketplaceRepository.findAllShopeeByShopId).mockResolvedValue([
      ...CONTA_ATIVA,
      { id: "acc-2", userId: "owner-2", status: "ACTIVE" },
    ] as any);

    const r = await WebhookUseCase.processShopeeOrderWebhook(PAYLOAD as any);

    expect(r.success).toBe(false);
    expect((prisma as any).webhookEventLog.deleteMany).toHaveBeenCalled();
  });

  it("conta não ACTIVE libera o claim", async () => {
    vi.mocked(MarketplaceRepository.findAllShopeeByShopId).mockResolvedValue([
      { id: "acc-1", userId: "owner-1", status: "ERROR" },
    ] as any);

    const r = await WebhookUseCase.processShopeeOrderWebhook(PAYLOAD as any);

    expect(r.success).toBe(false);
    expect((prisma as any).webhookEventLog.deleteMany).toHaveBeenCalled();
  });

  it("erros na importação liberam o claim", async () => {
    vi.mocked(MarketplaceRepository.findAllShopeeByShopId).mockResolvedValue(
      CONTA_ATIVA as any,
    );
    vi.mocked(
      OrderUseCase.importRecentShopeeOrdersForAccount,
    ).mockResolvedValue({ ...IMPORT_OK, errors: 2 } as any);

    const r = await WebhookUseCase.processShopeeOrderWebhook(PAYLOAD as any);

    expect(r.success).toBe(false);
    expect((prisma as any).webhookEventLog.deleteMany).toHaveBeenCalled();
  });

  it("exceção no importador (token, rede, banco) libera o claim", async () => {
    vi.mocked(MarketplaceRepository.findAllShopeeByShopId).mockResolvedValue(
      CONTA_ATIVA as any,
    );
    vi.mocked(
      OrderUseCase.importRecentShopeeOrdersForAccount,
    ).mockRejectedValue(
      new Error("Shopee API 403: Invalid access_token, please have a check."),
    );

    const r = await WebhookUseCase.processShopeeOrderWebhook(PAYLOAD as any);

    expect(r.success).toBe(false);
    expect((prisma as any).webhookEventLog.deleteMany).toHaveBeenCalled();
  });

  it("SUCESSO mantém o claim, para a reentrega ser ignorada", async () => {
    vi.mocked(MarketplaceRepository.findAllShopeeByShopId).mockResolvedValue(
      CONTA_ATIVA as any,
    );
    vi.mocked(
      OrderUseCase.importRecentShopeeOrdersForAccount,
    ).mockResolvedValue(IMPORT_OK as any);

    const r = await WebhookUseCase.processShopeeOrderWebhook(PAYLOAD as any);

    expect(r.success).toBe(true);
    expect((prisma as any).webhookEventLog.deleteMany).not.toHaveBeenCalled();
  });

  it("nada novo a importar também mantém o claim (é resultado legítimo)", async () => {
    vi.mocked(MarketplaceRepository.findAllShopeeByShopId).mockResolvedValue(
      CONTA_ATIVA as any,
    );
    vi.mocked(
      OrderUseCase.importRecentShopeeOrdersForAccount,
    ).mockResolvedValue({
      ...IMPORT_OK,
      imported: 0,
      alreadyExists: 1,
    } as any);

    const r = await WebhookUseCase.processShopeeOrderWebhook(PAYLOAD as any);

    expect(r.success).toBe(true);
    expect(r.action).toBe("no_new_orders");
    expect((prisma as any).webhookEventLog.deleteMany).not.toHaveBeenCalled();
  });

  it("evento duplicado é ignorado sem liberar nada", async () => {
    vi.mocked((prisma as any).webhookEventLog.create).mockRejectedValue({
      code: "P2002",
    });

    const r = await WebhookUseCase.processShopeeOrderWebhook(PAYLOAD as any);

    expect(r).toEqual({ success: true, action: "duplicate_ignored" });
    expect((prisma as any).webhookEventLog.deleteMany).not.toHaveBeenCalled();
  });

  it("reentrega após falha volta a processar e cria o pedido", async () => {
    // 1ª entrega: falha depois do claim.
    vi.mocked(MarketplaceRepository.findAllShopeeByShopId).mockResolvedValue(
      [] as any,
    );
    const primeira = await WebhookUseCase.processShopeeOrderWebhook(
      PAYLOAD as any,
    );
    expect(primeira.success).toBe(false);
    expect((prisma as any).webhookEventLog.deleteMany).toHaveBeenCalled();

    // O claim foi liberado, então o create da reentrega NÃO bate no unique.
    vi.mocked((prisma as any).webhookEventLog.create).mockResolvedValue({});
    vi.mocked(MarketplaceRepository.findAllShopeeByShopId).mockResolvedValue(
      CONTA_ATIVA as any,
    );
    vi.mocked(
      OrderUseCase.importRecentShopeeOrdersForAccount,
    ).mockResolvedValue(IMPORT_OK as any);

    const segunda = await WebhookUseCase.processShopeeOrderWebhook(
      PAYLOAD as any,
    );

    expect(segunda.success).toBe(true);
    expect(segunda.action).toBe("imported_1_orders");
  });
});

describe("processOrderWebhook (ML) — mesma correção", () => {
  const ML_PAYLOAD = {
    resource: "/orders/2000012345",
    user_id: 987,
    sent: "2026-07-29T12:07:19Z",
    topic: "orders_v2",
  };

  it("conta não encontrada libera o claim", async () => {
    vi.mocked(MarketplaceRepository.findAllByExternalUserId).mockResolvedValue(
      [] as any,
    );

    const r = await WebhookUseCase.processOrderWebhook(ML_PAYLOAD as any);

    expect(r.success).toBe(false);
    expect((prisma as any).webhookEventLog.deleteMany).toHaveBeenCalledWith({
      where: {
        source: "ML",
        externalId: "/orders/2000012345:987:2026-07-29T12:07:19Z",
      },
    });
  });

  it("resource inválido nem chega a reivindicar o evento", async () => {
    const r = await WebhookUseCase.processOrderWebhook({
      ...ML_PAYLOAD,
      resource: "/questions/123",
    } as any);

    expect(r.success).toBe(false);
    expect((prisma as any).webhookEventLog.create).not.toHaveBeenCalled();
    expect((prisma as any).webhookEventLog.deleteMany).not.toHaveBeenCalled();
  });
});
