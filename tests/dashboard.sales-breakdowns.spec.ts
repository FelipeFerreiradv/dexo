import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fastify from "fastify";

import { dashboardRoutes } from "../app/routes/dashboard.routes";
import { UserRepositoryPrisma } from "../app/repositories/user.repository";

// Os 4 endpoints novos agregam NO BANCO (convenção EGRESS): o mock devolve as
// linhas JÁ agrupadas, exatamente como o Postgres as entregaria.
// A factory é duplicada de propósito: `vi.mock` é hoisted e não pode referenciar
// nada do escopo do módulo. Os dois specifiers precisam ser mockados porque o
// código resolve tanto o caminho relativo quanto o alias "@".
vi.mock("../app/lib/prisma", () => ({
  default: {
    marketplaceAccount: { findMany: vi.fn() },
    product: { count: vi.fn(), groupBy: vi.fn() },
    order: { groupBy: vi.fn() },
    $queryRaw: vi.fn(),
  },
}));

vi.mock("@/app/lib/prisma", () => ({
  default: {
    marketplaceAccount: { findMany: vi.fn() },
    product: { count: vi.fn(), groupBy: vi.fn() },
    order: { groupBy: vi.fn() },
    $queryRaw: vi.fn(),
  },
}));

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Texto do template `Prisma.Sql`, sem os valores bindados. */
function sqlText(arg: any): string {
  if (!arg) return "";
  if (typeof arg.sql === "string") return arg.sql;
  if (typeof arg.text === "string") return arg.text;
  if (Array.isArray(arg.strings)) return arg.strings.join(" ? ");
  return String(arg);
}

function sqlValues(arg: any): any[] {
  return Array.isArray(arg?.values) ? arg.values : [];
}

