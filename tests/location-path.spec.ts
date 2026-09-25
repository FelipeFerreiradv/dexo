import { describe, expect, it } from "vitest";

import {
  createLegacyLocationPathResolver,
  createLocationPathResolver,
  type LocationPathNode,
} from "../app/lib/location-path";

// Cadeias copiadas de produção (25/09/2026). Em 7 clientes o código da
// localização já é o caminho inteiro; o montador antigo colava os códigos e a
// tela mostrava "BARR. > BARR. > CORR.-B > BARR. > CORR.-B > PRT.-57 > …".

const node = (
  id: string,
  code: string,
  parentId: string | null = null,
): LocationPathNode => ({ id, code, parentId });

describe("createLocationPathResolver", () => {
  it("código curto em cada nível: cola os códigos (comportamento de sempre)", () => {
    const pathOf = createLocationPathResolver([
      node("g", "Galpão 1"),
      node("a", "Andar 1", "g"),
      node("c", "Caixa 212", "a"),
    ]);
    expect(pathOf("c")).toBe("Galpão 1 > Andar 1 > Caixa 212");
    expect(pathOf("a")).toBe("Galpão 1 > Andar 1");
    expect(pathOf("g")).toBe("Galpão 1");
  });

  it("código que JÁ é o caminho inteiro não repete trechos (4 níveis reais)", () => {
    const pathOf = createLocationPathResolver([
      node("b", "BARR."),
      node("cb", "BARR. > CORR.-B", "b"),
      node("p57", "BARR. > CORR.-B > PRT.-57", "cb"),
      node("cx13", "BARR. > CORR.-B > PRT.-57 > CXA 13 - CHAVE SETA", "p57"),
    ]);
    expect(pathOf("cx13")).toBe(
      "BARR. > CORR.-B > PRT.-57 > CXA 13 - CHAVE SETA",
    );
    expect(pathOf("p57")).toBe("BARR. > CORR.-B > PRT.-57");
  });

  it("cinco níveis com o código-caminho (SRL)", () => {
    const pathOf = createLocationPathResolver([
      node("b1", "BARRACÃO 1"),
      node("r1", "BARRACÃO 1 > R1", "b1"),
      node("t4", "BARRACÃO 1 > R1 > T4", "r1"),
      node("a1", "BARRACÃO 1 > R1 > T4 > A1", "t4"),
      node("cx3", "BARRACÃO 1 > R1 > T4 > A1 > CX-3", "a1"),
    ]);
    expect(pathOf("cx3")).toBe("BARRACÃO 1 > R1 > T4 > A1 > CX-3");
  });

  it("filho de código curto sob pai com código-caminho (SRL 'A5')", () => {
    const pathOf = createLocationPathResolver([
      node("b1", "BARRACÃO 1"),
      node("r1", "BARRACÃO 1 > R1", "b1"),
      node("t8", "BARRACÃO 1 > R1 > T8", "r1"),
      node("a5", "A5", "t8"),
    ]);
    expect(pathOf("a5")).toBe("BARRACÃO 1 > R1 > T8 > A5");
  });

  it("código que começa pelo código CURTO do pai, com avô acima", () => {
    const pathOf = createLocationPathResolver([
      node("loja", "LOJA"),
      node("prt5", "PRT-5", "loja"),
      node("n2", "PRT-5 > NIVEL-2", "prt5"),
    ]);
    expect(pathOf("n2")).toBe("LOJA > PRT-5 > NIVEL-2");
  });

  it("ignora maiúsculas e espaços ao reconhecer o prefixo", () => {
    const pathOf = createLocationPathResolver([
      node("g", "Galpão"),
      node("p", "GALPÃO  >   Prateleira 4", "g"),
    ]);
    expect(pathOf("p")).toBe("GALPÃO > Prateleira 4");
  });

  it("prefixo só de texto (sem ' > ') não conta como caminho", () => {
    const pathOf = createLocationPathResolver([
      node("p", "PRAT 1"),
      node("c", "PRAT 12", "p"),
    ]);
    expect(pathOf("c")).toBe("PRAT 1 > PRAT 12");
  });

  it("filho com o MESMO código do pai (outra caixa/espaço) segue o comportamento antigo", () => {
    const pathOf = createLocationPathResolver([
      node("a1", "A1"),
      node("a1b", "a1", "a1"),
      node("g", "GALPAO"),
      node("p1", "P1", "g"),
      node("p1b", "p1", "p1"),
      node("cx", "CX 1"),
      node("cx2", "CX  1", "cx"),
    ]);
    expect(pathOf("a1b")).toBe("A1 > a1");
    expect(pathOf("p1b")).toBe("GALPAO > P1 > p1");
    expect(pathOf("cx2")).toBe("CX 1 > CX  1");
  });

  it('">" sem espaço faz parte do código, não é separador', () => {
    const pathOf = createLocationPathResolver([
      node("cx", "CX"),
      node("c10", "CX>10", "cx"),
    ]);
    expect(pathOf("c10")).toBe("CX > CX>10");
  });

  it("id desconhecido devolve vazio; pai ausente vira raiz", () => {
    const pathOf = createLocationPathResolver([node("c", "CX-1", "sumiu")]);
    expect(pathOf("nao-existe")).toBe("");
    expect(pathOf("c")).toBe("CX-1");
  });

  it("ciclo não trava", () => {
    const pathOf = createLocationPathResolver([
      node("a", "A", "b"),
      node("b", "B", "a"),
    ]);
    expect(pathOf("a")).toBe("B > A");
  });

  it("cadeia maior que 25 níveis é cortada sem estourar a pilha", () => {
    const nodes: LocationPathNode[] = [];
    for (let i = 0; i < 40; i++) {
      nodes.push(node(`n${i}`, `N${i}`, i === 0 ? null : `n${i - 1}`));
    }
    const path = createLocationPathResolver(nodes)("n39");
    expect(path.endsWith("N38 > N39")).toBe(true);
    expect(path.split(" > ").length).toBeLessThanOrEqual(26);
  });

  it("sem nenhum código-caminho na cadeia, idêntico ao montador antigo", () => {
    const nodes = [
      node("g", "Galpão 1"),
      node("a", "ANDAR  1", "g"),
      node("c", "CX-12 (fundo)", "a"),
      node("solto", "PRAT 1"),
    ];
    const novo = createLocationPathResolver(nodes);
    const antigo = createLegacyLocationPathResolver(nodes);
    for (const id of ["g", "a", "c", "solto"]) {
      expect(novo(id)).toBe(antigo(id));
    }
  });
});

describe("createLegacyLocationPathResolver", () => {
  it("reproduz o texto que mover/vincular grava hoje em Product.location", () => {
    const antigo = createLegacyLocationPathResolver([
      node("b", "BARR."),
      node("cb", "BARR. > CORR.-B", "b"),
    ]);
    expect(antigo("cb")).toBe("BARR. > BARR. > CORR.-B");
    expect(antigo("nada")).toBe("");
  });
});
