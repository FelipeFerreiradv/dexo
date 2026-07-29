import { describe, expect, it } from "vitest";

import {
  MAX_CATEGORY_ROWS,
  MAX_RANGE_DAYS,
  OUTRAS_CATEGORIAS_LABEL,
  SEM_CATEGORIA_LABEL,
  buildCategoryBreakdown,
  buildChannelSplit,
  buildPaymentMethodBreakdown,
  buildPlatformBreakdown,
  num,
  parseBooleanFlag,
  parsePlatformFilter,
  parseTopN,
  pct,
  resolveDashboardRange,
  serializeRange,
  type CategoryRow,
  type FinanceBucketRow,
  type PlatformRow,
} from "../app/lib/dashboard-breakdowns";

const NOW = new Date("2026-07-29T12:00:00.000Z");
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function daysBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / MS_PER_DAY;
}

// ───────────────────────────────── helpers ──────────────────────────────────

describe("num / pct", () => {
  it("converte numeric::text sem devolver NaN", () => {
    expect(num("1234.56")).toBe(1234.56);
    expect(num(42)).toBe(42);
    expect(num(null)).toBe(0);
    expect(num(undefined)).toBe(0);
    expect(num("abc")).toBe(0);
    expect(num("")).toBe(0);
    expect(num("Infinity")).toBe(0);
  });

  it("pct nunca divide por zero", () => {
    expect(pct(25, 100)).toBe(25);
    expect(pct(0, 0)).toBe(0);
    expect(pct(10, 0)).toBe(0);
  });
});

// ─────────────────────────────── período ────────────────────────────────────

