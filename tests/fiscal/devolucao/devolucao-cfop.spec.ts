import { describe, expect, it } from "vitest";

import {
  CFOPS_DEVOLUCAO,
  CFOPS_MEI_DEVOLUCAO,
  EXCECAO_1949_2949,
  cfopsPermitidosDevolucao,
  idDestDoCfop,
  isCfopDevolucao,
  isCfopPermitidoEmDevolucao,
  mapearCfopDevolucao,
  validarCfopVsIdDest,
  type IdDestCfop,
} from "../../../app/fiscal/domain/devolucao-cfop";

describe("CFOPS_DEVOLUCAO (indDevol=1, rejeição 327)", () => {
  it("tem exatamente os 105 códigos da NT", () => {
    const esperado = [
      "1201","1202","1203","1204","1208","1209","1212","1213","1214","1215","1216","1410","1411",
      "1503","1504","1505","1506","1553","1660","1661","1662","1918","1919",
      "2201","2202","2203","2204","2208","2209","2212","2213","2214","2215","2216","2410","2411",
      "2503","2504","2505","2506","2553","2660","2661","2662","2918","2919",
      "3201","3202","3211","3212","3503","3553",
      "5201","5202","5208","5209","5210","5213","5214","5215","5216","5410","5411","5412","5413",
      "5503","5553","5555","5556","5660","5661","5662","5918","5919","5921",
      "6201","6202","6208","6209","6210","6213","6214","6215","6216","6410","6411","6412","6413",
      "6503","6553","6555","6556","6660","6661","6662","6918","6919","6921",
      "7201","7202","7210","7211","7212","7553","7556",
    ];
    expect(esperado).toHaveLength(105);
    expect(CFOPS_DEVOLUCAO.size).toBe(105);
    expect([...CFOPS_DEVOLUCAO].sort()).toEqual([...esperado].sort());
  });

  it("isCfopDevolucao: conjunto oficial; venda e 1949 não entram", () => {
    for (const c of ["1212", "2919", "3553", "5921", "7556", "1202"]) expect(isCfopDevolucao(c)).toBe(true);
    for (const c of ["5102", "1102", "5949", "1949", "2949", "", "abc"]) expect(isCfopDevolucao(c)).toBe(false);
  });

  it("exceção 1949/2949 só em nota de entrada (tpNF=0)", () => {
    expect([...EXCECAO_1949_2949].sort()).toEqual(["1949", "2949"]);
    expect(isCfopPermitidoEmDevolucao("1949", "0")).toBe(true);
    expect(isCfopPermitidoEmDevolucao("2949", "0")).toBe(true);
    expect(isCfopPermitidoEmDevolucao("1949", "1")).toBe(false);
    expect(isCfopPermitidoEmDevolucao("3949", "0")).toBe(false);
    expect(isCfopPermitidoEmDevolucao("5202", "1")).toBe(true);
  });
});

describe("CFOP × idDest (rejeições 731/732/733)", () => {
  it("1/5 ↔ 1, 2/6 ↔ 2, 3/7 ↔ 3", () => {
    expect(idDestDoCfop("1202")).toBe(1);
    expect(idDestDoCfop("5202")).toBe(1);
    expect(idDestDoCfop("2202")).toBe(2);
    expect(idDestDoCfop("6202")).toBe(2);
    expect(idDestDoCfop("3201")).toBe(3);
    expect(idDestDoCfop("7201")).toBe(3);
    expect(idDestDoCfop("4202")).toBeNull();
    expect(idDestDoCfop("12")).toBeNull();
    expect(validarCfopVsIdDest("1202", 1)).toBe(true);
    expect(validarCfopVsIdDest("1202", 2)).toBe(false);
    expect(validarCfopVsIdDest("6411", "2")).toBe(true);
    expect(validarCfopVsIdDest("3202", 1)).toBe(false);
    expect(validarCfopVsIdDest("7202", 3)).toBe(true);
  });
});

