import { describe, it, expect } from "vitest";
import {
  MAX_QUANTITY_PER_ITEM,
  MAX_TOTAL_LABELS,
  normalizeQuantity,
  validateStandaloneLabelItems,
  expandItemsToPages,
  type StandaloneLabelItem,
} from "./standalone-labels";

describe("normalizeQuantity", () => {
  it("padrão 1 para entradas inválidas (vazio, NaN, negativo, zero, undefined)", () => {
    expect(normalizeQuantity(undefined)).toBe(1);
    expect(normalizeQuantity("")).toBe(1);
    expect(normalizeQuantity("   ")).toBe(1);
    expect(normalizeQuantity("abc")).toBe(1);
    expect(normalizeQuantity(NaN)).toBe(1);
    expect(normalizeQuantity(0)).toBe(1);
    expect(normalizeQuantity(-3)).toBe(1);
  });

  it("trunca decimais (floor)", () => {
    expect(normalizeQuantity(2.7)).toBe(2);
    expect(normalizeQuantity(1.0)).toBe(1);
    expect(normalizeQuantity("4.9")).toBe(4);
  });

  it("mantém inteiros válidos e aceita string numérica", () => {
    expect(normalizeQuantity(5)).toBe(5);
    expect(normalizeQuantity("7")).toBe(7);
  });

  it("limita ao teto por item", () => {
    expect(normalizeQuantity(150)).toBe(MAX_QUANTITY_PER_ITEM);
    expect(normalizeQuantity(MAX_QUANTITY_PER_ITEM)).toBe(MAX_QUANTITY_PER_ITEM);
  });
});

describe("validateStandaloneLabelItems", () => {
  it("marca linha sem nome ou sem sku como inválida e bloqueia geração", () => {
    const items: StandaloneLabelItem[] = [
      { name: "Farol direito", sku: "SKU-1", quantity: 1 },
      { name: "", sku: "SKU-2", quantity: 1 },
      { name: "Retrovisor", sku: "   ", quantity: 1 },
    ];
    const v = validateStandaloneLabelItems(items);

    expect(v.rows[0].valid).toBe(true);
    expect(v.rows[1].nameOk).toBe(false);
    expect(v.rows[1].valid).toBe(false);
    expect(v.rows[2].skuOk).toBe(false);
    expect(v.rows[2].valid).toBe(false);

    expect(v.allRowsValid).toBe(false);
    expect(v.canGenerate).toBe(false);
    // total conta apenas as linhas válidas
    expect(v.totalLabels).toBe(1);
  });

  it("lista vazia não pode gerar", () => {
    const v = validateStandaloneLabelItems([]);
    expect(v.hasValidRows).toBe(false);
    expect(v.allRowsValid).toBe(false);
    expect(v.canGenerate).toBe(false);
    expect(v.totalLabels).toBe(0);
  });

  it("lista toda válida: canGenerate true e total correto", () => {
    const items: StandaloneLabelItem[] = [
      { name: "Peça A", sku: "A-1", quantity: 2 },
      { name: "Peça B", sku: "B-1", quantity: 3 },
      { name: "Peça C", sku: "C-1" }, // quantity ausente => 1
    ];
    const v = validateStandaloneLabelItems(items);
    expect(v.allRowsValid).toBe(true);
    expect(v.canGenerate).toBe(true);
    expect(v.overCap).toBe(false);
    expect(v.totalLabels).toBe(6);
  });

  it("total acima do teto marca overCap e bloqueia", () => {
    const items: StandaloneLabelItem[] = [
      { name: "Peça A", sku: "A-1", quantity: MAX_QUANTITY_PER_ITEM },
      { name: "Peça B", sku: "B-1", quantity: MAX_QUANTITY_PER_ITEM },
      { name: "Peça C", sku: "C-1", quantity: MAX_QUANTITY_PER_ITEM },
      { name: "Peça D", sku: "D-1", quantity: MAX_QUANTITY_PER_ITEM },
      { name: "Peça E", sku: "E-1", quantity: MAX_QUANTITY_PER_ITEM },
      { name: "Peça F", sku: "F-1", quantity: MAX_QUANTITY_PER_ITEM },
    ];
    const v = validateStandaloneLabelItems(items);
    // 6 × 100 = 600 > 500
    expect(v.totalLabels).toBe(6 * MAX_QUANTITY_PER_ITEM);
    expect(v.totalLabels).toBeGreaterThan(MAX_TOTAL_LABELS);
    expect(v.overCap).toBe(true);
    expect(v.allRowsValid).toBe(true);
    expect(v.canGenerate).toBe(false);
  });
});

describe("expandItemsToPages", () => {
  it("3 itens diferentes com qtd 1 => 3 páginas na ordem", () => {
    const pages = expandItemsToPages([
      { name: "Peça A", sku: "A-1", quantity: 1 },
      { name: "Peça B", sku: "B-1", quantity: 1 },
      { name: "Peça C", sku: "C-1", quantity: 1 },
    ]);
    expect(pages).toHaveLength(3);
    expect(pages.map((p) => p.sku)).toEqual(["A-1", "B-1", "C-1"]);
  });

  it("1 item com qtd 4 => 4 páginas idênticas", () => {
    const pages = expandItemsToPages([
      { name: "Peça A", sku: "A-1", quantity: 4 },
    ]);
    expect(pages).toHaveLength(4);
    expect(pages.every((p) => p.sku === "A-1" && p.name === "Peça A")).toBe(true);
  });

  it("lista mista preserva a ordem (2×qtd1 + 1×qtd3 = 5)", () => {
    const pages = expandItemsToPages([
      { name: "Peça A", sku: "A-1", quantity: 1 },
      { name: "Peça B", sku: "B-1", quantity: 1 },
      { name: "Peça C", sku: "C-1", quantity: 3 },
    ]);
    expect(pages).toHaveLength(5);
    expect(pages.map((p) => p.sku)).toEqual([
      "A-1",
      "B-1",
      "C-1",
      "C-1",
      "C-1",
    ]);
  });

  it("aplica trim em nome e sku (conteúdo do QR fiel)", () => {
    const pages = expandItemsToPages([
      { name: "  Peça A  ", sku: "  A-1  ", quantity: 1 },
    ]);
    expect(pages[0]).toEqual({ name: "Peça A", sku: "A-1" });
  });

  it("quantidade ausente/ inválida vira 1 página", () => {
    const pages = expandItemsToPages([
      { name: "Peça A", sku: "A-1" },
      { name: "Peça B", sku: "B-1", quantity: 0 },
    ]);
    expect(pages).toHaveLength(2);
    expect(pages.map((p) => p.sku)).toEqual(["A-1", "B-1"]);
  });
});
