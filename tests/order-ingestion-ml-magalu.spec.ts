import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ──────────────────────────────────────────────────────────────────────────────
// Auditoria adversarial de 29/07/2026 — três achados CRÍTICOS/ALTA do invariante.
//
// A quarentena de ingestão cobria SÓ a Shopee. Ou seja, o invariante do cliente
// — "toda venda concretizada vira Order E baixa estoque, sempre; nenhum caminho
// descarta pedido em silêncio" — valia para um marketplace de três.
//
//  - ML, pedido sem vínculo: `processOrder` devolvia `no_products`, o laço
//    seguia e o SyncLog do ciclo era gravado como SUCCESS. Sem Order, sem
//    SystemLog, sem nada em /pedidos. A venda existia no ML e não existia aqui.
//  - ML, falha de baixa: um `console.error` e nada mais. O ciclo seguinte via o
//    pedido em `already_exists` e NUNCA re-tentava: estoque estufado para
//    sempre, peça seguindo vendável nos outros canais (oversell cross-canal).
//  - Magalu: tinha SystemLog, mas SEM `userId` — e a tela /logs filtra por
//    `userId IN (...)`, onde NULL nunca casa. O dono dos dados não via nada.
//
// Estes testes provam que os três desfechos agora abrem pendência, que o
// sucesso completo FECHA a pendência, e que o veredito do ciclo do ML deixou de
// mentir.
// ──────────────────────────────────────────────────────────────────────────────

vi.mock("@/app/marketplaces/services/stock-sync-retry.service", () => ({
  StockSyncRetryService: { runOnce: vi.fn().mockResolvedValue(undefined) },
}));

import { OrderUseCase } from "@/app/marketplaces/usecases/order.usercase";
import { OrderIngestionIssueService } from "@/app/marketplaces/services/order-ingestion-issue.service";

type Desfecho = {
  success: boolean;
  orderId: string | null;
  externalOrderId: string;
  status: string;
  message: string;
  stockDeducted: boolean;
  itemsLinked: number;
  itemsTotal: number;
};

const desfecho = (over: Partial<Desfecho> = {}): Desfecho => ({
  success: true,
  orderId: "order-1",
  externalOrderId: "ML-999",
  status: "imported",
  message: "ok",
  stockDeducted: true,
  itemsLinked: 1,
  itemsTotal: 1,
  ...over,
});

const registrar = (params: any) =>
  (OrderUseCase as any).registrarDesfechoIngestao(params);

let flagAnterior: string | undefined;
let abrir: ReturnType<typeof vi.spyOn>;
let resolver: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  flagAnterior = process.env.ORDER_INGESTION_ISSUES_ML_MAGALU_DISABLED;
  // A suíte desliga por default (vitest.config) para os specs de import de ML e
  // Magalu ficarem byte-idênticos. Aqui exercitamos o caminho de PRODUÇÃO.
  delete process.env.ORDER_INGESTION_ISSUES_ML_MAGALU_DISABLED;

  abrir = vi
    .spyOn(OrderIngestionIssueService, "open")
    .mockResolvedValue(undefined as any);
  resolver = vi
    .spyOn(OrderIngestionIssueService, "resolve")
    .mockResolvedValue(undefined as any);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (flagAnterior === undefined) {
    delete process.env.ORDER_INGESTION_ISSUES_ML_MAGALU_DISABLED;
  } else {
    process.env.ORDER_INGESTION_ISSUES_ML_MAGALU_DISABLED = flagAnterior;
  }
});

