import { describe, expect, it } from "vitest";

import {
  conferirVinculoNaVenda,
  LIMIAR_DE_DIVERGENCIA,
} from "../app/marketplaces/lib/conferencia-vinculo-na-venda";

describe("conferencia do vinculo no momento da venda", () => {
  it("aprova quando o anuncio descreve a peca vinculada", () => {
    const r = conferirVinculoNaVenda(
      "Maçaneta Externa Traseira Esquerda Cruze Hatch 2013 V1234",
      "Macaneta Externa Traseira Esquerda Cruze Hatch 2013 V1234",
    );
    expect(r.veredicto).toBe("CONFERE");
    expect(r.divergente).toBe(false);
    expect(r.motivo).toBe("");
  });

  it("acusa quando o anuncio passou a vender outra peca", () => {
    // Caso real medido em 23/09/2026 na MK2: a ficha e um cabo, o anuncio no ar
    // e um coxim. Quando vender, a Dexo baixaria o cabo.
    const r = conferirVinculoNaVenda(
      "Coxim Radiador C3 Exclusive 1.6 Vvt 2016 V2278",
      "Cabo Puxador Tanque Tracker Lt 1.0 3cc Ano 2021 V1223",
    );
    expect(r.veredicto).toBe("OUTRA_PECA");
    expect(r.divergente).toBe(true);
    expect(r.semelhanca).toBeLessThan(LIMIAR_DE_DIVERGENCIA);
    expect(r.motivo).toContain("Coxim Radiador");
    expect(r.motivo).toContain("Cabo Puxador");
  });

  it("acusa peca espelhada, que a semelhanca sozinha APROVARIA", () => {
    // Esta e a razao de `isOppositeSideOrAxis` vir antes do limiar: depois da
    // canonizacao de lado/eixo o par espelhado da ~0,78, que passa em qualquer
    // limiar usado na casa. O numero ficou honesto; o veredito, nao.
    const esquerda = "Amortecedor Tampa Do Porta Malas L/e Volkswagen Gol 2021";
    const direita = "Amortecedor Tampa Do Porta Malas L/d Volkswagen Gol 2021";
    const r = conferirVinculoNaVenda(esquerda, direita);
    expect(r.semelhanca).toBeGreaterThan(LIMIAR_DE_DIVERGENCIA);
    expect(r.veredicto).toBe("LADO_OPOSTO");
    expect(r.divergente).toBe(true);
    expect(r.motivo).toContain("lado");
  });

  it("acusa eixo oposto", () => {
    const r = conferirVinculoNaVenda(
      "Parabarro Dianteiro Direito Fiat Argo 2019",
      "Parabarro Traseiro Direito Fiat Argo 2019",
    );
    expect(r.veredicto).toBe("LADO_OPOSTO");
    expect(r.divergente).toBe(true);
  });

  it("aceita variacao normal de escrita sem virar pendencia", () => {
    const r = conferirVinculoNaVenda(
      "Bomba Agua Eletrica Bmw X6 Xdrive 2010 4.4 Biturbo",
      "Bomba De Agua Eletrica BMW X6 xDrive 2010 4.4 Biturbo V2276",
    );
    expect(r.veredicto).toBe("CONFERE");
  });

  it("fica calado quando falta um dos lados", () => {
    // Acusar divergencia por falta de dado encheria a tela de pendencia falsa.
    for (const entrada of [null, undefined, "", "   "]) {
      expect(conferirVinculoNaVenda(entrada, "Bomba Agua").veredicto).toBe("SEM_TITULO");
      expect(conferirVinculoNaVenda("Bomba Agua", entrada).veredicto).toBe("SEM_TITULO");
      expect(conferirVinculoNaVenda(entrada, "Bomba Agua").divergente).toBe(false);
    }
  });

  it("compara contra o texto que o anuncio publica, nao contra o nome do produto", () => {
    // Quando o anuncio tem titleOverride, e ele que esta na vitrine. Comparar
    // com o nome do produto acusaria divergencia em anuncio correto.
    const override = "Farol Dianteiro Esquerdo Onix 2017 - Original GM";
    const r = conferirVinculoNaVenda("Farol Dianteiro Esquerdo Onix 2017 Original GM", override);
    expect(r.veredicto).toBe("CONFERE");
  });
});
