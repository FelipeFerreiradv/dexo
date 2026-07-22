import { describe, it, expect } from "vitest";

import {
  exigeGrupoCard,
  TPAG_QUE_EXIGEM_CARD,
  TP_INTEGRA_NAO_INTEGRADO,
} from "../../app/fiscal/domain/pagamento-card";
import { MEIO_PAGAMENTO_COD } from "../../app/fiscal/domain/nfe.types";
import { NfeXmlBuilderSefazService } from "../../app/fiscal/sefaz/nfe-xml-builder-sefaz.service";
import { makeConfig, makeDraft } from "./__helpers__/test-draft";

// ──────────────────────────────────────────────────────────────────────────
// INCIDENTE PROD (2026-07-22): NFC-e paga em PIX rejeitada com cStat 391
// ("Não informados os dados do cartão de crédito / débito"). Causa: o builder
// nunca emitia o grupo <card>, obrigatório em 03/04 e — desde a NT 2025.001 —
// também em PIX (17). Provado nos dados: 65 PIX REJEITADAS vs 55 PIX/cartão
// AUTORIZADAS no mesmo emitente (GO) → a exigência vale para a NFC-e.
//
// Matriz de validação completa (PIX, dinheiro, crédito, débito e mistos).
// ──────────────────────────────────────────────────────────────────────────

const DH = new Date("2026-07-22T12:00:00-03:00");

function build(modelo: "55" | "65", pagamentos: Array<{ meio: string; valor: number }>) {
  return new NfeXmlBuilderSefazService().build({
    draft: makeDraft({
      modelo,
      ...(modelo === "65" ? { indPresenca: "PRESENCIAL" as any } : {}),
      pagamentosJson: pagamentos as any,
    }),
    config: makeConfig(),
    numero: 3,
    dhEmi: DH,
    cNF: "10000007",
  });
}

/** Extrai os pares (tPag, temCard) na ordem em que aparecem no XML. */
function detPags(xml: string): Array<{ tPag: string; card: boolean }> {
  const bloco = xml.slice(xml.indexOf("<pag>"), xml.indexOf("</pag>"));
  return [...bloco.matchAll(/<detPag>([\s\S]*?)<\/detPag>/g)].map((m) => ({
    tPag: /<tPag>(\d+)<\/tPag>/.exec(m[1])?.[1] ?? "",
    card: m[1].includes("<card>"),
  }));
}

describe("decisão centralizada — exigeGrupoCard", () => {
  it("a regra vive em UM lugar e é por CÓDIGO tPag (não por rótulo)", () => {
    expect([...TPAG_QUE_EXIGEM_CARD].sort()).toEqual(["03", "04", "17"]);
    // Os códigos vêm da tabela oficial — nada de string mágica no builder.
    expect(MEIO_PAGAMENTO_COD.PIX).toBe("17");
    expect(MEIO_PAGAMENTO_COD.CARTAO_CREDITO).toBe("03");
    expect(MEIO_PAGAMENTO_COD.CARTAO_DEBITO).toBe("04");
    expect(MEIO_PAGAMENTO_COD.DINHEIRO).toBe("01");
  });

  it("NFC-e (65): exige card só em 03/04/17", () => {
    for (const cod of ["03", "04", "17"]) {
      expect(exigeGrupoCard(cod, "65"), `tPag ${cod}`).toBe(true);
    }
    for (const cod of ["01", "02", "05", "15", "16", "18", "90", "99"]) {
      expect(exigeGrupoCard(cod, "65"), `tPag ${cod}`).toBe(false);
    }
  });

  it("NF-e (55): nunca exige — preserva o fluxo autorizado em produção", () => {
    for (const cod of ["01", "03", "04", "17", "99"]) {
      expect(exigeGrupoCard(cod, "55"), `tPag ${cod}`).toBe(false);
    }
  });

  it("entrada nula/indefinida nunca gera card (sem falso positivo)", () => {
    expect(exigeGrupoCard(null, "65")).toBe(false);
    expect(exigeGrupoCard(undefined, "65")).toBe(false);
    expect(exigeGrupoCard("", "65")).toBe(false);
  });
});

