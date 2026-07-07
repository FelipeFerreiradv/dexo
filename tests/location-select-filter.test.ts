import { describe, expect, it } from "vitest";
import {
  buildLocationSearchIndex,
  filterLocationIndex,
  filterLocationOptions,
  LOCATION_SELECT_MAX_RESULTS,
  type LocationSelectItem,
} from "@/app/produtos/lib/location-select-filter";

function loc(
  partial: Partial<LocationSelectItem> & {
    id: string;
    code: string;
    fullPath: string;
  },
): LocationSelectItem {
  return {
    description: undefined,
    maxCapacity: 0,
    productsCount: 0,
    isFull: false,
    ...partial,
  };
}

const options: LocationSelectItem[] = [
  loc({ id: "1", code: "R1", fullPath: "Barracão 1 > R1" }),
  loc({
    id: "2",
    code: "A2",
    fullPath: "Barracão 1 > R1 > T1 > A2",
    description: "Prateleira azul",
  }),
  loc({ id: "3", code: "T1", fullPath: "Galpão 2 > T1" }),
];

describe("filterLocationOptions", () => {
  it("sem query devolve todas as opções (até o cap)", () => {
    expect(filterLocationOptions(options, "")).toHaveLength(3);
    expect(filterLocationOptions(options, "   ")).toHaveLength(3);
  });

  it("casa por substring ignorando caixa e acento", () => {
    // "barracao" (sem acento, minúsculo) casa "Barracão".
    const r = filterLocationOptions(options, "barracao");
    expect(r.map((o) => o.id).sort()).toEqual(["1", "2"]);
  });

  it("casa pelo código", () => {
    expect(filterLocationOptions(options, "a2").map((o) => o.id)).toEqual(["2"]);
  });

  it("casa pela descrição", () => {
    expect(filterLocationOptions(options, "azul").map((o) => o.id)).toEqual([
      "2",
    ]);
  });

  it("múltiplos termos = AND entre tokens (em qualquer campo)", () => {
    // "r1" casa o caminho de 1 e 2; "t1" casa 2 e 3 → interseção {2}.
    expect(filterLocationOptions(options, "r1 t1").map((o) => o.id)).toEqual([
      "2",
    ]);
  });

  it("respeita o cap MAX_RESULTS", () => {
    const many = Array.from({ length: LOCATION_SELECT_MAX_RESULTS + 10 }, (_, i) =>
      loc({ id: String(i), code: `C${i}`, fullPath: `Raiz > C${i}` }),
    );
    expect(filterLocationOptions(many, "raiz")).toHaveLength(
      LOCATION_SELECT_MAX_RESULTS,
    );
    expect(filterLocationOptions(many, "raiz", 5)).toHaveLength(5);
  });
});

describe("filterLocationIndex (índice pré-normalizado)", () => {
  it("é equivalente a filterLocationOptions para as mesmas queries", () => {
    const index = buildLocationSearchIndex(options);
    for (const q of ["", "  ", "barracao", "a2", "azul", "r1 t1", "xyz", "R1"]) {
      expect(filterLocationIndex(index, q).map((o) => o.id)).toEqual(
        filterLocationOptions(options, q).map((o) => o.id),
      );
    }
  });

  it("mantém a tolerância a acento/caixa/substring e múltiplos termos", () => {
    const index = buildLocationSearchIndex(options);
    expect(filterLocationIndex(index, "BARRAÇÃO").map((o) => o.id).sort()).toEqual(
      ["1", "2"],
    );
    expect(filterLocationIndex(index, "r1 t1").map((o) => o.id)).toEqual(["2"]);
  });

  it("respeita o cap com early-break", () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      loc({ id: String(i), code: `C${i}`, fullPath: `Raiz > C${i}` }),
    );
    const index = buildLocationSearchIndex(many);
    expect(filterLocationIndex(index, "raiz", 5)).toHaveLength(5);
  });
});
