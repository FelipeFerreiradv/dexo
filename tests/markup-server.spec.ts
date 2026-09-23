import { describe, it, expect } from "vitest";
import {
  computeMarkupPercent,
  resolveDisplayMarkup,
  toCents,
  isStorableMoney,
  DECIMAL_10_2_MAX,
} from "../app/lib/money/markup";

/**
 * Markup calculado no servidor (PR-5, 22/09/2026).
 *
 * Caso real que motivou: preço 26000, custo 0,01 (custo PADRÃO do usuário) ⇒
 * 259.999.900% ⇒ `Decimal(10,2)` estourava e o produto não era criado.
 */
describe("computeMarkupPercent", () => {
  it("produto normal: mesma conta da tela (89,90 sobre 35,00 = 156,86%)", () => {
    expect(computeMarkupPercent(89.9, 35)).toEqual({
      value: 156.86,
      reason: null,
    });
  });

  it("produto caro com custo coerente cabe na coluna", () => {
    expect(computeMarkupPercent(250_000, 100_000)).toEqual({
      value: 150,
      reason: null,
    });
  });

  it("caso de produção: 26000 com custo 0,01 NÃO cabe ⇒ null (OUT_OF_RANGE)", () => {
    expect(computeMarkupPercent(26_000, 0.01)).toEqual({
      value: null,
      reason: "OUT_OF_RANGE",
    });
  });

  it("preço máximo da coluna com custo mínimo ⇒ OUT_OF_RANGE, nunca Infinity", () => {
    const r = computeMarkupPercent(DECIMAL_10_2_MAX, 0.01);
    expect(r.value).toBeNull();
    expect(r.reason).toBe("OUT_OF_RANGE");
  });

  it("limite exato: o maior markup que cabe é aceito, o seguinte não", () => {
    // custo 1,00: markup = (P − 1) × 100. P = 1.000.000,99 ⇒ 99.999.999,00 (cabe)
    expect(computeMarkupPercent(1_000_000.99, 1)).toEqual({
      value: 99_999_999,
      reason: null,
    });
    // P = 1.000.001,00 ⇒ 100.000.000,00 (não cabe)
    expect(computeMarkupPercent(1_000_001, 1).reason).toBe("OUT_OF_RANGE");
  });

  it("custo 0, nulo, ausente ou negativo ⇒ NO_COST (sem divisão por zero)", () => {
    for (const cost of [0, null, undefined, -5, ""]) {
      expect(computeMarkupPercent(100, cost as any)).toEqual({
        value: null,
        reason: "NO_COST",
      });
    }
  });

  it("preço 0 ou ausente ⇒ NO_PRICE (a tela também não calculava)", () => {
    expect(computeMarkupPercent(0, 10).reason).toBe("NO_PRICE");
    expect(computeMarkupPercent(null, 10).reason).toBe("NO_PRICE");
  });

  it("NaN, Infinity e texto não numérico ⇒ INVALID_INPUT, valor null", () => {
    for (const bad of [NaN, Infinity, -Infinity, "abc"]) {
      expect(computeMarkupPercent(bad as any, 10)).toEqual({
        value: null,
        reason: "INVALID_INPUT",
      });
      expect(computeMarkupPercent(100, bad as any)).toEqual({
        value: null,
        reason: "INVALID_INPUT",
      });
    }
  });

  it("preço abaixo do custo dá markup negativo (não é bloqueado aqui)", () => {
    expect(computeMarkupPercent(50, 100)).toEqual({ value: -50, reason: null });
  });

  it("preço igual ao custo dá 0, nunca -0", () => {
    const r = computeMarkupPercent(10, 10);
    expect(Object.is(r.value, 0)).toBe(true);
  });

  it("preço com muitas casas arredonda como o banco (meio para longe do zero)", () => {
    // 10,005 é gravado pelo Postgres como 10,01; com custo 10,00 ⇒ 0,10%
    expect(computeMarkupPercent(10.005, 10)).toEqual({ value: 0.1, reason: null });
  });

  it("markup com muitas casas sai com 2 casas", () => {
    // (100 − 30) / 30 × 100 = 233,333…
    expect(computeMarkupPercent(100, 30)).toEqual({
      value: 233.33,
      reason: null,
    });
  });

  it("aceita string numérica e objeto Decimal (toString)", () => {
    const decimalLike = { toString: () => "35.00" };
    expect(computeMarkupPercent("89.90", decimalLike).value).toBe(156.86);
  });

  it("nunca devolve NaN nem Infinity em nenhuma combinação extrema", () => {
    const values: any[] = [
      0, 0.01, 1, 99.99, 26_000, DECIMAL_10_2_MAX, null, undefined, NaN,
      Infinity, "", "1e3",
    ];
    for (const p of values) {
      for (const c of values) {
        const r = computeMarkupPercent(p, c);
        if (r.value !== null) {
          expect(Number.isFinite(r.value)).toBe(true);
          expect(Math.abs(r.value)).toBeLessThanOrEqual(DECIMAL_10_2_MAX);
        }
      }
    }
  });
});

describe("toCents", () => {
  it("usa a representação decimal (10,005 ⇒ 1001, não 1000)", () => {
    expect(toCents(10.005)).toBe(1001);
    expect(toCents("10.005")).toBe(1001);
    expect(toCents(0.01)).toBe(1);
    expect(toCents(89.9)).toBe(8990);
  });

  it("ausente/não finito ⇒ null", () => {
    expect(toCents(null)).toBeNull();
    expect(toCents(undefined)).toBeNull();
    expect(toCents("")).toBeNull();
    expect(toCents(NaN)).toBeNull();
    expect(toCents(Infinity)).toBeNull();
  });
});

describe("resolveDisplayMarkup", () => {
  it("usa o markup gravado quando existe", () => {
    expect(resolveDisplayMarkup({ markup: 42.5, price: 1, costPrice: 1 })).toBe(
      42.5,
    );
  });

  it("markup null com preço e custo ⇒ calcula na hora, sem o teto do banco", () => {
    expect(
      resolveDisplayMarkup({ markup: null, price: 26_000, costPrice: 0.01 }),
    ).toBe(259_999_900);
  });

  it("sem custo ⇒ null", () => {
    expect(resolveDisplayMarkup({ markup: null, price: 100 })).toBeNull();
  });
});

describe("isStorableMoney", () => {
  it("aceita de 0 até 99.999.999,99", () => {
    expect(isStorableMoney(0)).toBe(true);
    expect(isStorableMoney(DECIMAL_10_2_MAX)).toBe(true);
  });

  it("recusa acima do teto, negativo e não finito", () => {
    expect(isStorableMoney(100_000_000)).toBe(false);
    expect(isStorableMoney(-1)).toBe(false);
    expect(isStorableMoney(NaN)).toBe(false);
    expect(isStorableMoney(Infinity)).toBe(false);
    expect(isStorableMoney("10")).toBe(false);
  });
});
