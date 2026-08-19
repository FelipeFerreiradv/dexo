import { describe, expect, it } from "vitest";

import { OlxCategoryResolutionService as Olx } from "@/app/marketplaces/services/olx-category-resolution.service";
import {
  OLX_PART_LABEL,
  OLX_PART_MAP_BOATS,
  OLX_PART_MAP_CARS,
  OLX_PART_MAP_MOTOS,
  tabelaDePecaDaCategoria,
} from "@/app/marketplaces/olx/olx-part-map";

/**
 * TIPO DE PEÇA NO ANÚNCIO DA OLX (`params.parts_name_*`).
 *
 * Na OLX a `category` é o TIPO DE VEÍCULO — cinco opções, e ponto. O tipo de
 * peça vai num parâmetro separado, que até aqui era uma CONSTANTE: toda peça de
 * carro saía como "4".
 *
 * ⚠️ E a constante estava certa para quase tudo. Medido no catálogo real
 * (399.890 peças): 98,4% são legitimamente "Peças automotivas". A tabela da OLX
 * é comercial e grossa, não é por sistema mecânico como a do Google. O ganho são
 * os 1,64% que a OLX separa no filtro — pneus, rodas, calotas, som, GPS.
 *
 * As duas invariantes que sustentam o merge estão nos dois primeiros blocos:
 * não-regressão e "todo código existe na tabela oficial".
 */

const params = (name: string, categoryId: number) =>
  Olx.buildAdParams({ name, quality: "SUCATA" }, categoryId);

describe("não-regressão: sem casamento, o payload é o de antes", () => {
  it("peça comum de carro continua saindo como 4 (Peças automotivas)", () => {
    // Estes são os 98,4%. A OLX não tem filtro de maçaneta nem de farol — tudo
    // isso É "Peças automotivas", e o valor de hoje está certo.
    for (const nome of [
      "Maçaneta Interna Esquerda Chevrolet Celta",
      "Farol Dianteiro Direito Gol G5",
      "Amortecedor Dianteiro Spin 1.8",
      "Caixa de Câmbio Chevrolet Kadett",
      "Módulo de Injeção Ford Fiesta",
      "Parachoque Traseiro Onix 2018",
    ]) {
      expect(params(nome, 2101), nome).toEqual({
        condition: "2",
        parts_name_cars: "4",
      });
    }
  });

  it("caminhão e ônibus usam a MESMA tabela de carros, com o mesmo default", () => {
    for (const cat of [2102, 2105]) {
      expect(params("Farol Dianteiro", cat)).toEqual({
        condition: "2",
        parts_name_cars: "4",
      });
    }
  });

  it("moto e barco mantêm os defaults próprios", () => {
    expect(params("Carenagem Honda CG", 2103)).toEqual({
      condition: "2",
      parts_name_motos: "10",
    });
    // Barcos não têm um genérico "peças" na tabela — "Outros" é o honesto.
    expect(params("Peça de Barco", 2104)).toEqual({
      condition: "2",
      parts_name_boats: "11",
    });
  });

  it("condition segue sendo o único obrigatório, e continua igual", () => {
    expect(Olx.buildAdParams({ name: "Farol", quality: "NOVO" }, 2101).condition).toBe("1");
    expect(Olx.buildAdParams({ name: "Farol", quality: "SUCATA" }, 2101).condition).toBe("2");
  });

  it("categoria fora das cinco não recebe parts_name nenhum", () => {
    // A OLX recusa a operação se o parâmetro vier vazio ou 0 — então é omitir.
    expect(params("Qualquer coisa", 9999)).toEqual({ condition: "2" });
    expect(tabelaDePecaDaCategoria(9999)).toBeNull();
  });
});

