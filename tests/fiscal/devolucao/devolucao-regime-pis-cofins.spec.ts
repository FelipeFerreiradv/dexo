/**
 * PIS/COFINS da devolução conhecem o REGIME da empresa e o TIPO da devolução —
 * no mesmo molde do ICMS do PR #373.
 *
 * Caso real (DLS AUTO PEÇAS, Simples Nacional, 24/09/2026): devolução de COMPRA
 * à DISAUTO (regime normal). O item 33603-3 nasceu com o PIS/COFINS do
 * fornecedor — CST 01 a 1,65%/7,6% sobre a base dele (R$ 108,73 = 123,56 menos o
 * ICMS). O campo era texto livre; ela ficou 70 minutos chutando 01 → 49 → 01 →
 * 49, chegou a gravar COFINS a 1,64%, e trocar para 49 sem digitar a alíquota
 * gravava 49 a 1,65% sobre a base do fornecedor. Nada disso a SEFAZ recusa: a
 * nota sairia AUTORIZADA com PIS/COFINS de regime normal numa empresa do Simples.
 *
 * Decisões do dono que estes testes prendem:
 *  - 01/02 (alíquota do regime normal) numa empresa do Simples é RECUSADO, como
 *    o ICMS de outro regime;
 *  - emitente do Simples não herda alíquota nem base de PIS/COFINS de nota de
 *    outra família de regime;
 *  - o Dexo nunca escolhe o código por ela.
 */
import { describe, expect, it } from "vitest";

import {
  PIS_COFINS_CST_SUPORTADOS,
  ROTULOS_PIS_COFINS_DEVOLUCAO,
  aplicarOverrideTributacao,
  checarCodigoIcmsDevolucao,
  checarCstPisCofinsDevolucao,
  familiaPisCofinsDoCrt,
  normalizarImpostoOriginal,
  opcoesPisCofinsDevolucao,
  proporcionalizar,
  regimeEmitenteDevolucao,
  sentidoCstPisCofins,
} from "../../../app/fiscal/devolucao/tributacao";
import type { CstPisCofinsDevolucao } from "../../../app/fiscal/devolucao/tipos";

const codigos = (crt: string | null, tipo?: "VENDA_ENTRADA" | "COMPRA_SAIDA") =>
  opcoesPisCofinsDevolucao({ crt, tipo }).map((o) => o.codigo);

/** Todos os CSTs digitáveis: 1 e 2 dígitos. */
const DIGITADOS: string[] = [];
for (let n = 0; n < 100; n++) DIGITADOS.push(String(n), String(n).padStart(2, "0"));

// A nota de compra da DISAUTO, item 5 (33603-3), como veio no XML (regime normal).
const DISAUTO_ITEM5 = normalizarImpostoOriginal({
  ICMS: { ICMS00: { orig: "0", CST: "00", modBC: "3", vBC: "123.56", pICMS: "12.00", vICMS: "14.83" } },
  PIS: { PISAliq: { CST: "01", vBC: "108.73", pPIS: "1.65", vPIS: "1.79" } },
  COFINS: { COFINSAliq: { CST: "01", vBC: "108.73", pCOFINS: "7.60", vCOFINS: "8.26" } },
});

// Item 6 (24171-7): PIS/COFINS 04 (monofásico) na DISAUTO.
const DISAUTO_ITEM6 = normalizarImpostoOriginal({
  ICMS: { ICMS00: { orig: "0", CST: "00", modBC: "3", vBC: "295.88", pICMS: "12.00", vICMS: "35.51" } },
  PIS: { PISNT: { CST: "04" } },
  COFINS: { COFINSNT: { CST: "04" } },
});

const baseDls = (imposto = DISAUTO_ITEM5, vUnCom = 123.56) =>
  proporcionalizar({
    impostoOriginal: imposto,
    qOriginal: 1,
    qDevolvida: 1,
    vUnCom,
    crtEmitente: "1",
    crtOriginal: "3",
    tipoOperacao: "SAIDA",
  });

