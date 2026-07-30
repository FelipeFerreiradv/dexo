import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ──────────────────────────────────────────────────────────────────────────────
// Regressão MEDIDA EM PRODUÇÃO em 30/07/2026, causada pelo próprio trabalho de
// quarentena.
//
// `open()` gravava um SystemLog e uma linha de log estruturado a CADA chamada. Um
// pedido cujos itens não vinculam nunca vira Order completo, então reaparece em
// toda passada do poll (15 min) e em toda volta do reconciliador (10 min). Com
// 166 pendências abertas, o resultado medido foi:
//
//   ORDER_INGESTION_ISSUE WARNING: 2376 em 2 horas
//
// Cerca de 28 mil linhas por dia, para sempre, todas dizendo a MESMA coisa sobre
// os MESMOS pedidos. A tabela cresceria sozinha e o aviso viraria ruído — que é
// o oposto do objetivo da quarentena.
//
// Ironia registrada: o caminho da Magalu já tinha uma guarda de dedupe em
// processo, com um comentário explicando exatamente este risco. O `open()`
// genérico não tinha.
//
// Agora o AVISO sai só quando muda algo: pendência nova, motivo diferente, ou
// pendência que estava RESOLVED e reabriu. A LINHA NO BANCO continua sendo
// atualizada em toda chamada — o dado não pode ficar velho.
// ──────────────────────────────────────────────────────────────────────────────

vi.mock("@/app/lib/prisma", () => ({
  default: {
    orderIngestionIssue: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

vi.mock("@/app/services/system-log.service", () => ({
  SystemLogService: {
    logInfo: vi.fn().mockResolvedValue(undefined),
    logWarning: vi.fn().mockResolvedValue(undefined),
    logError: vi.fn().mockResolvedValue(undefined),
  },
}));

import prisma from "@/app/lib/prisma";
import { SystemLogService } from "@/app/services/system-log.service";
import { OrderIngestionIssueService } from "@/app/marketplaces/services/order-ingestion-issue.service";

const ENTRADA = {
  marketplaceAccountId: "acc-1",
  platform: "SHOPEE" as const,
  externalOrderId: "SN-1",
  reason: "NO_LINKED_ITEMS" as const,
  detail: "item 1 (SKU \"X\"): PRODUCT_NOT_FOUND",
};

let logSpy: any;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.ORDER_INGESTION_ISSUES_DISABLED;
  (prisma as any).orderIngestionIssue.upsert.mockResolvedValue({});
  // O `restoreAllMocks` do afterEach zera as implementações, e o código faz
  // `.catch()` no retorno — sem promise, quebra por motivo que não é o do teste.
  vi.mocked(SystemLogService.logWarning).mockResolvedValue(undefined as never);
  vi.mocked(SystemLogService.logInfo).mockResolvedValue(undefined as never);
  vi.mocked(SystemLogService.logError).mockResolvedValue(undefined as never);
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const quarentenados = () =>
  logSpy.mock.calls.filter((c: any[]) =>
    String(c[0]).includes("order_import.quarantined"),
  ).length;

describe("open() avisa uma vez, mas grava sempre", () => {
  it("pendência NOVA avisa", async () => {
    (prisma as any).orderIngestionIssue.findUnique.mockResolvedValue(null);

    await OrderIngestionIssueService.open(ENTRADA);

    expect((prisma as any).orderIngestionIssue.upsert).toHaveBeenCalledTimes(1);
    expect(SystemLogService.logWarning).toHaveBeenCalledTimes(1);
    expect(quarentenados()).toBe(1);
  });

  it("MESMA pendência, MESMO motivo: grava e NÃO avisa", async () => {
    (prisma as any).orderIngestionIssue.findUnique.mockResolvedValue({
      reason: "NO_LINKED_ITEMS",
      status: "OPEN",
    });

    await OrderIngestionIssueService.open(ENTRADA);

    // O dado é atualizado — não pode ficar velho.
    expect((prisma as any).orderIngestionIssue.upsert).toHaveBeenCalledTimes(1);
    // Mas o aviso não repete: eram 2.376 destes em 2 horas.
    expect(SystemLogService.logWarning).not.toHaveBeenCalled();
    expect(quarentenados()).toBe(0);
  });

  it("dez passadas do poll sobre a mesma pendência = UM aviso", async () => {
    (prisma as any).orderIngestionIssue.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ reason: "NO_LINKED_ITEMS", status: "OPEN" });

    for (let i = 0; i < 10; i++) {
      await OrderIngestionIssueService.open(ENTRADA);
    }

    expect((prisma as any).orderIngestionIssue.upsert).toHaveBeenCalledTimes(10);
    expect(SystemLogService.logWarning).toHaveBeenCalledTimes(1);
  });

  it("motivo DIFERENTE avisa de novo (o problema mudou)", async () => {
    (prisma as any).orderIngestionIssue.findUnique.mockResolvedValue({
      reason: "NO_LINKED_ITEMS",
      status: "OPEN",
    });

    await OrderIngestionIssueService.open({
      ...ENTRADA,
      reason: "STOCK_DEDUCTION_FAILED",
    });

    // Mudar de "não vinculou" para "não baixou" é informação nova, e muda o
    // caminho que o reconciliador vai seguir.
    expect(SystemLogService.logWarning).toHaveBeenCalledTimes(1);
  });

  it("pendência que estava RESOLVED e reabriu avisa", async () => {
    (prisma as any).orderIngestionIssue.findUnique.mockResolvedValue({
      reason: "NO_LINKED_ITEMS",
      status: "RESOLVED",
    });

    await OrderIngestionIssueService.open(ENTRADA);

    // Reabrir é regressão do pedido: tem de aparecer.
    expect(SystemLogService.logWarning).toHaveBeenCalledTimes(1);
  });

  it("falha ao ler o estado anterior avisa (erra para o lado de avisar)", async () => {
    (prisma as any).orderIngestionIssue.findUnique.mockRejectedValue(
      new Error("banco fora"),
    );

    await OrderIngestionIssueService.open(ENTRADA);

    expect((prisma as any).orderIngestionIssue.upsert).toHaveBeenCalledTimes(1);
    expect(SystemLogService.logWarning).toHaveBeenCalledTimes(1);
  });

  it("kill-switch da quarentena não grava nem avisa", async () => {
    process.env.ORDER_INGESTION_ISSUES_DISABLED = "1";

    await OrderIngestionIssueService.open(ENTRADA);

    expect((prisma as any).orderIngestionIssue.findUnique).not.toHaveBeenCalled();
    expect((prisma as any).orderIngestionIssue.upsert).not.toHaveBeenCalled();
    expect(SystemLogService.logWarning).not.toHaveBeenCalled();
    delete process.env.ORDER_INGESTION_ISSUES_DISABLED;
  });
});
