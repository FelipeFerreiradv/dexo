import { describe, it, expect } from "vitest";
import {
  normalizeText,
  kebab,
  stripStopwords,
  parseYearToNumber,
  parseYearRange,
  extractPosition,
  extractPartType,
  parseTitleToParts,
  normalizeBrand,
  buildLookupColumns,
  buildMatchKey,
  ANY,
} from "@/app/marketplaces/lib/title-parse";
import { __testables } from "@/app/marketplaces/usecases/ml-catalog-suggestion.usecase";

describe("title-parse — normalização", () => {
  it("normalizeText remove acento, baixa caixa e colapsa espaço", () => {
    expect(normalizeText("  Cubo  de  Roda Dianteiro  ")).toBe(
      "cubo de roda dianteiro",
    );
    expect(normalizeText("Câmbio Citroën")).toBe("cambio citroen");
    expect(normalizeText(null)).toBe("");
    expect(normalizeText(undefined)).toBe("");
  });

  it("kebab gera slug ascii", () => {
    expect(kebab("Cubo de Roda")).toBe("cubo-de-roda");
    expect(kebab("Farol/Milha")).toBe("farol-milha");
    expect(kebab("  ")).toBe("");
  });

  it("stripStopwords remove stopwords isoladas", () => {
    expect(stripStopwords("cubo de roda")).toBe("cubo roda");
    expect(stripStopwords("kit de embreagem para o motor")).toBe(
      "embreagem motor",
    );
  });
});

describe("title-parse — ano (paridade com o usecase)", () => {
  const fixtures = [
    "Cubo Fiat Uno 2010",
    "Amortecedor 2008 2014",
    "Sem ano aqui",
    "Modelo 1998 a 2003",
    "Ref 12345 não é ano",
    "",
  ];

  it("parseYearRange casa com __testables.parseYearRange do ml-catalog usecase", () => {
    // A regex /\b(19|20)\d{2}\b/ só casa 1900..2099, que cai dentro do teto
    // defensivo do title-parse — logo as duas implementações coincidem sempre.
    for (const f of fixtures) {
      expect(parseYearRange(f)).toEqual(__testables.parseYearRange(f));
    }
  });

  it("parseYearToNumber pega o primeiro ano de 4 dígitos", () => {
    expect(parseYearToNumber("Cubo Fiat Uno 2010")).toBe(2010);
    expect(parseYearToNumber("2008 2014")).toBe(2008);
    expect(parseYearToNumber("sem ano")).toBeNull();
    expect(parseYearToNumber("ref 12345")).toBeNull();
  });
});

describe("title-parse — posição e tipo de peça", () => {
  it("extractPosition captura eixo + lado em ordem canônica", () => {
    expect(extractPosition("cubo de roda dianteiro esquerdo")).toBe(
      "dianteiro-esquerdo",
    );
    expect(extractPosition("amortecedor traseiro")).toBe("traseiro");
    expect(extractPosition("farol lado direito")).toBe("direito");
    expect(extractPosition("peça sem posição")).toBeNull();
  });

  it("extractPartType casa tipo e dobra a posição", () => {
    expect(extractPartType("Cubo de Roda Dianteiro Fiat Uno 2008")).toBe(
      "cubo-de-roda-dianteiro",
    );
    expect(extractPartType("Cubo Roda Fiat Uno")).toBe("cubo-de-roda");
    expect(extractPartType("Para-choque Dianteiro Gol")).toBe(
      "parachoque-dianteiro",
    );
    expect(extractPartType("Amortecedor Traseiro Onix")).toBe(
      "amortecedor-traseiro",
    );
    expect(extractPartType("Disco de Freio Civic")).toBe("disco-de-freio");
  });

  it("extractPartType prefere a frase mais específica (longest-first)", () => {
    // "tampa porta malas" deve virar tampa-traseira, não "porta".
    expect(extractPartType("Tampa Porta Malas Corolla")).toBe("tampa-traseira");
    // "farol de milha" não pode colapsar em "farol".
    expect(extractPartType("Farol de Milha Hilux")).toBe("farol-de-milha");
    expect(extractPartType("Farol Dianteiro Hilux")).toBe("farol-dianteiro");
  });

  it("extractPartType retorna null para tipo desconhecido", () => {
    expect(extractPartType("xpto coisa nenhuma")).toBeNull();
    expect(extractPartType("")).toBeNull();
  });
});

describe("title-parse — vocabulário ampliado + leftmost-wins", () => {
  it("o tipo mais à esquerda vence (não o mais específico em qualquer lugar)", () => {
    // "limitador de porta" é uma peça PRÓPRIA, não a porta.
    expect(extractPartType("limitador porta dianteira Fiat Uno 2011")).toBe(
      "limitador-de-porta-dianteiro",
    );
    // "suporte do parachoque" é um suporte, não o parachoque.
    expect(extractPartType("suporte do parachoque dianteiro Gol")).toBe(
      "suporte-dianteiro",
    );
  });

  it("plural + agrupador (par/jogo) expõem o tipo real", () => {
    expect(extractPartType("par de farois Corolla")).toBe("farol");
    expect(extractPartType("jogo de molas Gol")).toBe("mola");
  });

  it("não confunde 'alto falante' com posição superior", () => {
    expect(extractPartType("alto falante Civic")).toBe("alto-falante");
  });

  it("reconhece tipos novos minerados do catálogo", () => {
    expect(extractPartType("fechadura eletrica porta traseira Onix")).toBe(
      "fechadura-traseiro",
    );
    expect(extractPartType("sonda lambda HB20")).toBe("sonda-lambda");
    expect(extractPartType("pedal acelerador Palio")).toBe("pedal");
    expect(extractPartType("reservatorio de agua Uno")).toBe("reservatorio");
    expect(extractPartType("compressor de ar condicionado Cruze")).toBe(
      "compressor-de-ar",
    );
    expect(extractPartType("manga de eixo dianteira Gol")).toBe(
      "manga-de-eixo-dianteiro",
    );
  });

  it("frase específica vence o termo genérico na mesma posição", () => {
    expect(extractPartType("tampa de tanque Fiesta")).toBe("tampa-de-tanque");
    expect(extractPartType("caixa de direcao Palio")).toBe("caixa-de-direcao");
    // genérico só quando lidera sozinho
    expect(extractPartType("tampa lateral Uno")).toBe("tampa");
  });
});

