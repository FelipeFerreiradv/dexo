import { describe, it, expect } from "vitest";
import {
  computeSuggestedPrice,
  nfeItemToInitialValues,
  nfeFieldEntries,
  NFE_FILLABLE_FIELDS,
  DEFAULT_NFE_MARKUP,
} from "../../app/produtos/lib/nfe-import-mapping";
import type { NfeParsedItem } from "../../app/fiscal/nfe-import/nfe-import.types";

const item: NfeParsedItem = {
  groupKey: "ABC123|7890000000017|PRODUTO TESTE",
  name: "PRODUTO TESTE",
  fullName: "PRODUTO TESTE",
  costPrice: 45.9,
  quantity: 5,
  unit: "UN",
  lineTotal: 229.5,
};

describe("computeSuggestedPrice", () => {
  it("markup 0 → preço = custo", () => {
    expect(computeSuggestedPrice(100, 0)).toBe(100);
  });
  it("markup 100 → dobro do custo", () => {
    expect(computeSuggestedPrice(45.9, 100)).toBe(91.8);
  });
  it("markup 30 com arredondamento a 2 casas", () => {
    expect(computeSuggestedPrice(45.9, 30)).toBe(59.67); // 45.9 * 1.3 = 59.67
  });
  it("custo inválido/negativo → 0", () => {
    expect(computeSuggestedPrice(-1, 100)).toBe(0);
    expect(computeSuggestedPrice(Number.NaN, 100)).toBe(0);
  });
  it("markup negativo é tratado como 0", () => {
    expect(computeSuggestedPrice(50, -10)).toBe(50);
  });
});

describe("nfeItemToInitialValues", () => {
  it("mapeia custo→costPrice, quantidade→stock, sugere price e marca NOVO", () => {
    const v = nfeItemToInitialValues(item, 100);
    expect(v.name).toBe("PRODUTO TESTE");
    expect(v.costPrice).toBe(45.9);
    expect(v.stock).toBe(5);
    expect(v.price).toBe(91.8);
    expect(v.quality).toBe("NOVO");
  });

  it("NUNCA injeta imageUrl nem sku (não burla imagem obrigatória / SKU automático)", () => {
    const v = nfeItemToInitialValues(item);
    expect("imageUrl" in v).toBe(false);
    expect("sku" in v).toBe(false);
  });

  it("usa DEFAULT_NFE_MARKUP quando o markup não é informado", () => {
    const v = nfeItemToInitialValues(item);
    expect(v.price).toBe(
      computeSuggestedPrice(item.costPrice, DEFAULT_NFE_MARKUP),
    );
  });
});

describe("nfeFieldEntries (guarda de retrocompatibilidade do modal)", () => {
  it("sem initialValues → nenhuma entrada (fluxo manual fica intocado)", () => {
    expect(nfeFieldEntries(undefined)).toEqual([]);
    expect(nfeFieldEntries(null)).toEqual([]);
    expect(nfeFieldEntries({})).toEqual([]);
  });

  it("aplica somente os campos permitidos que estão presentes", () => {
    const e = nfeFieldEntries({
      name: "X",
      costPrice: 10,
      stock: 5,
      price: 20,
      quality: "NOVO",
    });
    expect(e).toEqual([
      ["name", "X"],
      ["costPrice", 10],
      ["stock", 5],
      ["price", 20],
      ["quality", "NOVO"],
    ]);
  });

  it("NUNCA inclui imageUrl/sku/brand mesmo se vierem no input", () => {
    const e = nfeFieldEntries({
      name: "X",
      imageUrl: "/hack.png",
      sku: "ABC",
      brand: "Bosch",
    });
    expect(e.map(([k]) => k)).toEqual(["name"]);
  });

  it("ignora valores null/undefined (não preenche com vazio)", () => {
    const e = nfeFieldEntries({ name: "X", costPrice: null, stock: undefined });
    expect(e).toEqual([["name", "X"]]);
  });

  it("a lista permitida não contém imageUrl nem sku", () => {
    expect(NFE_FILLABLE_FIELDS).not.toContain("imageUrl");
    expect(NFE_FILLABLE_FIELDS).not.toContain("sku");
  });
});
