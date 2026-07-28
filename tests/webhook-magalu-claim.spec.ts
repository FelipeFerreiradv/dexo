import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ──────────────────────────────────────────────────────────
// Bloco C — o webhook da Magalu deixa de ser um ralo.
//
// Antes: o claim do evento era gravado ANTES do processamento, então qualquer
// falha depois disso (conta não encontrada, token expirado, erro no import)
// queimava o evento — a reentrega da Magalu caía em `duplicate_ignored` e o
// pedido se perdia em definitivo. E o id do pedido, que vem no payload
// (`data.params.id`), era descartado em favor de um poll genérico por janela
// de data.
//
// Agora: o claim é liberado em todo caminho de falha, e o id vai para o
// importador, que busca o pedido exato via GET /seller/v1/orders/{id}.
// ──────────────────────────────────────────────────────────

vi.mock("../app/marketplaces/repositories/marketplace.repository", () => ({
  MarketplaceRepository: {
    findAllByExternalUserId: vi.fn(),
    findAllShopeeByShopId: vi.fn(),
  },
}));

vi.mock("../app/marketplaces/usecases/order.usercase", () => ({
  OrderUseCase: {
    importRecentMagaluOrdersForAccount: vi.fn(),
  },
}));

vi.mock("../app/lib/prisma", () => ({
  default: {
    webhookEventLog: {
      create: vi.fn(),
      deleteMany: vi.fn(),
    },
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
  tenant_id: "tenant-1",
  topic: "orders_order",
  data: { status: "approved", params: { id: "MG-123" } },
} as any;

const CONTA_ATIVA = [{ id: "acc-mg", status: "ACTIVE" }];

const IMPORT_OK = {
  totalOrders: 1,
  imported: 1,
  alreadyExists: 0,
  noProducts: 0,
  errors: 0,
  stockDeductions: 1,
  results: [],
};

beforeEach(() => {
  (prisma as any).webhookEventLog.create = vi
    .fn()
    .mockResolvedValue({ id: "evt-1" });
  (prisma as any).webhookEventLog.deleteMany = vi
    .fn()
    .mockResolvedValue({ count: 1 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("processMagaluOrderWebhook", () => {
  it("passa o id do pedido do payload para o importador", async () => {
    vi.mocked(MarketplaceRepository.findAllByExternalUserId).mockResolvedValue(
      CONTA_ATIVA as any,
    );
    vi.mocked(
      OrderUseCase.importRecentMagaluOrdersForAccount,
    ).mockResolvedValue(IMPORT_OK as any);

    const r = await WebhookUseCase.processMagaluOrderWebhook(PAYLOAD);

    expect(r.success).toBe(true);
    expect(
      OrderUseCase.importRecentMagaluOrdersForAccount,
    ).toHaveBeenCalledWith("acc-mg", 2, true, { orderIds: ["MG-123"] });
    // Sucesso: o claim PERMANECE, para que a reentrega seja ignorada.
    expect((prisma as any).webhookEventLog.deleteMany).not.toHaveBeenCalled();
  });

  it("libera o claim quando a conta não é encontrada (reentrega reprocessável)", async () => {
    vi.mocked(MarketplaceRepository.findAllByExternalUserId).mockResolvedValue(
      [] as any,
    );

    const r = await WebhookUseCase.processMagaluOrderWebhook(PAYLOAD);

    expect(r.success).toBe(false);
    expect((prisma as any).webhookEventLog.deleteMany).toHaveBeenCalledWith({
      where: { source: "MAGALU", externalId: expect.stringContaining("MG-123") },
    });
  });

  it("libera o claim quando a conta não está ativa", async () => {
    vi.mocked(MarketplaceRepository.findAllByExternalUserId).mockResolvedValue([
      { id: "acc-mg", status: "ERROR" },
    ] as any);

    const r = await WebhookUseCase.processMagaluOrderWebhook(PAYLOAD);

    expect(r.success).toBe(false);
    expect((prisma as any).webhookEventLog.deleteMany).toHaveBeenCalled();
  });

  it("libera o claim quando o import reporta erros", async () => {
    vi.mocked(MarketplaceRepository.findAllByExternalUserId).mockResolvedValue(
      CONTA_ATIVA as any,
    );
    vi.mocked(
      OrderUseCase.importRecentMagaluOrdersForAccount,
    ).mockResolvedValue({ ...IMPORT_OK, imported: 0, errors: 2 } as any);

    const r = await WebhookUseCase.processMagaluOrderWebhook(PAYLOAD);

    expect(r.success).toBe(false);
    expect((prisma as any).webhookEventLog.deleteMany).toHaveBeenCalled();
  });

  it("libera o claim quando o import lança", async () => {
    vi.mocked(MarketplaceRepository.findAllByExternalUserId).mockResolvedValue(
      CONTA_ATIVA as any,
    );
    vi.mocked(
      OrderUseCase.importRecentMagaluOrdersForAccount,
    ).mockRejectedValue(new Error("token expirado"));

    const r = await WebhookUseCase.processMagaluOrderWebhook(PAYLOAD);

    expect(r.success).toBe(false);
    expect(r.error).toContain("token expirado");
    expect((prisma as any).webhookEventLog.deleteMany).toHaveBeenCalled();
  });

  it("reentrega do MESMO evento não reimporta (idempotência preservada)", async () => {
    (prisma as any).webhookEventLog.create = vi
      .fn()
      .mockRejectedValue({ code: "P2002" });

    const r = await WebhookUseCase.processMagaluOrderWebhook(PAYLOAD);

    expect(r).toEqual({ success: true, action: "duplicate_ignored" });
    expect(
      OrderUseCase.importRecentMagaluOrdersForAccount,
    ).not.toHaveBeenCalled();
  });

  it("payload sem tenant_id é recusado antes de qualquer claim", async () => {
    const r = await WebhookUseCase.processMagaluOrderWebhook({
      topic: "orders_order",
    } as any);

    expect(r.success).toBe(false);
    expect((prisma as any).webhookEventLog.create).not.toHaveBeenCalled();
    expect((prisma as any).webhookEventLog.deleteMany).not.toHaveBeenCalled();
  });
});