describe("title-parse — marca (token + aliases + inferência)", () => {
  it("reconhece marcas que faltavam (Chery/Jeep/Citroën) e extrai o modelo", () => {
    const chery = parseTitleToParts("Vareta Nivel Oleo Chery Tiggo 5X 2020");
    expect(chery.brand).toBe("Chery");
    expect(chery.model).toBe("TIGGO");
    const jeep = parseTitleToParts(
      "Suporte Maçaneta Traseira Esquerda Jeep Renegade",
    );
    expect(jeep.brand).toBe("Jeep");
    expect(jeep.model).toBe("RENEGADE");
    const citroen = parseTitleToParts(
      "Tampa Reservatorio Agua Citroen C3 2006",
    );
    expect(citroen.brand).toBe("Citroën");
    expect(citroen.model).toBe("C3");
  });

  it("alias 'Gm' é normalizado para Chevrolet (unifica a chave)", () => {
    const gm = parseTitleToParts(
      "Maquina Vidro Dianteira Direita Gm Corsa 1996",
    );
    expect(gm.brand).toBe("Chevrolet");
    expect(gm.model).toBe("CORSA");
  });

  it("infere a marca por modelo icônico quando não há marca escrita", () => {
    const p = parseTitleToParts("Haste Vareta Capo Corsa Classic 2002");
    expect(p.brand).toBe("Chevrolet");
    expect(p.model).toBe("CORSA");
  });

  it("normalizeBrand aplica aliases e preserva desconhecidas", () => {
    expect(normalizeBrand("GM")).toBe("Chevrolet");
    expect(normalizeBrand("vw")).toBe("Volkswagen");
    expect(normalizeBrand("Chery")).toBe("Chery");
    expect(normalizeBrand("MarcaXPTO")).toBe("MarcaXPTO");
    expect(normalizeBrand("")).toBeNull();
  });
});

describe("title-parse — parseTitleToParts", () => {
  it("extrai partType/brand/model/year do título livre", () => {
    const p = parseTitleToParts("Cubo de Roda Dianteiro Fiat Uno 2010");
    expect(p.partType).toBe("cubo-de-roda-dianteiro");
    expect(p.position).toBe("dianteiro");
    expect(p.brand).toBe("Fiat");
    expect(p.model).toBe("UNO");
    expect(p.year).toBe(2010);
    expect(p.version).toBeNull();
  });

  it("campos ausentes viram null", () => {
    const p = parseTitleToParts("peça genérica");
    expect(p.partType).toBeNull();
    expect(p.brand).toBeNull();
    expect(p.year).toBeNull();
  });
});

describe("title-parse — chaves de lookup e matchKey", () => {
  it("buildLookupColumns normaliza e usa sentinela '*'", () => {
    expect(
      buildLookupColumns({
        partType: "cubo-de-roda",
        brand: "Fiat",
        model: "Uno",
        version: null,
      }),
    ).toEqual({
      partType: "cubo-de-roda",
      brand: "fiat",
      model: "uno",
      version: ANY,
    });
  });

  it("job (colunas) e endpoint (título) produzem as MESMAS colunas", () => {
    // Endpoint: parseia o título.
    const fromTitle = parseTitleToParts("Cubo de Roda Fiat Uno 2010");
    const endpointCols = buildLookupColumns({
      partType: fromTitle.partType,
      brand: fromTitle.brand,
      model: fromTitle.model,
      version: fromTitle.version,
    });
    // Job: usa nome (partType) + colunas brand/model/version do Product.
    const jobCols = buildLookupColumns({
      partType: extractPartType("Cubo Roda Fiat Uno 2010 51234567"),
      brand: "Fiat",
      model: "UNO",
      version: null,
    });
    expect(endpointCols).toEqual(jobCols);
  });

  it("buildMatchKey monta partType|brand|model|version|faixa", () => {
    expect(
      buildMatchKey({
        partType: "cubo-de-roda",
        brand: "Fiat",
        model: "Uno",
        version: null,
        yearFrom: 2008,
        yearTo: 2014,
      }),
    ).toBe("cubo-de-roda|fiat|uno|*|2008-2014");

    expect(
      buildMatchKey({
        partType: "cubo-de-roda",
        brand: "Fiat",
        model: "Uno",
        version: "Way",
        yearFrom: null,
        yearTo: null,
      }),
    ).toBe("cubo-de-roda|fiat|uno|way|*");
  });
});