describe("quarentena do ML", () => {
  it("pedido sem vínculo abre NO_LINKED_ITEMS", async () => {
    await registrar({
      platform: "MERCADO_LIVRE",
      marketplaceAccountId: "acc-ml",
      resultado: desfecho({
        success: false,
        orderId: null,
        status: "no_products",
        itemsLinked: 0,
        itemsTotal: 2,
      }),
      esperavaBaixa: true,
    });

    expect(abrir).toHaveBeenCalledTimes(1);
    expect(abrir.mock.calls[0][0]).toMatchObject({
      marketplaceAccountId: "acc-ml",
      platform: "MERCADO_LIVRE",
      externalOrderId: "ML-999",
      reason: "NO_LINKED_ITEMS",
    });
  });

  it("falha de baixa abre STOCK_DEDUCTION_FAILED com o orderId", async () => {
    await registrar({
      platform: "MERCADO_LIVRE",
      marketplaceAccountId: "acc-ml",
      resultado: desfecho({ stockDeducted: false }),
      esperavaBaixa: true,
    });

    expect(abrir.mock.calls[0][0]).toMatchObject({
      reason: "STOCK_DEDUCTION_FAILED",
      orderId: "order-1",
    });
  });

  it("pedido NÃO pago não abre pendência de baixa", async () => {
    // `esperavaBaixa: false` = o pedido não devia baixar (ML só baixa em "paid").
    await registrar({
      platform: "MERCADO_LIVRE",
      marketplaceAccountId: "acc-ml",
      resultado: desfecho({ stockDeducted: false }),
      esperavaBaixa: false,
    });

    expect(abrir).not.toHaveBeenCalled();
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it("vínculo parcial abre PARTIAL_LINK", async () => {
    await registrar({
      platform: "MERCADO_LIVRE",
      marketplaceAccountId: "acc-ml",
      resultado: desfecho({ itemsLinked: 1, itemsTotal: 3 }),
      esperavaBaixa: true,
    });

    expect(abrir.mock.calls[0][0]).toMatchObject({ reason: "PARTIAL_LINK" });
  });

  it("baixa que falhou tem precedência sobre vínculo parcial", async () => {
    // Abrir PARTIAL_LINK aqui sobrescreveria o motivo e mandaria o
    // reconciliador pelo caminho errado — ele decide a partir do `reason`.
    await registrar({
      platform: "MERCADO_LIVRE",
      marketplaceAccountId: "acc-ml",
      resultado: desfecho({ stockDeducted: false, itemsLinked: 1, itemsTotal: 3 }),
      esperavaBaixa: true,
    });

    expect(abrir).toHaveBeenCalledTimes(1);
    expect(abrir.mock.calls[0][0]).toMatchObject({
      reason: "STOCK_DEDUCTION_FAILED",
    });
  });

  it("erro inesperado abre INGEST_FAILED", async () => {
    await registrar({
      platform: "MERCADO_LIVRE",
      marketplaceAccountId: "acc-ml",
      resultado: desfecho({
        success: false,
        orderId: null,
        status: "error",
        message: "banco fora do ar",
      }),
      esperavaBaixa: true,
    });

    expect(abrir.mock.calls[0][0]).toMatchObject({
      reason: "INGEST_FAILED",
      detail: "banco fora do ar",
    });
  });

  it("completo e com baixa FECHA a pendência", async () => {
    await registrar({
      platform: "MERCADO_LIVRE",
      marketplaceAccountId: "acc-ml",
      resultado: desfecho(),
      esperavaBaixa: true,
    });

    expect(abrir).not.toHaveBeenCalled();
    expect(resolver).toHaveBeenCalledWith("acc-ml", "ML-999", "order-1");
  });

  it("already_exists não abre nem fecha nada", async () => {
    await registrar({
      platform: "MERCADO_LIVRE",
      marketplaceAccountId: "acc-ml",
      resultado: desfecho({ status: "already_exists", orderId: null }),
      esperavaBaixa: true,
    });

    expect(abrir).not.toHaveBeenCalled();
    expect(resolver).not.toHaveBeenCalled();
  });

  it("NUNCA guarda payload do pedido (PII sem finalidade)", async () => {
    await registrar({
      platform: "MERCADO_LIVRE",
      marketplaceAccountId: "acc-ml",
      resultado: desfecho({ status: "no_products", orderId: null }),
      esperavaBaixa: true,
    });

    // A reingestão de ML/Magalu não é dirigida por id, então o payload nunca
    // seria lido — guardá-lo seria dado de comprador persistido sem prazo.
    expect(abrir.mock.calls[0][0].payload).toBeNull();
  });
});

describe("quarentena da Magalu", () => {
  it("pedido sem vínculo abre NO_LINKED_ITEMS com platform MAGALU", async () => {
    await registrar({
      platform: "MAGALU",
      marketplaceAccountId: "acc-mgl",
      resultado: desfecho({
        success: false,
        orderId: null,
        externalOrderId: "MGL-1",
        status: "no_products",
        itemsLinked: 0,
        itemsTotal: 1,
      }),
      esperavaBaixa: true,
    });

    expect(abrir.mock.calls[0][0]).toMatchObject({
      platform: "MAGALU",
      externalOrderId: "MGL-1",
      reason: "NO_LINKED_ITEMS",
    });
  });

  it("importado sem baixa abre STOCK_DEDUCTION_FAILED", async () => {
    await registrar({
      platform: "MAGALU",
      marketplaceAccountId: "acc-mgl",
      resultado: desfecho({ externalOrderId: "MGL-2", stockDeducted: false }),
      esperavaBaixa: true,
    });

    expect(abrir.mock.calls[0][0]).toMatchObject({
      platform: "MAGALU",
      reason: "STOCK_DEDUCTION_FAILED",
    });
  });
});

describe("kill-switch e robustez", () => {
  it('ORDER_INGESTION_ISSUES_ML_MAGALU_DISABLED=1 volta ao comportamento anterior', async () => {
    process.env.ORDER_INGESTION_ISSUES_ML_MAGALU_DISABLED = "1";

    await registrar({
      platform: "MERCADO_LIVRE",
      marketplaceAccountId: "acc-ml",
      resultado: desfecho({ status: "no_products", orderId: null }),
      esperavaBaixa: true,
    });

    expect(abrir).not.toHaveBeenCalled();
    expect(resolver).not.toHaveBeenCalled();
  });

  it("falha ao registrar a quarentena NUNCA propaga", async () => {
    abrir.mockRejectedValue(new Error("tabela nao existe"));

    // Um throw aqui abortaria o laço de import e trocaria um pedido incompleto
    // por NENHUM pedido — o oposto do objetivo.
    await expect(
      registrar({
        platform: "MERCADO_LIVRE",
        marketplaceAccountId: "acc-ml",
        resultado: desfecho({ status: "no_products", orderId: null }),
        esperavaBaixa: true,
      }),
    ).resolves.toBeUndefined();
  });
});
