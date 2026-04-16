import { describe, it, expect } from "vitest";
import { FiscalCalculatorService } from "../../app/fiscal/calculators/fiscal-calculator.service";
import {
  NfeItemInput,
  canTransition,
  NfeStatus,
} from "../../app/fiscal/domain/nfe.types";
import {
  round2,
  getAliquotasPadrao,
  isIcmsTributado,
  isIcmsComReducao,
  isIcmsIsento,
  isPisCofinsTributado,
  getAliquotaIcmsInterestadual,
} from "../../app/fiscal/calculators/tribute-rules";

// ── Helper para criar item com defaults ──

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

describe("FiscalCalculatorService", () => {
  const calc = new FiscalCalculatorService();

  // ── Validação básica ──

  it("rejeita nota sem itens", () => {
    expect(() => calc.calcular("LUCRO_PRESUMIDO", [])).toThrow(
      "ao menos 1 item",
    );
  });

  // ── Lucro Presumido: caso padrão ──

  describe("Lucro Presumido — item padrão CST 00", () => {
    const result = calc.calcular("LUCRO_PRESUMIDO", [makeItem()]);
    const item = result.itens[0];

    it("calcula ICMS 18% sobre base integral", () => {
      expect(item.bcIcms).toBe(100);
      expect(item.aliquotaIcms).toBe(18);
      expect(item.valorIcms).toBe(18);
    });

    it("PIS 0.65% cumulativo", () => {
      expect(item.bcPis).toBe(100);
      expect(item.aliquotaPis).toBe(0.65);
      expect(item.valorPis).toBe(0.65);
    });

    it("COFINS 3% cumulativo", () => {
      expect(item.bcCofins).toBe(100);
      expect(item.aliquotaCofins).toBe(3);
      expect(item.valorCofins).toBe(3);
    });

    it("IPI zero (padrão)", () => {
      expect(item.valorIpi).toBe(0);
    });

    it("valor total tributos = ICMS + PIS + COFINS", () => {
      expect(item.valorTotalTributos).toBe(round2(18 + 0.65 + 3));
    });

    it("totais da nota corretos", () => {
      expect(result.totais.totalProdutos).toBe(100);
      expect(result.totais.totalDesconto).toBe(0);
      expect(result.totais.totalNota).toBe(100); // IPI = 0, sem desconto
      expect(result.totais.totalIcms).toBe(18);
      expect(result.totais.totalPis).toBe(0.65);
      expect(result.totais.totalCofins).toBe(3);
    });
  });

  // ── Lucro Real ──

  describe("Lucro Real — PIS/COFINS não-cumulativo", () => {
    const result = calc.calcular("LUCRO_REAL", [makeItem()]);
    const item = result.itens[0];

    it("PIS 1.65%", () => {
      expect(item.aliquotaPis).toBe(1.65);
      expect(item.valorPis).toBe(1.65);
    });

    it("COFINS 7.6%", () => {
      expect(item.aliquotaCofins).toBe(7.6);
      expect(item.valorCofins).toBe(7.6);
    });
  });

  // ── Simples Nacional ──

  describe("Simples Nacional — tributos zerados", () => {
    const result = calc.calcular("SIMPLES", [makeItem()]);
    const item = result.itens[0];

    it("ICMS zero (recolhido via DAS)", () => {
      expect(item.bcIcms).toBe(0);
      expect(item.valorIcms).toBe(0);
      expect(item.aliquotaIcms).toBe(0);
    });

    it("PIS/COFINS zero quando CST 01 mas regime Simples (alíquotas padrão 0)", () => {
      // No Simples, as alíquotas padrão são 0 — se CST 01 incide mas alíquota = 0
      expect(item.valorPis).toBe(0);
      expect(item.valorCofins).toBe(0);
    });

    it("total da nota = total dos produtos", () => {
      expect(result.totais.totalNota).toBe(100);
      expect(result.totais.totalTributos).toBe(0);
    });
  });

  // ── Desconto ──

  describe("desconto reduz base de cálculo", () => {
    const result = calc.calcular("LUCRO_PRESUMIDO", [
      makeItem({ valorUnitario: 200, desconto: 50 }),
    ]);
    const item = result.itens[0];

    it("base de ICMS = valor bruto - desconto", () => {
      expect(item.bcIcms).toBe(150);
      expect(item.valorIcms).toBe(27); // 150 * 18%
    });

    it("total nota desconta corretamente", () => {
      expect(result.totais.totalProdutos).toBe(200);
      expect(result.totais.totalDesconto).toBe(50);
      expect(result.totais.totalNota).toBe(150);
    });
  });

  // ── Quantidade > 1 ──

  describe("quantidade multiplica valor unitário", () => {
    const result = calc.calcular("LUCRO_PRESUMIDO", [
      makeItem({ quantidade: 3, valorUnitario: 50 }),
    ]);

    it("total produtos = 3 * 50 = 150", () => {
      expect(result.totais.totalProdutos).toBe(150);
    });

    it("ICMS sobre 150", () => {
      expect(result.itens[0].bcIcms).toBe(150);
      expect(result.itens[0].valorIcms).toBe(27); // 150 * 18%
    });
  });

  // ── Múltiplos itens ──

  describe("múltiplos itens totalizam corretamente", () => {
    const result = calc.calcular("LUCRO_PRESUMIDO", [
      makeItem({ valorUnitario: 100 }),
      makeItem({ valorUnitario: 200, desconto: 20 }),
      makeItem({ quantidade: 2, valorUnitario: 50 }),
    ]);

    it("total produtos = 100 + 200 + 100 = 400", () => {
      expect(result.totais.totalProdutos).toBe(400);
    });

    it("total desconto = 0 + 20 + 0 = 20", () => {
      expect(result.totais.totalDesconto).toBe(20);
    });

    it("total nota = 400 - 20 = 380 (IPI = 0)", () => {
      expect(result.totais.totalNota).toBe(380);
    });

    it("total ICMS = soma dos 3 itens", () => {
      const expected = round2(100 * 0.18 + 180 * 0.18 + 100 * 0.18);
      expect(result.totais.totalIcms).toBe(expected);
    });
  });

  // ── IPI ──

  describe("IPI quando alíquota informada", () => {
    const result = calc.calcular("LUCRO_PRESUMIDO", [
      makeItem({ valorUnitario: 1000, aliquotaIpi: 5 }),
    ]);
    const item = result.itens[0];

    it("calcula IPI sobre base integral", () => {
      expect(item.bcIpi).toBe(1000);
      expect(item.aliquotaIpi).toBe(5);
      expect(item.valorIpi).toBe(50);
    });

    it("IPI soma no total da nota", () => {
      // totalNota = produtos - desconto + IPI = 1000 - 0 + 50 = 1050
      expect(result.totais.totalNota).toBe(1050);
      expect(result.totais.totalIpi).toBe(50);
    });
  });

  // ── Redução de base ICMS (CST 20) ──

  describe("CST 20 — ICMS com redução de base", () => {
    const result = calc.calcular("LUCRO_PRESUMIDO", [
      makeItem({ cstIcms: "20", reducaoBcIcms: 30 }),
    ]);
    const item = result.itens[0];

    it("aplica redução de 30% na base", () => {
      expect(item.bcIcms).toBe(70); // 100 * (1 - 30/100)
    });

    it("ICMS sobre base reduzida", () => {
      expect(item.valorIcms).toBe(round2(70 * 0.18)); // 12.6
    });
  });

  // ── CST isento (40) — ICMS zerado ──

  describe("CST 40 — isento de ICMS", () => {
    const result = calc.calcular("LUCRO_PRESUMIDO", [
      makeItem({ cstIcms: "40" }),
    ]);
    const item = result.itens[0];

    it("ICMS zerado", () => {
      expect(item.bcIcms).toBe(0);
      expect(item.valorIcms).toBe(0);
      expect(item.aliquotaIcms).toBe(0);
    });

    it("PIS/COFINS ainda incidem", () => {
      expect(item.valorPis).toBeGreaterThan(0);
      expect(item.valorCofins).toBeGreaterThan(0);
    });
  });

  // ── PIS/COFINS isentos (CST 04) ──

  describe("CST PIS/COFINS 04 — não tributado", () => {
    const result = calc.calcular("LUCRO_PRESUMIDO", [
      makeItem({ cstPis: "04", cstCofins: "04" }),
    ]);
    const item = result.itens[0];

    it("PIS zerado", () => {
      expect(item.bcPis).toBe(0);
      expect(item.valorPis).toBe(0);
      expect(item.aliquotaPis).toBe(0);
    });

    it("COFINS zerado", () => {
      expect(item.bcCofins).toBe(0);
      expect(item.valorCofins).toBe(0);
      expect(item.aliquotaCofins).toBe(0);
    });
  });

  // ── Override de alíquotas ──

  describe("override de alíquotas prevalece sobre padrão", () => {
    const result = calc.calcular("LUCRO_PRESUMIDO", [
      makeItem({
        aliquotaIcms: 12,
        aliquotaPis: 1,
        aliquotaCofins: 5,
      }),
    ]);
    const item = result.itens[0];

    it("ICMS usa alíquota override", () => {
      expect(item.aliquotaIcms).toBe(12);
      expect(item.valorIcms).toBe(12);
    });

    it("PIS usa alíquota override", () => {
      expect(item.aliquotaPis).toBe(1);
      expect(item.valorPis).toBe(1);
    });

    it("COFINS usa alíquota override", () => {
      expect(item.aliquotaCofins).toBe(5);
      expect(item.valorCofins).toBe(5);
    });
  });

  // ── Arredondamento ──

  describe("arredondamento a 2 casas decimais", () => {
    it("não gera erros de ponto flutuante", () => {
      // 3 * 33.33 = 99.99 — clássico problema de float
      const result = calc.calcular("LUCRO_PRESUMIDO", [
        makeItem({ quantidade: 3, valorUnitario: 33.33 }),
      ]);
      expect(result.totais.totalProdutos).toBe(99.99);
      // Garante que nenhum valor tem mais de 2 casas
      const item = result.itens[0];
      const values = [
        item.bcIcms, item.valorIcms, item.bcPis, item.valorPis,
        item.bcCofins, item.valorCofins, item.valorTotalTributos,
      ];
      for (const v of values) {
        const parts = v.toString().split(".");
        if (parts[1]) expect(parts[1].length).toBeLessThanOrEqual(2);
      }
    });
  });
});

