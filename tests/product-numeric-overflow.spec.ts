import { describe, it, expect } from "vitest";
import {
  isPrismaNumericOverflow,
  NumericOverflowError,
  isNumericOverflowError,
} from "../app/repositories/numeric-overflow-error";
import { productNumericLimitError } from "../app/lib/money/product-numeric-limits";

describe("isPrismaNumericOverflow", () => {
  it("reconhece o P2020 estruturado do Prisma", () => {
    expect(isPrismaNumericOverflow({ code: "P2020", message: "x" })).toBe(true);
  });

  it("reconhece a mensagem do Postgres (22003) vinda como erro desconhecido", () => {
    expect(
      isPrismaNumericOverflow(
        new Error(
          'Invalid `prisma.product.create()` invocation: ... code: "22003", message: "numeric field overflow"',
        ),
      ),
    ).toBe(true);
  });

  it("NÃO confunde um número 22003 qualquer (SKU, id) com estouro", () => {
    expect(
      isPrismaNumericOverflow(new Error("Produto 22003 não encontrado")),
    ).toBe(false);
    expect(isPrismaNumericOverflow({ code: "P2002" })).toBe(false);
    expect(isPrismaNumericOverflow(null)).toBe(false);
  });

  it("o erro tipado carrega mensagem legível", () => {
    const e = new NumericOverflowError();
    expect(isNumericOverflowError(e)).toBe(true);
    expect(e.message).toMatch(/acima do limite/);
    expect(isNumericOverflowError(new Error("x"))).toBe(false);
  });
});

describe("productNumericLimitError", () => {
  it("valores normais passam", () => {
    expect(
      productNumericLimitError({
        price: 199.9,
        costPrice: 50,
        weightKg: 2.5,
        heightCm: 20,
        widthCm: 20,
        lengthCm: 40,
      }),
    ).toBeNull();
  });

  it("ausente e nulo não são validados (a rota decide)", () => {
    expect(
      productNumericLimitError({
        price: undefined,
        costPrice: null,
        weightKg: undefined,
        heightCm: null,
      }),
    ).toBeNull();
  });

  it("limites exatos das colunas passam; um centavo acima não", () => {
    expect(productNumericLimitError({ price: 99_999_999.99 })).toBeNull();
    expect(productNumericLimitError({ price: 100_000_000 })).toMatch(
      /Preço acima/,
    );
    expect(productNumericLimitError({ weightKg: 9_999.99 })).toBeNull();
    expect(productNumericLimitError({ weightKg: 10_000 })).toMatch(/Peso/);
    expect(productNumericLimitError({ heightCm: 2_147_483_647 })).toBeNull();
    expect(productNumericLimitError({ heightCm: 2_147_483_648 })).toMatch(
      /Altura/,
    );
  });

  it("não finito é recusado com a mensagem do campo", () => {
    expect(productNumericLimitError({ price: NaN })).toBe("Preço inválido");
    expect(productNumericLimitError({ costPrice: "abc" })).toBe(
      "Custo inválido",
    );
    expect(productNumericLimitError({ lengthCm: Infinity })).toMatch(
      /Comprimento inválido/,
    );
  });

  it("centímetro fracionado é recusado (coluna Int); 0 e negativo passam como hoje", () => {
    expect(productNumericLimitError({ widthCm: 10.5 })).toMatch(
      /Largura inválida/,
    );
    expect(productNumericLimitError({ widthCm: 0 })).toBeNull();
    expect(productNumericLimitError({ widthCm: -3 })).toBeNull();
  });

  it("aceita número em string (a rota PUT repassa o que chega)", () => {
    expect(productNumericLimitError({ price: "10.5", costPrice: "3" })).toBeNull();
  });
});