describe("sincronia servidor ⇄ seletor de PIS/COFINS (os dois sentidos)", () => {
  it("→ todo CST que o servidor aceita tem rótulo", () => {
    for (const c of PIS_COFINS_CST_SUPORTADOS) {
      expect(ROTULOS_PIS_COFINS_DEVOLUCAO[c as CstPisCofinsDevolucao], `CST ${c} aceito e SEM rótulo`).toBeDefined();
    }
  });

  it("← todo rótulo é de um CST que o servidor aceita (nenhum órfão)", () => {
    for (const c of Object.keys(ROTULOS_PIS_COFINS_DEVOLUCAO)) {
      expect(PIS_COFINS_CST_SUPORTADOS.has(c), `rótulo de ${c}, que o servidor NÃO aceita`).toBe(true);
    }
    expect(Object.keys(ROTULOS_PIS_COFINS_DEVOLUCAO).sort()).toEqual([...PIS_COFINS_CST_SUPORTADOS].sort());
  });

  it("cada rótulo começa pelo número e é único", () => {
    const vistos = new Set<string>();
    for (const [c, r] of Object.entries(ROTULOS_PIS_COFINS_DEVOLUCAO)) {
      expect(r.startsWith(`${c} — `)).toBe(true);
      expect(r.length).toBeGreaterThan(c.length + 8);
      expect(vistos.has(r)).toBe(false);
      vistos.add(r);
    }
    // 03 e 05 continuam FORA: o montador não os emite no grupo certo.
    expect(ROTULOS_PIS_COFINS_DEVOLUCAO).not.toHaveProperty("03");
    expect(ROTULOS_PIS_COFINS_DEVOLUCAO).not.toHaveProperty("05");
  });

  it("o triângulo fecha: opção oferecida ⇔ código que o juiz aceita, para todo CRT e todo tipo", () => {
    for (const crt of ["1", "2", "3", "4", null] as const) {
      for (const tipo of ["VENDA_ENTRADA", "COMPRA_SAIDA", undefined] as const) {
        const oferecidos = new Set(codigos(crt, tipo));
        for (const d of DIGITADOS) {
          const r = checarCstPisCofinsDevolucao({ crt, tipo, codigo: d });
          const normal = d.padStart(2, "0");
          expect(r.ok, `${crt}/${tipo}/${d}`).toBe(oferecidos.has(normal));
          if (r.ok) expect(r.codigo).toBe(normal);
        }
      }
    }
  });
});

describe("opcoesPisCofinsDevolucao — o regime tira, o tipo ordena", () => {
  it("Simples (CRT 1 e 4) não recebe 01 nem 02; regime normal e sem regime recebem os 31", () => {
    for (const crt of ["1", "4"]) {
      expect(codigos(crt)).not.toContain("01");
      expect(codigos(crt)).not.toContain("02");
      expect(codigos(crt)).toHaveLength(29);
    }
    expect(codigos("3")).toHaveLength(31);
    expect(codigos(null)).toHaveLength(31);
    // CRT 2 (Simples acima do sublimite) recolhe PIS/COFINS no DAS: família SN.
    expect(familiaPisCofinsDoCrt("2")).toBe("SN");
    expect(codigos("2")).not.toContain("01");
  });

  it("devolução de COMPRA no Simples: 49, 04 e 99 no topo; os de entrada por último", () => {
    const o = opcoesPisCofinsDevolucao({ crt: "1", tipo: "COMPRA_SAIDA" });
    expect(o.slice(0, 3).map((x) => x.codigo)).toEqual(["49", "04", "99"]);
    expect(o.filter((x) => x.usual).map((x) => x.codigo)).toEqual(["49", "04", "99", "06", "07", "08", "09"]);
    const primeiroDeEntrada = o.findIndex((x) => x.sentido === "ENTRADA");
    expect(o.slice(primeiroDeEntrada).every((x) => x.sentido === "ENTRADA" && !x.doSentidoDaNota)).toBe(true);
  });

  it("devolução de VENDA no Simples: 98 e 99 no topo; o 49 herdado continua NA LISTA (ordena, não filtra)", () => {
    const o = opcoesPisCofinsDevolucao({ crt: "1", tipo: "VENDA_ENTRADA" });
    expect(o.slice(0, 2).map((x) => x.codigo)).toEqual(["98", "99"]);
    const q49 = o.find((x) => x.codigo === "49");
    expect(q49).toBeDefined();
    expect(q49?.doSentidoDaNota).toBe(false);
  });

  it("exigeAliquota: só os grupos sem valor (04, 06–09) não pedem alíquota", () => {
    const sem = opcoesPisCofinsDevolucao({ crt: "3" }).filter((o) => !o.exigeAliquota).map((o) => o.codigo);
    expect(sem).toEqual(["04", "06", "07", "08", "09"]);
  });

  it("sem tipo: ordem numérica, tudo 'do sentido', nada 'usual' (retrocompatível)", () => {
    const o = opcoesPisCofinsDevolucao({ crt: "3" });
    expect(o.map((x) => x.codigo)).toEqual([...o.map((x) => x.codigo)].sort());
    expect(o.every((x) => x.doSentidoDaNota && !x.usual)).toBe(true);
  });

  it("o sentido segue a tabela oficial: 01–49 saída, 50–98 entrada, 99 os dois", () => {
    expect(sentidoCstPisCofins("01")).toBe("SAIDA");
    expect(sentidoCstPisCofins("49")).toBe("SAIDA");
    expect(sentidoCstPisCofins("50")).toBe("ENTRADA");
    expect(sentidoCstPisCofins("98")).toBe("ENTRADA");
    expect(sentidoCstPisCofins("99")).toBe("AMBOS");
    expect(sentidoCstPisCofins(null)).toBeNull();
    expect(sentidoCstPisCofins("1")).toBeNull();
  });
});

