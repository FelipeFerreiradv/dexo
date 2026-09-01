import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

// ──────────────────────────────────────────────────────────────────────────
// Devolução na Shopee — contrato §5.8.
//
// `TO_RETURN` mapeia para `SHIPPED` de propósito desde 29/07/2026: a venda
// aconteceu e a peça saiu, então NÃO estornar está certo e não muda aqui.
//
// O que faltava era a OUTRA PONTA. Quando a peça volta de verdade, ninguém dá
// entrada dela e ela some do estoque — o furo espelhado do bug do ML, com o
// sinal invertido. A pendência é a pergunta que faltava fazer.
//
// Prova:
//  - `TO_RETURN` continua virando SHIPPED (zero mudança de estoque);
//  - abre a MESMA pendência de devolução, com `SHOPEE_TO_RETURN`;
//  - nenhum outro status abre pendência;
//  - kill-switch SHOPEE_RETURN_PENDENCY_DISABLED=1 restaura o de hoje.
// ──────────────────────────────────────────────────────────────────────────

vi.mock("@/app/marketplaces/services/stock-sync-retry.service", () => ({
  StockSyncRetryService: { runOnce: vi.fn().mockResolvedValue(undefined) },
}));

import { OrderUseCase } from "@/app/marketplaces/usecases/order.usercase";
import { MarketplaceRepository } from "@/app/marketplaces/repositories/marketplace.repository";
import { ShopeeApiService } from "@/app/marketplaces/services/shopee-api.service";
import { orderRepository } from "@/app/repositories/order.repository";
import { OrderReturnPendencyService } from "@/app/marketplaces/services/order-return-pendency.service";
import { OrderIngestionIssueService } from "@/app/marketplaces/services/order-ingestion-issue.service";
import prisma from "@/app/lib/prisma";

const ACC = {
  id: "acc-1",
  userId: "owner-1",
  accessToken: "token",
  refreshToken: "refresh",
  shopId: 123,
};

const pedido = (over: Record<string, any> = {}) => ({
  order_sn: "SN-1",
  order_status: "SHIPPED",
  total_amount: 100,
  buyer_username: "cliente",
  create_time: Math.floor(Date.now() / 1000),
  update_time: Math.floor(Date.now() / 1000),
  item_list: [{ item_id: 999, item_sku: "3060", model_quantity_purchased: 1 }],
  ...over,
});

let abrirPendencia: any;

beforeEach(() => {
  // A suíte desliga por default (vitest.config); este é o spec da correção.
  delete process.env.SHOPEE_RETURN_PENDENCY_DISABLED;
  delete process.env.ORDER_RETURN_HOLD_DISABLED;
  // `TO_RETURN` só chega ao laço de importação com a janela por `update_time`
  // ligada — que é o default de PRODUÇÃO. A suíte a desliga para os specs
  // antigos; aqui ligamos, senão o pedido cai na whitelist fechada do caminho
  // legado e o teste provaria o contrário do que quer provar.
  delete process.env.SHOPEE_ORDER_SYNC_BY_UPDATE_TIME_DISABLED;

  vi.spyOn(MarketplaceRepository, "findById").mockResolvedValue(ACC as any);
  vi.spyOn(prisma.order, "findMany").mockResolvedValue([]);
  vi.spyOn(prisma.productListing, "findMany").mockResolvedValue([]);
  vi.spyOn(prisma.syncLog, "create").mockResolvedValue({} as any);
  vi.spyOn(prisma.marketplaceAccount, "update").mockResolvedValue({} as any);
  vi.spyOn(OrderUseCase as any, "mapShopeeOrderItems").mockResolvedValue({
    items: [
      { productId: "prod-1", quantity: 1, unitPrice: 100, listingId: null },
    ],
    linkedCount: 1,
  });
  vi.spyOn(orderRepository, "create").mockResolvedValue({
    id: "order-1",
    items: [
      { productId: "prod-1", quantity: 1, unitPrice: 100, listingId: null },
    ],
  } as any);
  vi.spyOn(OrderUseCase as any, "deductStockForOrder").mockResolvedValue([]);
  abrirPendencia = vi
    .spyOn(OrderReturnPendencyService, "open")
    .mockResolvedValue(undefined);

  // O delegate só existe depois da migration; o caminho de produção usa
  // `(prisma as any).orderReturnPendency`, então injetamos aqui.
  (prisma as any).orderReturnPendency = { findMany: vi.fn(async () => []) };

  // A quarentena de ingestão não é objeto deste spec, e sem stub cada caso
  // gasta ~4s tentando abrir conexão real com o Postgres — 40s no arquivo, o
  // bastante para o teste ficar frágil sob carga na suíte completa.
  vi.spyOn(OrderIngestionIssueService, "open").mockResolvedValue(undefined);
  vi.spyOn(OrderIngestionIssueService, "resolve").mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env.SHOPEE_RETURN_PENDENCY_DISABLED = "1";
  process.env.ORDER_RETURN_HOLD_DISABLED = "1";
  process.env.SHOPEE_ORDER_SYNC_BY_UPDATE_TIME_DISABLED = "1";
});

