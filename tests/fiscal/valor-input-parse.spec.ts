import { describe, it, expect } from "vitest";
import { parseValorInput } from "../../app/notas-fiscais/components/valor-input";

// ──────────────────────────────────────────────────────────────────────────
// C2 — Valor (R$) na emissão fiscal → aba Pagamentos.
//
// O campo era <input type="number"> com default 0, exibido como "0"; digitar
// "50" anexava ao "0" → "050". O ValorInput começa vazio em 0 e usa este parse
// puro para converter o texto no número (reais) do formulário. Aceita "." ou
// "," como decimal; vazio/sem dígito → 0 (mesmo contrato de Number("")===0).
// ──────────────────────────────────────────────────────────────────────────

describe("parseValorInput — valor (R$) no wizard fiscal", () => {
  it.each<[string, number]>([
    ["50", 50],
    ["050", 50], // o bug reportado: digitar 50 não pode virar "050"
    ["1234", 1234],
    ["1234.56", 1234.56],
    ["1234,56", 1234.56],
    ["0,50", 0.5],
    ["0.5", 0.5],
    ["10,00", 10],
  ])("'%s' → %s", (input, expected) => {
    expect(parseValorInput(input)).toBeCloseTo(expected, 5);
  });

  it.each<[string]>([[""], ["R$"], ["abc"], [","], ["."]])(
    "vazio/sem dígito '%s' → 0",
    (input) => {
      expect(parseValorInput(input)).toBe(0);
    },
  );
});
