import { describe, it, expect } from "vitest";
import {
  baseKeyOf,
  dumpCategoryRejects,
  labelMatchesLeaf,
  modeOf,
  statisticalGate,
  type DumpFilterCandidate,
} from "../app/marketplaces/lib/category-inference/map-generation";

/**
 * Gates puros do gerador do mapa tipo-de-peça → categoria. Os cenários vêm de
 * poluição REAL encontrada na base: imports legados que despejaram fechadura/
 * maçaneta/porta em "Barra de Proteção" e tudo-que-é-traseiro em "Lanternas
 * Traseiras".
 */

const counts = (obj: Record<string, number>) => new Map(Object.entries(obj));

describe("modeOf", () => {
  it("moda + segundo colocado + share", () => {
    const mode = modeOf(counts({ a: 6, b: 3, c: 1 }));
    expect(mode).toMatchObject({
      value: "a",
      count: 6,
      sample: 10,
      share: 0.6,
      runnerUp: { value: "b", count: 3 },
    });
  });

  it("vazio → null; único → sem runnerUp", () => {
    expect(modeOf(counts({}))).toBeNull();
    expect(modeOf(counts({ a: 5 }))?.runnerUp).toBeNull();
  });
});

describe("statisticalGate", () => {
  it("passa com amostra, cobertura e dominância suficientes", () => {
    expect(statisticalGate(modeOf(counts({ a: 8, b: 2 }))!)).toBeNull();
  });

  it("reprova amostra pequena, moda difusa e empate técnico", () => {
    expect(statisticalGate(modeOf(counts({ a: 5, b: 1 }))!)).toContain(
      "amostra",
    );
    expect(statisticalGate(modeOf(counts({ a: 5, b: 3, c: 3 }))!)).toContain(
      "modeShare",
    );
    // 7/12 passa share mas 7 < 1.5×5 → dominância
    expect(statisticalGate(modeOf(counts({ a: 7, b: 5 }))!)).toContain(
      "dominância",
    );
    // Fronteira: dominância EXATAMENTE 1.5× passa (6 ≥ 1.5×4)
    expect(statisticalGate(modeOf(counts({ a: 6, b: 4 }))!)).toBeNull();
  });
});

describe("labelMatchesLeaf", () => {
  it("singular/plural casam ('farol' → 'Faróis'; 'lanterna' → 'Lanternas Traseiras')", () => {
    expect(labelMatchesLeaf("farol", "Iluminação > Faróis Dianteiros")).toBe(
      true,
    );
    expect(
      labelMatchesLeaf("lanterna", "Iluminação > Lanternas Traseiras"),
    ).toBe(true);
  });

  it("tipos diferentes NÃO casam ('fechadura' → 'Lanternas Traseiras')", () => {
    expect(
      labelMatchesLeaf("fechadura", "Iluminação > Lanternas Traseiras"),
    ).toBe(false);
    expect(
      labelMatchesLeaf("porta", "Acessórios para Porta-malas > Barra de Proteção"),
    ).toBe(false);
  });

  it("posição é ignorada dos dois lados (armadilha 'tampa-traseira' × 'Lanternas Traseiras')", () => {
    expect(
      labelMatchesLeaf("tampa-traseira", "Iluminação > Lanternas Traseiras"),
    ).toBe(false);
  });

  it("prefixo 'para' não gera falso positivo (parachoque × para-brisa)", () => {
    expect(labelMatchesLeaf("parachoque", "Vidros > Para-brisa Traseiro")).toBe(
      false,
    );
    expect(
      labelMatchesLeaf("parachoque", "Carroceria > Para-choques"),
    ).toBe(true);
  });
});

describe("baseKeyOf", () => {
  it("remove posição simples e composta", () => {
    expect(baseKeyOf("fechadura-traseiro-direito")).toBe("fechadura");
    expect(baseKeyOf("maquina-de-vidro-dianteiro-esquerdo")).toBe(
      "maquina-de-vidro",
    );
    expect(baseKeyOf("farol")).toBe("farol");
  });

  it("labels femininos próprios não são posição dobrada", () => {
    expect(baseKeyOf("tampa-traseira")).toBe("tampa-traseira");
  });
});

describe("dumpCategoryRejects", () => {
  const cand = (
    key: string,
    treeId: string,
    leafPath: string,
  ): DumpFilterCandidate => ({ key, baseKey: baseKeyOf(key), treeId, leafPath });

  it("categoria moda de ≥3 tipos-base só mantém quem bate com a folha", () => {
    const lanternas = "Iluminação > Lanternas Traseiras";
    const candidates = [
      cand("lanterna", "SHP_102298", lanternas),
      cand("fechadura-traseiro-direito", "SHP_102298", lanternas),
      cand("macaneta-traseiro-esquerdo", "SHP_102298", lanternas),
      cand("tampa-traseira", "SHP_102298", lanternas),
    ];
    const rejected = dumpCategoryRejects(candidates);
    expect(rejected.has(candidates[0])).toBe(false); // lanterna sobrevive
    expect(rejected.has(candidates[1])).toBe(true);
    expect(rejected.has(candidates[2])).toBe(true);
    expect(rejected.has(candidates[3])).toBe(true);
  });

  it("abaixo do limiar de tipos distintos nada é rejeitado", () => {
    const candidates = [
      cand("parachoque", "SHP_102287", "Carroceria > Grades de Para-choques"),
      cand("parachoque-dianteiro", "SHP_102287", "Carroceria > Grades de Para-choques"),
    ];
    // 2 chaves, mas 1 único tipo-base → não é lixão.
    expect(dumpCategoryRejects(candidates).size).toBe(0);
  });

  it("chaves dobradas contam pelo tipo-BASE (não inflam o limiar)", () => {
    const candidates = [
      cand("forro-dianteiro-direito", "MLB431271", "Peças de Interior > Painéis para Portas"),
      cand("forro-dianteiro-esquerdo", "MLB431271", "Peças de Interior > Painéis para Portas"),
      cand("forro-traseiro-esquerdo", "MLB431271", "Peças de Interior > Painéis para Portas"),
      cand("forro-direito", "MLB431271", "Peças de Interior > Painéis para Portas"),
    ];
    // 4 chaves, 1 base ("forro") → não dispara o gate.
    expect(dumpCategoryRejects(candidates).size).toBe(0);
  });
});
