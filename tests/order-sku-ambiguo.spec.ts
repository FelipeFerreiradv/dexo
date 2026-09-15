import { describe, it, expect, vi, afterEach } from "vitest";

// Mesmo stub do order.usecase.spec.ts: deductStockForOrder dispara um
// setImmediate pós-commit que chamaria o prisma real.
vi.mock("@/app/marketplaces/services/stock-sync-retry.service", () => ({
  StockSyncRetryService: { runOnce: vi.fn().mockResolvedValue(undefined) },
}));

import { OrderUseCase } from "@/app/marketplaces/usecases/order.usercase";
import { orderRepository } from "@/app/repositories/order.repository";
import prisma from "@/app/lib/prisma";
import { ListingRepository } from "@/app/marketplaces/repositories/listing.repository";

/**
 * A venda tem de baixar a peça certa — ou não baixar nada.
 *
 * Dois casos reais, medidos em produção em 14/09/2026:
 *
 * 1) SKU AMBÍGUO (Desmanche Tijuco Preto). Três anúncios de "Chicote de
 *    Injeção" carregavam `seller_sku = 12506`, e o catálogo tinha um "Puxador"
 *    com SKU 12506 vindo da etiqueta. Um `findFirst` sem desempate escolhia
 *    qualquer um, e o acerto GRAVAVA o vínculo — o erro colava e passava a ser
 *    confirmado pela via do `externalListingId`. Vendeu chicote, baixou puxador.
 *
 * 2) SKU ÚNICO E ERRADO (Motors Mania). UM produto com SKU "1" e 7.328 anúncios
 *    carregando "1" no `seller_sku`. O casamento é unívoco — a guarda de
 *    ambiguidade não pega — e está errado: 39 vendas de peças distintas foram
 *    lançadas numa única bobina de ignição entre 14/07 e 27/07.
 *
 * Auditoria dos 10.081 pedidos dos 22 clientes com conta ML ativa: 90 baixaram
 * em produto diferente do dono do anúncio.
 */
const pedido = (sellerSku: string | null, titulo: string) => ({
  id: 999,
  status: "paid",
  total_amount: 100,
  buyer: { first_name: "Jo", last_name: "Silva", nickname: "jo" },
  order_items: [
    {
      quantity: 1,
      unit_price: 100,
      item: {
        id: "MLB-TESTE",
        title: titulo,
        seller_custom_field: sellerSku,
        seller_sku: null,
      },
    },
  ],
});

const CHICOTE = "Chicote De Injeção Gm Vectra 2.2 2001";