describe("todo código enviado existe na tabela oficial da OLX", () => {
  // Esta é a invariante que impede um código inválido de chegar ao canal —
  // valor errado na OLX é anúncio recusado (-4) ou descartado em silêncio.
  const casos: Array<[string, Record<string, string>]> = [
    ["parts_name_cars", OLX_PART_MAP_CARS],
    ["parts_name_motos", OLX_PART_MAP_MOTOS],
    ["parts_name_boats", OLX_PART_MAP_BOATS],
  ];

  for (const [chave, mapa] of casos) {
    it(`${chave}: todo valor do de-para está na tabela`, () => {
      const oficiais = OLX_PART_LABEL[chave];
      expect(oficiais).toBeTruthy();
      for (const [palavra, valor] of Object.entries(mapa)) {
        expect(oficiais[valor], `${chave}["${palavra}"] = ${valor}`).toBeTruthy();
      }
    });
  }

  it("os defaults das cinco categorias existem na tabela", () => {
    for (const cat of [2101, 2102, 2103, 2104, 2105]) {
      const t = tabelaDePecaDaCategoria(cat)!;
      expect(OLX_PART_LABEL[t.chave][t.padrao], `categoria ${cat}`).toBeTruthy();
    }
  });

  it("nenhum valor é vazio ou zero — a OLX falha a operação nos dois casos", () => {
    for (const [, mapa] of casos) {
      for (const valor of Object.values(mapa)) {
        expect(valor).not.toBe("");
        expect(valor).not.toBe("0");
      }
    }
  });
});

describe("o que a OLX separa no filtro passa a sair certo", () => {
  const casos: Array<[string, string]> = [
    ["Pneu Aro 15 Continental", "1"],
    ["Roda de Liga Leve Aro 17 Gol", "2"],
    ["Calota Tampa Roda Kia", "3"],
    ["GPS Automotivo Garmin", "5"],
    ["Alto Falante Traseiro Direito Ford Ecosport", "6"],
    ["Central Multimidia Onix 2020", "6"],
    ["Rádio Original Volkswagen Gol", "6"],
    ["Tapete Carpete Dianteiro Corolla", "8"],
  ];

  for (const [nome, esperado] of casos) {
    it(`"${nome}" → ${OLX_PART_LABEL.parts_name_cars[esperado]}`, () => {
      expect(params(nome, 2101).parts_name_cars).toBe(esperado);
    });
  }
});

describe("as chaves compostas desempatam", () => {
  it("Cubo de Roda é PEÇA, não roda — ninguém procura cubo no filtro de rodas", () => {
    expect(params("Cubo de Roda Dianteiro Palio", 2101).parts_name_cars).toBe("4");
    expect(params("Rolamento de Roda Traseiro Onix", 2101).parts_name_cars).toBe("4");
    expect(params("Parafuso de Roda Corsa", 2101).parts_name_cars).toBe("4");
    expect(params("Caixa de Roda Dianteira Gol", 2101).parts_name_cars).toBe("4");
  });

  it("`radio` NÃO casa `radiador` — mesmo word-boundary que impede moto/motor", () => {
    expect(params("Radiador Hyundai HB20 1.0", 2101).parts_name_cars).toBe("4");
    expect(params("Rádio CD Player Fiat Uno", 2101).parts_name_cars).toBe("6");
  });
});

describe("motos e barcos têm tabelas PRÓPRIAS", () => {
  it("capacete só existe na tabela de motos", () => {
    expect(params("Capacete Fechado Preto", 2103).parts_name_motos).toBe("4");
    // O mesmo código "4" na tabela de carros significa outra coisa inteiramente.
    expect(OLX_PART_LABEL.parts_name_motos["4"]).toBe("Capacetes");
    expect(OLX_PART_LABEL.parts_name_cars["4"]).toBe("Peças automotivas");
  });

  it("hélice e âncora só existem na tabela de barcos", () => {
    expect(params("Hélice de Popa Evinrude", 2104).parts_name_boats).toBe("9");
    expect(params("Âncora de Ferro 10kg", 2104).parts_name_boats).toBe("10");
    expect(params("Motor de Popa Yamaha 15hp", 2104).parts_name_boats).toBe("1");
  });

  it("o MESMO nome resolve diferente conforme o veículo", () => {
    // "Farol" é peça automotiva no carro (4) e Iluminação no barco (4 da tabela
    // de barcos, que é outra coisa). Os códigos coincidem por acidente — o que
    // importa é que a CHAVE do parâmetro muda.
    expect(params("Farol Dianteiro", 2101)).toHaveProperty("parts_name_cars");
    expect(params("Farol de Proa", 2104)).toHaveProperty("parts_name_boats");
    expect(params("Farol de Proa", 2104).parts_name_boats).toBe("4");
    expect(OLX_PART_LABEL.parts_name_boats["4"]).toBe("Iluminação");
  });
});
