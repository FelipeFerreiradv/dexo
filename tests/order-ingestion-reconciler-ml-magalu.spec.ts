import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ──────────────────────────────────────────────────────────────────────────────
// Auditoria adversarial de 29/07/2026 — o reconciliador para ML e Magalu.
//
// Antes: `retryIssue` devolvia "Reingestao automatica ainda nao suportada" para
// qualquer plataforma que não fosse Shopee. Como agora ML e Magalu TAMBÉM abrem
// pendência, essa mensagem transformaria toda pendência deles num registro que
// só sobe o contador de tentativas até escalar para STUCK — sem nunca fechar,
// mesmo depois de o problema ter sido resolvido.
//
// ML e Magalu não têm busca dirigida por id, então não há como re-buscar UM
// pedido. Mas quem resolve esses casos é o próprio poll: o pedido não existe
// localmente, logo reaparece na janela a cada ciclo e entra sozinho quando o
// cliente cadastrar o produto. O que faltava era FECHAR a pendência quando isso
// acontece — e fazer isso sem bater na API do marketplace.
// ──────────────────────────────────────────────────────────────────────────────

vi.mock("@/app/lib/prisma", () => ({
  default: {
    orderIngestionIssue: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      upsert: vi.fn(),
    },
    order: { findFirst: vi.fn() },
  },
}));

