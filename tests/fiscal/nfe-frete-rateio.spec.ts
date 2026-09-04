import { describe, it, expect, vi, afterEach } from "vitest";
import {
  freteCompoeBaseIcms,
  formatDimensoesParaInfCpl,
  isNfeFreteMedidasEnabled,
  ratearFrete,
} from "../../app/fiscal/domain/frete";

/** Soma em centavos — evita comparar float com float. */
const somaCentavos = (xs: number[]) =>
  xs.reduce((acc, v) => acc + Math.round(v * 100), 0);

describe("ratearFrete", () => {
  it("sem itens devolve lista vazia", () => {
    expect(ratearFrete(100, [])).toEqual([]);
  });

  it("frete nulo/zero/negativo devolve zeros (nao cria vFrete no XML)", () => {
    expect(ratearFrete(null, [10, 20])).toEqual([0, 0]);
    expect(ratearFrete(undefined, [10, 20])).toEqual([0, 0]);
    expect(ratearFrete(0, [10, 20])).toEqual([0, 0]);
    expect(ratearFrete(-5, [10, 20])).toEqual([0, 0]);
  });

  it("item unico recebe o frete inteiro", () => {
    expect(ratearFrete(37.42, [500])).toEqual([37.42]);
  });

  it("rateia proporcionalmente ao valor do item", () => {
    // 100 de frete sobre itens 300 e 100 => 75% e 25%
    expect(ratearFrete(100, [300, 100])).toEqual([75, 25]);
  });

  it("a soma das parcelas e EXATAMENTE o frete informado (Rejeicao 535)", () => {
    // 3 itens iguais e R$ 10,00: 3,333... nao fecha por arredondamento simples.
    const parcelas = ratearFrete(10, [100, 100, 100]);
    expect(somaCentavos(parcelas)).toBe(1000);
  });

  it("nao produz parcela negativa no caso que quebra o round2 ingenuo", () => {
    // R$ 0,05 entre 10 itens iguais: arredondar cada parcela daria 10 x R$ 0,01
    // = R$ 0,10 e jogaria o resto do ultimo item para -0,05.
    const parcelas = ratearFrete(0.05, new Array(10).fill(100));
    expect(somaCentavos(parcelas)).toBe(5);
    expect(parcelas.every((p) => p >= 0)).toBe(true);
    expect(parcelas.filter((p) => p > 0)).toHaveLength(5);
  });

  it("fecha a conta em varios valores e quantidades de itens", () => {
    const casos: [number, number[]][] = [
      [0.01, [1, 1, 1]],
      [1234.56, [10, 20, 30, 40, 55.5]],
      [99.99, [7]],
      [0.03, new Array(7).fill(3)],
      [500, [0.01, 9999.99]],
    ];
    for (const [frete, itens] of casos) {
      const parcelas = ratearFrete(frete, itens);
      expect(somaCentavos(parcelas), `frete ${frete}`).toBe(
        Math.round(frete * 100),
      );
      expect(parcelas.every((p) => p >= 0)).toBe(true);
      expect(parcelas).toHaveLength(itens.length);
    }
  });

  it("itens sem valor recebem rateio igualitario (nao trava em zeros)", () => {
    const parcelas = ratearFrete(10, [0, 0, 0, 0]);
    expect(somaCentavos(parcelas)).toBe(1000);
    expect(parcelas).toEqual([2.5, 2.5, 2.5, 2.5]);
  });

  it("valor negativo ou nao-finito de item nao participa do rateio", () => {
    const parcelas = ratearFrete(10, [100, -50, Number.NaN]);
    expect(somaCentavos(parcelas)).toBe(1000);
    expect(parcelas[0]).toBe(10);
    expect(parcelas[1]).toBe(0);
    expect(parcelas[2]).toBe(0);
  });

  it("e deterministico — mesma entrada, mesma saida (XML reproduzivel)", () => {
    const itens = [13.37, 42, 7.5, 99.01, 1];
    expect(ratearFrete(23.45, itens)).toEqual(ratearFrete(23.45, itens));
  });
});

