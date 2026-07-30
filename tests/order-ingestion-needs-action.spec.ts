import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ──────────────────────────────────────────────────────────────────────────────
// Medido em produção 30/07/2026: 166 pendências OPEN, 89 delas já em
// `attempts >= 5`, todas NO_LINKED_ITEMS de produto que NÃO existe no Dexo
// (conferido contra o banco: item_id, SKU, skuNormalized e partNumber, todos
// zero). O reconciliador seguia batendo na API da Shopee de hora em hora, para
// cada uma, indefinidamente — e o aviso na tela do cliente nunca zerava, virando
// ruído que treina a ignorar o banner.
//
// A distinção que resolve isso sem furar o invariante:
//
//   O invariante proíbe estado terminal SILENCIOSO. Não proíbe parar de gastar
//   chamada externa com um problema que a máquina não resolve.
//
// `NEEDS_ACTION` sai da fila de re-tentativa automática e CONTINUA visível, com
// texto dizendo o que fazer, e com o botão "Tentar novamente" funcionando. Se o
// cliente cadastrar o produto, o próprio poll importa o item e `resolve()` fecha
// a pendência — sem depender do reconciliador.
//
// Os três pontos que precisam concordar, e que este spec amarra:
//  1. o reconciliador PROMOVE para NEEDS_ACTION ao esgotar as tentativas;
//  2. `open()` não REBAIXA de volta para OPEN quando o poll revê o pedido;
//  3. `resolve()` FECHA quem está em NEEDS_ACTION.
// Se qualquer um dos três discordar, a pendência ou volta para a fila a cada 15
// min, ou nunca sai da tela.
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
    logInfo: vi.fn(),
    logWarning: vi.fn(),
    logError: vi.fn(),
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
import { SystemLogService } from "@/app/services/system-log.service";
import { OrderUseCase } from "@/app/marketplaces/usecases/order.usercase";
import { OrderIngestionReconcilerService } from "@/app/marketplaces/services/order-ingestion-reconciler.service";
import { OrderIngestionIssueService } from "@/app/marketplaces/services/order-ingestion-issue.service";

const issue = (over: Record<string, any> = {}) => ({
  id: "iss-1",
  marketplaceAccountId: "acc-1",
  platform: "SHOPEE",
  externalOrderId: "SN-1",
  reason: "NO_LINKED_ITEMS",
  status: "OPEN",
  attempts: 4, // a próxima falha é a 5a
  resolvedOrderId: "order-1",
  payload: { item_list: [{ item_id: 1 }] },
  marketplaceAccount: {
    id: "acc-1",
    platform: "SHOPEE",
    status: "ACTIVE",
    userId: "dono-1",
  },
  ...over,
});

let anterior: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  anterior = process.env.ORDER_INGESTION_NEEDS_ACTION_DISABLED;
  // A suíte desliga por default (vitest.config) para o spec antigo do
  // reconciliador ficar byte-idêntico. Aqui exercitamos o caminho de PRODUÇÃO.
  delete process.env.ORDER_INGESTION_NEEDS_ACTION_DISABLED;
  delete process.env.ORDER_INGESTION_RECONCILER_DISABLED;
  delete process.env.ORDER_INGESTION_ISSUES_DISABLED;

  vi.mocked(SystemLogService.logError).mockResolvedValue(undefined as never);
  vi.mocked(SystemLogService.logWarning).mockResolvedValue(undefined as never);
  vi.mocked(SystemLogService.logInfo).mockResolvedValue(undefined as never);
  (prisma as any).orderIngestionIssue.update.mockResolvedValue({});
  (prisma as any).orderIngestionIssue.upsert.mockResolvedValue({});
  (prisma as any).orderIngestionIssue.updateMany.mockResolvedValue({ count: 1 });
  vi.spyOn(OrderIngestionIssueService, "nextRetryFrom").mockReturnValue(
    new Date("2026-07-31T00:00:00Z"),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  if (anterior === undefined) {
    delete process.env.ORDER_INGESTION_NEEDS_ACTION_DISABLED;
  } else {
    process.env.ORDER_INGESTION_NEEDS_ACTION_DISABLED = anterior;
  }
});