describe("checarCstPisCofinsDevolucao — recusa na hora, com o motivo", () => {
  it("o caso da DLS: Simples + 01 recusa por REGIME, dizendo que é do regime normal", () => {
    const r = checarCstPisCofinsDevolucao({ crt: "1", tipo: "COMPRA_SAIDA", codigo: "01" });
    if (r.ok) throw new Error("deveria recusar");
    expect(r.causa).toBe("REGIME");
    expect(r.motivo).toContain("CST 01");
    expect(r.motivo).toContain("regime normal");
    expect(r.motivo).toContain("Simples Nacional");
    expect(checarCstPisCofinsDevolucao({ crt: "1", codigo: "02" })).toMatchObject({ ok: false, causa: "REGIME" });
    // O mesmo 01 serve no regime normal.
    expect(checarCstPisCofinsDevolucao({ crt: "3", codigo: "01" }).ok).toBe(true);
  });

  it("vazio, formato e fora da lista (03 e 05 dizem por quê)", () => {
    expect(checarCstPisCofinsDevolucao({ crt: "1", codigo: "  " })).toMatchObject({ ok: false, causa: "VAZIO" });
    expect(checarCstPisCofinsDevolucao({ crt: "1", codigo: null })).toMatchObject({ ok: false, causa: "VAZIO" });
    expect(checarCstPisCofinsDevolucao({ crt: "1", codigo: "049" })).toMatchObject({ ok: false, causa: "FORMATO" });
    expect(checarCstPisCofinsDevolucao({ crt: "1", codigo: "4a" })).toMatchObject({ ok: false, causa: "FORMATO" });
    const q = checarCstPisCofinsDevolucao({ crt: "3", codigo: "03" });
    if (q.ok) throw new Error("deveria recusar");
    expect(q.causa).toBe("NAO_SUPORTADO");
    expect(q.motivo).toContain("por quantidade");
    expect(q.motivo).toContain("Escolha na lista");
    const st = checarCstPisCofinsDevolucao({ crt: "3", codigo: "5" });
    if (st.ok) throw new Error("deveria recusar");
    expect(st.codigo).toBe("05");
    expect(st.motivo).toContain("substituição tributária");
    expect(checarCstPisCofinsDevolucao({ crt: "3", codigo: "80" })).toMatchObject({ ok: false, causa: "NAO_SUPORTADO" });
  });

  it("normaliza o zero à esquerda ('4' → '04') e diz se pede alíquota", () => {
    expect(checarCstPisCofinsDevolucao({ crt: "1", codigo: " 4 " })).toMatchObject({ ok: true, codigo: "04", exigeAliquota: false });
    expect(checarCstPisCofinsDevolucao({ crt: "1", codigo: "49" })).toMatchObject({ ok: true, codigo: "49", exigeAliquota: true });
  });

  it("alíquota: 01/02 nunca a zero (é o 06); fora de 0–100 recusa; ausente não confere", () => {
    const zero = checarCstPisCofinsDevolucao({ crt: "3", codigo: "01", p: 0 });
    if (zero.ok) throw new Error("deveria recusar");
    expect(zero.causa).toBe("ALIQUOTA");
    expect(zero.motivo).toContain("06");
    expect(checarCstPisCofinsDevolucao({ crt: "3", codigo: "02", p: 0 })).toMatchObject({ ok: false, causa: "ALIQUOTA" });
    expect(checarCstPisCofinsDevolucao({ crt: "3", codigo: "01", p: 1.65 }).ok).toBe(true);
    expect(checarCstPisCofinsDevolucao({ crt: "3", codigo: "49", p: 150 })).toMatchObject({ ok: false, causa: "ALIQUOTA" });
    expect(checarCstPisCofinsDevolucao({ crt: "3", codigo: "49", p: 0 }).ok).toBe(true);
    expect(checarCstPisCofinsDevolucao({ crt: "3", codigo: "01" }).ok).toBe(true);
    // Grupo sem valor ignora a alíquota.
    expect(checarCstPisCofinsDevolucao({ crt: "3", codigo: "04", p: 150 }).ok).toBe(true);
  });

  it("sentido oposto AVISA e não recusa — nas duas direções, e o 49 é de saída", () => {
    const e49 = checarCstPisCofinsDevolucao({ crt: "1", tipo: "VENDA_ENTRADA", codigo: "49" });
    expect(e49).toMatchObject({ ok: true, aviso: "PIS_CST_SAIDA_EM_ENTRADA" });
    if (e49.ok) expect(e49.avisoTexto).toContain("Não impede a emissão");
    expect(checarCstPisCofinsDevolucao({ crt: "3", tipo: "ENTRADA", codigo: "01" })).toMatchObject({ ok: true, aviso: "PIS_CST_SAIDA_EM_ENTRADA" });
    expect(checarCstPisCofinsDevolucao({ crt: "1", tipo: "COMPRA_SAIDA", codigo: "98" })).toMatchObject({ ok: true, aviso: "PIS_CST_ENTRADA_EM_SAIDA" });
    expect(checarCstPisCofinsDevolucao({ crt: "1", tipo: "COMPRA_SAIDA", codigo: "49" })).toMatchObject({ ok: true, aviso: null, avisoTexto: "" });
    expect(checarCstPisCofinsDevolucao({ crt: "1", tipo: "VENDA_ENTRADA", codigo: "99" })).toMatchObject({ ok: true, aviso: null });
    expect(checarCstPisCofinsDevolucao({ crt: "1", codigo: "49" })).toMatchObject({ ok: true, aviso: null });
  });
});

