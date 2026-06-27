import { describe, it, expect, vi, afterEach } from "vitest";

import prisma from "@/app/lib/prisma";
import { OrderRepositoryPrisma } from "@/app/repositories/order.repository";

/**
 * Cobre `findAllForList` (Entrega B): miniatura leve do 1º item + contagem, SEM
 * vazar o grafo de itens, e o WHERE dos novos filtros (preço/data) + o no-op
 * quando vazios. Mocka o Prisma e inspeciona os argumentos do findMany.
 */
describe("OrderRepositoryPrisma.findAllForList — vitrine (miniatura + filtros)", () => {
  const repo = new OrderRepositoryPrisma();
  const decimal = (n: number) => ({ toNumber: () => n });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const mockOrder = (over?: Record<string, unknown>) =>
    ({
      id: "order-1",
      marketplaceAccountId: "acc-1",
      externalOrderId: "2000123",
      status: "PAID",
      totalAmount: decimal(150),
      customerName: "Cliente",
      customerEmail: null,
      paidAt: null,
      shippedAt: null,
      deliveredAt: null,
      createdAt: new Date("2026-06-20T10:00:00Z"),
      updatedAt: new Date("2026-06-20T10:00:00Z"),
      marketplaceAccount: {
        id: "acc-1",
        platform: "MERCADO_LIVRE",
        accountName: "Conta ML",
      },
      items: [
        {
          product: {
            imageUrl: "https://img/x.jpg",
            name: "Parachoque",
            sku: "SKU-1",
            location: null,
            productLocation: { code: "A-12" },
          },
        },
      ],
      _count: { items: 3 },
      ...over,
    }) as unknown;

  it("retorna thumbnail (1ª imagem/nome/sku/localização) + itemCount e NÃO vaza items completos", async () => {
    const findMany = vi
      .spyOn(prisma.order, "findMany")
      .mockResolvedValue([mockOrder()] as never);
    vi.spyOn(prisma.order, "count").mockResolvedValue(1 as never);

    const result = await repo.findAllForList({
      userId: "u1",
      page: 1,
      limit: 10,
    });

    expect(result.total).toBe(1);
    const order = result.orders[0];
    expect(order.thumbnail).toEqual({
      imageUrl: "https://img/x.jpg",
      name: "Parachoque",
      sku: "SKU-1",
      location: "A-12", // productLocation.code tem prioridade
    });
    expect(order.itemCount).toBe(3);
    // EGRESS: a lista NÃO traz o grafo de itens
    expect(order.items).toBeUndefined();
    // base mapeada corretamente
    expect(order.totalAmount).toBe(150);
    expect(order.marketplaceAccount?.accountName).toBe("Conta ML");

    // include enxuto: items take:1 + _count
    const arg = findMany.mock.calls[0][0] as {
      include: {
        items: { take: number };
        _count: { select: { items: boolean } };
      };
    };
    expect(arg.include.items.take).toBe(1);
    expect(arg.include._count.select.items).toBe(true);
  });

  it("location cai para product.location quando não há productLocation.code", async () => {
    vi.spyOn(prisma.order, "findMany").mockResolvedValue([
      mockOrder({
        items: [
          {
            product: {
              imageUrl: null,
              name: "Item",
              sku: "S2",
              location: "Prateleira 5",
              productLocation: null,
            },
          },
        ],
      }),
    ] as never);
    vi.spyOn(prisma.order, "count").mockResolvedValue(1 as never);

    const result = await repo.findAllForList({ userId: "u1" });
    const thumb = result.orders[0].thumbnail;
    expect(thumb?.location).toBe("Prateleira 5");
    expect(thumb?.imageUrl).toBeNull();
  });

  it("pedido sem itens ⇒ thumbnail undefined e itemCount 0", async () => {
    vi.spyOn(prisma.order, "findMany").mockResolvedValue([
      mockOrder({ items: [], _count: { items: 0 } }),
    ] as never);
    vi.spyOn(prisma.order, "count").mockResolvedValue(1 as never);

    const result = await repo.findAllForList({ userId: "u1" });
    const order = result.orders[0];
    expect(order.thumbnail).toBeUndefined();
    expect(order.itemCount).toBe(0);
  });

  describe("WHERE dos filtros (retrocompatível)", () => {
    const captureWhere = async (options: Record<string, unknown>) => {
      const findMany = vi
        .spyOn(prisma.order, "findMany")
        .mockResolvedValue([] as never);
      vi.spyOn(prisma.order, "count").mockResolvedValue(0 as never);
      await repo.findAllForList(options);
      return (findMany.mock.calls[0][0] as { where: Record<string, unknown> })
        .where;
    };

    it("amountMin/amountMax viram totalAmount { gte, lte }", async () => {
      const where = await captureWhere({
        userId: "u1",
        amountMin: 50,
        amountMax: 500,
      });
      expect(where.totalAmount).toEqual({ gte: 50, lte: 500 });
    });

    it("só amountMin ⇒ totalAmount { gte }", async () => {
      const where = await captureWhere({ userId: "u1", amountMin: 50 });
      expect(where.totalAmount).toEqual({ gte: 50 });
    });

    it("filtros de valor vazios/NaN ⇒ sem cláusula totalAmount (no-op)", async () => {
      const where = await captureWhere({
        userId: "u1",
        amountMin: Number.NaN,
        amountMax: undefined,
      });
      expect(where.totalAmount).toBeUndefined();
    });

    it("dateFrom/dateTo mapeiam createdAt { gte, lte }", async () => {
      const from = new Date("2026-06-01T00:00:00Z");
      const to = new Date("2026-06-30T23:59:59Z");
      const where = await captureWhere({
        userId: "u1",
        dateFrom: from,
        dateTo: to,
      });
      expect(where.createdAt).toEqual({ gte: from, lte: to });
    });

    it("escopo do tenant + platform + status + busca", async () => {
      const where = await captureWhere({
        userId: "u1",
        platform: "SHOPEE",
        status: "PAID",
        search: "joão",
      });
      expect(where.marketplaceAccount).toEqual({
        userId: "u1",
        platform: "SHOPEE",
      });
      expect(where.status).toBe("PAID");
      expect(where.OR).toHaveLength(2);
    });

    it("sem filtros ⇒ where só com escopo do tenant (no-op nos demais)", async () => {
      const where = await captureWhere({ userId: "u1" });
      expect(where.marketplaceAccount).toEqual({ userId: "u1" });
      expect(where.totalAmount).toBeUndefined();
      expect(where.createdAt).toBeUndefined();
      expect(where.status).toBeUndefined();
      expect(where.OR).toBeUndefined();
    });
  });
});
