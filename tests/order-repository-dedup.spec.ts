import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import prisma from "@/app/lib/prisma";
import { OrderRepositoryPrisma } from "@/app/repositories/order.repository";

describe("OrderRepositoryPrisma.create — dedup de webhook ML duplicado", () => {
  const repo = new OrderRepositoryPrisma();

  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const validData = () => ({
    marketplaceAccountId: "acc-ml-test",
    externalOrderId: "200001657260100",
    status: "PAID",
    totalAmount: 100,
    customerName: "Cliente Teste",
    customerEmail: null,
    items: [
      {
        productId: "prod-1",
        listingId: null,
        quantity: 1,
        unitPrice: 100,
      },
    ],
  }) as any;

  it("captura P2002 (race entre webhooks duplicados) e re-throw preservando code — sem logar stacktrace inteiro (anti-OOM)", async () => {
    const prismaP2002 = Object.assign(
      new Error("Unique constraint failed on (marketplaceAccountId, externalOrderId)"),
      { code: "P2002", meta: { target: ["marketplaceAccountId", "externalOrderId"] } },
    );
    vi.spyOn(prisma.order, "create").mockRejectedValue(prismaP2002);

    await expect(repo.create(validData())).rejects.toMatchObject({
      code: "P2002",
    });

    // Log compacto via console.warn — sem stacktrace pesado
    expect(consoleWarnSpy).toHaveBeenCalled();
    const warnCall = consoleWarnSpy.mock.calls.find(
      (c) =>
        typeof c[0] === "string" &&
        c[0].includes("[OrderRepository] race P2002") &&
        c[0].includes("externalOrderId=200001657260100"),
    );
    expect(warnCall).toBeDefined();

    // Comportamento ANTIGO logava o erro inteiro via console.error em
    // "Erro Prisma ao criar pedido:" — isso causava o OOM no log do servidor.
    // Garantimos que esse caminho NÃO é mais tocado em P2002.
    const oldErrorCall = consoleErrorSpy.mock.calls.find(
      (c) =>
        typeof c[0] === "string" &&
        c[0].includes("Erro Prisma ao criar pedido"),
    );
    expect(oldErrorCall).toBeUndefined();
  });

  it("outros erros (não-P2002) continuam logando via console.error (regressão check)", async () => {
    const otherError = new Error("connection refused");
    vi.spyOn(prisma.order, "create").mockRejectedValue(otherError);

    await expect(repo.create(validData())).rejects.toThrow("connection refused");

    const errorCall = consoleErrorSpy.mock.calls.find(
      (c) =>
        typeof c[0] === "string" &&
        c[0].includes("Erro Prisma ao criar pedido"),
    );
    expect(errorCall).toBeDefined();
  });

  it("sucesso normal retorna a Order mapeada (caminho feliz não regrediu)", async () => {
    // Prisma retorna Decimal para totalAmount/unitPrice — mapPrismaToOrder chama
    // .toNumber(). Mock precisa expor o método.
    const decimal = (n: number) => ({ toNumber: () => n });

    vi.spyOn(prisma.order, "create").mockResolvedValue({
      id: "order-ok",
      marketplaceAccountId: "acc-ml-test",
      externalOrderId: "200001657260100",
      status: "PAID",
      totalAmount: decimal(100),
      customerName: "Cliente",
      customerEmail: null,
      paidAt: null,
      shippedAt: null,
      deliveredAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      items: [],
    } as any);

    const order = await repo.create(validData());
    expect(order.id).toBe("order-ok");
    expect(order.externalOrderId).toBe("200001657260100");
  });
});