describe("regimeEmitenteDevolucao — o bloco `emitente` ganha o PIS/COFINS", () => {
  it("SIMPLES + devolução de compra: lista sem 01/02, ordenada, e a ajuda diz que a alíquota do fornecedor não passa", () => {
    const e = regimeEmitenteDevolucao("SIMPLES", "COMPRA_SAIDA");
    expect(e.tipoDevolucao).toBe("COMPRA_SAIDA");
    expect(e.pisCofinsOpcoes?.map((o) => o.codigo)).toEqual(codigos("1", "COMPRA_SAIDA"));
    expect(e.pisCofinsOpcoes?.[0].codigo).toBe("49");
    expect(e.pisCofinsAjuda).toContain("Simples Nacional");
    expect(e.pisCofinsAjuda).toContain("01 e 02");
    expect(e.pisCofinsAjuda).toContain("fornecedor");
    // O ICMS continua igual.
    expect(e.icmsOpcoes.map((o) => o.codigo)).toEqual(["102", "103", "300", "400", "500", "900"]);
  });

  it("chamada antiga, sem o tipo: continua funcionando, lista em ordem numérica", () => {
    const e = regimeEmitenteDevolucao("LUCRO_REAL");
    expect(e.tipoDevolucao).toBeNull();
    expect(e.pisCofinsOpcoes).toHaveLength(31);
    expect(e.pisCofinsAjuda).toContain("regime normal");
    const semRegime = regimeEmitenteDevolucao(null, "VENDA_ENTRADA");
    expect(semRegime.pisCofinsOpcoes).toHaveLength(31);
    expect(semRegime.pisCofinsAjuda).toContain("não está cadastrado");
  });
});

