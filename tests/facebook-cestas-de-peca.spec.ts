import { describe, expect, it } from "vitest";

import {
  FACEBOOK_CATEGORY_LABEL,
  FACEBOOK_CATEGORY_MAP,
  FACEBOOK_DEFAULT_CATEGORY,
} from "@/app/marketplaces/facebook/facebook-category-map";
import {
  FACEBOOK_PART_MAP,
  FB_PART,
  FB_PART_LABEL,
} from "@/app/marketplaces/facebook/facebook-part-map";
import { FacebookCategoryResolutionService as Resolucao } from "@/app/marketplaces/services/facebook-category-resolution.service";

/**
 * AS 21 CESTAS POR SISTEMA DO CATÁLOGO META.
 *
 * A integração usava 3 categorias e toda peça caía na genérica. A taxonomia do
 * Google — que é o que a Meta lê — tem 21 cestas por sistema sob "Peças para
 * veículos motorizados" (899), e existe em português oficial com os mesmos ids.
 *
 * Medido contra 600 nomes REAIS do catálogo: 85,2% passam a cair numa cesta
 * específica, contra 0% antes.
 *
 * As duas invariantes que sustentam isso estão nos dois primeiros blocos:
 * não-regressão e "veículo antes de peça".
 */

const resolver = (name: string) => Resolucao.resolveCategory({ name });

describe("não-regressão: só o genérico pode ter virado específico", () => {
  it("peça de MOTO continua indo para Peças de motos, não para a cesta da peça", () => {
    // Sem a ordem veículo→peça, `farol`(5) ganharia de `moto`(4) pela regra da
    // chave mais longa, e toda peça de moto mudaria de destino em silêncio.
    for (const nome of [
      "Farol Moto Honda CG 160",
      "Banco Moto Yamaha Fazer",
      "Amortecedor Moto Titan 150",
      "Retrovisor Motocicleta Suzuki",
      "Escapamento Scooter Honda PCX",
    ]) {
      expect(resolver(nome), nome).toBe(FACEBOOK_CATEGORY_MAP["moto"]);
    }
  });

  it("peça de BARCO continua indo para Peças de barcos", () => {
    for (const nome of ["Farol Barco", "Banco Lancha", "Motor Jetski"]) {
      expect(resolver(nome), nome).toBe(FACEBOOK_CATEGORY_MAP["barco"]);
    }
  });

  it("o que não casa nada continua na cesta genérica", () => {
    // As palavras ambíguas ficaram DE FORA do de-para de propósito: mapeá-las
    // erraria mais do que acertaria, e fora dele elas deixam a palavra
    // específica do nome decidir.
    for (const nome of [
      "Suporte Fiat Palio 2010",
      "Kit Chevrolet Onix",
      "Par Ford Ka 2018",
      "Peça Volkswagen Gol",
    ]) {
      expect(resolver(nome), nome).toBe(FACEBOOK_DEFAULT_CATEGORY);
    }
  });

  it("a categoria explícita do produto continua vencendo tudo", () => {
    expect(
      Resolucao.resolveCategory({
        name: "Farol Dianteiro Gol",
        fbCategoryId: FB_PART.FREIOS,
      }),
    ).toBe(FB_PART.FREIOS);
  });
});

describe("a peça vai para a cesta certa", () => {
  const casos: Array<[string, string]> = [
    ["Maçaneta Interna Esquerda Chevrolet Celta", FB_PART.CARROCERIA],
    ["Farol Dianteiro Direito Gol G5", FB_PART.ILUMINACAO],
    ["Lanterna Traseira Esquerda Onix 2018", FB_PART.ILUMINACAO],
    ["Retrovisor Elétrico Fiat Argo", FB_PART.ESPELHOS],
    ["Amortecedor Dianteiro Spin 1.8", FB_PART.SUSPENSAO],
    ["Pinça de Freio Sandero 2012", FB_PART.FREIOS],
    ["Radiador Hyundai HB20 1.0", FB_PART.CLIMATIZACAO],
    ["Bico Injetor Jeep Compass 2.0", FB_PART.COMBUSTIVEL],
    ["Módulo de Injeção Ford Fiesta", FB_PART.ELETRICA],
    ["Sonda Lambda Hyundai Tucson", FB_PART.SENSORES],
    ["Caixa de Câmbio Chevrolet Kadett", FB_PART.TRANSMISSAO],
    ["Banco Dianteiro Direito Corolla", FB_PART.BANCOS],
    ["Catalisador Corsa Classic 1.0", FB_PART.ESCAPAMENTO],
    ["Cabeçote Motor Palio 1.0", FB_PART.MOTOR_PECAS],
    ["Motor Completo Ford Ka 1.0", FB_PART.MOTOR_COMPLETO],
  ];

  for (const [nome, esperado] of casos) {
    it(`"${nome}" → ${FB_PART_LABEL[esperado]}`, () => {
      expect(resolver(nome)).toBe(esperado);
    });
  }
});

