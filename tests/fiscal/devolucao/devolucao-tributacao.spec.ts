import { describe, expect, it } from "vitest";

import {
  aplicarOverrideTributacao,
  crtDeRegime,
  normalizarImpostoOriginal,
  proporcionalizar,
  round2,
  tagCompativelComCrt,
  tagIcmsParaDevolucao,
} from "../../../app/fiscal/devolucao/tributacao";

// Formato do fast-xml-parser com parseTagValue:false (tudo texto), como em parseNfeXml.
const RAW_SN102 = {
  ICMS: { ICMSSN102: { orig: "0", CSOSN: "102" } },
  PIS: { PISOutr: { CST: "49", vBC: "0.00", pPIS: "0.00", vPIS: "0.00" } },
  COFINS: { COFINSOutr: { CST: "49", vBC: "0.00", pCOFINS: "0.00", vCOFINS: "0.00" } },
};

const RAW_LP = {
  ICMS: { ICMS00: { orig: "1", CST: "00", modBC: "3", vBC: "300.00", pICMS: "18.00", vICMS: "54.00" } },
  IPI: { cEnq: "999", IPITrib: { CST: "50", vBC: "300.00", pIPI: "10.00", vIPI: "30.00" } },
  PIS: { PISAliq: { CST: "01", vBC: "300.00", pPIS: "1.65", vPIS: "4.95" } },
  COFINS: { COFINSAliq: { CST: "01", vBC: "300.00", pCOFINS: "7.60", vCOFINS: "22.80" } },
};

// PIS/COFINS com CST de ENTRADA (98), para os casos que não devem acender o aviso de CST de saída.
const PIS_ENTRADA = { PISOutr: { CST: "98", vBC: "0.00", pPIS: "0.00", vPIS: "0.00" } };
const COFINS_ENTRADA = { COFINSOutr: { CST: "98", vBC: "0.00", pCOFINS: "0.00", vCOFINS: "0.00" } };

describe("normalizarImpostoOriginal", () => {
  it("SN102 + PISOutr/COFINSOutr", () => {
    expect(normalizarImpostoOriginal(RAW_SN102)).toEqual({
      icms: { grupo: "ICMSSN102", orig: 0, csosn: "102" },
      ipi: null,
      pis: { grupo: "PISOutr", cst: "49", vBC: 0, pPIS: 0, vPIS: 0 },
      cofins: { grupo: "COFINSOutr", cst: "49", vBC: 0, pCOFINS: 0, vCOFINS: 0 },
      temIbsCbs: false,
    });
  });

  it("ICMS00 + IPITrib + PISAliq", () => {
    const n = normalizarImpostoOriginal(RAW_LP);
    expect(n.icms).toEqual({ grupo: "ICMS00", orig: 1, cst: "00", modBC: "3", vBC: 300, pICMS: 18, vICMS: 54 });
    expect(n.ipi).toEqual({ grupo: "IPITrib", cst: "50", cEnq: "999", vBC: 300, pIPI: 10, vIPI: 30 });
    expect(n.pis).toEqual({ grupo: "PISAliq", cst: "01", vBC: 300, pPIS: 1.65, vPIS: 4.95 });
    expect(n.cofins?.pCOFINS).toBe(7.6);
  });

  it("robusto: valores number (CST 0 → '00'), arrays, #text, IPINT, PISNT, IBSCBS", () => {
    const n = normalizarImpostoOriginal({
      ICMS: [{ ICMS40: { orig: 0, CST: 41 } }],
      IPI: { cEnq: 999, IPINT: { CST: "53" } },
      PIS: { PISNT: { CST: { "#text": "07" } } },
      COFINS: { COFINSNT: { CST: 7 } },
      IBSCBS: { CST: "000" },
    });
    expect(n.icms).toEqual({ grupo: "ICMS40", orig: 0, cst: "41" });
    expect(n.ipi).toEqual({ grupo: "IPINT", cst: "53", cEnq: "999" });
    expect(n.pis).toEqual({ grupo: "PISNT", cst: "07" });
    expect(n.cofins).toEqual({ grupo: "COFINSNT", cst: "07" });
    expect(n.temIbsCbs).toBe(true);
    expect(normalizarImpostoOriginal({ ICMS: { ICMS00: { CST: 0, orig: "0" } } }).icms?.cst).toBe("00");
  });

  it("nulo/ausente e idempotência", () => {
    expect(normalizarImpostoOriginal(null)).toEqual({ icms: null, ipi: null, pis: null, cofins: null, temIbsCbs: false });
    const uma = normalizarImpostoOriginal(RAW_LP);
    expect(normalizarImpostoOriginal(uma)).toEqual(uma);
    expect(normalizarImpostoOriginal(JSON.parse(JSON.stringify(uma)))).toEqual(uma);
  });
});