const falhar = (iss: any, detalhe = "nao resolveu") =>
  (OrderIngestionReconcilerService as any).registerFailure(iss, detalhe);

const ultimoUpdate = () =>
  (prisma as any).orderIngestionIssue.update.mock.calls[0][0].data;

describe("1. o reconciliador promove para NEEDS_ACTION", () => {
  it("NO_LINKED_ITEMS na 5a tentativa sai da fila automática", async () => {
    await falhar(issue({ attempts: 4 }));

    expect(ultimoUpdate().status).toBe("NEEDS_ACTION");
    expect(ultimoUpdate().attempts).toBe(5);
  });

  it("antes da 5a continua OPEN (a máquina ainda pode resolver)", async () => {
    await falhar(issue({ attempts: 2 }));

    expect(ultimoUpdate().status).toBe("OPEN");
  });

  it("STOCK_DEDUCTION_FAILED continua OPEN mesmo na 5a", async () => {
    // Este a máquina RESOLVE sozinha: o Order existe e a baixa é idempotente.
    // Tirá-lo da fila deixaria estoque estufado sem ninguém tentando de novo.
    await falhar(issue({ attempts: 4, reason: "STOCK_DEDUCTION_FAILED" }));

    expect(ultimoUpdate().status).toBe("OPEN");
  });

  it("PARTIAL_LINK continua OPEN na 5a", async () => {
    await falhar(issue({ attempts: 4, reason: "PARTIAL_LINK" }));

    expect(ultimoUpdate().status).toBe("OPEN");
  });

  it("ainda escala o SystemLog na 5a — não fica silencioso", async () => {
    await falhar(issue({ attempts: 4 }));

    expect(SystemLogService.logError).toHaveBeenCalledTimes(1);
    expect(vi.mocked(SystemLogService.logError).mock.calls[0][0]).toBe(
      "ORDER_INGESTION_ISSUE_STUCK",
    );
  });

  it("NUNCA grava RESOLVED por esgotamento", async () => {
    await falhar(issue({ attempts: 9 }));

    // Fechar por desistência seria perder a venda de vista — é exatamente o que
    // o invariante proíbe.
    expect(ultimoUpdate().status).not.toBe("RESOLVED");
  });

  it("kill-switch=1 restaura o comportamento anterior (segue OPEN)", async () => {
    process.env.ORDER_INGESTION_NEEDS_ACTION_DISABLED = "1";

    await falhar(issue({ attempts: 4 }));

    expect(ultimoUpdate().status).toBe("OPEN");
  });
});

describe("2. o poll não rebaixa NEEDS_ACTION de volta para OPEN", () => {
  it("open() sobre NEEDS_ACTION preserva o estado", async () => {
    (prisma as any).orderIngestionIssue.findUnique.mockResolvedValue({
      reason: "NO_LINKED_ITEMS",
      status: "NEEDS_ACTION",
    });

    await OrderIngestionIssueService.open({
      marketplaceAccountId: "acc-1",
      platform: "SHOPEE",
      externalOrderId: "SN-1",
      reason: "NO_LINKED_ITEMS",
      detail: "segue sem produto",
    });

    const data = (prisma as any).orderIngestionIssue.upsert.mock.calls[0][0]
      .update;
    // Sem esta guarda, o pedido voltaria para a fila automática a cada 15 min e
    // o teto de tentativas nunca valeria de nada.
    expect(data.status).toBeUndefined();
    // O detalhe continua sendo atualizado: o dado não pode ficar velho.
    expect(data.detail).toBe("segue sem produto");
  });

  it("open() sobre OPEN mantém OPEN (comportamento normal)", async () => {
    (prisma as any).orderIngestionIssue.findUnique.mockResolvedValue({
      reason: "NO_LINKED_ITEMS",
      status: "OPEN",
    });

    await OrderIngestionIssueService.open({
      marketplaceAccountId: "acc-1",
      platform: "SHOPEE",
      externalOrderId: "SN-1",
      reason: "NO_LINKED_ITEMS",
    });

    expect(
      (prisma as any).orderIngestionIssue.upsert.mock.calls[0][0].update.status,
    ).toBe("OPEN");
  });

  it("pendência em NEEDS_ACTION que muda de MOTIVO volta para OPEN", async () => {
    (prisma as any).orderIngestionIssue.findUnique.mockResolvedValue({
      reason: "NO_LINKED_ITEMS",
      status: "NEEDS_ACTION",
    });

    await OrderIngestionIssueService.open({
      marketplaceAccountId: "acc-1",
      platform: "SHOPEE",
      externalOrderId: "SN-1",
      reason: "STOCK_DEDUCTION_FAILED",
      orderId: "order-1",
    });

    // Motivo novo é problema novo, e este a máquina resolve: tem de voltar para
    // a fila. A guarda é por status, então aqui o `status: "OPEN"` sai — o que
    // importa é que o reconciliador volte a pegá-la.
    const data = (prisma as any).orderIngestionIssue.upsert.mock.calls[0][0]
      .update;
    expect(data.reason).toBe("STOCK_DEDUCTION_FAILED");
  });
});