describe("as chaves compostas desempatam", () => {
  it("Máquina de Vidro é peça de JANELA, não de motor", () => {
    // `maquina de vidro`(16) tem que ganhar de `vidro`(5) e de `motor`(5).
    expect(resolver("Máquina De Vidro Elétrica Traseira Citroen")).toBe(
      FB_PART.JANELAS,
    );
    expect(resolver("Motor do Vidro Elétrico Dianteiro Gol")).toBe(
      FB_PART.JANELAS,
    );
  });

  it("Motor de Partida é ELÉTRICA, não peça de motor", () => {
    expect(resolver("Motor de Partida Fiat Uno 1.0")).toBe(FB_PART.ELETRICA);
  });

  it("Coletor de Escape é ESCAPAMENTO, não peça de motor", () => {
    expect(resolver("Coletor de Escape Gol 1.6")).toBe(FB_PART.ESCAPAMENTO);
    expect(resolver("Coletor de Admissão Gol 1.6")).toBe(FB_PART.MOTOR_PECAS);
  });

  it("Reservatório de Fluido de Freio é FREIO, não arrefecimento", () => {
    // Erro real, encontrado medindo contra o catálogo: `reservatorio` sozinho
    // levava para arrefecimento.
    expect(resolver("Reservatório Fluido De Freio Citroen C3")).toBe(
      FB_PART.FREIOS,
    );
    expect(resolver("Reservatório de Água Gol G4")).toBe(FB_PART.CLIMATIZACAO);
  });

  it("Amortecedor da Tampa é LATARIA, não suspensão", () => {
    expect(resolver("Amortecedor Tampa Traseira Tracker 2021")).toBe(
      FB_PART.CARROCERIA,
    );
  });

  it("Porta-luvas é INTERIOR, não lataria", () => {
    expect(resolver("Moldura Interna Porta Luvas Lancer 2014")).toBe(
      FB_PART.INTERIOR,
    );
  });
});

describe("a lista e os rótulos ficam íntegros", () => {
  it("toda cesta que a resolução pode devolver tem rótulo em português", () => {
    // A invariante que faltou da outra vez, agora nas DUAS direções.
    const possiveis = new Set<string>([
      ...Object.values(FACEBOOK_PART_MAP),
      ...Object.values(FACEBOOK_CATEGORY_MAP),
      FACEBOOK_DEFAULT_CATEGORY,
    ]);
    for (const cesta of possiveis) {
      expect(FACEBOOK_CATEGORY_LABEL[cesta], `sem rótulo: ${cesta}`).toBeTruthy();
    }
  });

  it("todo rótulo é oferecido pela lista, e são 24", () => {
    expect(Object.keys(FACEBOOK_CATEGORY_LABEL)).toHaveLength(24);
    expect(Object.keys(FB_PART_LABEL)).toHaveLength(21);
  });

  it("nenhum rótulo tem inglês, caminho ou código cru", () => {
    for (const rotulo of Object.values(FACEBOOK_CATEGORY_LABEL)) {
      expect(rotulo).not.toContain(">");
      expect(rotulo).not.toContain("Vehicle");
      expect(rotulo).not.toMatch(/^\d+$/);
    }
  });

  it("o VALOR enviado à Meta segue sendo o caminho do Google, em inglês", () => {
    // Traduzir o valor faz a Meta recusar o item — com HTTP 200, sem ninguém ver.
    for (const cesta of Object.keys(FACEBOOK_CATEGORY_LABEL)) {
      expect(cesta.startsWith("Vehicles & Parts >")).toBe(true);
    }
  });

  it("as 21 cestas são as filhas de Motor Vehicle Parts, sem repetição", () => {
    const valores = Object.values(FB_PART);
    expect(new Set(valores).size).toBe(valores.length);
    for (const v of valores) {
      expect(v.startsWith("Vehicles & Parts > Vehicle Parts & Accessories > Motor Vehicle Parts > ")).toBe(true);
    }
  });
});
