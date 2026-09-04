import { describe, it, expect } from "vitest";
import { FiscalCalculatorService } from "../../app/fiscal/calculators/fiscal-calculator.service";
import type { NfeItemInput } from "../../app/fiscal/domain/nfe.types";

function makeItem(overrides: Partial<NfeItemInput> = {}): NfeItemInput {
  return {
    quantidade: 1,
    valorUnitario: 100,
    desconto: 0,
    ncm: "87089990",
    cfop: "5102",
    origem: 0,
    cstIcms: "00",
    cstPis: "01",
    cstCofins: "01",
    aliquotaIcms: null,
    aliquotaIpi: null,
    aliquotaPis: null,
    aliquotaCofins: null,
    reducaoBcIcms: null,
    ...overrides,
  };
}

describe("FiscalCalculatorService — frete", () => {
  const calc = new FiscalCalculatorService();
  const REGIME = "LUCRO_PRESUMIDO";

  // ── Cenário 1 / 6: emissão como é hoje, sem os dados novos ──

  describe("sem frete informado — comportamento atual preservado", () => {
    const itens = [makeItem(), makeItem({ valorUnitario: 50 })];

    it("omitir o 3o parametro produz o MESMO resultado de passar frete 0", () => {
      const semParam = calc.calcular(REGIME, itens);
      const comZero = calc.calcular(REGIME, itens, {
        valorFrete: 0,
        modalidadeFrete: "CIF",
      });
      expect(comZero).toEqual(semParam);
    });

    it("frete null/undefined nao altera nada", () => {
      const base = calc.calcular(REGIME, itens);
      expect(calc.calcular(REGIME, itens, { valorFrete: null })).toEqual(base);
      expect(calc.calcular(REGIME, itens, {})).toEqual(base);
    });

    it("totalNota segue a formula original (produtos - desconto + IPI)", () => {
      const { totais } = calc.calcular(REGIME, itens);
      expect(totais.totalProdutos).toBe(150);
      expect(totais.totalNota).toBe(150);
      expect(totais.totalFrete).toBe(0);
    });
  });

  // ── Cenário 2: emissão com valor de frete ──

  describe("com frete informado", () => {
    it("frete entra no vNF (regra W16 — sem isso, Rejeicao 610)", () => {
      const { totais } = calc.calcular(REGIME, [makeItem()], {
        valorFrete: 25.5,
        modalidadeFrete: "FOB",
      });
      expect(totais.totalProdutos).toBe(100);
      expect(totais.totalFrete).toBe(25.5);
      expect(totais.totalNota).toBe(125.5);
    });

    it("totalFrete e exatamente o valor informado, com N itens", () => {
      const itens = [makeItem(), makeItem(), makeItem()];
      const { totais } = calc.calcular(REGIME, itens, {
        valorFrete: 10,
        modalidadeFrete: "FOB",
      });
      // 10 / 3 nao e exato: o metodo do maior resto fecha a conta.
      expect(totais.totalFrete).toBe(10);
      expect(totais.totalNota).toBe(310);
    });

    it("convive com desconto e IPI", () => {
      const itens = [makeItem({ desconto: 20, aliquotaIpi: 10 })];
      const { totais } = calc.calcular(REGIME, itens, {
        valorFrete: 30,
        modalidadeFrete: "FOB",
      });
      // produtos 100 - desconto 20 + IPI 8 (10% de 80) + frete 30
      expect(totais.totalProdutos).toBe(100);
      expect(totais.totalDesconto).toBe(20);
      expect(totais.totalIpi).toBe(8);
      expect(totais.totalNota).toBe(118);
    });
  });

  // ── Base do ICMS: só CIF ──

  describe("frete na base de calculo do ICMS", () => {
    const itens = [makeItem({ aliquotaIcms: 18 })];

    it("CIF: o frete SOBE a base e o valor do ICMS", () => {
      const semFrete = calc.calcular(REGIME, itens);
      const comFrete = calc.calcular(REGIME, itens, {
        valorFrete: 50,
        modalidadeFrete: "CIF",
      });
      expect(semFrete.totais.totalBcIcms).toBe(100);
      expect(semFrete.totais.totalIcms).toBe(18);
      // base 100 + 50 = 150 ⇒ ICMS 27,00
      expect(comFrete.totais.totalBcIcms).toBe(150);
      expect(comFrete.totais.totalIcms).toBe(27);
    });

    it("FOB e demais modalidades NAO mexem na base", () => {
      for (const mod of [
        "FOB",
        "TERCEIROS",
        "PROPRIO_REMETENTE",
        "PROPRIO_DESTINATARIO",
        "SEM_FRETE",
        null,
      ]) {
        const { totais } = calc.calcular(REGIME, itens, {
          valorFrete: 50,
          modalidadeFrete: mod,
        });
        expect(totais.totalBcIcms, `modalidade ${mod}`).toBe(100);
        expect(totais.totalIcms, `modalidade ${mod}`).toBe(18);
        // ...mas o frete continua entrando no total da nota.
        expect(totais.totalNota, `modalidade ${mod}`).toBe(150);
      }
    });

    it("CIF NAO altera as bases de IPI, PIS e COFINS", () => {
      const itensComTudo = [makeItem({ aliquotaIpi: 10 })];
      const semFrete = calc.calcular(REGIME, itensComTudo);
      const comFrete = calc.calcular(REGIME, itensComTudo, {
        valorFrete: 50,
        modalidadeFrete: "CIF",
      });
      expect(comFrete.totais.totalBcIpi).toBe(semFrete.totais.totalBcIpi);
      expect(comFrete.totais.totalIpi).toBe(semFrete.totais.totalIpi);
      expect(comFrete.totais.totalPis).toBe(semFrete.totais.totalPis);
      expect(comFrete.totais.totalCofins).toBe(semFrete.totais.totalCofins);
      expect(comFrete.itens[0].bcPis).toBe(semFrete.itens[0].bcPis);
      expect(comFrete.itens[0].bcCofins).toBe(semFrete.itens[0].bcCofins);
    });

    it("CIF respeita a reducao de base (aplica sobre produto + frete)", () => {
      const item = makeItem({
        cstIcms: "20",
        aliquotaIcms: 18,
        reducaoBcIcms: 50,
      });
      const { totais } = calc.calcular(REGIME, [item], {
        valorFrete: 100,
        modalidadeFrete: "CIF",
      });
      // (100 + 100) x 50% = 100 de base ⇒ 18,00 de ICMS
      expect(totais.totalBcIcms).toBe(100);
      expect(totais.totalIcms).toBe(18);
    });

    it("SIMPLES nao destaca ICMS nem com frete CIF", () => {
      const { totais } = calc.calcular("SIMPLES", itens, {
        valorFrete: 50,
        modalidadeFrete: "CIF",
      });
      expect(totais.totalBcIcms).toBe(0);
      expect(totais.totalIcms).toBe(0);
      expect(totais.totalNota).toBe(150);
    });

    it("item isento/nao tributado nao ganha base por causa do frete", () => {
      const { totais } = calc.calcular(REGIME, [makeItem({ cstIcms: "40" })], {
        valorFrete: 50,
        modalidadeFrete: "CIF",
      });
      expect(totais.totalBcIcms).toBe(0);
      expect(totais.totalIcms).toBe(0);
    });
  });

  // ── Cenário 7: valores inválidos ──

  describe("valores invalidos de frete", () => {
    it("frete negativo e tratado como zero (nao reduz a nota)", () => {
      const { totais } = calc.calcular(REGIME, [makeItem()], {
        valorFrete: -100,
        modalidadeFrete: "CIF",
      });
      expect(totais.totalFrete).toBe(0);
      expect(totais.totalNota).toBe(100);
      expect(totais.totalBcIcms).toBe(100);
    });

    it("frete nao-numerico e tratado como zero", () => {
      const { totais } = calc.calcular(REGIME, [makeItem()], {
        valorFrete: Number.NaN,
        modalidadeFrete: "CIF",
      });
      expect(totais.totalFrete).toBe(0);
      expect(totais.totalNota).toBe(100);
    });
  });
});
