import { describe, it, expect } from "vitest";
import {
  normalizePagamentos,
  normalizeTransportadora,
  normalizeVolumes,
  normalizeDuplicatas,
  readItemImposto,
  MEIO_PAGAMENTO_LABEL,
} from "../../app/fiscal/generators/danfe-render-extras";

// ──────────────────────────────────────────────────────────────────
// P1 — os dois shapes de pagamentosJson têm que produzir a MESMA view.
// Este é o bug que a re-renderização a partir do XML exporia num cupom
// fiscal entregue ao consumidor: label "Outros" e valor "R$ 0,00".
// ──────────────────────────────────────────────────────────────────

describe("normalizePagamentos — paridade entre os dois caminhos", () => {
  it("shape do DB e shape do XML produzem a mesma view", () => {
    const doBanco = normalizePagamentos([{ meio: "PIX", valor: 150 }]);
    const doXml = normalizePagamentos([{ tPag: "17", vPag: "150.00" }]);
    expect(doBanco).toEqual([{ label: "PIX", valor: 150 }]);
    expect(doXml).toEqual(doBanco);
  });

  it.each([
    ["DINHEIRO", "01"],
    ["CHEQUE", "02"],
    ["CARTAO_CREDITO", "03"],
    ["CARTAO_DEBITO", "04"],
    ["CREDITO_LOJA", "05"],
    ["VALE_ALIMENTACAO", "10"],
    ["VALE_REFEICAO", "11"],
    ["VALE_PRESENTE", "12"],
    ["VALE_COMBUSTIVEL", "13"],
    ["BOLETO", "15"],
    ["DEPOSITO", "16"],
    ["PIX", "17"],
    ["TRANSFERENCIA", "18"],
    ["SEM_PAGAMENTO", "90"],
    ["OUTROS", "99"],
  ])("%s ⇄ tPag %s dão o mesmo rótulo", (meio, tPag) => {
    const a = normalizePagamentos([{ meio, valor: 10 }]);
    const b = normalizePagamentos([{ tPag, vPag: "10.00" }]);
    expect(a[0].label).toBe(MEIO_PAGAMENTO_LABEL[meio as never]);
    expect(b[0]).toEqual(a[0]);
  });

  it("valores do XML chegam como STRING e viram número", () => {
    // O parser roda com parseTagValue:false — tudo é string.
    const v = normalizePagamentos([{ tPag: "01", vPag: "1234.56" }]);
    expect(v[0].valor).toBe(1234.56);
    expect(typeof v[0].valor).toBe("number");
  });

  it("tPag com 1 dígito é normalizado para 2", () => {
    expect(normalizePagamentos([{ tPag: "1", vPag: "5" }])[0].label).toBe("Dinheiro");
  });

  it("códigos da SEFAZ fora do enum do domínio são decodificados, não viram 'Outros'", () => {
    expect(normalizePagamentos([{ tPag: "20", vPag: "1" }])[0].label).toMatch(/PIX/i);
    expect(normalizePagamentos([{ tPag: "19", vPag: "1" }])[0].label).toMatch(/fidelidade/i);
  });

  it("código desconhecido não se disfarça de 'Outros'", () => {
    const v = normalizePagamentos([{ tPag: "77", vPag: "1" }]);
    expect(v[0].label).toContain("77");
    expect(v[0].label).not.toBe("Outros");
  });

  it("múltiplos pagamentos preservam ordem", () => {
    const v = normalizePagamentos([
      { tPag: "01", vPag: "10.00" },
      { tPag: "17", vPag: "20.00" },
    ]);
    expect(v.map((p) => p.label)).toEqual(["Dinheiro", "PIX"]);
    expect(v.map((p) => p.valor)).toEqual([10, 20]);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["objeto", { meio: "PIX" }],
    ["string", "PIX"],
    ["array vazio", []],
    ["array de lixo", [null, 42, "x", {}]],
  ])("%s → [] sem lançar", (_l, input) => {
    expect(() => normalizePagamentos(input)).not.toThrow();
    expect(normalizePagamentos(input)).toEqual([]);
  });

  it("valor ausente vira null (não 0) — 'não informado' ≠ 'zero'", () => {
    expect(normalizePagamentos([{ meio: "PIX" }])[0].valor).toBeNull();
    expect(normalizePagamentos([{ meio: "PIX", valor: 0 }])[0].valor).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────

describe("normalizeTransportadora — paridade entre os dois caminhos", () => {
  it("shape do DB e shape do XML produzem a mesma view", () => {
    const doBanco = normalizeTransportadora({
      cpfCnpj: "12345678000199",
      nome: "Transportes Silva",
      inscricaoEstadual: "123456",
      endereco: "Rua A, 100",
      municipio: "Goiânia",
      uf: "GO",
    });
    const doXml = normalizeTransportadora({
      CNPJ: "12345678000199",
      xNome: "Transportes Silva",
      IE: "123456",
      xEnder: "Rua A, 100",
      xMun: "Goiânia",
      UF: "GO",
    });
    expect(doXml).toEqual(doBanco);
    expect(doBanco?.nome).toBe("Transportes Silva");
  });

  it("CPF do XML cai no mesmo campo cpfCnpj", () => {
    expect(normalizeTransportadora({ CPF: "12345678901" })?.cpfCnpj).toBe("12345678901");
  });

  it.each([
    ["null", null],
    ["array", []],
    ["string", "x"],
    ["objeto vazio", {}],
    ["objeto só com nulls", { nome: null, CNPJ: null }],
    ["objeto só com vazios", { nome: "  ", xNome: "" }],
  ])("%s → null", (_l, input) => {
    expect(normalizeTransportadora(input)).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────

describe("normalizeVolumes", () => {
  it("consolida N volumes numa linha: soma quantidades e pesos", () => {
    const v = normalizeVolumes([
      { quantidade: 2, especie: "CAIXA", marca: "ACME", pesoBruto: 10.5, pesoLiquido: 9 },
      { quantidade: 3, pesoBruto: 4.5, pesoLiquido: 4 },
    ]);
    expect(v).toEqual({
      quantidade: 5,
      especie: "CAIXA",
      marca: "ACME",
      numeracao: null,
      pesoBruto: 15,
      pesoLiquido: 13,
    });
  });

  it("usa o primeiro texto preenchido, ignorando vazios anteriores", () => {
    const v = normalizeVolumes([{ especie: "" }, { especie: "PALLET" }]);
    expect(v?.especie).toBe("PALLET");
  });

  it.each([
    ["null", null],
    ["array vazio", []],
    ["array de lixo", [null, 1, "x"]],
  ])("%s → null", (_l, input) => {
    expect(normalizeVolumes(input)).toBeNull();
  });
});

describe("normalizeDuplicatas", () => {
  it("lê o shape do formulário", () => {
    expect(
      normalizeDuplicatas([{ numero: "001", vencimento: "2026-06-01", valor: 100 }]),
    ).toEqual([{ numero: "001", vencimento: "2026-06-01", valor: 100 }]);
  });

  it("lê também o shape do XML (nDup/dVenc/vDup)", () => {
    expect(
      normalizeDuplicatas([{ nDup: "001", dVenc: "2026-06-01", vDup: "100.00" }]),
    ).toEqual([{ numero: "001", vencimento: "2026-06-01", valor: 100 }]);
  });

  it("entrada inválida → []", () => {
    expect(normalizeDuplicatas(null)).toEqual([]);
    expect(normalizeDuplicatas([null, 3])).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────
// P3 — os valores fiscais por item vivem no dump bruto de <imposto>;
// projectParsedNfeToDraft os descarta.
// ──────────────────────────────────────────────────────────────────

describe("readItemImposto", () => {
  it("lê CSOSN do Simples Nacional (ICMSSN102)", () => {
    const v = readItemImposto({ ICMS: { ICMSSN102: { orig: "0", CSOSN: "102" } } });
    expect(v).toMatchObject({ origem: "0", cstCsosn: "102", isCsosn: true });
    expect(v?.valorIcms).toBeNull();
  });

  it("lê CST e valores do regime normal (ICMS00)", () => {
    const v = readItemImposto({
      ICMS: {
        ICMS00: {
          orig: "1",
          CST: "00",
          modBC: "3",
          vBC: "100.00",
          pICMS: "18.00",
          vICMS: "18.00",
        },
      },
    });
    expect(v).toEqual({
      origem: "1",
      cstCsosn: "00",
      isCsosn: false,
      bcIcms: 100,
      valorIcms: 18,
      aliquotaIcms: 18,
      valorIpi: null,
      aliquotaIpi: null,
    });
  });

  it("todos os valores vêm como STRING do parser e viram number", () => {
    const v = readItemImposto({ ICMS: { ICMS20: { vBC: "1234.56", vICMS: "222.22" } } })!;
    expect(v.bcIcms).toBe(1234.56);
    expect(v.valorIcms).toBe(222.22);
    expect(typeof v.bcIcms).toBe("number");
  });

  it("lê IPI de dentro de IPITrib", () => {
    const v = readItemImposto({
      ICMS: { ICMS00: { orig: "0", CST: "00" } },
      IPI: { cEnq: "999", IPITrib: { CST: "50", vBC: "100.00", pIPI: "5.00", vIPI: "5.00" } },
    });
    expect(v?.valorIpi).toBe(5);
    expect(v?.aliquotaIpi).toBe(5);
  });

  it("IPINT (não tributado) não inventa valores de IPI", () => {
    const v = readItemImposto({
      ICMS: { ICMS00: { orig: "0", CST: "00" } },
      IPI: { cEnq: "999", IPINT: { CST: "53" } },
    });
    expect(v?.valorIpi).toBeNull();
    expect(v?.aliquotaIpi).toBeNull();
  });

  it("qualquer variante do grupo ICMS é aceita sem listar as ~20 tags", () => {
    for (const tag of ["ICMS00", "ICMS20", "ICMS60", "ICMSSN101", "ICMSSN500", "ICMSSN900"]) {
      const v = readItemImposto({ ICMS: { [tag]: { orig: "0", CST: "40" } } });
      expect(v?.cstCsosn, tag).toBe("40");
    }
  });

  it("ausente/ilegível → null (o chamador cai no dado do banco, não inventa)", () => {
    expect(readItemImposto(null)).toBeNull();
    expect(readItemImposto(undefined)).toBeNull();
    expect(readItemImposto("x")).toBeNull();
    expect(readItemImposto({})).toBeNull();
    expect(readItemImposto({ PIS: { PISAliq: { CST: "01" } } })).toBeNull();
  });

  it("valor zero é preservado como 0 e distinguido de ausente", () => {
    const v = readItemImposto({ ICMS: { ICMS00: { orig: "0", CST: "00", vICMS: "0.00" } } })!;
    expect(v.valorIcms).toBe(0);
    expect(v.valorIpi).toBeNull();
  });

  it("não lança para shapes bizarros", () => {
    expect(() => readItemImposto({ ICMS: "texto" })).not.toThrow();
    expect(() => readItemImposto({ ICMS: [1, 2] })).not.toThrow();
    expect(() => readItemImposto({ IPI: 42 })).not.toThrow();
  });
});
