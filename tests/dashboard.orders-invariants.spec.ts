import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fastify from "fastify";

import { dashboardRoutes } from "../app/routes/dashboard.routes";
import { UserRepositoryPrisma } from "../app/repositories/user.repository";

// ──────────────────────────────────────────────────────────
// REGRESSÃO dos endpoints VIZINHOS aos gráficos novos.
//
// /sales-by-platform e /sales-by-category leem as MESMAS tabelas que
// /orders-over-time e /account-stats, e moram no mesmo arquivo. Este spec trava
// o comportamento que já está em produção, para que uma mudança nos endpoints
// novos não vaze para os antigos:
//   - o ENVELOPE de cada resposta (array nu × objeto) — o front quebraria em
//     silêncio, porque todos os fetchers de app/page.tsx têm `catch { return [] }`;
//   - o WHERE do Prisma byte-a-byte (`toEqual` pega até chave `undefined` a mais);
//   - a decisão de INCLUIR pedidos cancelados na receita, que é o que faz os
//     gráficos novos baterem com os números exibidos na mesma tela.
// ──────────────────────────────────────────────────────────

vi.mock("../app/lib/prisma", () => ({
  default: {
    product: { groupBy: vi.fn(), count: vi.fn(), aggregate: vi.fn() },
    order: { groupBy: vi.fn() },
    marketplaceAccount: { findMany: vi.fn() },
    $queryRaw: vi.fn(),
  },
}));

vi.mock("@/app/lib/prisma", () => ({
  default: {
    product: { groupBy: vi.fn(), count: vi.fn(), aggregate: vi.fn() },
    order: { groupBy: vi.fn() },
    marketplaceAccount: { findMany: vi.fn() },
    $queryRaw: vi.fn(),
  },
}));

function sqlText(arg: any): string {
  if (!arg) return "";
  if (typeof arg.sql === "string") return arg.sql;
  if (typeof arg.text === "string") return arg.text;
  if (Array.isArray(arg.strings)) return arg.strings.join(" ? ");
  return String(arg);
}

describe("REGRESSÃO: endpoints do Dashboard que já estão em produção", () => {
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

  const get = (url: string) =>
    app.inject({ method: "GET", url, headers: { email: "test@example.com" } });

  describe("/dashboard/products-by-category", () => {
    it("a query continua sendo o groupBy simples por userId", async () => {
      prisma.product.groupBy.mockResolvedValue([]);
      await get("/dashboard/products-by-category");

      expect(prisma.product.groupBy).toHaveBeenCalledWith({
        by: ["category"],
        _count: { _all: true },
        where: { userId: "user-1" },
      });
    });

    it("responde ARRAY NU, ordenado desc, com null virando 'Sem categoria'", async () => {
      prisma.product.groupBy.mockResolvedValue([
        { category: "Farol", _count: { _all: 2 } },
        { category: null, _count: { _all: 9 } },
        { category: "Motor", _count: { _all: 5 } },
      ]);

      const res = await get("/dashboard/products-by-category");
      const body = JSON.parse(res.payload);

      expect(Array.isArray(body)).toBe(true);
      expect(body).toEqual([
        { category: "Sem categoria", count: 9 },
        { category: "Motor", count: 5 },
        { category: "Farol", count: 2 },
      ]);
    });

    it("ignora querystring desconhecida em vez de mudar a query", async () => {
      prisma.product.groupBy.mockResolvedValue([]);
      await get("/dashboard/products-by-category?platform=ml&days=7&limit=3");

      expect(prisma.product.groupBy).toHaveBeenCalledWith({
        by: ["category"],
        _count: { _all: true },
        where: { userId: "user-1" },
      });
    });
  });

  describe("/dashboard/orders-over-time", () => {
    it("continua devolvendo ARRAY NU com a janela default de 30 dias", async () => {
      prisma.$queryRaw.mockResolvedValue([]);

      const res = await get("/dashboard/orders-over-time");
      const body = JSON.parse(res.payload);

      expect(Array.isArray(body)).toBe(true);
      expect(body).toHaveLength(31); // 0..30 inclusive
      expect(Object.keys(body[0]).sort()).toEqual([
        "date",
        "orders",
        "totalAmount",
      ]);
      expect(body.every((d: any) => d.orders === 0 && d.totalAmount === 0)).toBe(
        true,
      );
    });

    it("soma os dias vindos do banco sem perder os dias vazios", async () => {
      prisma.$queryRaw.mockResolvedValue([
        { day: "2024-01-02", orders: 3, total: "150.50" },
      ]);

      const body = JSON.parse((await get("/dashboard/orders-over-time")).payload);
      const dia = body.find((d: any) => d.date === "2024-01-02");

      // O dia fora da janela ainda entra no mapa (comportamento atual).
      expect(dia.orders).toBe(3);
      expect(dia.totalAmount).toBeCloseTo(150.5, 2);
    });

    it("NÃO filtra pedidos cancelados (a receita do Dashboard os inclui)", async () => {
      prisma.$queryRaw.mockResolvedValue([]);
      await get("/dashboard/orders-over-time");

      expect(sqlText(prisma.$queryRaw.mock.calls[0][0])).not.toContain(
        "CANCELLED",
      );
    });
  });

  describe("/dashboard/account-stats", () => {
    it("a query continua sem recorte de período e escopada pelo tenant", async () => {
      prisma.order.groupBy.mockResolvedValue([]);
      await get("/dashboard/account-stats");

      expect(prisma.order.groupBy).toHaveBeenCalledWith({
        by: ["marketplaceAccountId"],
        _count: { _all: true },
        _sum: { totalAmount: true },
        where: { marketplaceAccount: { userId: "user-1" } },
      });
    });

    it("responde o envelope { accountStats } como MAPA, não array", async () => {
      prisma.order.groupBy.mockResolvedValue([
        {
          marketplaceAccountId: "acc-1",
          _count: { _all: 4 },
          _sum: { totalAmount: "1000.00" },
        },
      ]);

      const body = JSON.parse((await get("/dashboard/account-stats")).payload);

      expect(Array.isArray(body)).toBe(false);
      expect(body.accountStats["acc-1"]).toEqual({ revenue: 1000, orders: 4 });
    });
  });
});
