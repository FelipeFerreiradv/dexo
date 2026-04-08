import { describe, expect, it } from "vitest";
import {
  DEFAULT_PRODUCT_FILTERS,
  filterPublishedCategories,
  getCompatibleListingCategoryValue,
  hasActiveProductFilters,
  normalizeProductFilters,
  serializeProductFilters,
} from "../app/produtos/lib/product-filters";

describe("product filter serialization helpers", () => {
  it("omits empty values and trims filled filters", () => {
    const normalized = normalizeProductFilters({
      ...DEFAULT_PRODUCT_FILTERS,
      search: "  cubo de roda  ",
      listingCategory: "  SHOPEE:SHP_12345 ",
      brand: " Fiat ",
      publicationStatus: "ACTIVE",
      priceMin: " 10 ",
      locationId: " loc-1 ",
    });

    expect(normalized).toEqual({
      search: "cubo de roda",
      listingCategory: "SHOPEE:SHP_12345",
      brand: "Fiat",
      publicationStatus: "ACTIVE",
      priceMin: "10",
      locationId: "loc-1",
    });
  });

  it("serializes pagination together with non-empty filters", () => {
    const params = serializeProductFilters(
      {
        ...DEFAULT_PRODUCT_FILTERS,
        search: "cubo",
        marketplace: "BOTH",
        stockStatus: "LOW_STOCK",
      },
      { page: 3, limit: 25 },
    );

    expect(params.toString()).toBe(
      "page=3&limit=25&search=cubo&stockStatus=LOW_STOCK&marketplace=BOTH",
    );
  });

  it("ignores one-character search terms to preserve debounce behavior", () => {
    const params = serializeProductFilters({
      ...DEFAULT_PRODUCT_FILTERS,
      search: "a",
      brand: "Fiat",
    });

    expect(params.toString()).toBe("page=1&limit=10&brand=Fiat");
  });

  it("reports reset state as having no active filters", () => {
    expect(hasActiveProductFilters(DEFAULT_PRODUCT_FILTERS)).toBe(false);
  });

  it("filters published categories by marketplace and clears incompatible selections", () => {
    const categories = [
      {
        value: "MERCADO_LIVRE:MLB114766",
        label: "Mercado Livre • Peças > Motor",
        platform: "MERCADO_LIVRE" as const,
        categoryId: "MLB114766",
      },
      {
        value: "SHOPEE:SHP_12345",
        label: "Shopee • Auto > Cubos de roda",
        platform: "SHOPEE" as const,
        categoryId: "SHP_12345",
      },
    ];

    expect(filterPublishedCategories(categories, "SHOPEE")).toEqual([
      categories[1],
    ]);
    expect(filterPublishedCategories(categories, "BOTH")).toEqual(categories);
    expect(
      getCompatibleListingCategoryValue(
        "MERCADO_LIVRE:MLB114766",
        categories,
        "SHOPEE",
      ),
    ).toBe("");
    expect(
      getCompatibleListingCategoryValue(
        "SHOPEE:SHP_12345",
        categories,
        "SHOPEE",
      ),
    ).toBe("SHOPEE:SHP_12345");
    expect(
      getCompatibleListingCategoryValue(
        "MERCADO_LIVRE:MLB114766",
        categories,
        "BOTH",
      ),
    ).toBe("MERCADO_LIVRE:MLB114766");
  });
});
