import { describe, expect, it } from "vitest";
import {
  buildLocationSearchIndex,
  filterLocationIndex,
  filterLocationOptions,
  LOCATION_SELECT_MAX_RESULTS,
  type LocationSelectItem,
} from "@/app/produtos/lib/location-select-filter";
import { tokenize } from "@/app/localizacoes/lib/search-utils";

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

// --- Cenário do bug: dois galpões irmãos, o primeiro com muitos descendentes
// cujo CAMINHO (ou o próprio código) contém um "2" — "Galpão 1 > Prateleira 2",
// "Galpão 1 > A12"... Como o backend entrega ordenado por fullPath, TODOS eles
// vinham antes de "Galpão 2", que caía fora do cap.
function galpoes(descendentes: number): LocationSelectItem[] {
  const items: LocationSelectItem[] = [
    loc({ id: "g1", code: "Galpão 1", fullPath: "Galpão 1" }),
    loc({ id: "g2", code: "Galpão 2", fullPath: "Galpão 2" }),
    loc({
      id: "g2-p1",
      code: "Prateleira 1",
      fullPath: "Galpão 2 > Prateleira 1",
    }),
  ];
  for (let i = 1; i <= descendentes; i++) {
    items.push(
      loc({
        id: `g1-p${i}`,
        code: `Prateleira ${i}`,
        fullPath: `Galpão 1 > Prateleira ${i}`,
      }),
      // "A{i}2" casa o "2" pelo PRÓPRIO código — o pior caso do bug.
      loc({ id: `g1-a${i}`, code: `A${i}2`, fullPath: `Galpão 1 > A${i}2` }),
    );
  }
  // Espelha `listForSelect`: sort((a, b) => a.fullPath.localeCompare(b.fullPath)).
  items.sort((a, b) => a.fullPath.localeCompare(b.fullPath));
  return items;
}

/**
 * Reimplementação do filtro ANTIGO (match na ordem do backend + corte no
 * primeiro `max`). Serve para dois fins: fixar o bug que estamos corrigindo e
 * provar que o CONJUNTO que casa não mudou — só a ordem.
 */
function filtroAntigo(
  options: LocationSelectItem[],
  query: string,
  max: number = LOCATION_SELECT_MAX_RESULTS,
): LocationSelectItem[] {
  const index = buildLocationSearchIndex(options);
  const tokens = tokenize(query);
  const out: LocationSelectItem[] = [];
  for (const entry of index) {
    if (tokens.every((t) => entry.haystack.includes(t))) {
      out.push(entry.item);
      if (out.length >= max) break;
    }
  }
  return out;
}

