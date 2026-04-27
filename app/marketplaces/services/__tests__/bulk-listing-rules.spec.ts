import { describe, expect, it } from "vitest";
import {
  applyRules,
  computeBulkPrice,
  computeBulkTitle,
  previewWarnings,
} from "../bulk-listing-rules.service";

const baseProduct = {
  id: "p1",
  name: "Bomba d'água Honda Civic",
  price: 100,
  costPrice: 50,
};

describe("computeBulkPrice", () => {
  it("returns null for keep rule", () => {
    expect(computeBulkPrice(baseProduct, { type: "keep" })).toBeNull();
    expect(computeBulkPrice(baseProduct, undefined)).toBeNull();
  });

  it("returns rounded fixed price", () => {
    expect(
      computeBulkPrice(baseProduct, { type: "fixed", value: 199.999 }),
    ).toBe(200);
  });

  it("rejects non-positive fixed", () => {
    expect(computeBulkPrice(baseProduct, { type: "fixed", value: 0 })).toBeNull();
  });

  it("applies markup_pct over costPrice", () => {
    expect(
      computeBulkPrice(baseProduct, { type: "markup_pct", value: 100 }),
    ).toBe(100);
    expect(
      computeBulkPrice(baseProduct, { type: "markup_pct", value: 50 }),
    ).toBe(75);
  });

  it("returns null for markup when no costPrice", () => {
    expect(
      computeBulkPrice(
        { ...baseProduct, costPrice: null },
        { type: "markup_pct", value: 30 },
      ),
    ).toBeNull();
  });

  it("applies delta_pct on current price", () => {
    expect(
      computeBulkPrice(baseProduct, { type: "delta_pct", value: 30 }),
    ).toBe(130);
    expect(
      computeBulkPrice(baseProduct, { type: "delta_pct", value: -20 }),
    ).toBe(80);
  });

  it("rejects delta that brings price to zero or below", () => {
    expect(
      computeBulkPrice(baseProduct, { type: "delta_pct", value: -100 }),
    ).toBeNull();
  });
});

describe("computeBulkTitle", () => {
  it("returns null when suffix empty", () => {
    expect(computeBulkTitle(baseProduct, undefined)).toBeNull();
    expect(computeBulkTitle(baseProduct, { titleSuffix: "  " })).toBeNull();
  });

  it("appends suffix and trims", () => {
    expect(
      computeBulkTitle(
        { ...baseProduct, name: "Bomba" },
        { titleSuffix: "Original" },
      ),
    ).toBe("Bomba Original");
  });

  it("clamps to 60 chars", () => {
    const longName = "a".repeat(80);
    const result = computeBulkTitle(
      { ...baseProduct, name: longName },
      { titleSuffix: "x" },
    );
    expect(result?.length).toBe(60);
  });
});

describe("applyRules", () => {
  it("returns null when template has no effective rule", () => {
    expect(applyRules(baseProduct, undefined)).toBeNull();
    expect(applyRules(baseProduct, {})).toBeNull();
    expect(applyRules(baseProduct, { priceRule: { type: "keep" } })).toBeNull();
  });

  it("merges price + title overrides", () => {
    const result = applyRules(baseProduct, {
      priceRule: { type: "delta_pct", value: 10 },
      titleSuffix: "Premium",
    });
    expect(result).toEqual({
      priceOverride: 110,
      titleOverride: "Bomba d'água Honda Civic Premium",
    });
  });
});

describe("previewWarnings", () => {
  it("warns about missing image and category", () => {
    const w = previewWarnings(
      { ...baseProduct, imageUrl: null, mlCategoryId: null },
      undefined,
    );
    expect(w.length).toBe(2);
  });

  it("warns when markup is set but no cost", () => {
    const w = previewWarnings(
      {
        ...baseProduct,
        costPrice: null,
        imageUrl: "x.jpg",
        mlCategoryId: "MLB1",
      },
      { priceRule: { type: "markup_pct", value: 30 } },
    );
    expect(w.some((m) => m.includes("custo"))).toBe(true);
  });
});
