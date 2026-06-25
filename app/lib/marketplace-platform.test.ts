import { describe, it, expect } from "vitest";
import { canonPlatform } from "./marketplace-platform";

describe("canonPlatform (normalização de plataforma p/ leitura de logs)", () => {
  it("reconhece todos os formatos históricos de Mercado Livre como ML", () => {
    for (const raw of [
      "MercadoLivre",
      "Mercado Livre",
      "MERCADO_LIVRE",
      "mercadolivre",
      "mercadolibre",
      "ML",
      "ml",
      "MELI",
    ]) {
      expect(canonPlatform(raw)).toBe("ML");
    }
  });

  it("reconhece todos os formatos de Shopee como SHOPEE", () => {
    for (const raw of ["SHOPEE", "Shopee", "shopee"]) {
      expect(canonPlatform(raw)).toBe("SHOPEE");
    }
  });

  it("entradas vazias/nulas/desconhecidas caem em OUTRO (sem lançar)", () => {
    expect(canonPlatform(undefined)).toBe("OUTRO");
    expect(canonPlatform(null)).toBe("OUTRO");
    expect(canonPlatform("")).toBe("OUTRO");
    expect(canonPlatform("   ")).toBe("OUTRO");
    expect(canonPlatform("Amazon")).toBe("OUTRO");
    expect(canonPlatform("12345")).toBe("OUTRO");
  });
});