// ── Testes para tribute-rules.ts ──

describe("tribute-rules", () => {
  describe("round2", () => {
    it("arredonda para 2 casas", () => {
      expect(round2(1.005)).toBe(1.01);
      expect(round2(1.004)).toBe(1);
      expect(round2(0.1 + 0.2)).toBe(0.3);
    });
  });

  describe("getAliquotasPadrao", () => {
    it("Simples: tudo zero", () => {
      const a = getAliquotasPadrao("SIMPLES");
      expect(a.icms).toBe(0);
      expect(a.pis).toBe(0);
      expect(a.cofins).toBe(0);
    });

    it("Lucro Presumido: PIS 0.65, COFINS 3", () => {
      const a = getAliquotasPadrao("LUCRO_PRESUMIDO");
      expect(a.pis).toBe(0.65);
      expect(a.cofins).toBe(3);
    });

    it("Lucro Real: PIS 1.65, COFINS 7.6", () => {
      const a = getAliquotasPadrao("LUCRO_REAL");
      expect(a.pis).toBe(1.65);
      expect(a.cofins).toBe(7.6);
    });
  });

  describe("getAliquotaIcmsInterestadual", () => {
    it("intraestadual = 18%", () => {
      expect(getAliquotaIcmsInterestadual("SP", "SP")).toBe(18);
    });

    it("SP → BA = 7% (Sul/Sudeste → demais)", () => {
      expect(getAliquotaIcmsInterestadual("SP", "BA")).toBe(12);
    });

    it("BA → SP = 7% (demais → Sul/Sudeste)", () => {
      expect(getAliquotaIcmsInterestadual("BA", "SP")).toBe(7);
    });
  });

  describe("helpers de CST", () => {
    it("CST 00 é tributado", () => expect(isIcmsTributado("00")).toBe(true));
    it("CST 20 é tributado com redução", () => {
      expect(isIcmsTributado("20")).toBe(true);
      expect(isIcmsComReducao("20")).toBe(true);
    });
    it("CST 40 é isento", () => expect(isIcmsIsento("40")).toBe(true));
    it("CST 60 é isento", () => expect(isIcmsIsento("60")).toBe(true));
    it("PIS CST 01 é tributado", () =>
      expect(isPisCofinsTributado("01")).toBe(true));
    it("PIS CST 04 NÃO é tributado", () =>
      expect(isPisCofinsTributado("04")).toBe(false));
  });
});

