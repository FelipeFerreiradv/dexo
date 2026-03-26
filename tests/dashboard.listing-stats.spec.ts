import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fastify from "fastify";

import { dashboardRoutes } from "../app/routes/dashboard.routes";
import { UserRepositoryPrisma } from "../app/repositories/user.repository";

vi.mock("../app/lib/prisma", () => ({
  default: {
    marketplaceAccount: { findMany: vi.fn() },
    productListing: { findMany: vi.fn() },
  },
}));

vi.mock("@/app/lib/prisma", () => ({
  default: {
    marketplaceAccount: { findMany: vi.fn() },
    productListing: { findMany: vi.fn() },
  },
}));

describe("GET /dashboard/listing-stats", () => {
  let app: ReturnType<typeof fastify>;
  let prisma: any;

  beforeEach(async () => {
    app = fastify();
    await app.register(dashboardRoutes, { prefix: "/dashboard" });
    prisma = (await import("../app/lib/prisma")).default as any;

    vi.spyOn(UserRepositoryPrisma.prototype, "findByEmail").mockResolvedValue({
      id: "user-1",
      email: "test@example.com",
      name: "Test User",
    } as any);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  it("returns empty stats when there are no accounts or listings", async () => {
    prisma.marketplaceAccount.findMany.mockResolvedValue([]);
    prisma.productListing.findMany.mockResolvedValue([]);

    const res = await app.inject({
      method: "GET",
      url: "/dashboard/listing-stats",
      headers: { email: "test@example.com" },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.totalListings).toBe(0);
    expect(body.totalListingsActive).toBe(0);
    expect(body.perAccount).toEqual([]);
    expect(body.timeline.global).toEqual([]);
    expect(body.timeline.perAccount).toEqual({});
  });

  it("aggregates totals and timeline per account", async () => {
    prisma.marketplaceAccount.findMany.mockResolvedValue([
      {
        id: "acc-1",
        platform: "MERCADO_LIVRE",
        accountName: "Loja A",
        status: "ACTIVE",
        _count: { listings: 3 },
      },
      {
        id: "acc-2",
        platform: "SHOPEE",
        accountName: "Loja B",
        status: "INACTIVE",
        _count: { listings: 2 },
      },
    ]);

    prisma.productListing.findMany.mockResolvedValue([
      {
        createdAt: new Date("2024-01-01T00:00:00.000Z"),
        marketplaceAccountId: "acc-1",
      },
      {
        createdAt: new Date("2024-01-02T00:00:00.000Z"),
        marketplaceAccountId: "acc-1",
      },
      {
        createdAt: new Date("2024-01-02T00:00:00.000Z"),
        marketplaceAccountId: "acc-2",
      },
    ]);

    const res = await app.inject({
      method: "GET",
      url: "/dashboard/listing-stats?days=365",
      headers: { email: "test@example.com" },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);

    expect(body.totalListings).toBe(5);
    expect(body.totalListingsActive).toBe(3);
    expect(body.perAccount).toHaveLength(2);
    const acc1 = body.perAccount.find((a: any) => a.accountId === "acc-1");
    const acc2 = body.perAccount.find((a: any) => a.accountId === "acc-2");
    expect(acc1.totalListings).toBe(3);
    expect(acc2.totalListings).toBe(2);

    expect(body.timeline.global).toEqual([
      { date: "2024-01-01", count: 1 },
      { date: "2024-01-02", count: 2 },
    ]);

    expect(body.timeline.perAccount["acc-1"]).toEqual([
      { date: "2024-01-01", count: 1 },
      { date: "2024-01-02", count: 1 },
    ]);
    expect(body.timeline.perAccount["acc-2"]).toEqual([
      { date: "2024-01-02", count: 1 },
    ]);
  });
});