describe("tagIcmsParaDevolucao (allowlist §6.4)", () => {
  it.each([
    ["102", "ICMSSN102"],
    ["103", "ICMSSN102"],
    ["300", "ICMSSN102"],
    ["400", "ICMSSN102"],
    ["500", "ICMSSN500"],
    ["900", "ICMSSN900"],
    ["101", null],
    ["201", null],
    ["202", null],
    ["203", null],
  ])("CSOSN %s → %s", (csosn, tag) => {
    expect(tagIcmsParaDevolucao({ crt: "1", csosn })).toBe(tag);
    expect(tagIcmsParaDevolucao({ crt: "4", csosn })).toBe(tag);
  });

  it.each([
    ["00", "ICMS00"],
    ["40", "ICMS40"],
    ["41", "ICMS40"],
    ["50", "ICMS40"],
    ["60", "ICMS60"],
    ["90", "ICMS90"],
    ["10", null],
    ["20", null],
    ["30", null],
    ["51", null],
    ["70", null],
  ])("CST %s → %s", (cst, tag) => {
    expect(tagIcmsParaDevolucao({ crt: "3", cst })).toBe(tag);
    expect(tagIcmsParaDevolucao({ crt: "2", cst })).toBe(tag);
  });

  it("família do CRT precisa bater; sem CRT decide pelo código", () => {
    expect(tagIcmsParaDevolucao({ crt: "3", csosn: "102" })).toBeNull();
    expect(tagIcmsParaDevolucao({ crt: "1", cst: "00" })).toBeNull();
    expect(tagIcmsParaDevolucao({ csosn: "400" })).toBe("ICMSSN102");
    expect(tagIcmsParaDevolucao({ cst: "41" })).toBe("ICMS40");
    expect(tagIcmsParaDevolucao({})).toBeNull();
    expect(tagCompativelComCrt("ICMSSN102", "3")).toBe(false);
    expect(tagCompativelComCrt("ICMS00", "3")).toBe(true);
    expect(crtDeRegime("SIMPLES")).toBe("1");
    expect(crtDeRegime("LUCRO_REAL")).toBe("3");
    expect(crtDeRegime(null)).toBeNull();
  });
});

describe("round2 (meio-para-cima)", () => {
  it("absorve o erro binário", () => {
    expect(round2(1.005)).toBe(1.01);
    expect(round2(2.675)).toBe(2.68);
    expect(round2(0.025)).toBe(0.03);
    expect(round2(3.3349)).toBe(3.33);
    expect(round2(Number.NaN)).toBe(0);
  });
});

