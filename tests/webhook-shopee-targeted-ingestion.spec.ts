import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ──────────────────────────────────────────────────────────────────────────────
// Commit 2 — o push da Shopee passa a resolver o pedido que ele mesmo anunciou.
//
// A Shopee entrega o `ordersn` no push (`payload.data.ordersn`), mas o Dexo o
// usava só para a chave de idempotência e para a checagem de cancelamento. Para
// importar, jogava a informação fora e fazia um re-poll cego de 1 dia — ou
// seja, a Shopee dizia exatamente qual pedido mudou e nós varríamos a janela
// torcendo para ele estar lá.
//
// Como a janela era por `create_time`, um pedido criado há 10 dias que só foi
// liberado hoje NUNCA aparecia nesse re-poll: o webhook devolvia
// `no_new_orders` com `success: true` e a venda se perdia com o log dizendo que
// deu tudo certo.
//
// A suíte roda com SHOPEE_WEBHOOK_TARGETED_ORDER_DISABLED=1 (vitest.config)
// para os specs antigos verem a assinatura antiga do re-poll. Aqui ligamos.
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

const ORDERSN = "260729129UM6AS";

const PAYLOAD = {
  shop_id: 1814202747,
  code: 4,
  timestamp: 1785337639,
  data: { ordersn: ORDERSN, status: "SHIPPED" },
};

const CONTA_ATIVA = [
  { id: "acc-1", userId: "owner-1", status: "ACTIVE", shopId: 1814202747 },
];

const semNada = {
  totalOrders: 0,
  imported: 0,
  alreadyExists: 0,
  noProducts: 0,
  errors: 0,
  stockDeductions: 0,
  results: [],
};

const importadoComBaixa = {
  ...semNada,
  totalOrders: 1,
  imported: 1,
  stockDeductions: 1,
  results: [
    {
      success: true,
      orderId: "order-1",
      externalOrderId: ORDERSN,
      status: "imported",
      message: "Pedido Shopee importado com sucesso",
      stockDeducted: true,
      itemsLinked: 1,
      itemsTotal: 1,
    },
  ],
};

let flagAnterior: string | undefined;

beforeEach(() => {
  flagAnterior = process.env.SHOPEE_WEBHOOK_TARGETED_ORDER_DISABLED;
  delete process.env.SHOPEE_WEBHOOK_TARGETED_ORDER_DISABLED;

  vi.mocked((prisma as any).webhookEventLog.create).mockResolvedValue({});
  vi.mocked((prisma as any).webhookEventLog.deleteMany).mockResolvedValue({
    count: 1,
  });
  vi.mocked((prisma as any).order.findFirst).mockResolvedValue(null);
  vi.mocked(MarketplaceRepository.findAllShopeeByShopId).mockResolvedValue(
    CONTA_ATIVA as any,
  );
});

afterEach(() => {
  if (flagAnterior === undefined) {
    delete process.env.SHOPEE_WEBHOOK_TARGETED_ORDER_DISABLED;
  } else {
    process.env.SHOPEE_WEBHOOK_TARGETED_ORDER_DISABLED = flagAnterior;
  }
  vi.clearAllMocks();
});

describe("processShopeeOrderWebhook — ingestão dirigida por ordersn", () => {
  it("passa o ordersn do push para o importador", async () => {
    vi.mocked(
      OrderUseCase.importRecentShopeeOrdersForAccount,
    ).mockResolvedValue(importadoComBaixa as any);

    const r = await WebhookUseCase.processShopeeOrderWebhook(PAYLOAD as any);

    expect(
      OrderUseCase.importRecentShopeeOrdersForAccount,
    ).toHaveBeenCalledWith("acc-1", 1, true, { orderSns: [ORDERSN] });
    expect(r.success).toBe(true);
    expect(r.action).toBe("imported_1_orders");
  });

  it("pedido criado há 10 dias, fora da janela do re-poll, ainda assim entra", async () => {
    // O importador só devolve o pedido porque ele foi buscado por order_sn:
    // a janela de 1 dia por si só não o traria.
    vi.mocked(
      OrderUseCase.importRecentShopeeOrdersForAccount,
    ).mockImplementation(async (_acc, _dias, _baixa, opts?: any) =>
      opts?.orderSns?.includes(ORDERSN)
        ? (importadoComBaixa as any)
        : (semNada as any),
    );

    const r = await WebhookUseCase.processShopeeOrderWebhook(PAYLOAD as any);

    expect(r.success).toBe(true);
    expect(r.action).toBe("imported_1_orders");
    // Antes desta correção o retorno era `no_new_orders` com success:true —
    // "sincronizou sem erro" enquanto a venda se perdia.
    expect(r.action).not.toBe("no_new_orders");
  });

  it("deixa rastro estruturado quando o pedido anunciado não é resolvido", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(
      OrderUseCase.importRecentShopeeOrdersForAccount,
    ).mockResolvedValue(semNada as any);

    await WebhookUseCase.processShopeeOrderWebhook(PAYLOAD as any);

    const logado = logSpy.mock.calls
      .map((c) => String(c[0]))
      .some(
        (l) =>
          l.includes("shopee.webhook.order_not_resolved") && l.includes(ORDERSN),
      );
    expect(logado).toBe(true);
  });

  it("push sem ordersn continua fazendo só o re-poll da janela", async () => {
    vi.mocked(
      OrderUseCase.importRecentShopeeOrdersForAccount,
    ).mockResolvedValue(semNada as any);

    await WebhookUseCase.processShopeeOrderWebhook({
      ...PAYLOAD,
      data: { status: "SHIPPED" },
    } as any);

    expect(
      OrderUseCase.importRecentShopeeOrdersForAccount,
    ).toHaveBeenCalledWith("acc-1", 1, true);
  });

  it("kill-switch SHOPEE_WEBHOOK_TARGETED_ORDER_DISABLED=1 volta ao re-poll cego", async () => {
    process.env.SHOPEE_WEBHOOK_TARGETED_ORDER_DISABLED = "1";
    vi.mocked(
      OrderUseCase.importRecentShopeeOrdersForAccount,
    ).mockResolvedValue(semNada as any);

    await WebhookUseCase.processShopeeOrderWebhook(PAYLOAD as any);

    expect(
      OrderUseCase.importRecentShopeeOrdersForAccount,
    ).toHaveBeenCalledWith("acc-1", 1, true);
  });
});