describe("derivação: o Simples não herda o PIS/COFINS do fornecedor do regime normal", () => {
  it("DISAUTO item 5: 01 a 1,65%/7,6% sobre R$ 108,73 nasce 01 SEM valores (e é recusado depois)", () => {
    const t = baseDls();
    expect(t.pis).toEqual({ cst: "01", vBC: 0, p: 0, v: 0 });
    expect(t.cofins).toEqual({ cst: "01", vBC: 0, p: 0, v: 0 });
    // O ICMS não muda: a herança do ICMS na devolução de compra do Simples é a
    // exigida (Res. CGSN 140/2018, art. 59) — só o PIS/COFINS deixou de herdar.
    expect(t.icms).toMatchObject({ tag: "ICMS00", vBC: 123.56, pICMS: 12, vICMS: 14.83 });
  });

  it("regime normal continua herdando (é o estorno do crédito)", () => {
    const t = proporcionalizar({
      impostoOriginal: DISAUTO_ITEM5, qOriginal: 1, qDevolvida: 1, vUnCom: 123.56,
      crtEmitente: "3", crtOriginal: "3", tipoOperacao: "SAIDA",
    });
    expect(t.pis).toEqual({ cst: "01", vBC: 108.73, p: 1.65, v: 1.79 });
    expect(t.cofins).toEqual({ cst: "01", vBC: 108.73, p: 7.6, v: 8.26 });
  });

  it("03, por quantidade e ausente nascem SEM código (a escolha é dela; nada de 03 zerado)", () => {
    const q = proporcionalizar({
      impostoOriginal: normalizarImpostoOriginal({
        ICMS: { ICMSSN102: { orig: "0", CSOSN: "102" } },
        PIS: { PISQtde: { CST: "03", qBCProd: "1", vAliqProd: "0.5", vPIS: "0.5" } },
        COFINS: { COFINSOutr: { CST: "99", qBCProd: "1", vAliqProd: "2", vCOFINS: "2" } },
      }),
      qOriginal: 1, qDevolvida: 1, vUnCom: 10, crtEmitente: "1", crtOriginal: "1",
    });
    expect(q.pis.cst).toBeNull();
    expect(q.cofins.cst).toBeNull();
    expect(q.motivosRevisao).toEqual(expect.arrayContaining(["PIS_NAO_SUPORTADO", "COFINS_NAO_SUPORTADO"]));
  });

  it("base que nasce do item desconta o desconto da linha (N-pis-cofins-ipi-9)", () => {
    const semQtd = proporcionalizar({
      impostoOriginal: normalizarImpostoOriginal({
        ICMS: { ICMS00: { orig: "0", CST: "00", modBC: "3", vBC: "100", pICMS: "18", vICMS: "18" } },
        PIS: { PISNT: { CST: "04" } },
        COFINS: { COFINSNT: { CST: "04" } },
      }),
      qOriginal: null, qDevolvida: 1, vUnCom: 100, crtEmitente: "3", crtOriginal: "3", descontoDevolvido: 10,
    });
    expect(semQtd.icms.vBC).toBe(90);
    expect(semQtd.icms.vICMS).toBe(16.2);
  });
});

