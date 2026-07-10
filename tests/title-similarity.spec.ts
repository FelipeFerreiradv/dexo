import { describe, it, expect } from "vitest";
import {
  titleSimilarity,
  areTitlesSimilar,
} from "../app/lib/title-similarity";

describe("title-similarity", () => {
  it("títulos idênticos → similaridade 1 (mesmo produto)", () => {
    expect(
      titleSimilarity("Par Tela Autofalantes 12cm", "Par Tela Autofalantes 12cm"),
    ).toBe(1);
    expect(
      areTitlesSimilar(
        "Par Tela Autofalantes 12cm",
        "Par Tela Autofalantes 12cm",
      ),
    ).toBe(true);
  });

  it("mesmo produto com variação leve → agrupa (similar)", () => {
    expect(
      areTitlesSimilar(
        "Lanterna traseira esquerda kwid",
        "Lanterna Traseira Esquerda Kwid Usado",
      ),
    ).toBe(true);
  });

  it("produtos DIFERENTES com SKU de caixa → não similar (separa)", () => {
    // Compartilham mangueira/renault/usado mas são veículos diferentes.
    expect(
      areTitlesSimilar(
        "Mangueira Hidrovacuo Renault Kangoo 2010 2018 16v Usado",
        "Mangueira Combustivel Pajero Tr4 4x2 Flex Usada 2010 2012",
      ),
    ).toBe(false);
    expect(
      areTitlesSimilar(
        "Mangueira Hidrovacuo Renault Kangoo 2010 2018 16v Usado",
        "Mangueira Combustivel Renault Kwid Usado",
      ),
    ).toBe(false);
  });

  it("ignora palavras genéricas (usado/novo/par) na comparação", () => {
    // Só as palavras genéricas em comum → não deve considerar similar.
    expect(areTitlesSimilar("Roda Usado", "Farol Novo")).toBe(false);
  });

  it("título vazio → similaridade 0", () => {
    expect(titleSimilarity("", "qualquer coisa")).toBe(0);
  });
});
