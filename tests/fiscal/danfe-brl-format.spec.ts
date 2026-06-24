import { describe, it, expect } from "vitest";
import { formatBRLNumber } from "../../app/fiscal/generators/danfe-helpers";

// ──────────────────────────────────────────────────────────────────────────
// Exibições do DANFE no padrão BRL ("R$ 50,00" em vez de "R$ 50.00").
//
// formatBRLNumber formata SÓ a exibição do PDF (vírgula decimal, ponto de
// milhar). O XML da SEFAZ continua com ponto (testado/garantido à parte) — este
// helper NÃO é usado lá. Implementação manual (sem ICU) → roda no servidor.
// ──────────────────────────────────────────────────────────────────────────

describe("formatBRLNumber — padrão monetário BR (sem R$)", () => {
  it.each<[number, string]>([
    [50, "50,00"],
    [50.5, "50,50"],
    [1234.5, "1.234,50"],
    [1234.56, "1.234,56"],
    [1000000, "1.000.000,00"],
    [0, "0,00"],
    [99.999, "100,00"], // arredonda para 2 casas
  ])("%s → %s", (input, expected) => {
    expect(formatBRLNumber(input)).toBe(expected);
  });

  it("null/undefined → 0,00", () => {
    expect(formatBRLNumber(null)).toBe("0,00");
    expect(formatBRLNumber(undefined)).toBe("0,00");
  });

  it("usa vírgula como separador decimal (não ponto)", () => {
    const out = formatBRLNumber(50);
    expect(out).toContain(",");
    // o decimal nunca usa ponto: "50,00" não tem ".00"
    expect(out.endsWith(",00")).toBe(true);
  });
});
