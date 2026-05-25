import { describe, it, expect } from "vitest";
import { chunk } from "./chunk";

describe("chunk", () => {
  it("retorna array vazio para entrada vazia", () => {
    expect(chunk([], 10)).toEqual([]);
  });

  it("divide um array em sub-arrays do tamanho exato quando divide certinho", () => {
    expect(chunk([1, 2, 3, 4, 5, 6], 2)).toEqual([
      [1, 2],
      [3, 4],
      [5, 6],
    ]);
  });

  it("último chunk fica menor quando o tamanho não divide certinho", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("size maior que o array retorna um único chunk com tudo", () => {
    expect(chunk([1, 2, 3], 10)).toEqual([[1, 2, 3]]);
  });

  it("size = 1 retorna um chunk por elemento", () => {
    expect(chunk(["a", "b", "c"], 1)).toEqual([["a"], ["b"], ["c"]]);
  });

  it("simula o caso real: 42637 IDs em chunks de 10000", () => {
    const ids = Array.from({ length: 42637 }, (_, i) => `id_${i}`);
    const chunks = chunk(ids, 10000);
    expect(chunks).toHaveLength(5);
    expect(chunks[0]).toHaveLength(10000);
    expect(chunks[1]).toHaveLength(10000);
    expect(chunks[2]).toHaveLength(10000);
    expect(chunks[3]).toHaveLength(10000);
    expect(chunks[4]).toHaveLength(2637);
    // Sem perda de elementos
    expect(chunks.flat()).toEqual(ids);
  });

  it("rejeita size inválido", () => {
    expect(() => chunk([1, 2, 3], 0)).toThrow(/positivo/);
    expect(() => chunk([1, 2, 3], -1)).toThrow(/positivo/);
    expect(() => chunk([1, 2, 3], 1.5)).toThrow(/inteiro/);
    expect(() => chunk([1, 2, 3], NaN)).toThrow(/inteiro/);
  });
});