describe("resolveDashboardRange", () => {
  it("sem parâmetros usa os últimos 30 dias, como o resto do Dashboard", () => {
    const r = resolveDashboardRange({}, NOW);
    expect(r.label).toBe("Últimos 30 dias");
    expect(r.clamped).toBe(false);
    expect(daysBetween(r.startDate, r.endDate)).toBeCloseTo(30, 5);
  });

  it("aceita days e rotula a janela", () => {
    const r = resolveDashboardRange({ days: "7" }, NOW);
    expect(daysBetween(r.startDate, r.endDate)).toBeCloseTo(7, 5);
    expect(r.label).toBe("Últimos 7 dias");
  });

  it("days inválido cai no default sem lançar", () => {
    for (const days of ["abc", "0", "-5", ""]) {
      const r = resolveDashboardRange({ days }, NOW);
      expect(daysBetween(r.startDate, r.endDate)).toBeCloseTo(30, 5);
    }
  });

  it("days é IGNORADO quando há startDate (mesma precedência do report.pdf)", () => {
    const r = resolveDashboardRange(
      { startDate: "2026-07-01", days: "7" },
      NOW,
    );
    expect(r.startDate.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(r.label).not.toBe("Últimos 7 dias");
  });

  it("respeita startDate/endDate explícitos", () => {
    const r = resolveDashboardRange(
      { startDate: "2026-06-01", endDate: "2026-06-30" },
      NOW,
    );
    expect(r.startDate.toISOString()).toBe("2026-06-01T00:00:00.000Z");
    expect(r.endDate.toISOString()).toBe("2026-06-30T23:59:59.999Z");
    expect(r.clamped).toBe(false);
  });

  it("clampa janela absurda em MAX_RANGE_DAYS e sinaliza", () => {
    const r = resolveDashboardRange({ startDate: "1900-01-01" }, NOW);
    expect(r.clamped).toBe(true);
    expect(daysBetween(r.startDate, r.endDate)).toBeCloseTo(MAX_RANGE_DAYS, 5);
  });

  it("clampa days absurdo antes de tocar o banco", () => {
    const r = resolveDashboardRange({ days: "99999" }, NOW);
    expect(daysBetween(r.startDate, r.endDate)).toBeLessThanOrEqual(
      MAX_RANGE_DAYS + 1,
    );
  });

  it("start > end volta ao default em vez de lançar", () => {
    const r = resolveDashboardRange(
      { startDate: "2026-07-20", endDate: "2026-07-01" },
      NOW,
    );
    expect(r.startDate.getTime()).toBeLessThanOrEqual(r.endDate.getTime());
  });

  it("serializeRange devolve ISO + label + clamped", () => {
    const s = serializeRange(resolveDashboardRange({}, NOW));
    expect(typeof s.startDate).toBe("string");
    expect(typeof s.endDate).toBe("string");
    expect(s.label).toBe("Últimos 30 dias");
    expect(s.clamped).toBe(false);
  });
});

// ──────────────────────────── filtro de plataforma ───────────────────────────

describe("parsePlatformFilter", () => {
  it("vazio ou ausente não filtra nada", () => {
    expect(parsePlatformFilter(undefined)).toEqual([]);
    expect(parsePlatformFilter(null)).toEqual([]);
    expect(parsePlatformFilter("")).toEqual([]);
  });

  it("normaliza as grafias que circulam no projeto", () => {
    expect(parsePlatformFilter("ml")).toEqual(["MERCADO_LIVRE"]);
    expect(parsePlatformFilter("MERCADO_LIVRE")).toEqual(["MERCADO_LIVRE"]);
    expect(parsePlatformFilter("Mercado Livre")).toEqual(["MERCADO_LIVRE"]);
    expect(parsePlatformFilter("MercadoLivre")).toEqual(["MERCADO_LIVRE"]);
    expect(parsePlatformFilter("shopee")).toEqual(["SHOPEE"]);
    expect(parsePlatformFilter("magalu")).toEqual(["MAGALU"]);
  });

  it("aceita CSV e deduplica", () => {
    expect(parsePlatformFilter("ml,shopee")).toEqual([
      "MERCADO_LIVRE",
      "SHOPEE",
    ]);
    expect(parsePlatformFilter("ml,ML,mercadolivre")).toEqual([
      "MERCADO_LIVRE",
    ]);
  });

  it("token desconhecido é ignorado, nunca vira 400", () => {
    expect(parsePlatformFilter("foo")).toEqual([]);
    expect(parsePlatformFilter("ml,foo")).toEqual(["MERCADO_LIVRE"]);
  });

  it("payload de injeção não vira filtro", () => {
    expect(parsePlatformFilter(`';DROP TABLE "Order";--`)).toEqual([]);
    expect(parsePlatformFilter("1' OR '1'='1")).toEqual([]);
  });

  it("CSV gigante é cortado (anti-DoS de parsing)", () => {
    const raw = Array.from({ length: 500 }, () => "ml").join(",");
    expect(parsePlatformFilter(raw)).toEqual(["MERCADO_LIVRE"]);
  });
});

describe("parseTopN / parseBooleanFlag", () => {
  it("clampa e cai no default", () => {
    expect(parseTopN("10", 10, 50)).toBe(10);
    expect(parseTopN("999", 10, 50)).toBe(50);
    expect(parseTopN("-5", 10, 50)).toBe(0);
    expect(parseTopN("abc", 10, 50)).toBe(10);
    expect(parseTopN(undefined, 10, 50)).toBe(10);
  });

  it("só o literal 'true' liga a flag (padrão do repo)", () => {
    expect(parseBooleanFlag("true")).toBe(true);
    expect(parseBooleanFlag("1")).toBe(false);
    expect(parseBooleanFlag("TRUE")).toBe(false);
    expect(parseBooleanFlag(undefined)).toBe(false);
  });
});

// ─────────────────────────── vendas por plataforma ───────────────────────────

const platformRow = (
  platform: string,
  orders: number,
  revenue: string,
  cancelledOrders = 0,
  cancelledRevenue = "0",
): PlatformRow => ({
  platform,
  orders,
  revenue,
  cancelledOrders,
  cancelledRevenue,
});

describe("buildPlatformBreakdown", () => {
  it("sem linhas devolve as 3 plataformas zeradas (legenda estável)", () => {
    const r = buildPlatformBreakdown([]);
    expect(r.byPlatform.map((p) => p.platform)).toEqual([
      "ML",
      "SHOPEE",
      "MAGALU",
    ]);
    expect(r.totals).toEqual({
      orders: 0,
      revenue: 0,
      cancelledOrders: 0,
      cancelledRevenue: 0,
    });
    expect(r.byPlatform.every((p) => p.share === 0)).toBe(true);
  });

  it("converte revenue::text e soma os totais", () => {
    const r = buildPlatformBreakdown([
      platformRow("MERCADO_LIVRE", 90, "33000.00", 2, "600.00"),
      platformRow("SHOPEE", 30, "11000.50"),
      platformRow("MAGALU", 12, "4210.00", 1, "200.00"),
    ]);
    expect(r.totals.orders).toBe(132);
    expect(r.totals.revenue).toBeCloseTo(48210.5, 2);
    expect(r.totals.cancelledOrders).toBe(3);
    expect(r.totals.cancelledRevenue).toBeCloseTo(800, 2);
    const ml = r.byPlatform.find((p) => p.platform === "ML")!;
    expect(typeof ml.revenue).toBe("number");
    expect(ml.label).toBe("Mercado Livre");
  });

  it("os shares somam 100%", () => {
    const r = buildPlatformBreakdown([
      platformRow("MERCADO_LIVRE", 1, "100"),
      platformRow("SHOPEE", 1, "300"),
    ]);
    const soma = r.byPlatform.reduce((s, p) => s + p.share, 0);
    expect(soma).toBeCloseTo(100, 6);
  });

  it("OUTRO só aparece quando tem movimento", () => {
    expect(
      buildPlatformBreakdown([platformRow("MERCADO_LIVRE", 1, "10")]).byPlatform,
    ).toHaveLength(3);
    const comOutro = buildPlatformBreakdown([
      platformRow("PLATAFORMA_NOVA", 5, "500"),
    ]);
    expect(comOutro.byPlatform.map((p) => p.platform)).toContain("OUTRO");
    expect(comOutro.byPlatform.find((p) => p.platform === "OUTRO")!.label).toBe(
      "Outros",
    );
  });
});

// ──────────────────────────── vendas por categoria ───────────────────────────

const categoryRow = (
  category: string | null,
  revenue: string,
  units: number,
): CategoryRow => ({ category, revenue, units });

describe("buildCategoryBreakdown", () => {
  it("entrada vazia não produz NaN", () => {
    const r = buildCategoryBreakdown([], null, 10);
    expect(r.items).toEqual([]);
    expect(r.totals).toEqual({
      revenue: 0,
      units: 0,
      orders: 0,
      categories: 0,
    });
    expect(r.truncated).toBe(false);
  });

  it("category nula ou em branco vira 'Sem categoria'", () => {
    const r = buildCategoryBreakdown(
      [categoryRow(null, "100", 2), categoryRow("   ", "50", 1)],
      { revenue: "150", units: 3, orders: 2, categories: 1 },
      10,
    );
    expect(r.items.map((i) => i.category)).toEqual([
      SEM_CATEGORIA_LABEL,
      SEM_CATEGORIA_LABEL,
    ]);
  });

  it("'Outras' = totais − top-N, e os shares fecham 100%", () => {
    const rows = [
      categoryRow("Motor", "12000", 40),
      categoryRow("Suspensão", "8000", 55),
      categoryRow("Farol", "3000", 12),
    ];
    const r = buildCategoryBreakdown(
      rows,
      { revenue: "30000", units: 150, orders: 90, categories: 27 },
      2,
    );
    const outras = r.items.find((i) => i.isOther)!;
    expect(outras.category).toBe(OUTRAS_CATEGORIAS_LABEL);
    expect(outras.revenue).toBeCloseTo(30000 - 12000 - 8000, 2);
    expect(outras.units).toBe(150 - 40 - 55);
    expect(r.items.reduce((s, i) => s + i.share, 0)).toBeCloseTo(100, 6);
  });

  it("sem cauda restante não inventa a linha 'Outras'", () => {
    const r = buildCategoryBreakdown(
      [categoryRow("Motor", "100", 2)],
      { revenue: "100", units: 2, orders: 1, categories: 1 },
      10,
    );
    expect(r.items.some((i) => i.isOther)).toBe(false);
  });

  it("shares fecham 100% mesmo com a cauda truncada pelo SQL", () => {
    const rows = Array.from({ length: MAX_CATEGORY_ROWS }, (_, i) =>
      categoryRow(`Cat ${i}`, "10", 1),
    );
    const r = buildCategoryBreakdown(
      rows,
      { revenue: "999999", units: 5000, orders: 1000, categories: 4321 },
      5,
    );
    expect(r.truncated).toBe(true);
    expect(r.items.reduce((s, i) => s + i.share, 0)).toBeCloseTo(100, 6);
  });

  it("limit 0 devolve todas as linhas", () => {
    const rows = [
      categoryRow("A", "10", 1),
      categoryRow("B", "20", 2),
      categoryRow("C", "30", 3),
    ];
    const r = buildCategoryBreakdown(
      rows,
      { revenue: "60", units: 6, orders: 3, categories: 3 },
      0,
    );
    expect(r.items.filter((i) => !i.isOther)).toHaveLength(3);
  });

  it("resto negativo por ruído de float não vira fatia negativa", () => {
    const r = buildCategoryBreakdown(
      [categoryRow("A", "100.00", 5)],
      { revenue: "99.999", units: 5, orders: 1, categories: 1 },
      10,
    );
    const outras = r.items.find((i) => i.isOther);
    expect(outras === undefined || outras.revenue >= 0).toBe(true);
  });
});

// ───────────────────── forma de pagamento / forma de venda ───────────────────

const financeRow = (
  key: string | null,
  total: string,
  pago = "0",
  pendente = "0",
  vencido = "0",
  count = 1,
): FinanceBucketRow => ({ key, total, pago, pendente, vencido, count });

describe("buildPaymentMethodBreakdown", () => {
  it("entrada vazia devolve totais zerados", () => {
    const r = buildPaymentMethodBreakdown([]);
    expect(r.items).toEqual([]);
    expect(r.totals.total).toBe(0);
  });

  it("traduz o código e ordena por valor desc", () => {
    const r = buildPaymentMethodBreakdown([
      financeRow("CREDITO", "1000", "1000", "0", "0", 3),
      financeRow("PIX", "6000", "6000", "0", "0", 20),
    ]);
    expect(r.items.map((i) => i.method)).toEqual(["PIX", "CREDITO"]);
    expect(r.items[0].label).toBe("PIX");
    expect(r.items[1].label).toBe("Cartão de Crédito");
    expect(r.items.reduce((s, i) => s + i.share, 0)).toBeCloseTo(100, 6);
  });

  it("método nulo é bucket legítimo, rotulado '—'", () => {
    const r = buildPaymentMethodBreakdown([
      financeRow("PIX", "100"),
      financeRow(null, "30"),
    ]);
    const semMetodo = r.items.find((i) => i.method === null)!;
    expect(semMetodo.label).toBe("—");
    expect(semMetodo.total).toBe(30);
  });

  it("código legado desconhecido passa cru em vez de sumir", () => {
    const r = buildPaymentMethodBreakdown([financeRow("CHEQUE_ANTIGO", "10")]);
    expect(r.items[0].label).toBe("CHEQUE_ANTIGO");
  });

  it("soma os buckets de situação", () => {
    const r = buildPaymentMethodBreakdown([
      financeRow("PIX", "100", "60", "30", "10", 4),
      financeRow("BOLETO", "50", "0", "20", "30", 2),
    ]);
    expect(r.totals).toEqual({
      total: 150,
      pago: 60,
      pendente: 50,
      vencido: 40,
      count: 6,
    });
  });
});

describe("buildChannelSplit", () => {
  it("sempre devolve as duas linhas, mesmo sem movimento", () => {
    const r = buildChannelSplit([]);
    expect(r.items.map((i) => i.channel)).toEqual(["BALCAO", "AVULSO"]);
    expect(r.items.every((i) => i.total === 0 && i.share === 0)).toBe(true);
  });

  it("calcula a divisão percentual", () => {
    const r = buildChannelSplit([
      financeRow("BALCAO", "9000", "7000", "1500", "500", 30),
      financeRow("AVULSO", "3000", "1000", "1500", "500", 12),
    ]);
    const balcao = r.items.find((i) => i.channel === "BALCAO")!;
    const avulso = r.items.find((i) => i.channel === "AVULSO")!;
    expect(balcao.share).toBeCloseTo(75, 6);
    expect(avulso.share).toBeCloseTo(25, 6);
    expect(balcao.label).toBe("Venda balcão");
    expect(avulso.label).toBe("A receber avulso");
    expect(balcao.total + avulso.total).toBe(r.totals.total);
  });

  it("um canal ausente zera sem quebrar o outro", () => {
    const r = buildChannelSplit([financeRow("BALCAO", "500", "500")]);
    expect(r.items.find((i) => i.channel === "AVULSO")!.total).toBe(0);
    expect(r.items.find((i) => i.channel === "BALCAO")!.share).toBeCloseTo(
      100,
      6,
    );
  });
});