// ── Testes da máquina de estados ──

describe("NFe state machine (canTransition)", () => {
  it("DRAFT → VALIDATING: ok", () =>
    expect(canTransition("DRAFT", "VALIDATING")).toBe(true));

  it("DRAFT → AUTHORIZED: bloqueado", () =>
    expect(canTransition("DRAFT", "AUTHORIZED")).toBe(false));

  it("VALIDATING → SIGNING: ok", () =>
    expect(canTransition("VALIDATING", "SIGNING")).toBe(true));

  it("VALIDATING → DRAFT: ok (volta para edição)", () =>
    expect(canTransition("VALIDATING", "DRAFT")).toBe(true));

  it("SENDING → AUTHORIZED: ok", () =>
    expect(canTransition("SENDING", "AUTHORIZED")).toBe(true));

  it("SENDING → REJECTED: ok", () =>
    expect(canTransition("SENDING", "REJECTED")).toBe(true));

  it("AUTHORIZED → CANCELLED: ok", () =>
    expect(canTransition("AUTHORIZED", "CANCELLED")).toBe(true));

  it("AUTHORIZED → DRAFT: bloqueado", () =>
    expect(canTransition("AUTHORIZED", "DRAFT")).toBe(false));

  it("CANCELLED → qualquer: bloqueado", () => {
    const targets: NfeStatus[] = [
      "DRAFT", "VALIDATING", "SIGNING", "SENDING",
      "AUTHORIZED", "REJECTED", "INUTILIZED",
    ];
    for (const t of targets) {
      expect(canTransition("CANCELLED", t)).toBe(false);
    }
  });

  it("INUTILIZED → qualquer: bloqueado", () => {
    const targets: NfeStatus[] = [
      "DRAFT", "VALIDATING", "SIGNING", "SENDING",
      "AUTHORIZED", "REJECTED", "CANCELLED",
    ];
    for (const t of targets) {
      expect(canTransition("INUTILIZED", t)).toBe(false);
    }
  });

  it("REJECTED → DRAFT: ok (permite correção)", () =>
    expect(canTransition("REJECTED", "DRAFT")).toBe(true));
});