describe("resolução do item do pedido por SKU", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("RECUSA vincular quando o SKU casa com mais de um produto do mesmo dono", async () => {
    vi.spyOn(orderRepository, "exists").mockResolvedValue(false);
    vi.spyOn(prisma.productListing, "findUnique").mockResolvedValue(null);
    // Dois produtos com o mesmo skuNormalized: a unique é sobre o sku CRU,
    // então "12506" e "12506 " coexistem no mesmo dono.
    vi.spyOn(prisma.product, "findMany").mockResolvedValue([
      { id: "prod-puxador", name: "Puxador Interno Porta Traseira" },
      { id: "prod-chicote", name: CHICOTE },
    ] as never);
    const upsert = vi
      .spyOn(ListingRepository, "upsertFromOrderFallback")
      .mockResolvedValue({ id: "listing-x" } as never);
    const criar = vi.spyOn(orderRepository, "create");

    const r = await (
      OrderUseCase as never as {
        processOrder: (...a: unknown[]) => Promise<{ status?: string }>;
      }
    ).processOrder(pedido("12506", CHICOTE), "acc-1", true, undefined, "user-1");

    // Nada é vinculado, nada é gravado — melhor não baixar do que baixar errado.
    expect(upsert).not.toHaveBeenCalled();
    expect(criar).not.toHaveBeenCalled();
    expect(r.status).toBe("no_products");
  });

  it("RECUSA quando o SKU é único mas aponta para peça de outro título", async () => {
    vi.spyOn(orderRepository, "exists").mockResolvedValue(false);
    vi.spyOn(prisma.productListing, "findUnique").mockResolvedValue(null);
    vi.spyOn(prisma.product, "findMany").mockResolvedValue([
      { id: "prod-bobina", name: "Bobina De Ignição Peugeot 206 207 C3 1.4 8v" },
    ] as never);
    const upsert = vi
      .spyOn(ListingRepository, "upsertFromOrderFallback")
      .mockResolvedValue({ id: "listing-x" } as never);
    const criar = vi.spyOn(orderRepository, "create");

    const r = await (
      OrderUseCase as never as {
        processOrder: (...a: unknown[]) => Promise<{ status?: string }>;
      }
    ).processOrder(pedido("1", CHICOTE), "acc-1", true, undefined, "user-1");

    expect(upsert).not.toHaveBeenCalled();
    expect(criar).not.toHaveBeenCalled();
    expect(r.status).toBe("no_products");
  });

  it("EGRESS: a busca por SKU traz so id e name, com take 2", async () => {
    vi.spyOn(orderRepository, "exists").mockResolvedValue(false);
    vi.spyOn(prisma.productListing, "findUnique").mockResolvedValue(null);
    const buscar = vi
      .spyOn(prisma.product, "findMany")
      .mockResolvedValue([
        { id: "prod-unico", name: CHICOTE },
      ] as never);
    vi.spyOn(ListingRepository, "upsertFromOrderFallback").mockResolvedValue({
      id: "listing-ok",
    } as never);
    vi.spyOn(orderRepository, "create").mockResolvedValue({
      id: "ord-1",
      items: [{ productId: "prod-unico", quantity: 1 }],
    } as never);
    vi.spyOn(
      OrderUseCase as never as { deductStockForOrder: unknown },
      "deductStockForOrder" as never,
    ).mockResolvedValue([] as never);

    await (
      OrderUseCase as never as {
        processOrder: (...a: unknown[]) => Promise<unknown>;
      }
    ).processOrder(pedido("12506", CHICOTE), "acc-1", true, undefined, "user-1");

    // A regra de vínculo (`where`) segue idêntica; o `select` continua enxuto —
    // `name` entrou porque a conferência de título precisa dele, e só.
    expect(buscar).toHaveBeenCalledWith({
      where: { skuNormalized: "12506", userId: "user-1" },
      select: { id: true, name: true },
      orderBy: { id: "asc" },
      take: 2,
    });
  });

  it("vincula normalmente quando o SKU casa com UM produto de titulo compativel", async () => {
    vi.spyOn(orderRepository, "exists").mockResolvedValue(false);
    vi.spyOn(prisma.productListing, "findUnique").mockResolvedValue(null);
    vi.spyOn(prisma.product, "findMany").mockResolvedValue([
      { id: "prod-unico", name: CHICOTE },
    ] as never);
    const upsert = vi
      .spyOn(ListingRepository, "upsertFromOrderFallback")
      .mockResolvedValue({ id: "listing-ok" } as never);
    vi.spyOn(orderRepository, "create").mockResolvedValue({
      id: "ord-1",
      items: [{ productId: "prod-unico", quantity: 1 }],
    } as never);
    const baixa = vi
      .spyOn(
        OrderUseCase as never as { deductStockForOrder: unknown },
        "deductStockForOrder" as never,
      )
      .mockResolvedValue([] as never);

    const r = await (
      OrderUseCase as never as {
        processOrder: (...a: unknown[]) => Promise<{ stockDeducted?: boolean }>;
      }
    ).processOrder(pedido("12506", CHICOTE), "acc-1", true, undefined, "user-1");

    // Controle negativo: o caminho bom continua igual ao de antes.
    expect(upsert).toHaveBeenCalled();
    expect(baixa).toHaveBeenCalledTimes(1);
    expect(r.stockDeducted).toBe(true);
  });

  it("sem titulo no anuncio, o comportamento antigo vale (nao bloqueia)", async () => {
    vi.spyOn(orderRepository, "exists").mockResolvedValue(false);
    vi.spyOn(prisma.productListing, "findUnique").mockResolvedValue(null);
    vi.spyOn(prisma.product, "findMany").mockResolvedValue([
      { id: "prod-qualquer", name: "Peça Sem Relação Nenhuma" },
    ] as never);
    const upsert = vi
      .spyOn(ListingRepository, "upsertFromOrderFallback")
      .mockResolvedValue({ id: "listing-ok" } as never);
    vi.spyOn(orderRepository, "create").mockResolvedValue({
      id: "ord-1",
      items: [{ productId: "prod-qualquer", quantity: 1 }],
    } as never);
    vi.spyOn(
      OrderUseCase as never as { deductStockForOrder: unknown },
      "deductStockForOrder" as never,
    ).mockResolvedValue([] as never);

    await (
      OrderUseCase as never as {
        processOrder: (...a: unknown[]) => Promise<unknown>;
      }
    ).processOrder(pedido("12506", ""), "acc-1", true, undefined, "user-1");

    expect(upsert).toHaveBeenCalled();
  });
});
