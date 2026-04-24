import { describe, it, expect } from "vitest";
import { __testables } from "../app/marketplaces/usecases/ml-catalog-suggestion.usecase";

const { normalizeSuggestion, normalizeDetail, extractCompatibilities, parseYearRange } =
  __testables;

describe("parseYearRange", () => {
  it("retorna null quando não há ano parseável", () => {
    expect(parseYearRange(null)).toEqual({ from: null, to: null });
    expect(parseYearRange("Todos")).toEqual({ from: null, to: null });
  });

  it("extrai ano único quando só há um valor", () => {
    expect(parseYearRange("2018")).toEqual({ from: 2018, to: 2018 });
  });

  it("extrai range '2008-2013'", () => {
    expect(parseYearRange("2008-2013")).toEqual({ from: 2008, to: 2013 });
  });

  it("extrai range com texto ao redor", () => {
    expect(parseYearRange("2008 a 2013")).toEqual({ from: 2008, to: 2013 });
  });
});

describe("normalizeSuggestion", () => {
  it("extrai id/name/categoria/thumbnail de um hit do ML", () => {
    const result = normalizeSuggestion({
      id: "MLB19765739",
      name: "Cubo de Roda Fiat Uno 2018",
      status: "active",
      domain_id: "MLB-AUTOMOTIVE_WHEEL_HUBS",
      category_id: "MLB1765-01",
      permalink: "https://produto.mercadolivre.com.br/MLB19765739",
      pictures: [
        { id: "p1", url: "http://img.com/a.jpg", secure_url: "https://img.com/a.jpg" },
      ],
      attributes: [
        { id: "BRAND", value_name: "Fiat" },
        { id: "MODEL", value_name: "Uno" },
      ],
    });

    expect(result.catalogProductId).toBe("MLB19765739");
    expect(result.brand).toBe("Fiat");
    expect(result.model).toBe("Uno");
    expect(result.thumbnailUrl).toBe("https://img.com/a.jpg");
  });

  it("tolera campos ausentes", () => {
    const result = normalizeSuggestion({ id: "MLB1" });
    expect(result.catalogProductId).toBe("MLB1");
    expect(result.brand).toBeNull();
    expect(result.model).toBeNull();
    expect(result.thumbnailUrl).toBeNull();
  });
});

describe("normalizeDetail", () => {
  it("mapeia atributos para o formato consumido pelo form", () => {
    const result = normalizeDetail({
      id: "MLB19765739",
      catalog_product_id: "MLB19765739",
      site_id: "MLB",
      domain_id: "MLB-AUTOMOTIVE_WHEEL_HUBS",
      category_id: "MLB1765-01",
      name: "Cubo de Roda Dianteiro",
      family_name: "Cubo de Roda",
      permalink: null,
      pictures: [{ url: "http://img.com/a.jpg" }],
      attributes: [
        { id: "BRAND", value_id: "123", value_name: "Fiat" },
        { id: "MODEL", value_name: "Uno" },
        { id: "VEHICLE_YEAR", value_name: "2008-2018" },
        { id: "MATERIAL", value_name: "Aço" },
      ],
    } as any);

    expect(result.brand).toBe("Fiat");
    expect(result.model).toBe("Uno");
    expect(result.attributes.BRAND).toEqual({
      value_id: "123",
      value_name: "Fiat",
    });
    expect(result.attributes.MATERIAL).toEqual({ value_name: "Aço" });
    expect(result.pictures).toHaveLength(1);
    expect(result.year).toBe("2008"); // parseYearToNumber pega primeiro ano de 4 dígitos
  });

  it("prioriza catalog_product_id quando presente", () => {
    const result = normalizeDetail({
      id: "MLB1",
      catalog_product_id: "MLBCAT42",
      name: "x",
    } as any);
    expect(result.catalogProductId).toBe("MLBCAT42");
  });

  it("cai para details.id quando não há catalog_product_id", () => {
    const result = normalizeDetail({ id: "MLB1", name: "x" } as any);
    expect(result.catalogProductId).toBe("MLB1");
  });

  it("extrai partNumber de PART_NUMBER", () => {
    const result = normalizeDetail({
      id: "MLB1",
      name: "x",
      attributes: [{ id: "PART_NUMBER", value_name: "GN118A080AA" }],
    } as any);
    expect(result.partNumber).toBe("GN118A080AA");
  });

  it("cai para MPN quando PART_NUMBER ausente", () => {
    const result = normalizeDetail({
      id: "MLB1",
      name: "x",
      attributes: [{ id: "MPN", value_name: "MPN-999" }],
    } as any);
    expect(result.partNumber).toBe("MPN-999");
  });

  it("cai para OEM quando PART_NUMBER e MPN ausentes", () => {
    const result = normalizeDetail({
      id: "MLB1",
      name: "x",
      attributes: [{ id: "OEM", value_name: "OEM-123" }],
    } as any);
    expect(result.partNumber).toBe("OEM-123");
  });

  it("partNumber é null quando nenhum código presente", () => {
    const result = normalizeDetail({
      id: "MLB1",
      name: "x",
      attributes: [{ id: "MATERIAL", value_name: "Aço" }],
    } as any);
    expect(result.partNumber).toBeNull();
  });
});

describe("extractCompatibilities", () => {
  it("monta uma entrada com range de anos quando BRAND/MODEL/VEHICLE_YEAR existem", () => {
    const compat = extractCompatibilities({
      id: "MLB1",
      attributes: [
        { id: "BRAND", value_name: "Fiat" },
        { id: "MODEL", value_name: "Uno" },
        { id: "VEHICLE_YEAR", value_name: "2008-2018" },
        { id: "TRIM", value_name: "Attractive" },
      ],
    } as any);

    expect(compat).toEqual([
      {
        brand: "Fiat",
        model: "Uno",
        yearFrom: 2008,
        yearTo: 2018,
        version: "Attractive",
      },
    ]);
  });

  it("retorna [] quando falta marca ou modelo", () => {
    expect(
      extractCompatibilities({
        id: "MLB1",
        attributes: [{ id: "BRAND", value_name: "Fiat" }],
      } as any),
    ).toEqual([]);
  });

  it("retorna yearFrom/yearTo null quando VEHICLE_YEAR ausente", () => {
    const compat = extractCompatibilities({
      id: "MLB1",
      attributes: [
        { id: "BRAND", value_name: "Fiat" },
        { id: "MODEL", value_name: "Uno" },
      ],
    } as any);
    expect(compat).toEqual([
      {
        brand: "Fiat",
        model: "Uno",
        yearFrom: null,
        yearTo: null,
        version: null,
      },
    ]);
  });
});