describe("gráficos novos do Dashboard — agregações por plataforma/categoria/financeiro", () => {
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

  // ───────────────────────────── plataforma ─────────────────────────────────

  describe("GET /dashboard/sales-by-platform", () => {
    it("sem pedidos devolve as 3 plataformas zeradas", async () => {
      prisma.$queryRaw.mockResolvedValue([]);

      const res = await get("/dashboard/sales-by-platform");

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.byPlatform.map((p: any) => p.platform)).toEqual([
        "ML",
        "SHOPEE",
        "MAGALU",
      ]);
      expect(body.totals.revenue).toBe(0);
      expect(body.range.label).toBe("Últimos 30 dias");
    });

    it("agrega receita e pedidos por plataforma", async () => {
      prisma.$queryRaw.mockResolvedValue([
        {
          platform: "MERCADO_LIVRE",
          orders: 90,
          revenue: "33000.00",
          cancelledOrders: 2,
          cancelledRevenue: "600.00",
        },
        {
          platform: "SHOPEE",
          orders: 30,
          revenue: "11000.50",
          cancelledOrders: 0,
          cancelledRevenue: "0",
        },
      ]);

      const res = await get("/dashboard/sales-by-platform?days=7");
      const body = JSON.parse(res.payload);

      expect(body.totals.orders).toBe(120);
      expect(body.totals.revenue).toBeCloseTo(44000.5, 2);
      expect(body.totals.cancelledRevenue).toBeCloseTo(600, 2);
      const ml = body.byPlatform.find((p: any) => p.platform === "ML");
      expect(ml.label).toBe("Mercado Livre");
      expect(ml.revenue).toBe(33000);
    });

    it("VAZAMENTO: a query é escopada pelo dataOwnerId", async () => {
      prisma.$queryRaw.mockResolvedValue([]);
      await get("/dashboard/sales-by-platform");

      expect(sqlValues(prisma.$queryRaw.mock.calls[0][0])).toContain("user-1");
    });

    it("INJEÇÃO: o filtro de plataforma vai BINDADO, não concatenado", async () => {
      prisma.$queryRaw.mockResolvedValue([]);
      await get("/dashboard/sales-by-platform?platform=ml");

      const arg = prisma.$queryRaw.mock.calls[0][0];
      expect(sqlValues(arg)).toContain("MERCADO_LIVRE");
      expect(sqlText(arg)).not.toContain("MERCADO_LIVRE");
    });

    it("INJEÇÃO: payload malicioso em ?platform vira no-op, não SQL", async () => {
      prisma.$queryRaw.mockResolvedValue([]);
      const res = await get(
        `/dashboard/sales-by-platform?platform=${encodeURIComponent(
          `';DROP TABLE "Order";--`,
        )}`,
      );

      expect(res.statusCode).toBe(200);
      const arg = prisma.$queryRaw.mock.calls[0][0];
      expect(sqlText(arg)).not.toContain("DROP TABLE");
      expect(sqlValues(arg).some((v) => String(v).includes("DROP"))).toBe(false);
      expect(JSON.parse(res.payload).platform).toEqual([]);
    });

    it("DoS: janela absurda é clampada ANTES de chegar ao banco", async () => {
      prisma.$queryRaw.mockResolvedValue([]);
      await get("/dashboard/sales-by-platform?days=99999");

      const datas = sqlValues(prisma.$queryRaw.mock.calls[0][0]).filter(
        (v: any) => v instanceof Date,
      );
      expect(datas).toHaveLength(2);
      const [inicio, fim] = datas.sort(
        (a: Date, b: Date) => a.getTime() - b.getTime(),
      );
      expect((fim.getTime() - inicio.getTime()) / MS_PER_DAY).toBeLessThanOrEqual(
        731,
      );
    });

    it("excludeCancelled=true muda a query; ausente mantém o padrão do Dashboard", async () => {
      prisma.$queryRaw.mockResolvedValue([]);

      await get("/dashboard/sales-by-platform");
      expect(sqlText(prisma.$queryRaw.mock.calls[0][0])).not.toContain(
        `<> 'CANCELLED'`,
      );

      prisma.$queryRaw.mockClear();
      await get("/dashboard/sales-by-platform?excludeCancelled=true");
      expect(sqlText(prisma.$queryRaw.mock.calls[0][0])).toContain(
        `<> 'CANCELLED'`,
      );
    });

    it("erro no banco vira 500 com envelope de erro", async () => {
      prisma.$queryRaw.mockRejectedValue(new Error("boom"));
      const res = await get("/dashboard/sales-by-platform");

      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.payload).error).toBeTruthy();
    });
  });

  // ────────────────────────────── categoria ─────────────────────────────────

  describe("GET /dashboard/sales-by-category", () => {
    const linhas = [
      { category: "Motor", revenue: "12000.00", units: 40 },
      { category: "Suspensão", revenue: "8000.00", units: 55 },
      { category: null, revenue: "1000.00", units: 5 },
    ];
    const totais = {
      revenue: "30000.00",
      units: 150,
      orders: 90,
      categories: 27,
    };

    it("dispara as DUAS leituras (linhas + totais exatos)", async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce(linhas)
        .mockResolvedValueOnce([totais]);

      const res = await get("/dashboard/sales-by-category");

      expect(res.statusCode).toBe(200);
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    });

    it("'Outras' fecha o total e os percentuais somam 100%", async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce(linhas)
        .mockResolvedValueOnce([totais]);

      const body = JSON.parse(
        (await get("/dashboard/sales-by-category?limit=2")).payload,
      );

      const outras = body.items.find((i: any) => i.isOther);
      expect(outras.category).toBe("Outras");
      expect(outras.revenue).toBeCloseTo(10000, 2);
      expect(
        body.items.reduce((s: number, i: any) => s + i.share, 0),
      ).toBeCloseTo(100, 6);
      expect(body.totals.orders).toBe(90);
    });

    it("categoria nula vira 'Sem categoria'", async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([{ category: null, revenue: "10", units: 1 }])
        .mockResolvedValueOnce([
          { revenue: "10", units: 1, orders: 1, categories: 1 },
        ]);

      const body = JSON.parse(
        (await get("/dashboard/sales-by-category")).payload,
      );
      expect(body.items[0].category).toBe("Sem categoria");
    });

    it("VAZAMENTO: as duas queries são escopadas pelo dataOwnerId", async () => {
      prisma.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      await get("/dashboard/sales-by-category");

      for (const call of prisma.$queryRaw.mock.calls) {
        expect(sqlValues(call[0])).toContain("user-1");
      }
    });

    it("o filtro de plataforma chega às duas queries, bindado", async () => {
      prisma.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      await get("/dashboard/sales-by-category?platform=shopee");

      for (const call of prisma.$queryRaw.mock.calls) {
        expect(sqlValues(call[0])).toContain("SHOPEE");
        expect(sqlText(call[0])).not.toContain("SHOPEE");
      }
    });

    it("ORDENAÇÃO: o SQL ordena pela expressão numérica, não pelo alias ::text", async () => {
      prisma.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      await get("/dashboard/sales-by-category");

      const texto = sqlText(prisma.$queryRaw.mock.calls[0][0]);
      expect(texto).toContain("ORDER BY COALESCE(SUM");
      expect(texto).not.toMatch(/ORDER BY\s+"revenue"/);
    });

    it("limit é clampado", async () => {
      prisma.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      const body = JSON.parse(
        (await get("/dashboard/sales-by-category?limit=9999")).payload,
      );
      expect(body.limit).toBe(50);
    });
  });

  // ──────────────────────── financeiro (a receber) ──────────────────────────

  describe("GET /dashboard/sales-by-payment-method", () => {
    it("traduz os códigos e ordena por valor", async () => {
      prisma.$queryRaw.mockResolvedValue([
        {
          key: "CREDITO",
          count: 3,
          total: "1000",
          pago: "1000",
          pendente: "0",
          vencido: "0",
        },
        {
          key: "PIX",
          count: 20,
          total: "6000",
          pago: "6000",
          pendente: "0",
          vencido: "0",
        },
        {
          key: null,
          count: 2,
          total: "500",
          pago: "0",
          pendente: "500",
          vencido: "0",
        },
      ]);

      const body = JSON.parse(
        (await get("/dashboard/sales-by-payment-method")).payload,
      );

      expect(body.items[0].method).toBe("PIX");
      expect(body.items[0].label).toBe("PIX");
      expect(body.items.find((i: any) => i.method === null).label).toBe("—");
      expect(body.totals.total).toBe(7500);
    });

    it("CANCELADA fica de fora (regra do módulo financeiro)", async () => {
      prisma.$queryRaw.mockResolvedValue([]);
      await get("/dashboard/sales-by-payment-method");

      expect(sqlText(prisma.$queryRaw.mock.calls[0][0])).toContain(
        `<> 'CANCELADA'`,
      );
    });

    it("VAZAMENTO: escopo por dataOwnerId e `now` bindado", async () => {
      prisma.$queryRaw.mockResolvedValue([]);
      await get("/dashboard/sales-by-payment-method");

      const valores = sqlValues(prisma.$queryRaw.mock.calls[0][0]);
      expect(valores).toContain("user-1");
      expect(valores.filter((v: any) => v instanceof Date).length).toBe(4);
    });

    it("unidadeId só entra na query quando informado", async () => {
      prisma.$queryRaw.mockResolvedValue([]);

      await get("/dashboard/sales-by-payment-method");
      expect(sqlValues(prisma.$queryRaw.mock.calls[0][0])).not.toContain(
        "uni-1",
      );

      prisma.$queryRaw.mockClear();
      await get("/dashboard/sales-by-payment-method?unidadeId=uni-1");
      expect(sqlValues(prisma.$queryRaw.mock.calls[0][0])).toContain("uni-1");
    });
  });

  describe("GET /dashboard/sales-by-channel", () => {
    it("devolve balcão e avulso com os percentuais", async () => {
      prisma.$queryRaw.mockResolvedValue([
        {
          key: "BALCAO",
          count: 30,
          total: "9000",
          pago: "7000",
          pendente: "1500",
          vencido: "500",
        },
        {
          key: "AVULSO",
          count: 12,
          total: "3000",
          pago: "1000",
          pendente: "1500",
          vencido: "500",
        },
      ]);

      const body = JSON.parse((await get("/dashboard/sales-by-channel")).payload);

      expect(body.items.map((i: any) => i.channel)).toEqual([
        "BALCAO",
        "AVULSO",
      ]);
      expect(body.items[0].share).toBeCloseTo(75, 6);
      expect(body.items[0].label).toBe("Venda balcão");
      expect(body.totals.total).toBe(12000);
    });

    it("sem movimento devolve as duas linhas zeradas, sem NaN", async () => {
      prisma.$queryRaw.mockResolvedValue([]);
      const body = JSON.parse((await get("/dashboard/sales-by-channel")).payload);

      expect(body.items).toHaveLength(2);
      expect(body.items.every((i: any) => i.total === 0 && i.share === 0)).toBe(
        true,
      );
    });

    it("o split usa EXISTS em ReceivableItem (mesmo critério do PDF)", async () => {
      prisma.$queryRaw.mockResolvedValue([]);
      await get("/dashboard/sales-by-channel");

      expect(sqlText(prisma.$queryRaw.mock.calls[0][0])).toContain(
        `"ReceivableItem"`,
      );
    });
  });

  // ─────────────────── contrato de serialização (todas as 4) ────────────────

  describe("contrato de serialização", () => {
    const rotas = [
      "/dashboard/sales-by-platform",
      "/dashboard/sales-by-category",
      "/dashboard/sales-by-payment-method",
      "/dashboard/sales-by-channel",
    ];

    it("dinheiro sai como number, nunca string (Decimal) — e nada de BigInt", async () => {
      for (const rota of rotas) {
        prisma.$queryRaw.mockReset();
        prisma.$queryRaw.mockResolvedValue([]);

        const res = await get(rota);
        expect(res.statusCode, rota).toBe(200);

        // Se algum COUNT voltasse como bigint, o send já teria explodido antes daqui.
        const body = JSON.parse(res.payload);
        const total = body.totals?.revenue ?? body.totals?.total;
        expect(typeof total, rota).toBe("number");
        expect(typeof body.range.startDate, rota).toBe("string");
      }
    });

    it("exigem autenticação", async () => {
      for (const rota of rotas) {
        const res = await app.inject({ method: "GET", url: rota });
        expect(res.statusCode, rota).toBe(401);
      }
    });
  });
});