describe("proporcionalizar", () => {
  it("SN102 do mesmo regime: sem revisão, zeros", () => {
    const t = proporcionalizar({
      impostoOriginal: normalizarImpostoOriginal(RAW_SN102),
      qOriginal: 2,
      qDevolvida: 1,
      vUnCom: 150,
      crtEmitente: "1",
      crtOriginal: "1",
    });
    expect(t).toEqual({
      versao: 1,
      fonte: "XML_ORIGINAL",
      icms: { tag: "ICMSSN102", cst: null, csosn: "102", orig: 0, modBC: null, vBC: 0, pICMS: 0, vICMS: 0 },
      pis: { cst: "49", vBC: 0, p: 0, v: 0 },
      cofins: { cst: "49", vBC: 0, p: 0, v: 0 },
      ipiDevol: null,
      requerRevisao: false,
      motivosRevisao: [],
      avisos: [],
      confirmada: false,
    });
  });

  it("ICMS00/PIS/COFINS/IPI proporcionais (1 de 3) e flags", () => {
    const t = proporcionalizar({
      impostoOriginal: normalizarImpostoOriginal(RAW_LP),
      qOriginal: "3.0000",
      qDevolvida: 1,
      vUnCom: 100,
      crtEmitente: "3",
      crtOriginal: "3",
    });
    expect(t.icms).toEqual({ tag: "ICMS00", cst: "00", csosn: null, orig: 1, modBC: "3", vBC: 100, pICMS: 18, vICMS: 18 });
    expect(t.pis).toEqual({ cst: "01", vBC: 100, p: 1.65, v: 1.65 });
    expect(t.cofins).toEqual({ cst: "01", vBC: 100, p: 7.6, v: 7.6 });
    expect(t.ipiDevol).toEqual({ pDevol: 33.33, vIPIDevol: 10 });
    expect(t.requerRevisao).toBe(true);
    expect(t.motivosRevisao).toEqual(expect.arrayContaining(["IPI_DESTACADO", "PIS_CST_SAIDA_EM_ENTRADA"]));
    expect(t.avisos).toContain("PIS_CST_SAIDA_EM_ENTRADA");
  });

  it("devolução integral copia os valores sem deriva", () => {
    const t = proporcionalizar({
      impostoOriginal: normalizarImpostoOriginal(RAW_LP),
      qOriginal: 3,
      qDevolvida: 3,
      vUnCom: 100,
      crtEmitente: "3",
      crtOriginal: "3",
    });
    expect(t.icms.vBC).toBe(300);
    expect(t.icms.vICMS).toBe(54);
    expect(t.ipiDevol).toEqual({ pDevol: 100, vIPIDevol: 30 });
  });

  it("arredondamento proporcional meio-para-cima, parcelas somam o original ± 1 centavo", () => {
    const imp = normalizarImpostoOriginal({
      ICMS: { ICMS00: { orig: "0", CST: "00", modBC: "3", vBC: "10.01", pICMS: "12.00", vICMS: "1.20" } },
      PIS: PIS_ENTRADA,
      COFINS: COFINS_ENTRADA,
    });
    const um = proporcionalizar({ impostoOriginal: imp, qOriginal: 3, qDevolvida: 1, vUnCom: 3.3367, crtEmitente: "3", crtOriginal: "3" });
    const dois = proporcionalizar({ impostoOriginal: imp, qOriginal: 3, qDevolvida: 2, vUnCom: 3.3367, crtEmitente: "3", crtOriginal: "3" });
    expect(um.icms.vBC).toBe(3.34);
    expect(dois.icms.vBC).toBe(6.67);
    expect(um.icms.vICMS).toBe(0.4);
    expect(dois.icms.vICMS).toBe(0.8);
    expect(Math.abs(round2(um.icms.vBC + dois.icms.vBC) - 10.01)).toBeLessThanOrEqual(0.01);
    expect(um.pis).toEqual({ cst: "98", vBC: 0, p: 0, v: 0 });
    expect(um.requerRevisao).toBe(false);

    const meio = proporcionalizar({
      impostoOriginal: normalizarImpostoOriginal({
        ICMS: { ICMS00: { orig: "0", CST: "00", modBC: "3", vBC: "0.05", pICMS: "10.00", vICMS: "0.01" } },
        PIS: { PISNT: { CST: "04" } },
        COFINS: { COFINSNT: { CST: "04" } },
      }),
      qOriginal: 2,
      qDevolvida: 1,
      vUnCom: 0.025,
      crtEmitente: "3",
      crtOriginal: "3",
    });
    expect(meio.icms.vBC).toBe(0.03);
    expect(meio.icms.vICMS).toBe(0.01);
  });

  it("ICMSSN900 com valores; ICMS60 e ICMS40 (CST 41) sem valores", () => {
    const sn900 = proporcionalizar({
      impostoOriginal: normalizarImpostoOriginal({
        ICMS: { ICMSSN900: { orig: "0", CSOSN: "900", modBC: "3", vBC: "200.00", pICMS: "12.00", vICMS: "24.00" } },
        PIS: RAW_SN102.PIS,
        COFINS: RAW_SN102.COFINS,
      }),
      qOriginal: 2,
      qDevolvida: 1,
      vUnCom: 100,
      crtEmitente: "1",
      crtOriginal: "1",
    });
    expect(sn900.icms).toMatchObject({ tag: "ICMSSN900", csosn: "900", modBC: "3", vBC: 100, pICMS: 12, vICMS: 12 });
    expect(sn900.requerRevisao).toBe(false);

    const i60 = proporcionalizar({
      impostoOriginal: normalizarImpostoOriginal({
        ICMS: { ICMS60: { orig: "0", CST: "60", vBCSTRet: "0.00", vICMSSTRet: "0.00" } },
        PIS: PIS_ENTRADA,
        COFINS: COFINS_ENTRADA,
      }),
      qOriginal: 1,
      qDevolvida: 1,
      vUnCom: 10,
      crtEmitente: "3",
      crtOriginal: "3",
    });
    expect(i60.icms).toMatchObject({ tag: "ICMS60", vBC: 0, vICMS: 0 });
    expect(i60.requerRevisao).toBe(false);

    const i41 = proporcionalizar({
      impostoOriginal: normalizarImpostoOriginal({ ICMS: { ICMS40: { orig: "0", CST: "41" } }, PIS: { PISNT: { CST: "06" } }, COFINS: { COFINSNT: { CST: "06" } } }),
      qOriginal: 1,
      qDevolvida: 1,
      vUnCom: 10,
      crtEmitente: "3",
      crtOriginal: "3",
    });
    expect(i41.icms.tag).toBe("ICMS40");
    expect(i41.icms.cst).toBe("41");
  });

  it("fora da allowlist, ST e base reduzida exigem revisão (nada inventado)", () => {
    const st = proporcionalizar({
      impostoOriginal: normalizarImpostoOriginal({
        ICMS: { ICMS10: { orig: "0", CST: "10", modBC: "3", vBC: "100", pICMS: "18", vICMS: "18", vBCST: "130", vICMSST: "5.40" } },
        PIS: RAW_LP.PIS,
        COFINS: RAW_LP.COFINS,
      }),
      qOriginal: 1,
      qDevolvida: 1,
      vUnCom: 100,
      crtEmitente: "3",
      crtOriginal: "3",
    });
    expect(st.icms.tag).toBeNull();
    expect(st.icms.vBC).toBe(0);
    expect(st.motivosRevisao).toEqual(expect.arrayContaining(["ICMS_GRUPO_NAO_SUPORTADO", "ICMS_ST_NAO_SUPORTADO"]));

    const red = proporcionalizar({
      impostoOriginal: normalizarImpostoOriginal({
        ICMS: { ICMS90: { orig: "0", CST: "90", modBC: "3", vBC: "60", pRedBC: "40", pICMS: "18", vICMS: "10.80" } },
        PIS: { PISNT: { CST: "04" } },
        COFINS: { COFINSNT: { CST: "04" } },
      }),
      qOriginal: 1,
      qDevolvida: 1,
      vUnCom: 100,
      crtEmitente: "3",
      crtOriginal: "3",
    });
    expect(red.motivosRevisao).toContain("ICMS_BASE_REDUZIDA");

    const sn101 = proporcionalizar({
      impostoOriginal: normalizarImpostoOriginal({ ICMS: { ICMSSN101: { orig: "0", CSOSN: "101", pCredSN: "2", vCredICMSSN: "1" } }, PIS: RAW_SN102.PIS, COFINS: RAW_SN102.COFINS }),
      qOriginal: 1,
      qDevolvida: 1,
      vUnCom: 50,
      crtEmitente: "1",
      crtOriginal: "1",
    });
    expect(sn101.motivosRevisao).toEqual(["ICMS_GRUPO_NAO_SUPORTADO"]);

    const i00SemValores = proporcionalizar({
      impostoOriginal: normalizarImpostoOriginal({ ICMS: { ICMS00: { orig: "0", CST: "00" } }, PIS: PIS_ENTRADA, COFINS: COFINS_ENTRADA }),
      qOriginal: 1,
      qDevolvida: 1,
      vUnCom: 50,
      crtEmitente: "3",
      crtOriginal: "3",
    });
    expect(i00SemValores.motivosRevisao).toEqual(["ICMS_VALORES_AUSENTES"]);
    expect(i00SemValores.icms.vBC).toBe(0);

    const modBC = proporcionalizar({
      impostoOriginal: normalizarImpostoOriginal({ ICMS: { ICMS00: { orig: "0", CST: "00", modBC: "0", vBC: "10", pICMS: "18", vICMS: "1.80" } }, PIS: { PISNT: { CST: "04" } }, COFINS: { COFINSNT: { CST: "04" } } }),
      qOriginal: 1,
      qDevolvida: 1,
      vUnCom: 10,
      crtEmitente: "3",
      crtOriginal: "3",
    });
    expect(modBC.motivosRevisao).toContain("ICMS_MODBC_NAO_SUPORTADO");
  });

  it("regime divergente (Simples na venda, normal hoje) exige revisão", () => {
    const t = proporcionalizar({
      impostoOriginal: normalizarImpostoOriginal(RAW_SN102),
      qOriginal: 1,
      qDevolvida: 1,
      vUnCom: 10,
      crtEmitente: "3",
      crtOriginal: "1",
    });
    expect(t.icms.tag).toBe("ICMSSN102");
    expect(t.requerRevisao).toBe(true);
    expect(t.motivosRevisao).toEqual(["REGIME_DIVERGENTE"]);
  });

  it("PIS/COFINS: 03 (Qtde) não suportado; CST de saída só avisa em ENTRADA", () => {
    const qtde = proporcionalizar({
      impostoOriginal: normalizarImpostoOriginal({
        ICMS: RAW_SN102.ICMS,
        PIS: { PISQtde: { CST: "03", qBCProd: "1", vAliqProd: "0.5", vPIS: "0.5" } },
        COFINS: RAW_SN102.COFINS,
      }),
      qOriginal: 1,
      qDevolvida: 1,
      vUnCom: 10,
      crtEmitente: "1",
      crtOriginal: "1",
    });
    expect(qtde.motivosRevisao).toEqual(["PIS_NAO_SUPORTADO"]);

    const saida = proporcionalizar({
      impostoOriginal: normalizarImpostoOriginal(RAW_LP),
      qOriginal: 3,
      qDevolvida: 1,
      vUnCom: 100,
      crtEmitente: "3",
      crtOriginal: "3",
      tipoOperacao: "SAIDA",
    });
    expect(saida.avisos).not.toContain("PIS_CST_SAIDA_EM_ENTRADA");
    expect(saida.motivosRevisao).toEqual(["IPI_DESTACADO"]);

    const semPis = proporcionalizar({
      impostoOriginal: { ...normalizarImpostoOriginal(RAW_SN102), pis: null },
      qOriginal: 1,
      qDevolvida: 1,
      vUnCom: 10,
      crtEmitente: "1",
      crtOriginal: "1",
    });
    expect(semPis.motivosRevisao).toEqual(["PIS_AUSENTE"]);
  });

  it("sem XML ⇒ tudo zerado e revisão; quantidade original desconhecida ⇒ base do item + revisão", () => {
    const semXml = proporcionalizar({ impostoOriginal: null, qOriginal: null, qDevolvida: 1, vUnCom: 10 });
    expect(semXml.fonte).toBe("SEM_XML");
    expect(semXml.requerRevisao).toBe(true);
    expect(semXml.motivosRevisao).toEqual(["SEM_XML"]);
    expect(semXml.icms.tag).toBeNull();

    const semQ = proporcionalizar({
      impostoOriginal: normalizarImpostoOriginal(RAW_LP),
      qOriginal: null,
      qDevolvida: 2,
      vUnCom: 100,
      crtEmitente: "3",
      crtOriginal: "3",
    });
    expect(semQ.motivosRevisao[0]).toBe("QUANTIDADE_ORIGINAL_DESCONHECIDA");
    expect(semQ.icms.vBC).toBe(200);
    expect(semQ.icms.vICMS).toBe(36);
    expect(semQ.ipiDevol).toBeNull();
  });

  it("PISNT com CST de saída (07) numa ENTRADA: aviso e revisão, valores zerados", () => {
    const t = proporcionalizar({
      impostoOriginal: normalizarImpostoOriginal({ ICMS: RAW_SN102.ICMS, PIS: { PISNT: { CST: "07" } }, COFINS: { COFINSNT: { CST: "07" } } }),
      qOriginal: 1,
      qDevolvida: 1,
      vUnCom: 10,
      crtEmitente: "1",
      crtOriginal: "1",
    });
    expect(t.pis).toEqual({ cst: "07", vBC: 0, p: 0, v: 0 });
    expect(t.avisos).toEqual(["PIS_CST_SAIDA_EM_ENTRADA"]);
    expect(t.motivosRevisao).toEqual(["PIS_CST_SAIDA_EM_ENTRADA"]);
    expect(t.requerRevisao).toBe(true);
  });

  it("IBS/CBS presente vira aviso, sem revisão", () => {
    const t = proporcionalizar({
      impostoOriginal: normalizarImpostoOriginal({ ...RAW_SN102, IBSCBS: { CST: "000" } }),
      qOriginal: 1,
      qDevolvida: 1,
      vUnCom: 10,
      crtEmitente: "1",
      crtOriginal: "1",
    });
    expect(t.avisos).toEqual(["IBS_CBS_NAO_ENVIADO"]);
    expect(t.requerRevisao).toBe(false);
  });
});