describe("freteCompoeBaseIcms", () => {
  it("so CIF compoe a base do ICMS", () => {
    expect(freteCompoeBaseIcms("CIF")).toBe(true);
  });

  it("demais modalidades nao compoem", () => {
    for (const m of [
      "FOB",
      "TERCEIROS",
      "PROPRIO_REMETENTE",
      "PROPRIO_DESTINATARIO",
      "SEM_FRETE",
      null,
      undefined,
      "",
    ]) {
      expect(freteCompoeBaseIcms(m as any), String(m)).toBe(false);
    }
  });
});

describe("isNfeFreteMedidasEnabled", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('so liga com exatamente "true"', () => {
    vi.stubEnv("NEXT_PUBLIC_NFE_FRETE_MEDIDAS_ENABLED", "true");
    expect(isNfeFreteMedidasEnabled()).toBe(true);
  });

  it("qualquer outro valor mantem desligado", () => {
    for (const v of ["", "false", "1", "TRUE", "yes"]) {
      vi.stubEnv("NEXT_PUBLIC_NFE_FRETE_MEDIDAS_ENABLED", v);
      expect(isNfeFreteMedidasEnabled(), `valor ${JSON.stringify(v)}`).toBe(
        false,
      );
    }
  });
});

describe("formatDimensoesParaInfCpl", () => {
  it("sem volumes ou sem medidas devolve string vazia (infCpl intacto)", () => {
    expect(formatDimensoesParaInfCpl(null)).toBe("");
    expect(formatDimensoesParaInfCpl([])).toBe("");
    expect(formatDimensoesParaInfCpl("nao e array")).toBe("");
    expect(
      formatDimensoesParaInfCpl([{ quantidade: 1, pesoBruto: 10 }]),
    ).toBe("");
  });

  it("formata as tres medidas de um volume", () => {
    expect(
      formatDimensoesParaInfCpl([
        { comprimentoCm: 40, larguraCm: 30, alturaCm: 20 },
      ]),
    ).toBe("Dimensoes dos volumes: 1) C40 x L30 x A20 cm");
  });

  it("numera varios volumes e ignora os sem medida", () => {
    const out = formatDimensoesParaInfCpl([
      { comprimentoCm: 40, larguraCm: 30, alturaCm: 20 },
      { pesoBruto: 5 },
      { comprimentoCm: 10, larguraCm: 10, alturaCm: 10 },
    ]);
    // A numeracao segue o indice do volume na nota, nao a posicao na lista
    // filtrada — o volume 2 nao tem medida e some, o 3 continua sendo o 3.
    expect(out).toBe(
      "Dimensoes dos volumes: 1) C40 x L30 x A20 cm; 3) C10 x L10 x A10 cm",
    );
  });

  it("aceita medida parcial, sempre rotulada (nunca posicional)", () => {
    expect(formatDimensoesParaInfCpl([{ alturaCm: 15 }])).toBe(
      "Dimensoes dos volumes: 1) A15 cm",
    );
    expect(
      formatDimensoesParaInfCpl([{ comprimentoCm: 50, alturaCm: 15 }]),
    ).toBe("Dimensoes dos volumes: 1) C50 x A15 cm");
  });

  it("descarta medida invalida (zero, negativa, nao-numerica)", () => {
    expect(
      formatDimensoesParaInfCpl([
        { comprimentoCm: 0, larguraCm: -3, alturaCm: "abc" },
      ]),
    ).toBe("");
  });

  it("nao emite acento (o DANFE desenha em WinAnsi)", () => {
    const out = formatDimensoesParaInfCpl([
      { comprimentoCm: 1, larguraCm: 2, alturaCm: 3 },
    ]);
    // eslint-disable-next-line no-control-regex
    expect(out).toMatch(/^[\x00-\x7F]*$/);
  });
});