describe("aplicarOverrideTributacao — PIS/COFINS pelo MESMO juiz da tela", () => {
  it("DLS: trocar para 49 sem digitar alíquota grava 49 a ZERO — não 1,65% sobre R$ 108,73", () => {
    const r = aplicarOverrideTributacao({
      base: baseDls(), override: { pis: { cst: "49" }, cofins: { cst: "49" } },
      crtEmitente: "1", baseCalculoItem: 123.56, tipoOperacao: "SAIDA",
    });
    if (!r.ok) throw new Error(r.erros.join("; "));
    expect(r.tributacao.pis).toEqual({ cst: "49", vBC: 0, p: 0, v: 0 });
    expect(r.tributacao.cofins).toEqual({ cst: "49", vBC: 0, p: 0, v: 0 });
  });

  it("DLS: escolher 01 no Simples é recusado no servidor também, com a frase da tela", () => {
    const r = aplicarOverrideTributacao({
      base: baseDls(DISAUTO_ITEM6, 295.88), override: { pis: { cst: "01", p: 1.65 } },
      crtEmitente: "1", baseCalculoItem: 295.88, tipoOperacao: "SAIDA",
    });
    if (r.ok) throw new Error("deveria recusar");
    expect(r.erros[0]).toMatch(/^PIS: /);
    expect(r.erros[0]).toContain("regime normal");
  });

  it("regime normal: 04 → 01 sem alíquota é recusado (antes gravava 01 a 0% em silêncio — rascunho 4a3698ee)", () => {
    const base = proporcionalizar({
      impostoOriginal: DISAUTO_ITEM6, qOriginal: 1, qDevolvida: 1, vUnCom: 295.88,
      crtEmitente: "3", crtOriginal: "3", tipoOperacao: "SAIDA",
    });
    const semP = aplicarOverrideTributacao({ base, override: { pis: { cst: "01" } }, crtEmitente: "3", baseCalculoItem: 295.88, tipoOperacao: "SAIDA" });
    if (semP.ok) throw new Error("deveria recusar");
    expect(semP.erros[0]).toContain("06");
    const comP = aplicarOverrideTributacao({ base, override: { pis: { cst: "01", p: 1.65 } }, crtEmitente: "3", baseCalculoItem: 295.88, tipoOperacao: "SAIDA" });
    if (!comP.ok) throw new Error(comP.erros.join("; "));
    expect(comP.tributacao.pis).toEqual({ cst: "01", vBC: 295.88, p: 1.65, v: 4.88 });
  });

  it("reenviar o valor que já está na base NÃO é recusado (o caso de uso reenvia o gravado a cada save)", () => {
    // Base com o 01 do fornecedor (não serve no Simples): salvar só o ICMS reenvia
    // {pis:{cst:'01',p:0}} — isso não pode derrubar o salvamento do ICMS.
    const r = aplicarOverrideTributacao({
      base: baseDls(),
      override: { icms: { csosn: "900", cst: null, pICMS: 12 }, pis: { cst: "01", p: 0 }, cofins: { cst: "01", p: 0 } },
      crtEmitente: "1", baseCalculoItem: 123.56, tipoOperacao: "SAIDA",
    });
    if (!r.ok) throw new Error(r.erros.join("; "));
    expect(r.tributacao.icms).toMatchObject({ tag: "ICMSSN900", pICMS: 12, vICMS: 14.83 });
    expect(r.tributacao.pis).toEqual({ cst: "01", vBC: 0, p: 0, v: 0 });

    // Idem para o PIS SEM código (manual sem XML): antes, todo save depois do
    // primeiro ajuste voltava 422 "CST fora da lista".
    const semXml = proporcionalizar({ impostoOriginal: null, qOriginal: null, qDevolvida: 1, vUnCom: 10 });
    const s = aplicarOverrideTributacao({
      base: semXml, override: { icms: { csosn: "102", cst: null }, pis: { cst: null, p: 0 }, cofins: { cst: null, p: 0 } },
      crtEmitente: "1", baseCalculoItem: 10, tipoOperacao: "SAIDA",
    });
    expect(s.ok).toBe(true);
  });

  it("49 escolhido numa ENTRADA vira aviso; 98 escolhido numa SAÍDA vira o aviso inverso", () => {
    const venda = proporcionalizar({
      impostoOriginal: normalizarImpostoOriginal({
        ICMS: { ICMSSN102: { orig: "0", CSOSN: "102" } },
        PIS: { PISOutr: { CST: "98", vBC: "0", pPIS: "0", vPIS: "0" } },
        COFINS: { COFINSOutr: { CST: "98", vBC: "0", pCOFINS: "0", vCOFINS: "0" } },
      }),
      qOriginal: 1, qDevolvida: 1, vUnCom: 10, crtEmitente: "1", crtOriginal: "1",
    });
    const e = aplicarOverrideTributacao({ base: venda, override: { pis: { cst: "49", p: 0 } }, crtEmitente: "1", baseCalculoItem: 10 });
    if (!e.ok) throw new Error(e.erros.join("; "));
    expect(e.tributacao.avisos).toContain("PIS_CST_SAIDA_EM_ENTRADA");

    const s = aplicarOverrideTributacao({ base: baseDls(), override: { pis: { cst: "98", p: 0 } }, crtEmitente: "1", baseCalculoItem: 123.56, tipoOperacao: "SAIDA" });
    if (!s.ok) throw new Error(s.erros.join("; "));
    expect(s.tributacao.avisos).toContain("PIS_CST_ENTRADA_EM_SAIDA");
    expect(s.tributacao.avisos).not.toContain("PIS_CST_SAIDA_EM_ENTRADA");
  });
});