describe("mapearCfopDevolucao — VENDA_ENTRADA", () => {
  const casos: Array<[string, IdDestCfop, string]> = [
    ["5102", 1, "1202"],
    ["6102", 2, "2202"],
    ["6108", 2, "2202"],
    ["5101", 1, "1201"],
    ["6101", 2, "2201"],
    ["6107", 2, "2201"],
    ["5405", 1, "1411"],
    ["5403", 1, "1411"],
    ["6403", 2, "2411"],
    ["5401", 1, "1410"],
    ["6401", 2, "2410"],
    ["7101", 3, "3201"],
    ["7102", 3, "3202"],
  ];

  it.each(casos)("%s (idDest %s) → %s MAPEADO", (orig, idDest, esperado) => {
    const r = mapearCfopDevolucao({ cfopOriginal: orig, tipo: "VENDA_ENTRADA", idDestOriginal: idDest });
    expect(r).toEqual({ status: "MAPEADO", cfop: esperado, opcoes: [esperado], motivo: "TABELA" });
  });

  it("6404 → ESCOLHA [2411, 2949]", () => {
    const r = mapearCfopDevolucao({ cfopOriginal: "6404", tipo: "VENDA_ENTRADA", idDestOriginal: 2 });
    expect(r.status).toBe("ESCOLHA");
    expect(r.cfop).toBeNull();
    expect(r.opcoes).toEqual(["2411", "2949"]);
  });

  it("5949 → ESCOLHA [1949]; 6949 → ESCOLHA [2949] (confirmação obrigatória)", () => {
    expect(mapearCfopDevolucao({ cfopOriginal: "5949", tipo: "VENDA_ENTRADA", idDestOriginal: 1 }))
      .toMatchObject({ status: "ESCOLHA", cfop: null, opcoes: ["1949"] });
    expect(mapearCfopDevolucao({ cfopOriginal: "6949", tipo: "VENDA_ENTRADA", idDestOriginal: 2 }))
      .toMatchObject({ status: "ESCOLHA", cfop: null, opcoes: ["2949"] });
  });

  it("5929/6929 → escolha pela venda subjacente", () => {
    const r5 = mapearCfopDevolucao({ cfopOriginal: "5929", tipo: "VENDA_ENTRADA", idDestOriginal: 1 });
    expect(r5.status).toBe("ESCOLHA");
    expect(r5.opcoes).toEqual(["1202", "1201", "1411", "1410", "1949"]);
    const r6 = mapearCfopDevolucao({ cfopOriginal: "6929", tipo: "VENDA_ENTRADA", idDestOriginal: 2 });
    expect(r6.opcoes).toEqual(["2202", "2201", "2411", "2410", "2949"]);
  });

  it("NFC-e usa os mesmos códigos de venda (5102/5405)", () => {
    expect(mapearCfopDevolucao({ cfopOriginal: "5405", tipo: "VENDA_ENTRADA", idDestOriginal: 1 }).cfop).toBe("1411");
  });

  it("idDest divergente do dígito → ESCOLHA no dígito certo", () => {
    const r = mapearCfopDevolucao({ cfopOriginal: "5102", tipo: "VENDA_ENTRADA", idDestOriginal: 2 });
    expect(r).toEqual({ status: "ESCOLHA", cfop: null, opcoes: ["2202"], motivo: "DESTINO_DIVERGENTE" });
  });

  it("sem inverso (5117) → SEM_INVERSO com a lista permitida do dígito + 1949", () => {
    const r = mapearCfopDevolucao({ cfopOriginal: "5117", tipo: "VENDA_ENTRADA", idDestOriginal: 1 });
    expect(r.status).toBe("SEM_INVERSO");
    expect(r.cfop).toBeNull();
    expect(r.opcoes.every((c) => c[0] === "1")).toBe(true);
    expect(r.opcoes).toContain("1949");
    expect(r.opcoes).toContain("1202");
  });

  it("exterior sem inverso (7105) só oferece 3xxx e nunca 3949", () => {
    const r = mapearCfopDevolucao({ cfopOriginal: "7105", tipo: "VENDA_ENTRADA", idDestOriginal: 3 });
    expect(r.status).toBe("SEM_INVERSO");
    expect(r.opcoes.length).toBeGreaterThan(0);
    expect(r.opcoes.every((c) => c[0] === "3")).toBe(true);
    expect(r.opcoes).not.toContain("3949");
  });
});