describe("aplicarOverrideTributacao", () => {
  const baseSn = () =>
    proporcionalizar({
      impostoOriginal: normalizarImpostoOriginal(RAW_SN102),
      qOriginal: 1,
      qDevolvida: 1,
      vUnCom: 100,
      crtEmitente: "1",
      crtOriginal: "3",
    });

  it("só confirmação: marca confirmada, não muda valores", () => {
    const base = baseSn();
    const r = aplicarOverrideTributacao({ base, confirmar: true, crtEmitente: "1", baseCalculoItem: 100 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tributacao).toEqual({ ...base, confirmada: true });
    expect(base.confirmada).toBe(false);
  });

  it("CSOSN 900 com alíquota: calcula sobre a base do item, fonte USUARIO, exige confirmação", () => {
    const r = aplicarOverrideTributacao({
      base: baseSn(),
      override: { icms: { csosn: "900", pICMS: 12 } },
      confirmar: false,
      crtEmitente: "1",
      baseCalculoItem: 100,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tributacao.icms).toEqual({ tag: "ICMSSN900", cst: null, csosn: "900", orig: 0, modBC: "3", vBC: 100, pICMS: 12, vICMS: 12 });
    expect(r.tributacao.fonte).toBe("USUARIO");
    expect(r.tributacao.requerRevisao).toBe(true);
    expect(r.tributacao.confirmada).toBe(false);
    expect(r.tributacao.motivosRevisao).toContain("ALTERADA_PELO_USUARIO");
  });

  it("recusa grupo fora da allowlist, família errada e alíquota inválida", () => {
    expect(aplicarOverrideTributacao({ base: baseSn(), override: { icms: { csosn: "101" } }, crtEmitente: "1", baseCalculoItem: 1 }).ok).toBe(false);
    expect(aplicarOverrideTributacao({ base: baseSn(), override: { icms: { cst: "00", pICMS: 18 } }, crtEmitente: "1", baseCalculoItem: 1 }).ok).toBe(false);
    expect(aplicarOverrideTributacao({ base: baseSn(), override: { icms: { csosn: "900", pICMS: 150 } }, crtEmitente: "1", baseCalculoItem: 1 }).ok).toBe(false);
    expect(aplicarOverrideTributacao({ base: baseSn(), override: { pis: { cst: "03" } }, crtEmitente: "1", baseCalculoItem: 1 }).ok).toBe(false);
    expect(aplicarOverrideTributacao({ base: baseSn(), override: { icms: { csosn: "900", modBC: "0", pICMS: 1 } }, crtEmitente: "1", baseCalculoItem: 1 }).ok).toBe(false);
  });

  it("PIS/COFINS: troca de CST e alíquota recalcula; ipiDevol false remove o grupo", () => {
    const lp = proporcionalizar({
      impostoOriginal: normalizarImpostoOriginal(RAW_LP),
      qOriginal: 3,
      qDevolvida: 1,
      vUnCom: 100,
      crtEmitente: "3",
      crtOriginal: "3",
    });
    const r = aplicarOverrideTributacao({
      base: lp,
      override: { pis: { cst: "98", p: 0.65 }, cofins: { cst: "70" }, ipiDevol: false },
      confirmar: true,
      crtEmitente: "3",
      baseCalculoItem: 100,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tributacao.pis).toEqual({ cst: "98", vBC: 100, p: 0.65, v: 0.65 });
    expect(r.tributacao.cofins).toEqual({ cst: "70", vBC: 100, p: 7.6, v: 7.6 });
    expect(r.tributacao.ipiDevol).toBeNull();
    expect(r.tributacao.avisos).not.toContain("PIS_CST_SAIDA_EM_ENTRADA");
    expect(r.tributacao.confirmada).toBe(true);
  });
});
