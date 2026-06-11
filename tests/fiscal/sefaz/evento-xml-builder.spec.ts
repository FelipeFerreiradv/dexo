import { describe, it, expect } from "vitest";
import { EventoXmlBuilderService } from "../../../app/fiscal/sefaz/evento-xml-builder.service";

const builder = new EventoXmlBuilderService();
const CHAVE = "35260411222333000181550010000000011000000017";
const DH = new Date("2026-05-14T15:30:00-03:00");

describe("EventoXmlBuilderService — cancelamento (110111)", () => {
  it("monta envelope <evento versao='1.00'> com Id de 54 chars", () => {
    const { xml, infEventoId } = builder.build({
      chNFe: CHAVE,
      uf: "SP",
      ambiente: "homologacao",
      cnpj: "11222333000181",
      tpEvento: "110111",
      nSeqEvento: 1,
      dhEvento: DH,
      detalhe: {
        kind: "cancelamento",
        nProt: "135260000000999",
        xJust: "Cancelamento por erro de digitacao em quantidade",
      },
    });

    expect(infEventoId).toBe(`ID110111${CHAVE}01`);
    expect(infEventoId.length).toBe(54);
    expect(xml).toContain('<evento xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.00">');
    expect(xml).toContain(`<infEvento Id="${infEventoId}">`);
    expect(xml).toContain("<tpEvento>110111</tpEvento>");
    expect(xml).toContain("<cOrgao>35</cOrgao>");
    expect(xml).toContain("<tpAmb>2</tpAmb>");
    expect(xml).toContain("<CNPJ>11222333000181</CNPJ>");
    expect(xml).toContain(`<chNFe>${CHAVE}</chNFe>`);
    expect(xml).toContain("<nSeqEvento>1</nSeqEvento>");
    expect(xml).toContain("<verEvento>1.00</verEvento>");
    expect(xml).toContain("<descEvento>Cancelamento</descEvento>");
    expect(xml).toContain("<nProt>135260000000999</nProt>");
    expect(xml).toContain("<xJust>Cancelamento por erro de digitacao em quantidade</xJust>");
  });

  it("dhEvento usa offset fixo -03:00 independente do TZ do servidor (EVT-1)", () => {
    // 18:30Z = 15:30 em Brasilia. Mesmo em servidor UTC, sai -03:00.
    const { xml } = builder.build({
      chNFe: CHAVE,
      uf: "SP",
      ambiente: "homologacao",
      cnpj: "11222333000181",
      tpEvento: "110111",
      nSeqEvento: 1,
      dhEvento: new Date("2026-05-14T18:30:00Z"),
      detalhe: {
        kind: "cancelamento",
        nProt: "135260000000999",
        xJust: "Cancelamento por erro de digitacao em quantidade",
      },
    });
    expect(xml).toContain("<dhEvento>2026-05-14T15:30:00-03:00</dhEvento>");
  });

  it("inclui dhEvento em formato ISO com TZ", () => {
    const { xml } = builder.build({
      chNFe: CHAVE,
      uf: "SP",
      ambiente: "homologacao",
      cnpj: "11222333000181",
      tpEvento: "110111",
      nSeqEvento: 1,
      dhEvento: DH,
      detalhe: {
        kind: "cancelamento",
        nProt: "135260000000999",
        xJust: "Justificativa para o cancelamento da nota fiscal",
      },
    });
    expect(xml).toMatch(/<dhEvento>2026-05-14T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}<\/dhEvento>/);
  });

  it("rejeita chave com menos de 44 digitos", () => {
    expect(() =>
      builder.build({
        chNFe: "123",
        uf: "SP",
        ambiente: "homologacao",
        cnpj: "11222333000181",
        tpEvento: "110111",
        nSeqEvento: 1,
        detalhe: {
          kind: "cancelamento",
          nProt: "135260000000999",
          xJust: "Justificativa valida com pelo menos 15",
        },
      }),
    ).toThrow(/44 digitos/);
  });

  it("rejeita justificativa com menos de 15 caracteres", () => {
    expect(() =>
      builder.build({
        chNFe: CHAVE,
        uf: "SP",
        ambiente: "homologacao",
        cnpj: "11222333000181",
        tpEvento: "110111",
        nSeqEvento: 1,
        detalhe: {
          kind: "cancelamento",
          nProt: "135260000000999",
          xJust: "Curto",
        },
      }),
    ).toThrow(/15\.\.255/);
  });

  it("usa tpAmb=1 em producao", () => {
    const { xml } = builder.build({
      chNFe: CHAVE,
      uf: "SP",
      ambiente: "producao",
      cnpj: "11222333000181",
      tpEvento: "110111",
      nSeqEvento: 1,
      detalhe: {
        kind: "cancelamento",
        nProt: "135260000000999",
        xJust: "Justificativa do cancelamento em producao",
      },
    });
    expect(xml).toContain("<tpAmb>1</tpAmb>");
  });

  it("rejeita detalhe cce com tpEvento de cancelamento (mismatch)", () => {
    expect(() =>
      builder.build({
        chNFe: CHAVE,
        uf: "SP",
        ambiente: "homologacao",
        cnpj: "11222333000181",
        tpEvento: "110111",
        nSeqEvento: 1,
        detalhe: {
          kind: "cce",
          xCorrecao: "Correcao da descricao do produto X para Y",
        } as any,
      }),
    ).toThrow();
  });
});

describe("EventoXmlBuilderService — CCe (110110, preparado para F-F)", () => {
  it("monta XML CCe com xCorrecao + xCondUso obrigatorio", () => {
    const { xml, descEvento } = builder.build({
      chNFe: CHAVE,
      uf: "SP",
      ambiente: "homologacao",
      cnpj: "11222333000181",
      tpEvento: "110110",
      nSeqEvento: 2,
      detalhe: {
        kind: "cce",
        xCorrecao: "Correcao na natureza da operacao para Devolucao",
      },
    });
    expect(descEvento).toBe("Carta de Correcao");
    expect(xml).toContain("<descEvento>Carta de Correcao</descEvento>");
    expect(xml).toContain("<xCorrecao>Correcao na natureza da operacao para Devolucao</xCorrecao>");
    expect(xml).toContain("<xCondUso>");
    expect(xml).toContain("Carta de Correcao e disciplinada pelo paragrafo 1o-A do art. 7o");
  });

  it("rejeita xCorrecao com menos de 15 caracteres", () => {
    expect(() =>
      builder.build({
        chNFe: CHAVE,
        uf: "SP",
        ambiente: "homologacao",
        cnpj: "11222333000181",
        tpEvento: "110110",
        nSeqEvento: 1,
        detalhe: {
          kind: "cce",
          xCorrecao: "curto",
        },
      }),
    ).toThrow(/15\.\.1000/);
  });

  it("nSeqEvento padded para 2 digitos no Id", () => {
    const { infEventoId } = builder.build({
      chNFe: CHAVE,
      uf: "SP",
      ambiente: "homologacao",
      cnpj: "11222333000181",
      tpEvento: "110110",
      nSeqEvento: 5,
      detalhe: {
        kind: "cce",
        xCorrecao: "Correcao na natureza da operacao para Devolucao",
      },
    });
    expect(infEventoId).toBe(`ID110110${CHAVE}05`);
  });
});
