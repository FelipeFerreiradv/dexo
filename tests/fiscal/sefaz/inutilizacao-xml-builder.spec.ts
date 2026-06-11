import { describe, it, expect } from "vitest";
import { InutilizacaoXmlBuilderService } from "../../../app/fiscal/sefaz/inutilizacao-xml-builder.service";

const builder = new InutilizacaoXmlBuilderService();

describe("InutilizacaoXmlBuilderService", () => {
  it("monta <inutNFe versao='4.00'> com Id de 43 chars", () => {
    const { xml, infInutId } = builder.build({
      uf: "SP",
      ambiente: "homologacao",
      cnpj: "11222333000181",
      ano: 2026,
      modelo: "55",
      serie: 1,
      nNFIni: 100,
      nNFFin: 105,
      xJust: "Inutilizacao por falha de impressao em todas",
    });

    expect(infInutId.length).toBe(43);
    // ID + cUF(2)35 + ano(2)26 + CNPJ(14) + mod(2)55 + serie(3)001 + nIni(9)000000100 + nFin(9)000000105
    expect(infInutId).toBe("ID35261122233300018155001000000100000000105");

    expect(xml).toContain('<inutNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">');
    expect(xml).toContain(`<infInut Id="${infInutId}">`);
    expect(xml).toContain("<tpAmb>2</tpAmb>");
    expect(xml).toContain("<xServ>INUTILIZAR</xServ>");
    expect(xml).toContain("<cUF>35</cUF>");
    expect(xml).toContain("<ano>26</ano>");
    expect(xml).toContain("<CNPJ>11222333000181</CNPJ>");
    expect(xml).toContain("<mod>55</mod>");
    expect(xml).toContain("<serie>1</serie>");
    expect(xml).toContain("<nNFIni>100</nNFIni>");
    expect(xml).toContain("<nNFFin>105</nNFFin>");
    expect(xml).toContain("<xJust>Inutilizacao por falha de impressao em todas</xJust>");
  });

  it("rejeita CNPJ invalido", () => {
    expect(() =>
      builder.build({
        uf: "SP",
        ambiente: "homologacao",
        cnpj: "123",
        ano: 2026,
        modelo: "55",
        serie: 1,
        nNFIni: 1,
        nNFFin: 5,
        xJust: "Justificativa com pelo menos 15 caracteres",
      }),
    ).toThrow(/CNPJ/);
  });

  it("rejeita nNFIni > nNFFin", () => {
    expect(() =>
      builder.build({
        uf: "SP",
        ambiente: "homologacao",
        cnpj: "11222333000181",
        ano: 2026,
        modelo: "55",
        serie: 1,
        nNFIni: 10,
        nNFFin: 5,
        xJust: "Justificativa com pelo menos 15 caracteres",
      }),
    ).toThrow(/nNFIni/);
  });

  it("rejeita justificativa curta", () => {
    expect(() =>
      builder.build({
        uf: "SP",
        ambiente: "homologacao",
        cnpj: "11222333000181",
        ano: 2026,
        modelo: "55",
        serie: 1,
        nNFIni: 1,
        nNFFin: 5,
        xJust: "curto",
      }),
    ).toThrow(/15\.\.255/);
  });

  it("usa tpAmb=1 em producao", () => {
    const { xml } = builder.build({
      uf: "SP",
      ambiente: "producao",
      cnpj: "11222333000181",
      ano: 2026,
      modelo: "55",
      serie: 1,
      nNFIni: 1,
      nNFFin: 1,
      xJust: "Justificativa de inutilizacao em producao",
    });
    expect(xml).toContain("<tpAmb>1</tpAmb>");
  });

  it("pad cUF/ano/mod/serie/nNFIni/nNFFin conforme schema SEFAZ", () => {
    const { infInutId } = builder.build({
      uf: "RJ", // cUF=33
      ambiente: "homologacao",
      cnpj: "11222333000181",
      ano: 2026,
      modelo: "55",
      serie: 0,
      nNFIni: 1,
      nNFFin: 1,
      xJust: "Justificativa de inutilizacao com tamanho suficiente",
    });
    expect(infInutId).toBe("ID33261122233300018155000000000001000000001");
    expect(infInutId.slice(2, 4)).toBe("33"); // cUF
    expect(infInutId.slice(4, 6)).toBe("26"); // ano
    expect(infInutId.slice(20, 22)).toBe("55"); // mod
    expect(infInutId.slice(22, 25)).toBe("000"); // serie
    expect(infInutId.slice(25, 34)).toBe("000000001"); // nNFIni
    expect(infInutId.slice(34, 43)).toBe("000000001"); // nNFFin
  });
});