describe("mapearCfopDevolucao — COMPRA_SAIDA (espelha a entrada do comprador)", () => {
  const casos: Array<[string, IdDestCfop, string]> = [
    ["1102", 1, "5202"],
    ["2102", 2, "6202"],
    ["1403", 1, "5411"],
    ["2403", 2, "6411"],
    ["1556", 1, "5556"],
    ["1551", 1, "5553"],
    ["1101", 1, "5201"],
    ["1401", 1, "5410"],
    ["1407", 1, "5413"],
    ["3102", 3, "7202"],
  ];

  it.each(casos)("%s (idDest %s) → %s", (orig, idDest, esperado) => {
    const r = mapearCfopDevolucao({ cfopOriginal: orig, tipo: "COMPRA_SAIDA", idDestOriginal: idDest });
    expect(r).toMatchObject({ status: "MAPEADO", cfop: esperado });
  });

  it("CFOP de saída do fornecedor → só sugestão (ESCOLHA), sugestão primeiro", () => {
    const r = mapearCfopDevolucao({ cfopOriginal: "6403", tipo: "COMPRA_SAIDA", idDestOriginal: 2 });
    expect(r.status).toBe("ESCOLHA");
    expect(r.motivo).toBe("FINALIDADE_DA_ENTRADA_DESCONHECIDA");
    expect(r.opcoes[0]).toBe("6411");
    expect(r.opcoes).toContain("6202");
    expect(r.opcoes.every((c) => c[0] === "6")).toBe(true);
  });

  it("entrada sem inverso (1949) → SEM_INVERSO só com saídas de devolução", () => {
    const r = mapearCfopDevolucao({ cfopOriginal: "1949", tipo: "COMPRA_SAIDA", idDestOriginal: 1 });
    expect(r.status).toBe("SEM_INVERSO");
    expect(r.opcoes.every((c) => c[0] === "5" && CFOPS_DEVOLUCAO.has(c))).toBe(true);
  });
});

describe("MEI (CRT 4) — lista restrita (rejeição 1179)", () => {
  it("lista oficial", () => {
    expect([...CFOPS_MEI_DEVOLUCAO].sort()).toEqual(["1202", "1553", "2202", "2553", "5202", "6202"]);
  });

  it("5405 → 1202; 6403 → 2202; exterior → ESCOLHA vazia", () => {
    expect(mapearCfopDevolucao({ cfopOriginal: "5405", tipo: "VENDA_ENTRADA", idDestOriginal: 1, crt: "4" }))
      .toMatchObject({ status: "MAPEADO", cfop: "1202", motivo: "MEI_RESTRITO" });
    expect(mapearCfopDevolucao({ cfopOriginal: "6403", tipo: "VENDA_ENTRADA", idDestOriginal: 2, crt: "4" }))
      .toMatchObject({ status: "MAPEADO", cfop: "2202" });
    expect(mapearCfopDevolucao({ cfopOriginal: "7101", tipo: "VENDA_ENTRADA", idDestOriginal: 3, crt: "4" }))
      .toEqual({ status: "ESCOLHA", cfop: null, opcoes: [], motivo: "MEI_RESTRITO" });
  });

  it("MEI mantém 1553 (ativo) e devolve compra por 5202", () => {
    expect(mapearCfopDevolucao({ cfopOriginal: "5551", tipo: "VENDA_ENTRADA", idDestOriginal: 1, crt: "4" }).cfop).toBe("1553");
    expect(mapearCfopDevolucao({ cfopOriginal: "1403", tipo: "COMPRA_SAIDA", idDestOriginal: 1, crt: "4" }).cfop).toBe("5202");
  });

  it("permitidos do MEI só da lista", () => {
    expect(cfopsPermitidosDevolucao({ tipo: "VENDA_ENTRADA", idDest: 1, crt: "4" })).toEqual(["1202", "1553"]);
    expect(cfopsPermitidosDevolucao({ tipo: "COMPRA_SAIDA", idDest: 2, crt: "4" })).toEqual(["6202"]);
  });
});

describe("propriedades do mapeamento", () => {
  it("toda sugestão/opção é permitida no contexto e bate com o idDest", () => {
    const originais = ["5101", "5102", "5403", "5405", "5401", "5949", "5929", "5117", "6101", "6102", "6107", "6108",
      "6401", "6403", "6404", "6949", "6929", "7101", "7102", "1102", "2102", "1403", "2403", "1556", "1551", "1101", "3102"];
    for (const tipo of ["VENDA_ENTRADA", "COMPRA_SAIDA"] as const) {
      for (const idDest of [1, 2, 3] as const) {
        for (const crt of [undefined, "1", "3", "4"] as const) {
          const permitidos = cfopsPermitidosDevolucao({ tipo, idDest, crt });
          const tpNF = tipo === "VENDA_ENTRADA" ? "0" : "1";
          for (const cfopOriginal of originais) {
            const r = mapearCfopDevolucao({ cfopOriginal, tipo, idDestOriginal: idDest, crt });
            if (r.status === "MAPEADO") {
              expect(r.opcoes).toEqual([r.cfop]);
            } else {
              expect(r.cfop).toBeNull();
            }
            for (const c of [...r.opcoes, ...(r.cfop ? [r.cfop] : [])]) {
              expect(permitidos).toContain(c);
              expect(isCfopPermitidoEmDevolucao(c, tpNF)).toBe(true);
              expect(validarCfopVsIdDest(c, idDest)).toBe(true);
            }
          }
        }
      }
    }
  });
});