async function importar(order_status: string) {
  vi.spyOn(ShopeeApiService, "getOrderList").mockResolvedValue({
    more: false,
    order_list: [{ order_sn: "SN-1" }],
  } as any);
  vi.spyOn(ShopeeApiService, "getOrderDetails").mockResolvedValue([
    pedido({ order_status }),
  ] as any);
  return OrderUseCase.importRecentShopeeOrdersForAccount("acc-1", 7, true);
}

describe("§5.8 — Shopee TO_RETURN", () => {
  it("abre a pendência de devolução com o motivo SHOPEE_TO_RETURN", async () => {
    await importar("TO_RETURN");

    expect(abrirPendencia).toHaveBeenCalledWith(
      expect.objectContaining({
        marketplaceAccountId: "acc-1",
        platform: "SHOPEE",
        externalOrderId: "SN-1",
        reason: "SHOPEE_TO_RETURN",
      }),
    );
  });

  it("⭐ continua SEM estornar — o mapeamento para SHIPPED não muda", async () => {
    const r = await importar("TO_RETURN");
    // O pedido entra normalmente e a baixa da venda acontece como sempre: a
    // peça saiu, e é exatamente isso que TO_RETURN significa. A pendência não
    // desfaz nada — ela só faz a pergunta sobre o retorno.
    expect(r.imported).toBe(1);
    expect((OrderUseCase as any).mapShopeeStatus("TO_RETURN")).toBe("SHIPPED");
    expect((OrderUseCase as any).deductStockForOrder).toHaveBeenCalled();
  });

  it("a evidência guarda o status cru, sem dado do comprador", async () => {
    await importar("TO_RETURN");
    const arg = abrirPendencia.mock.calls[0][0];
    expect(arg.evidencia).toMatchObject({ orderStatus: "TO_RETURN" });
    expect(JSON.stringify(arg)).not.toContain("cliente");
  });
});

describe("EGRESS — a pergunta é feita UMA vez, não a cada 15 minutos", () => {
  it("⭐ devolução já registrada não reabre nada (pré-carga em lote)", async () => {
    // A janela do poll revisita o mesmo pedido por dias, a 96 ciclos/dia. Sem
    // esta guarda, cada ciclo faria 1 `findUnique` + 1 `upsert` reescrevendo
    // valores idênticos — 576 queries e 288 UPDATEs inúteis por pedido.
    (prisma as any).orderReturnPendency.findMany = vi.fn(async () => [
      { externalOrderId: "SN-1" },
    ]);

    await importar("TO_RETURN");

    expect(abrirPendencia).not.toHaveBeenCalled();
  });

  it("a pré-carga é UMA consulta em lote, escopada pela conta", async () => {
    await importar("TO_RETURN");
    const findMany = (prisma as any).orderReturnPendency.findMany;
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          marketplaceAccountId: "acc-1",
          externalOrderId: { in: ["SN-1"] },
          reason: "SHOPEE_TO_RETURN",
        }),
        select: { externalOrderId: true },
      }),
    );
  });

  it("lote SEM nenhuma devolução não gasta consulta nenhuma", async () => {
    await importar("SHIPPED");
    expect((prisma as any).orderReturnPendency.findMany).not.toHaveBeenCalled();
  });

  it("kill-switch ligado não gasta nem a pré-carga", async () => {
    process.env.SHOPEE_RETURN_PENDENCY_DISABLED = "1";
    await importar("TO_RETURN");
    expect((prisma as any).orderReturnPendency.findMany).not.toHaveBeenCalled();
  });
});

describe("NÃO-INTERFERÊNCIA", () => {
  it("pedido normal (SHIPPED) não abre pendência nenhuma", async () => {
    await importar("SHIPPED");
    expect(abrirPendencia).not.toHaveBeenCalled();
  });

  it("COMPLETED não abre pendência", async () => {
    await importar("COMPLETED");
    expect(abrirPendencia).not.toHaveBeenCalled();
  });

  it("kill-switch SHOPEE_RETURN_PENDENCY_DISABLED=1 → nada abre", async () => {
    process.env.SHOPEE_RETURN_PENDENCY_DISABLED = "1";
    const r = await importar("TO_RETURN");
    expect(abrirPendencia).not.toHaveBeenCalled();
    // E o import segue idêntico ao de hoje.
    expect(r.imported).toBe(1);
  });
});
