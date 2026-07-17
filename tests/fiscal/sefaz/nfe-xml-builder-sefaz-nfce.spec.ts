import { describe, it, expect } from "vitest";

import { NfeXmlBuilderSefazService } from "../../../app/fiscal/sefaz/nfe-xml-builder-sefaz.service";
import { makeConfig, makeDraft, makeItem } from "../__helpers__/test-draft";

// NFC-e (modelo 65) no builder SEFAZ — TODAS as diferenças guardadas por
// modelo==="65". O bloco de regressão no fim TRAVA o comportamento do 55.

const builder = new NfeXmlBuilderSefazService();
const DH = new Date("2026-07-17T12:00:00-03:00");

function build65(overrides: Record<string, any> = {}) {
  return builder.build({
    draft: makeDraft({
      modelo: "65",
      indPresenca: "PRESENCIAL",
      pagamentosJson: [{ meio: "PIX", valor: 100 }] as any,
      ...overrides,
    }),
    config: makeConfig(),
    numero: 123,
    dhEmi: DH,
    cNF: "10000007",
  });
}

describe("builder SEFAZ — modelo 65 (NFC-e)", () => {
  it("mod=65 na chave e no <mod>; tpImp=4; sem dhSaiEnt", () => {
    const out = build65({ dataSaida: "2026-07-18" });
    expect(out.chaveAcesso.slice(20, 22)).toBe("65");
    expect(out.xml).toContain("<mod>65</mod>");
    expect(out.xml).toContain("<tpImp>4</tpImp>");
    expect(out.xml).not.toContain("<dhSaiEnt>");
    expect(out.xml).toContain("<idDest>1</idDest>");
    expect(out.xml).toContain("<indPres>1</indPres>");
  });

  it("destinatario OPCIONAL: sem dest ⇒ sem <dest>; nao lanca", () => {
    const out = build65({ destinatarioJson: null });
    expect(out.xml).not.toContain("<dest>");
  });

  it("dest com CPF: só CPF + xNome + indIEDest=9, SEM enderDest/IE", () => {
    const out = build65({
      destinatarioJson: {
        tipoPessoa: "PF",
        cpfCnpj: "12345678909",
        nome: "CONSUMIDOR TESTE",
        inscricaoEstadual: "123",
      } as any,
    });
    expect(out.xml).toContain("<CPF>12345678909</CPF>");
    expect(out.xml).toContain("<indIEDest>9</indIEDest>");
    expect(out.xml).not.toContain("<enderDest>");
    // IE não pode aparecer DENTRO do <dest> (o <IE> do emitente é legítimo).
    const destBlock = out.xml.slice(
      out.xml.indexOf("<dest>"),
      out.xml.indexOf("</dest>"),
    );
    expect(destBlock).not.toContain("<IE>");
    // Regra 598 vale no 65 tambem (homolog: literal no xNome).
    expect(out.xml).toContain(
      "NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL",
    );
  });

  it("homolog: 1o item recebe o literal SEM VALOR FISCAL no xProd", () => {
    const out = build65({
      itens: [
        makeItem({ descricao: "PECA A" }),
        makeItem({ id: "item-2", numero: 2, descricao: "PECA B" }),
      ],
    });
    expect(out.xml).toContain(
      "<xProd>NOTA FISCAL EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL</xProd>",
    );
    expect(out.xml).toContain("<xProd>PECA B</xProd>");
  });

  it("65: sem cobr, sem transporta, sem IPI; modFrete=9", () => {
    const out = build65({
      duplicatasJson: [{ numero: "001", valor: 100 }] as any,
      transportadoraJson: { nome: "TRANSP X", cpfCnpj: "11222333000181" } as any,
      itens: [
        makeItem({
          tributosJson: {
            ...makeItem().tributosJson!,
            valorIpi: 10,
            bcIpi: 100,
            aliquotaIpi: 10,
          },
        }),
      ],
    });
    expect(out.xml).not.toContain("<cobr>");
    expect(out.xml).not.toContain("<transporta>");
    expect(out.xml).not.toContain("<IPI>");
    expect(out.xml).toContain("<modFrete>9</modFrete>");
  });
});

describe("REGRESSAO — modelo 55 travado (comportamento atual)", () => {
  function build55() {
    return builder.build({
      draft: makeDraft({
        dataSaida: new Date("2026-07-18T00:00:00-03:00") as any,
        duplicatasJson: [{ numero: "001", valor: 100 }] as any,
        transportadoraJson: {
          nome: "TRANSP X",
          cpfCnpj: "11222333000181",
        } as any,
      }),
      config: makeConfig(),
      numero: 123,
      dhEmi: DH,
      cNF: "10000007",
    });
  }

  it("mod=55, tpImp=1, dhSaiEnt presente, enderDest presente, cobr/transporta presentes", () => {
    const out = build55();
    expect(out.chaveAcesso.slice(20, 22)).toBe("55");
    expect(out.xml).toContain("<mod>55</mod>");
    expect(out.xml).toContain("<tpImp>1</tpImp>");
    expect(out.xml).toContain("<dhSaiEnt>");
    expect(out.xml).toContain("<enderDest>");
    expect(out.xml).toContain("<cobr>");
    expect(out.xml).toContain("<transporta>");
  });

  it("deterministico: duas builds 55 identicas byte a byte", () => {
    const a = build55();
    const b = build55();
    expect(a.xml).toBe(b.xml);
    expect(a.chaveAcesso).toBe(b.chaveAcesso);
  });

  it("55 sem destinatario continua LANCANDO (guard intacto)", () => {
    expect(() =>
      builder.build({
        draft: makeDraft({ destinatarioJson: null as any }),
        config: makeConfig(),
        numero: 1,
        dhEmi: DH,
        cNF: "10000007",
      }),
    ).toThrow(/destinatario/);
  });
});