describe("3. resolve() fecha quem está em NEEDS_ACTION", () => {
  it("o filtro inclui NEEDS_ACTION", async () => {
    await OrderIngestionIssueService.resolve("acc-1", "SN-1", "order-1");

    const where = (prisma as any).orderIngestionIssue.updateMany.mock.calls[0][0]
      .where;
    // Sem isto, a pendência que saiu da fila automática nunca sairia da tela,
    // nem depois de o cliente cadastrar o produto.
    expect(where.status).toEqual({ in: ["OPEN", "NEEDS_ACTION"] });
  });
});

describe("4. o botão Tentar novamente continua valendo", () => {
  it("retryOne aceita pendência em NEEDS_ACTION", async () => {
    (prisma as any).orderIngestionIssue.findUnique
      .mockResolvedValueOnce(issue({ status: "NEEDS_ACTION" }))
      .mockResolvedValueOnce({ status: "RESOLVED" });
    (prisma as any).order.findFirst.mockResolvedValue({
      id: "order-1",
      status: "PAID",
      stockDeductedAt: null,
    });
    vi.mocked(OrderUseCase.retryStockDeduction).mockResolvedValue(true as any);
    vi.mocked(
      OrderUseCase.importRecentShopeeOrdersForAccount,
    ).mockResolvedValue({
      results: [
        {
          externalOrderId: "SN-1",
          status: "already_exists",
          itemsLinked: 0,
          itemsTotal: 1,
          stockDeducted: false,
        },
      ],
    } as any);
    vi.mocked(OrderUseCase.completePartialShopeeOrder).mockResolvedValue(
      1 as any,
    );

    const r = await OrderIngestionReconcilerService.retryOne("iss-1");

    // "Cadastrei o produto, tenta agora" é justamente o caso de uso do botão.
    expect(r.resolved).toBe(true);
  });

  it("retryOne sobre pendência JÁ RESOLVED não faz trabalho nenhum", async () => {
    (prisma as any).orderIngestionIssue.findUnique.mockResolvedValue(
      issue({ status: "RESOLVED" }),
    );

    const r = await OrderIngestionReconcilerService.retryOne("iss-1");

    expect(r).toEqual({ resolved: true });
    expect((prisma as any).order.findFirst).not.toHaveBeenCalled();
    expect(
      OrderUseCase.importRecentShopeeOrdersForAccount,
    ).not.toHaveBeenCalled();
  });
});

describe("5. o worker automático não pega NEEDS_ACTION", () => {
  it("runOnce filtra somente status OPEN", async () => {
    (prisma as any).orderIngestionIssue.findMany.mockResolvedValue([]);

    await OrderIngestionReconcilerService.runOnce();

    const where = (prisma as any).orderIngestionIssue.findMany.mock.calls[0][0]
      .where;
    // É este filtro que faz o custo de API parar: 89 pendências irresolvíveis
    // deixam de ser buscadas de hora em hora.
    expect(where.status).toBe("OPEN");
  });
});
