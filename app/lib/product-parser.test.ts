import { describe, it, expect } from "vitest";
import {
  parseTitleToFields,
  suggestCategoryFromTitle,
  mapSuggestedCategory,
} from "./product-parser";

describe("product-parser", () => {
  it("parses brand/model/year from `Limitador Porta Diantera Hyundai Hb20 2014`", () => {
    const title = "Limitador Porta Diantera Hyundai Hb20 2014";
    const r = parseTitleToFields(title);
    expect(r.brand).toBe("Hyundai");
    expect(r.model).toBe("HB20");
    expect(r.year).toBe("2014");
    // now we return the more specific subcategory when matched
    expect(r.category).toBe("Carroceria e Lataria > Portas");
  });

  it("parses simple title with model token e.g. 'Amortecedor Cofap Honda City 2018'", () => {
    const title = "Amortecedor Cofap Honda City 2018";
    const r = parseTitleToFields(title);
    expect(r.brand).toBe("Honda");
    expect(r.model).toBe("CITY");
    expect(r.year).toBe("2018");
    // category from keywords (amortecedor) -> more specific child
    expect(r.category).toBe("Suspensão > Amortecedor");
  });

  it("mapSuggestedCategory maps a child suggestion to parent + id", () => {
    const m = mapSuggestedCategory("Carroceria e Lataria > Portas");
    expect(m.topLevel).toBe("Carroceria e Lataria");
    expect(m.detailedId).toBe("MLB1754-01");
    expect(m.detailedValue).toBe("Carroceria e Lataria > Portas");
  });

  it("returns empty for unknown title", () => {
    const r = parseTitleToFields("Random item without brand or year");
    expect(r.brand).toBeUndefined();
    expect(r.model).toBeUndefined();
    expect(r.year).toBeUndefined();
  });

  it("suggests cubo de roda as detailed child", () => {
    const title = "Cubo de roda dianteiro para palio";
    const suggested = suggestCategoryFromTitle(title);
    expect(suggested).toBe(
      "Acessórios para Veículos > Peças de Carros e Caminhonetes > Suspensão e Direção > Cubo de Roda",
    );
    const m = mapSuggestedCategory(suggested!);
    expect(m.detailedId).toBe("MLB1765-01");
    expect(m.topLevel).toBe("Acessórios para Veículos");
  });
});