describe("ranqueamento por relevância (bug: 'Galpão 2' não aparecia)", () => {
  const tenant = galpoes(60);
  const ids = (r: LocationSelectItem[]) => r.map((o) => o.id);

  it("1) 'Galpão 2' devolve o próprio Galpão 2 em PRIMEIRO", () => {
    const r = filterLocationOptions(tenant, "Galpão 2");
    expect(r[0]?.id).toBe("g2");
    expect(r[0]?.fullPath).toBe("Galpão 2");
  });

  it("2) 'Galpão 2' sobrevive ao cap — o filtro antigo o perdia", () => {
    expect(ids(filtroAntigo(tenant, "Galpão 2"))).not.toContain("g2");
    const r = filterLocationOptions(tenant, "Galpão 2");
    expect(r).toHaveLength(LOCATION_SELECT_MAX_RESULTS);
    expect(ids(r)).toContain("g2");
  });

  it("3) 'Galpão 1' devolve Galpão 1 em primeiro e sua subárvore abaixo", () => {
    const r = filterLocationOptions(tenant, "Galpão 1");
    expect(r[0]?.id).toBe("g1");
    // Os seguintes são descendentes DE Galpão 1 (rank de caminho), antes do
    // ruído de Galpão 2 (tokens espalhados).
    for (const item of r.slice(1, 6)) {
      expect(item.fullPath.startsWith("Galpão 1 > ")).toBe(true);
    }
  });

  it("4) parcial 'Galpão' traz as DUAS raízes no topo", () => {
    const r = filterLocationOptions(tenant, "Galpão");
    expect(ids(r).slice(0, 2)).toEqual(["g1", "g2"]);
  });

  it("5) minúsculo e sem acento ('galpao 2') é idêntico a 'Galpão 2'", () => {
    expect(ids(filterLocationOptions(tenant, "galpao 2"))).toEqual(
      ids(filterLocationOptions(tenant, "Galpão 2")),
    );
  });

  it("6) espaços extras ('  galpao   2  ') são idênticos a 'Galpão 2'", () => {
    expect(ids(filterLocationOptions(tenant, "  galpao   2  "))).toEqual(
      ids(filterLocationOptions(tenant, "Galpão 2")),
    );
  });

  it("7) query inexistente devolve vazio", () => {
    expect(filterLocationOptions(tenant, "xyz")).toEqual([]);
    expect(filterLocationOptions(tenant, "galpao 3 xyz")).toEqual([]);
  });

  it("8) query vazia/em branco preserva EXATAMENTE a ordem do backend", () => {
    for (const q of ["", "   "]) {
      const r = filterLocationOptions(tenant, q);
      expect(ids(r)).toEqual(ids(filtroAntigo(tenant, q)));
      expect(ids(r)).toEqual(ids(tenant.slice(0, LOCATION_SELECT_MAX_RESULTS)));
    }
  });

  it("9) com mais de 50 matches respeita o cap (e o cap explícito)", () => {
    expect(filterLocationOptions(tenant, "galpao")).toHaveLength(
      LOCATION_SELECT_MAX_RESULTS,
    );
    const cinco = filterLocationOptions(tenant, "galpao", 5);
    expect(cinco).toHaveLength(5);
    expect(ids(cinco).slice(0, 2)).toEqual(["g1", "g2"]);
  });

  it("10) o CONJUNTO que casa é idêntico ao do filtro antigo — só a ordem muda", () => {
    for (const q of [
      "Galpão 2",
      "Galpão 1",
      "Galpão",
      "galpao 2",
      "  galpao   2  ",
      "prateleira",
      "2",
      "a12",
      "xyz",
      "",
    ]) {
      const novo = ids(
        filterLocationOptions(tenant, q, Number.MAX_SAFE_INTEGER),
      );
      const antigo = ids(filtroAntigo(tenant, q, Number.MAX_SAFE_INTEGER));
      expect([...novo].sort()).toEqual([...antigo].sort());
    }
  });

  it("11) empates preservam a ordem original (sort estável, ES2019)", () => {
    // Todos com o mesmo rank (caminho contém a frase) e a mesma profundidade.
    const many = Array.from(
      { length: LOCATION_SELECT_MAX_RESULTS + 10 },
      (_, i) => loc({ id: String(i), code: `C${i}`, fullPath: `Raiz > C${i}` }),
    );
    const r = filterLocationOptions(many, "raiz");
    expect(r).toHaveLength(LOCATION_SELECT_MAX_RESULTS);
    expect(ids(r)).toEqual(ids(many.slice(0, LOCATION_SELECT_MAX_RESULTS)));
  });

  it("12) desempate por profundidade: a raiz vem antes do descendente", () => {
    // "2" casa o código de "Galpão 2" (profundidade 1) e o de "A12"/"A21"
    // (profundidade 2) no MESMO rank — sem o desempate, a ordem alfabética
    // voltaria a enterrar "Galpão 2".
    const r = filterLocationOptions(tenant, "2");
    expect(r[0]?.id).toBe("g2");
  });

  it("13) nunca inventa itens fora de `options` (isolamento é do backend)", () => {
    // Multi-tenant é garantido em `LocationUseCase.listForSelect` (escopo por
    // userId). No cliente o invariante testável é: toda opção devolvida é uma
    // referência da lista de entrada.
    const conjunto = new Set(tenant);
    for (const q of ["galpao 2", "prateleira", "", "a12"]) {
      for (const item of filterLocationOptions(tenant, q)) {
        expect(conjunto.has(item)).toBe(true);
      }
    }
  });

  it("é genérico: vale para qualquer nomenclatura, não só 'Galpão'", () => {
    // Mesmo formato do bug com códigos totalmente diferentes: "PRAT 02" exato
    // vs descendentes de "PRAT 01" cujo caminho contém "prat" e "02".
    const outro: LocationSelectItem[] = [
      loc({ id: "p1", code: "PRAT 01", fullPath: "PRAT 01" }),
      loc({ id: "p2", code: "PRAT 02", fullPath: "PRAT 02" }),
    ];
    for (let i = 1; i <= 60; i++) {
      outro.push(
        loc({
          id: `p1-${i}`,
          code: `CX 02${i}`,
          fullPath: `PRAT 01 > CX 02${i}`,
        }),
      );
    }
    outro.sort((a, b) => a.fullPath.localeCompare(b.fullPath));
    expect(ids(filtroAntigo(outro, "PRAT 02"))).not.toContain("p2");
    expect(filterLocationOptions(outro, "PRAT 02")[0]?.id).toBe("p2");
  });
});
