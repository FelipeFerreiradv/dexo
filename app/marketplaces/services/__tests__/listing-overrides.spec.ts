import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import {
  effectiveListingValues,
  applyOverridesToProduct,
} from "../listing-overrides.service";

/**
 * Contrato do módulo: "override null ⇒ herda o valor do produto".
 *
 * O preço tinha um furo: `overridePrice ?? productPrice` só cai no fallback
 * para null/undefined, nunca para 0. Um `priceOverride = 0` (que a UI conseguia
 * persistir) virava preço efetivo 0 e zerava o `price` do produto efetivo.
 * Preço de anúncio zerado significa HERDAR, não publicar por R$ 0.
 */

const product = {
  id: "prod-1",
  name: "Farol Dianteiro",
  price: new Prisma.Decimal("100.00"),
  stock: 3,
} as any;

describe("effectiveListingValues — preço", () => {
  it("herda o preço do produto quando o override é null", () => {
    const eff = effectiveListingValues({ priceOverride: null }, product);
    expect(eff.price).toBe(100);
  });

  it("herda o preço do produto quando o override é undefined", () => {
    const eff = effectiveListingValues({}, product);
    expect(eff.price).toBe(100);
  });

  it("herda o preço do produto quando o override é 0", () => {
    const eff = effectiveListingValues({ priceOverride: 0 }, product);
    expect(eff.price).toBe(100);
  });

  it("herda o preço do produto quando o override é um Decimal zerado", () => {
    const eff = effectiveListingValues(
      { priceOverride: new Prisma.Decimal("0") },
      product,
    );
    expect(eff.price).toBe(100);
  });

  it("usa o override quando ele é > 0", () => {
    const eff = effectiveListingValues({ priceOverride: 150.5 }, product);
    expect(eff.price).toBe(150.5);
  });

  it("usa o override quando ele é um Decimal > 0", () => {
    const eff = effectiveListingValues(
      { priceOverride: new Prisma.Decimal("150.50") },
      product,
    );
    expect(eff.price).toBe(150.5);
  });
});

describe("applyOverridesToProduct — preço", () => {
  it("preserva o Decimal do produto quando não há override", () => {
    const result = applyOverridesToProduct(product, { priceOverride: null });
    // Preservar o tipo importa: callers passam o resultado adiante esperando
    // o shape do Product do Prisma.
    expect(result.price).toBe(product.price);
    expect(Number(result.price)).toBe(100);
  });

  it("NÃO zera o preço do produto quando o override é 0", () => {
    const result = applyOverridesToProduct(product, { priceOverride: 0 });
    expect(Number(result.price)).toBe(100);
  });

  it("sobrescreve o preço quando o override é > 0", () => {
    const result = applyOverridesToProduct(product, { priceOverride: 150.5 });
    expect(Number(result.price)).toBe(150.5);
  });

  it("não altera o produto original (retorna cópia)", () => {
    const result = applyOverridesToProduct(product, { priceOverride: 150.5 });
    expect(Number(product.price)).toBe(100);
    expect(result).not.toBe(product);
  });

  it("não sobrescreve o stock (estoque não tem override por design)", () => {
    const result = applyOverridesToProduct(product, { priceOverride: 150.5 });
    expect(result.stock).toBe(3);
  });
});