vi.mock("@/app/services/system-log.service", () => ({
  SystemLogService: {
    logInfo: vi.fn().mockResolvedValue(undefined),
    logWarning: vi.fn().mockResolvedValue(undefined),
    logError: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/app/marketplaces/usecases/order.usercase", () => ({
  OrderUseCase: {
    importRecentShopeeOrdersForAccount: vi.fn(),
    retryStockDeduction: vi.fn(),
    completePartialShopeeOrder: vi.fn(),
  },
}));

import prisma from "@/app/lib/prisma";
import { OrderUseCase } from "@/app/marketplaces/usecases/order.usercase";
import { OrderIngestionReconcilerService } from "@/app/marketplaces/services/order-ingestion-reconciler.service";
import { OrderIngestionIssueService } from "@/app/marketplaces/services/order-ingestion-issue.service";

const issueML = (over: Record<string, any> = {}) => ({
  id: "iss-ml",
  marketplaceAccountId: "acc-ml",
  platform: "MERCADO_LIVRE",
  externalOrderId: "ML-999",
  reason: "NO_LINKED_ITEMS",
  status: "OPEN",
  attempts: 0,
  resolvedOrderId: null,
  payload: null,
  marketplaceAccount: {
    id: "acc-ml",
    platform: "MERCADO_LIVRE",
    status: "ACTIVE",
    userId: "dono-1",
  },
  ...over,
});

// `any` de proposito: ver nota no spec order-ingestion-ml-magalu.
let resolver: any;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.ORDER_INGESTION_RECONCILER_DISABLED;
  delete process.env.ORDER_INGESTION_ISSUES_DISABLED;
  resolver = vi
    .spyOn(OrderIngestionIssueService, "resolve")
    .mockResolvedValue(undefined as any);
  vi.spyOn(OrderIngestionIssueService, "nextRetryFrom").mockReturnValue(
    new Date("2026-07-30T00:00:00Z"),
  );
  (prisma as any).orderIngestionIssue.update.mockResolvedValue({});
  (prisma as any).orderIngestionIssue.findUnique.mockResolvedValue({
    status: "OPEN",
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function retry(iss: any) {
  await (OrderIngestionReconcilerService as any).retryIssue(iss);
}

describe("reconciliador — ML e Magalu", () => {
  it("NUNCA bate na API do marketplace (não existe busca dirigida)", async () => {
    (prisma as any).order.findFirst.mockResolvedValue(null);

    await retry(issueML());

    expect(
      OrderUseCase.importRecentShopeeOrdersForAccount,
    ).not.toHaveBeenCalled();
  });

  it("pedido ainda não importado mantém OPEN e adia", async () => {
    (prisma as any).order.findFirst.mockResolvedValue(null);

    await retry(issueML());

    expect(resolver).not.toHaveBeenCalled();
    const update = (prisma as any).orderIngestionIssue.update.mock.calls[0][0];
    // Nunca existe estado terminal de falha que faça a pendência sumir da tela.
    expect(update.data.status).toBe("OPEN");
    expect(update.data.attempts).toBe(1);
  });

  it("pedido que entrou e baixou FECHA a pendência", async () => {
    (prisma as any).order.findFirst.mockResolvedValue({
      id: "order-ml-1",
      status: "PAID",
      stockDeductedAt: null,
    });
    vi.mocked(OrderUseCase.retryStockDeduction).mockResolvedValue(true as any);

    await retry(issueML());

    expect(OrderUseCase.retryStockDeduction).toHaveBeenCalledWith(
      "order-ml-1",
      "MERCADO_LIVRE",
      "ML-999",
    );
    expect(resolver).toHaveBeenCalledWith("acc-ml", "ML-999", "order-ml-1");
  });

  it("pedido que entrou mas a baixa segue pendente mantém OPEN", async () => {
    (prisma as any).order.findFirst.mockResolvedValue({
      id: "order-ml-1",
      status: "PAID",
      stockDeductedAt: null,
    });
    vi.mocked(OrderUseCase.retryStockDeduction).mockResolvedValue(false as any);

    await retry(issueML());

    expect(resolver).not.toHaveBeenCalled();
    expect(
      (prisma as any).orderIngestionIssue.update.mock.calls[0][0].data.status,
    ).toBe("OPEN");
  });

  it("pedido CANCELLED encerra a pendência sem tentar baixa", async () => {
    (prisma as any).order.findFirst.mockResolvedValue({
      id: "order-ml-1",
      status: "CANCELLED",
      stockDeductedAt: null,
    });

    await retry(issueML());

    expect(OrderUseCase.retryStockDeduction).not.toHaveBeenCalled();
    expect(resolver).toHaveBeenCalledWith("acc-ml", "ML-999", "order-ml-1");
  });

  it("busca o Order escopado pela conta, não só pelo id externo", async () => {
    (prisma as any).order.findFirst.mockResolvedValue(null);

    await retry(issueML());

    // Sem o escopo por conta, o mesmo id externo de OUTRO tenant casaria.
    expect((prisma as any).order.findFirst.mock.calls[0][0].where).toEqual({
      marketplaceAccountId: "acc-ml",
      externalOrderId: "ML-999",
    });
  });

  it("Magalu segue o mesmo caminho", async () => {
    (prisma as any).order.findFirst.mockResolvedValue({
      id: "order-mgl-1",
      status: "PAID",
      stockDeductedAt: null,
    });
    vi.mocked(OrderUseCase.retryStockDeduction).mockResolvedValue(true as any);

    await retry(
      issueML({
        id: "iss-mgl",
        platform: "MAGALU",
        externalOrderId: "MGL-1",
        marketplaceAccountId: "acc-mgl",
        marketplaceAccount: {
          id: "acc-mgl",
          platform: "MAGALU",
          status: "ACTIVE",
          userId: "dono-1",
        },
      }),
    );

    expect(resolver).toHaveBeenCalledWith("acc-mgl", "MGL-1", "order-mgl-1");
  });

  it("conta que não está ACTIVE não chega a consultar o pedido", async () => {
    await retry(
      issueML({
        marketplaceAccount: {
          id: "acc-ml",
          platform: "MERCADO_LIVRE",
          status: "ERROR",
          userId: "dono-1",
        },
      }),
    );

    expect((prisma as any).order.findFirst).not.toHaveBeenCalled();
    expect(resolver).not.toHaveBeenCalled();
  });

  it("STOCK_DEDUCTION_FAILED com orderId usa o caminho direto da baixa", async () => {
    vi.mocked(OrderUseCase.retryStockDeduction).mockResolvedValue(true as any);

    await retry(
      issueML({ reason: "STOCK_DEDUCTION_FAILED", resolvedOrderId: "order-ml-9" }),
    );

    // Este ramo é anterior ao bloco de plataforma e já funcionava para ML.
    expect(OrderUseCase.retryStockDeduction).toHaveBeenCalledWith(
      "order-ml-9",
      "MERCADO_LIVRE",
      "ML-999",
    );
    expect((prisma as any).order.findFirst).not.toHaveBeenCalled();
    expect(resolver).toHaveBeenCalledWith("acc-ml", "ML-999", "order-ml-9");
  });
});

describe("retryOne respeita os kill-switches", () => {
  it("com ORDER_INGESTION_ISSUES_DISABLED=1 não faz nada", async () => {
    process.env.ORDER_INGESTION_ISSUES_DISABLED = "1";

    const r = await OrderIngestionReconcilerService.retryOne("iss-ml");

    expect(r).toEqual({ resolved: false });
    // Com a quarentena desligada o resolve() é no-op: o botão batia na API,
    // baixava estoque e devolvia "não resolvido" para sempre.
    expect((prisma as any).orderIngestionIssue.findUnique).not.toHaveBeenCalled();
  });

  it("com ORDER_INGESTION_RECONCILER_DISABLED=1 não faz nada", async () => {
    process.env.ORDER_INGESTION_RECONCILER_DISABLED = "1";

    const r = await OrderIngestionReconcilerService.retryOne("iss-ml");

    expect(r).toEqual({ resolved: false });
    expect((prisma as any).orderIngestionIssue.findUnique).not.toHaveBeenCalled();
  });
});