describe("ICMS: código do outro regime FORA da lista ganha a frase de regime (decisão 3)", () => {
  it("Simples + CST 10 (o LUBRAX da DISAUTO): diz que 10 é do regime normal, com ST", () => {
    const r = checarCodigoIcmsDevolucao({ crt: "1", codigo: "10" });
    if (r.ok) throw new Error("deveria recusar");
    // A causa segue NAO_SUPORTADO — o Dexo não emite 10 em regime nenhum —, a frase é a de regime.
    expect(r.causa).toBe("NAO_SUPORTADO");
    expect(r.motivo).toContain("CST 10");
    expect(r.motivo).toContain("regime normal");
    expect(r.motivo).toContain("ICMS-ST");
    expect(r.motivo).toContain("Simples Nacional");
    expect(r.motivo).toContain("CSOSN, de 3 dígitos");
    expect(r.motivo).toContain("Escolha na lista");
    for (const c of ["20", "30", "51", "70"]) {
      const x = checarCodigoIcmsDevolucao({ crt: "1", codigo: c });
      expect(x.ok).toBe(false);
      if (!x.ok) expect(x.motivo).toContain("regime normal");
    }
  });

  it("regime normal + CST 10: frase própria (tem ICMS-ST, que o Dexo ainda não devolve)", () => {
    const r = checarCodigoIcmsDevolucao({ crt: "3", codigo: "10" });
    if (r.ok) throw new Error("deveria recusar");
    expect(r.causa).toBe("NAO_SUPORTADO");
    expect(r.motivo).toContain("O Dexo não emite devolução com CST 10");
    expect(r.motivo).toContain("ainda não devolve ICMS-ST");
    expect(r.motivo).not.toContain("regime normal");
  });

  it("regime normal + CSOSN 201: frase de regime, espelhada", () => {
    const r = checarCodigoIcmsDevolucao({ crt: "3", codigo: "201" });
    if (r.ok) throw new Error("deveria recusar");
    expect(r.motivo).toContain("CSOSN 201");
    expect(r.motivo).toContain("Simples Nacional");
    expect(r.motivo).toContain("CST, de 2 dígitos");
  });

  it("sem regime cadastrado: frase curta de sempre (não sabe qual é 'o seu' regime)", () => {
    const r = checarCodigoIcmsDevolucao({ crt: null, codigo: "10" });
    if (r.ok) throw new Error("deveria recusar");
    expect(r.motivo).toBe("O Dexo não emite devolução com CST 10. Escolha na lista um dos códigos que ele emite.");
  });
});

describe("recusa estruturada do ajuste — o caso de uso consegue dizer QUAL tributo e POR QUÊ", () => {
  it("cada recusa traz o tributo, o código de pendência e a frase (a mesma de `erros`)", () => {
    const r = aplicarOverrideTributacao({
      base: baseDls(),
      override: { icms: { cst: "00", csosn: null, pICMS: 18 }, pis: { cst: "01", p: 1.65 }, cofins: { cst: "03" } },
      crtEmitente: "1", baseCalculoItem: 123.56, tipoOperacao: "SAIDA",
    });
    if (r.ok) throw new Error("deveria recusar");
    expect(r.recusas.map((x) => [x.tributo, x.code])).toEqual([
      ["ICMS", "TRIBUTACAO_REGIME_INCOMPATIVEL"],
      ["PIS", "PIS_COFINS_REGIME_INCOMPATIVEL"],
      ["COFINS", "PIS_COFINS_NAO_SUPORTADO"],
    ]);
    expect(r.recusas[0].motivo).toContain("regime normal");
    expect(r.recusas[2].motivo).toContain("por quantidade");
    expect(r.erros).toHaveLength(3);
    expect(r.erros[1]).toBe(`PIS: ${r.recusas[1].motivo}`);
  });

  it("alíquota zero no 01 vira PIS_COFINS_ALIQUOTA_INVALIDA", () => {
    const base = proporcionalizar({
      impostoOriginal: DISAUTO_ITEM6, qOriginal: 1, qDevolvida: 1, vUnCom: 295.88,
      crtEmitente: "3", crtOriginal: "3", tipoOperacao: "SAIDA",
    });
    const r = aplicarOverrideTributacao({ base, override: { cofins: { cst: "01", p: 0 } }, crtEmitente: "3", baseCalculoItem: 295.88, tipoOperacao: "SAIDA" });
    if (r.ok) throw new Error("deveria recusar");
    expect(r.recusas).toEqual([{ tributo: "COFINS", code: "PIS_COFINS_ALIQUOTA_INVALIDA", motivo: expect.stringContaining("06") }]);
  });
});

