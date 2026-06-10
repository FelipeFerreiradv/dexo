import { describe, it, expect } from "vitest";
import {
  computeStaggeredPrice,
  computeStaggeredPrices,
} from "../cross-account-price.service";

describe("computeStaggeredPrice", () => {
  it("mantém o preço base na 1ª conta (índice 0), para qualquer percentual", () => {
    expect(computeStaggeredPrice(100, 0, 10)).toBe(100);
    expect(computeStaggeredPrice(100, 0, 0)).toBe(100);
    expect(computeStaggeredPrice(199.9, 0, 12.75)).toBe(199.9);
  });

  it("aplica a cascata composta (base 100, 10%) conforme o exemplo do spec", () => {
    expect(computeStaggeredPrice(100, 0, 10)).toBe(100); // Conta 1
    expect(computeStaggeredPrice(100, 1, 10)).toBe(110); // Conta 2
    expect(computeStaggeredPrice(100, 2, 10)).toBe(121); // Conta 3
    expect(computeStaggeredPrice(100, 3, 10)).toBe(133.1); // Conta 4
  });

  it("percentual 0 (desativado) ⇒ preço base em todos os índices", () => {
    expect(computeStaggeredPrice(250, 0, 0)).toBe(250);
    expect(computeStaggeredPrice(250, 1, 0)).toBe(250);
    expect(computeStaggeredPrice(250, 5, 0)).toBe(250);
  });

  it("suporta percentuais decimais (5,5% e 12,75%)", () => {
    // 100 * 1.055 = 105.5 ; 100 * 1.055^2 = 111.3025 → 111.3
    expect(computeStaggeredPrice(100, 1, 5.5)).toBe(105.5);
    expect(computeStaggeredPrice(100, 2, 5.5)).toBe(111.3);
    // 100 * 1.1275 = 112.75 ; 100 * 1.1275^2 = 127.125625 → 127.13
    expect(computeStaggeredPrice(100, 1, 12.75)).toBe(112.75);
    expect(computeStaggeredPrice(100, 2, 12.75)).toBe(127.13);
  });

  it("arredonda para 2 casas (ROUND_HALF_UP) — borda 33,33 a 7%", () => {
    expect(computeStaggeredPrice(33.33, 0, 7)).toBe(33.33);
    // 33.33 * 1.07 = 35.6631 → 35.66
    expect(computeStaggeredPrice(33.33, 1, 7)).toBe(35.66);
    // 33.33 * 1.1449 = 38.159517 → 38.16
    expect(computeStaggeredPrice(33.33, 2, 7)).toBe(38.16);
  });

  it("não produz NaN/Infinity com muitas contas", () => {
    for (let i = 0; i < 10; i++) {
      const v = computeStaggeredPrice(100, i, 10);
      expect(Number.isFinite(v)).toBe(true);
    }
    // 100 * 1.1^9 = 235.7947... → 235.79
    expect(computeStaggeredPrice(100, 9, 10)).toBe(235.79);
  });

  it("base <= 0 ou inválida ⇒ devolve a base sem escalar (caller ignora)", () => {
    expect(computeStaggeredPrice(0, 2, 10)).toBe(0);
    expect(computeStaggeredPrice(-5, 2, 10)).toBe(-5);
  });

  it("índice ou percentual negativo/ inválido ⇒ preço base", () => {
    expect(computeStaggeredPrice(100, -1, 10)).toBe(100);
    expect(computeStaggeredPrice(100, 2, -10)).toBe(100);
    expect(computeStaggeredPrice(100, Number.NaN, 10)).toBe(100);
  });
});

describe("computeStaggeredPrices", () => {
  it("retorna um vetor de tamanho N com o índice 0 no preço base", () => {
    const prices = computeStaggeredPrices(100, 4, 10);
    expect(prices).toHaveLength(4);
    expect(prices[0]).toBe(100);
    expect(prices).toEqual([100, 110, 121, 133.1]);
  });

  it("vetor vazio quando não há contas", () => {
    expect(computeStaggeredPrices(100, 0, 10)).toEqual([]);
  });

  it("com percentual 0 ⇒ todos iguais ao preço base", () => {
    expect(computeStaggeredPrices(80, 3, 0)).toEqual([80, 80, 80]);
  });
});