describe("matriz de validação — XML da NFC-e (65)", () => {
  it("PIX → tPag 17 COM card (o bug do incidente)", () => {
    const out = build("65", [{ meio: "PIX", valor: 2700 }]);
    expect(detPags(out.xml)).toEqual([{ tPag: "17", card: true }]);
    expect(out.xml).toContain(
      `<card><tpIntegra>${TP_INTEGRA_NAO_INTEGRADO}</tpIntegra></card>`,
    );
    // tpIntegra=2 ⇒ nada de CNPJ/bandeira/autorização inventados.
    expect(out.xml).not.toContain("<tBand>");
    expect(out.xml).not.toContain("<cAut>");
  });

  it("Dinheiro → tPag 01 SEM card", () => {
    expect(detPags(build("65", [{ meio: "DINHEIRO", valor: 100 }]).xml)).toEqual(
      [{ tPag: "01", card: false }],
    );
  });

  it("Crédito → 03 COM card; Débito → 04 COM card", () => {
    expect(
      detPags(build("65", [{ meio: "CARTAO_CREDITO", valor: 50 }]).xml),
    ).toEqual([{ tPag: "03", card: true }]);
    expect(
      detPags(build("65", [{ meio: "CARTAO_DEBITO", valor: 50 }]).xml),
    ).toEqual([{ tPag: "04", card: true }]);
  });

  it("MISTO PIX + Dinheiro → card só no PIX", () => {
    expect(
      detPags(
        build("65", [
          { meio: "PIX", valor: 60 },
          { meio: "DINHEIRO", valor: 40 },
        ]).xml,
      ),
    ).toEqual([
      { tPag: "17", card: true },
      { tPag: "01", card: false },
    ]);
  });

  it("MISTO PIX + Crédito → card nos dois", () => {
    expect(
      detPags(
        build("65", [
          { meio: "PIX", valor: 60 },
          { meio: "CARTAO_CREDITO", valor: 40 },
        ]).xml,
      ),
    ).toEqual([
      { tPag: "17", card: true },
      { tPag: "03", card: true },
    ]);
  });

  it("MISTO Crédito + Débito → card nos dois", () => {
    expect(
      detPags(
        build("65", [
          { meio: "CARTAO_CREDITO", valor: 30 },
          { meio: "CARTAO_DEBITO", valor: 70 },
        ]).xml,
      ),
    ).toEqual([
      { tPag: "03", card: true },
      { tPag: "04", card: true },
    ]);
  });

  it("MISTO Dinheiro + Cartão + Boleto → card só no cartão", () => {
    expect(
      detPags(
        build("65", [
          { meio: "DINHEIRO", valor: 10 },
          { meio: "CARTAO_DEBITO", valor: 20 },
          { meio: "BOLETO", valor: 30 },
        ]).xml,
      ),
    ).toEqual([
      { tPag: "01", card: false },
      { tPag: "04", card: true },
      { tPag: "15", card: false },
    ]);
  });

  it("meio desconhecido (dado legado) → 99 SEM card, sem quebrar", () => {
    expect(
      detPags(build("65", [{ meio: "MOEDA_ANTIGA_XPTO", valor: 10 }] as any).xml),
    ).toEqual([{ tPag: "99", card: false }]);
  });

  it("sem pagamentos → tPag 90 SEM card", () => {
    const out = new NfeXmlBuilderSefazService().build({
      draft: makeDraft({
        modelo: "65",
        indPresenca: "PRESENCIAL" as any,
        pagamentosJson: [] as any,
      }),
      config: makeConfig(),
      numero: 3,
      dhEmi: DH,
      cNF: "10000007",
    });
    expect(detPags(out.xml)).toEqual([{ tPag: "90", card: false }]);
  });
});

describe("REGRESSÃO — NF-e 55 byte-idêntica (fluxo autorizado em produção)", () => {
  it("PIX no 55 continua SEM card", () => {
    expect(detPags(build("55", [{ meio: "PIX", valor: 900 }]).xml)).toEqual([
      { tPag: "17", card: false },
    ]);
  });

  it("Cartão no 55 continua SEM card (55 nº 1/521 e 4/57 autorizadas assim)", () => {
    expect(
      detPags(build("55", [{ meio: "CARTAO_CREDITO", valor: 1150 }]).xml),
    ).toEqual([{ tPag: "03", card: false }]);
    expect(build("55", [{ meio: "CARTAO_CREDITO", valor: 1150 }]).xml).not.toContain(
      "<card>",
    );
  });

  it("determinístico: duas builds 55 idênticas byte a byte", () => {
    const a = build("55", [{ meio: "PIX", valor: 900 }]);
    const b = build("55", [{ meio: "PIX", valor: 900 }]);
    expect(a.xml).toBe(b.xml);
  });
});