describe("ICMS igual ao da base não é ajuste (o caso de uso reenvia o gravado desde a mescla por tributo)", () => {
  it("salvar só o PIS com o ICMS 00 do fornecedor reenviado NÃO derruba o salvamento", () => {
    // Base da DLS: ICMS 00 da DISAUTO (não serve no Simples — a validação barra a
    // emissão por TRIBUTACAO_REGIME_INCOMPATIVEL). O ajuste gravado reenvia esse
    // ICMS inteiro a cada save; antes, qualquer save do PIS voltava 422.
    const base = baseDls();
    const r = aplicarOverrideTributacao({
      base,
      override: { icms: { cst: "00", csosn: null, modBC: "3", pICMS: 12 }, pis: { cst: "49", p: 0 }, cofins: { cst: "49", p: 0 } },
      crtEmitente: "1", baseCalculoItem: 123.56, tipoOperacao: "SAIDA",
    });
    if (!r.ok) throw new Error(r.erros.join("; "));
    expect(r.tributacao.icms).toEqual(base.icms);
    expect(r.tributacao.pis.cst).toBe("49");
  });

  it("mas 00 com OUTRA alíquota é ajuste, e continua recusado no Simples", () => {
    const r = aplicarOverrideTributacao({
      base: baseDls(), override: { icms: { cst: "00", csosn: null, pICMS: 18 } },
      crtEmitente: "1", baseCalculoItem: 123.56, tipoOperacao: "SAIDA",
    });
    expect(r.ok).toBe(false);
  });
});

describe("base do ICMS: a da nota original quando a atual é zero (N-icms-residual-5)", () => {
  it("CST 20 (base reduzida) → 900: usa a base reduzida do fornecedor, não o valor cheio", () => {
    const cst20 = normalizarImpostoOriginal({
      ICMS: { ICMS20: { orig: "0", CST: "20", modBC: "3", pRedBC: "40", vBC: "60.00", pICMS: "18", vICMS: "10.80" } },
      PIS: { PISNT: { CST: "04" } },
      COFINS: { COFINSNT: { CST: "04" } },
    });
    const base = proporcionalizar({ impostoOriginal: cst20, qOriginal: 1, qDevolvida: 1, vUnCom: 100, crtEmitente: "1", crtOriginal: "3", tipoOperacao: "SAIDA" });
    expect(base.icms.vBC).toBe(0);
    const comBase = aplicarOverrideTributacao({
      base, override: { icms: { csosn: "900", cst: null, pICMS: 18 } },
      crtEmitente: "1", baseCalculoItem: 100, tipoOperacao: "SAIDA", baseIcmsOriginal: 60,
    });
    if (!comBase.ok) throw new Error(comBase.erros.join("; "));
    expect(comBase.tributacao.icms).toMatchObject({ vBC: 60, pICMS: 18, vICMS: 10.8 });
    // Sem a informação (caso de uso antigo), o comportamento de antes: a base do item.
    const semBase = aplicarOverrideTributacao({
      base, override: { icms: { csosn: "900", cst: null, pICMS: 18 } },
      crtEmitente: "1", baseCalculoItem: 100, tipoOperacao: "SAIDA",
    });
    if (!semBase.ok) throw new Error(semBase.erros.join("; "));
    expect(semBase.tributacao.icms).toMatchObject({ vBC: 100, vICMS: 18 });
  });
});

describe("o grupo de ICMS-ST do XML original é guardado inteiro (para o dia em que o construtor devolver ST)", () => {
  it("modBCST, pMVAST, pICMSST… e o ST retido do CST 60", () => {
    const st = normalizarImpostoOriginal({
      ICMS: { ICMS10: {
        orig: "0", CST: "10", modBC: "3", vBC: "117.45", pICMS: "12.00", vICMS: "14.09",
        modBCST: "4", pMVAST: "71.03", pRedBCST: "0", vBCST: "200.87", pICMSST: "17.00", vICMSST: "20.05", vFCPST: "0.00",
      } },
    });
    expect(st.icms).toMatchObject({ modBCST: "4", pMVAST: 71.03, pRedBCST: 0, pICMSST: 17, vBCST: 200.87, vICMSST: 20.05, vFCPST: 0 });
    const retido = normalizarImpostoOriginal({
      ICMS: { ICMS60: { orig: "0", CST: "60", vBCSTRet: "50.00", pST: "17.00", vICMSSubstituto: "3.00", vICMSSTRet: "5.50" } },
    });
    expect(retido.icms).toMatchObject({ vBCSTRet: 50, pST: 17, vICMSSubstituto: 3, vICMSSTRet: 5.5 });
    // O ST RETIDO antes não é ST a devolver (o CST 60 continua na allowlist).
    expect(proporcionalizar({ impostoOriginal: retido, qOriginal: 1, qDevolvida: 1, vUnCom: 10, crtEmitente: "3", crtOriginal: "3" }).motivosRevisao)
      .not.toContain("ICMS_ST_NAO_SUPORTADO");
  });
});
