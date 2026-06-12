import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * PR-A3 — Isolamento multi-tenant (IDOR) nos repositórios.
 * Verifica que as queries passam a escopar pelo dono.
 */

// Captura os argumentos `where` que chegam ao prisma para inspeção.
const calls: Record<string, any[]> = {
  orderFindFirst: [],
  orderUpdate: [],
  compatFindMany: [],
  compatDeleteMany: [],
  productFindFirst: [],
};

vi.mock("@/app/lib/prisma", () => ({
  default: {
    order: {
      findFirst: vi.fn((args: any) => {
        calls.orderFindFirst.push(args);
        // Simula "não é dono" => null (a não ser que userId ausente).
        return Promise.resolve(null);
      }),
      update: vi.fn((args: any) => {
        calls.orderUpdate.push(args);
        return Promise.resolve({ id: "o1", items: [], marketplaceAccount: {} });
      }),
    },
    productCompatibility: {
      findMany: vi.fn((args: any) => {
        calls.compatFindMany.push(args);
        return Promise.resolve([]);
      }),
      deleteMany: vi.fn((args: any) => {
        calls.compatDeleteMany.push(args);
        return Promise.resolve({ count: 0 });
      }),
      create: vi.fn(() => Promise.resolve({ id: "c1", productId: "p1" })),
    },
    product: {
      findFirst: vi.fn((args: any) => {
        calls.productFindFirst.push(args);
        return Promise.resolve({ id: "p1" });
      }),
    },
  },
}));

import { orderRepository } from "@/app/repositories/order.repository";
import { ProductCompatibilityRepositoryPrisma } from "@/app/repositories/compatibility.repository";

describe("PR-A3: order escopado por marketplaceAccount.userId", () => {
  beforeEach(() => {
    calls.orderFindFirst.length = 0;
    calls.orderUpdate.length = 0;
  });

  it("findById com userId filtra por marketplaceAccount.userId", async () => {
    await orderRepository.findById("o1", "user-a");
    expect(calls.orderFindFirst[0].where).toMatchObject({
      id: "o1",
      marketplaceAccount: { userId: "user-a" },
    });
  });

  it("update com userId verifica posse antes de escrever; nega cross-tenant", async () => {
    await expect(
      orderRepository.update("o1", { status: "PAID" as any }, "intruso"),
    ).rejects.toThrow(/não encontrado/i);
    // Verificou posse via findFirst e NÃO chamou update (não é dono).
    expect(calls.orderFindFirst[0].where).toMatchObject({
      id: "o1",
      marketplaceAccount: { userId: "intruso" },
    });
    expect(calls.orderUpdate.length).toBe(0);
  });
});

describe("PR-A3: compatibility escopada por product.userId", () => {
  const repo = new ProductCompatibilityRepositoryPrisma();

  beforeEach(() => {
    calls.compatFindMany.length = 0;
    calls.compatDeleteMany.length = 0;
    calls.productFindFirst.length = 0;
  });

  it("findByProductId filtra por product.userId", async () => {
    await repo.findByProductId("p1", "user-a");
    expect(calls.compatFindMany[0].where).toMatchObject({
      productId: "p1",
      product: { userId: "user-a" },
    });
  });

  it("delete escopa por product.userId (deleteMany, não delete por id cru)", async () => {
    await repo.delete("c1", "user-a");
    expect(calls.compatDeleteMany[0].where).toMatchObject({
      id: "c1",
      product: { userId: "user-a" },
    });
  });

  it("create verifica posse do produto antes de inserir", async () => {
    await repo.create("p1", { brand: "X", model: "Y" } as any, "user-a");
    expect(calls.productFindFirst[0].where).toMatchObject({
      id: "p1",
      userId: "user-a",
    });
  });
});
