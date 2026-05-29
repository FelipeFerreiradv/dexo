import { describe, it, expect } from "vitest";
import {
  buildTree,
  buildFullPathMap,
  filterTree,
  countNodes,
  type FlatNode,
} from "../app/localizacoes/lib/location-tree";
import { tokenize } from "../app/localizacoes/lib/search-utils";

// Árvore de teste (3 níveis):
//   G1 (Galpão 1)
//     PRAT-02 (Prateleira)
//       SUB-03 (Subdivisão Norte)
//     PRAT-09
//   G2 (Galpão 2)
const flat: FlatNode[] = [
  { id: "g1", code: "G1", description: "Galpão 1", parentId: null },
  { id: "prat02", code: "PRAT-02", description: "Prateleira", parentId: "g1" },
  {
    id: "sub03",
    code: "SUB-03",
    description: "Subdivisão Norte",
    parentId: "prat02",
  },
  { id: "prat09", code: "PRAT-09", description: "Outra", parentId: "g1" },
  { id: "g2", code: "G2", description: "Galpão 2", parentId: null },
];

function filter(query: string) {
  const tree = buildTree(flat);
  return filterTree(tree, tokenize(query));
}

describe("buildTree", () => {
  it("monta hierarquia por parentId", () => {
    const tree = buildTree(flat);
    expect(tree.map((n) => n.id)).toEqual(["g1", "g2"]);
    const g1 = tree.find((n) => n.id === "g1")!;
    expect(g1.children.map((c) => c.id)).toEqual(["prat02", "prat09"]);
    const prat02 = g1.children.find((c) => c.id === "prat02")!;
    expect(prat02.children.map((c) => c.id)).toEqual(["sub03"]);
  });

  it("órfão (pai ausente) vira raiz, não desaparece", () => {
    const orphans: FlatNode[] = [
      { id: "a", code: "A", parentId: "missing" },
      { id: "b", code: "B", parentId: null },
    ];
    const tree = buildTree(orphans);
    expect(tree.map((n) => n.id).sort()).toEqual(["a", "b"]);
  });

  it("countNodes conta todas as profundidades", () => {
    expect(countNodes(buildTree(flat))).toBe(5);
  });
});

describe("buildFullPathMap", () => {
  it("monta caminho legível com separador ' / '", () => {
    const map = buildFullPathMap(flat);
    expect(map.get("g1")).toBe("G1");
    expect(map.get("prat02")).toBe("G1 / PRAT-02");
    expect(map.get("sub03")).toBe("G1 / PRAT-02 / SUB-03");
  });
});

describe("filterTree", () => {
  it("query vazia → árvore inteira, sem expansão forçada", () => {
    const r = filter("");
    expect(countNodes(r.filtered)).toBe(5);
    expect(r.matchedIds.size).toBe(0);
    expect(r.expandedIds.size).toBe(0);
    expect(r.count).toBe(0);
  });

  it("CRÍTICO: match no NETO preserva e expande os ancestrais", () => {
    // "SUB-03" só existe no neto; ancestrais G1 e PRAT-02 devem aparecer
    const r = filter("sub-03");
    expect(r.count).toBe(1);
    expect([...r.matchedIds]).toEqual(["sub03"]);

    // árvore podada: G1 → PRAT-02 → SUB-03 (PRAT-09 e G2 sumiram)
    expect(r.filtered.map((n) => n.id)).toEqual(["g1"]);
    const g1 = r.filtered[0];
    expect(g1.children.map((c) => c.id)).toEqual(["prat02"]);
    expect(g1.children[0].children.map((c) => c.id)).toEqual(["sub03"]);

    // ancestrais auto-expandidos
    expect(r.expandedIds.has("g1")).toBe(true);
    expect(r.expandedIds.has("prat02")).toBe(true);
  });

  it("match por acento ausente encontra neto acentuado (Subdivisão)", () => {
    const r = filter("subdivisao");
    expect([...r.matchedIds]).toEqual(["sub03"]);
  });

  it("match em CONTAINER (pai) mantém a subárvore completa", () => {
    // "G1" casa o pai; PRAT-02, SUB-03 e PRAT-09 continuam visíveis
    const r = filter("g1");
    expect(r.matchedIds.has("g1")).toBe(true);
    expect(r.filtered.map((n) => n.id)).toEqual(["g1"]);
    expect(countNodes(r.filtered)).toBe(4); // G1 + 2 prat + 1 sub
    expect(r.expandedIds.has("g1")).toBe(true);
  });

  it("poda ramos sem match (G2 não aparece ao buscar PRAT)", () => {
    const r = filter("prat");
    expect(r.filtered.map((n) => n.id)).toEqual(["g1"]);
    expect(r.matchedIds.has("prat02")).toBe(true);
    expect(r.matchedIds.has("prat09")).toBe(true);
    expect(r.count).toBe(2);
  });

  it("múltiplos termos casam code + description do PRÓPRIO nó (AND)", () => {
    // "sub norte" → code "SUB-03" + description "Subdivisão Norte"
    const r = filter("sub norte");
    expect(r.matchedIds.has("sub03")).toBe(true);
  });

  it("match NÃO considera o caminho/ancestrais (count previsível)", () => {
    // buscar "g1" não marca os descendentes (eles não têm "g1" no próprio texto)
    const r = filter("g1");
    expect(r.matchedIds.has("g1")).toBe(true);
    expect(r.matchedIds.has("prat02")).toBe(false);
    expect(r.matchedIds.has("sub03")).toBe(false);
    expect(r.count).toBe(1);
  });

  it("sem resultado → árvore vazia", () => {
    const r = filter("inexistente-xyz");
    expect(r.filtered).toHaveLength(0);
    expect(r.count).toBe(0);
  });
});
