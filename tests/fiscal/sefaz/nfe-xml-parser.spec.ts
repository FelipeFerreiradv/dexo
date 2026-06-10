import { describe, it, expect } from "vitest";
import { parseNfeXml } from "../../../app/fiscal/sefaz/nfe-xml-parser.service";

const NFE_PROC_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
  <NFe xmlns="http://www.portalfiscal.inf.br/nfe">
    <infNFe Id="NFe35260511222333000181550010000000011120100012" versao="4.00">
      <ide>
        <cUF>35</cUF>
        <natOp>VENDA DE MERCADORIA</natOp>
        <mod>55</mod>
        <serie>1</serie>
        <nNF>1</nNF>
        <dhEmi>2026-05-14T15:00:00-03:00</dhEmi>
        <tpNF>1</tpNF>
        <idDest>1</idDest>
        <cMunFG>3550308</cMunFG>
        <tpImp>1</tpImp>
        <tpEmis>1</tpEmis>
        <cDV>2</cDV>
        <tpAmb>2</tpAmb>
        <finNFe>1</finNFe>
        <indFinal>1</indFinal>
        <indPres>1</indPres>
        <procEmi>0</procEmi>
        <verProc>Dexo-1.0</verProc>
      </ide>
      <emit>
        <CNPJ>11222333000181</CNPJ>
        <xNome>EMPRESA TESTE LTDA</xNome>
        <xFant>EMPRESA TESTE</xFant>
        <enderEmit>
          <xLgr>RUA TESTE</xLgr>
          <nro>100</nro>
          <xBairro>CENTRO</xBairro>
          <cMun>3550308</cMun>
          <xMun>SAO PAULO</xMun>
          <UF>SP</UF>
          <CEP>01000000</CEP>
          <cPais>1058</cPais>
          <xPais>BRASIL</xPais>
        </enderEmit>
        <IE>123456789</IE>
        <CRT>1</CRT>
      </emit>
      <dest>
        <CNPJ>00000000000100</CNPJ>
        <xNome>CLIENTE TESTE LTDA</xNome>
        <enderDest>
          <xLgr>AV CLIENTE</xLgr>
          <nro>200</nro>
          <xBairro>VILA</xBairro>
          <cMun>3550308</cMun>
          <xMun>SAO PAULO</xMun>
          <UF>SP</UF>
          <CEP>04000000</CEP>
          <cPais>1058</cPais>
          <xPais>BRASIL</xPais>
        </enderDest>
        <indIEDest>2</indIEDest>
      </dest>
      <det nItem="1">
        <prod>
          <cProd>PROD-001</cProd>
          <cEAN>SEM GTIN</cEAN>
          <xProd>PRODUTO TESTE</xProd>
          <NCM>87089990</NCM>
          <CFOP>5102</CFOP>
          <uCom>UN</uCom>
          <qCom>1.0000</qCom>
          <vUnCom>100.0000</vUnCom>
          <vProd>100.00</vProd>
          <cEANTrib>SEM GTIN</cEANTrib>
          <uTrib>UN</uTrib>
          <qTrib>1.0000</qTrib>
          <vUnTrib>100.0000</vUnTrib>
          <indTot>1</indTot>
        </prod>
        <imposto>
          <ICMS>
            <ICMSSN102>
              <orig>0</orig>
              <CSOSN>102</CSOSN>
            </ICMSSN102>
          </ICMS>
        </imposto>
      </det>
      <total>
        <ICMSTot>
          <vBC>0.00</vBC>
          <vICMS>0.00</vICMS>
          <vICMSDeson>0.00</vICMSDeson>
          <vFCP>0.00</vFCP>
          <vBCST>0.00</vBCST>
          <vST>0.00</vST>
          <vFCPST>0.00</vFCPST>
          <vFCPSTRet>0.00</vFCPSTRet>
          <vProd>100.00</vProd>
          <vFrete>0.00</vFrete>
          <vSeg>0.00</vSeg>
          <vDesc>0.00</vDesc>
          <vII>0.00</vII>
          <vIPI>0.00</vIPI>
          <vIPIDevol>0.00</vIPIDevol>
          <vPIS>0.00</vPIS>
          <vCOFINS>0.00</vCOFINS>
          <vOutro>0.00</vOutro>
          <vNF>100.00</vNF>
        </ICMSTot>
      </total>
      <transp>
        <modFrete>9</modFrete>
      </transp>
      <pag>
        <detPag>
          <tPag>90</tPag>
          <vPag>0.00</vPag>
        </detPag>
      </pag>
    </infNFe>
  </NFe>
  <protNFe versao="4.00">
    <infProt>
      <tpAmb>2</tpAmb>
      <verAplic>SVRS202604</verAplic>
      <chNFe>35260511222333000181550010000000011120100012</chNFe>
      <dhRecbto>2026-05-14T15:00:31-03:00</dhRecbto>
      <nProt>135260000000001</nProt>
      <digVal>abc==</digVal>
      <cStat>100</cStat>
      <xMotivo>Autorizado o uso da NF-e</xMotivo>
    </infProt>
  </protNFe>
</nfeProc>`;

describe("parseNfeXml — nfeProc completo", () => {
  it("extrai chaveAcesso do Id do infNFe", () => {
    const parsed = parseNfeXml(NFE_PROC_SAMPLE);
    expect(parsed.chaveAcesso).toBe("35260511222333000181550010000000011120100012");
  });

  it("extrai dados do <ide>", () => {
    const { ide } = parseNfeXml(NFE_PROC_SAMPLE);
    expect(ide.cUF).toBe(35);
    expect(ide.natOp).toBe("VENDA DE MERCADORIA");
    expect(ide.mod).toBe("55");
    expect(ide.serie).toBe(1);
    expect(ide.nNF).toBe(1);
    expect(ide.tpNF).toBe("1");
    expect(ide.tpAmb).toBe("2");
    expect(ide.tpEmis).toBe(1);
    expect(ide.cDV).toBe("2");
    expect(ide.dhEmi).toMatch(/2026-05-14/);
  });

  it("extrai dados do <emit> e endereco", () => {
    const { emit } = parseNfeXml(NFE_PROC_SAMPLE);
    expect(emit.CNPJ).toBe("11222333000181");
    expect(emit.xNome).toBe("EMPRESA TESTE LTDA");
    expect(emit.xFant).toBe("EMPRESA TESTE");
    expect(emit.IE).toBe("123456789");
    expect(emit.CRT).toBe("1");
    expect(emit.ender.UF).toBe("SP");
    expect(emit.ender.CEP).toBe("01000000");
    expect(emit.ender.cMun).toBe("3550308");
  });

  it("extrai dados do <dest> e endereco", () => {
    const { dest } = parseNfeXml(NFE_PROC_SAMPLE);
    expect(dest.CNPJ).toBe("00000000000100");
    expect(dest.xNome).toBe("CLIENTE TESTE LTDA");
    expect(dest.indIEDest).toBe("2");
    expect(dest.ender?.UF).toBe("SP");
  });

  it("extrai itens (det[])", () => {
    const { itens } = parseNfeXml(NFE_PROC_SAMPLE);
    expect(itens).toHaveLength(1);
    expect(itens[0].nItem).toBe(1);
    expect(itens[0].cProd).toBe("PROD-001");
    expect(itens[0].xProd).toBe("PRODUTO TESTE");
    expect(itens[0].NCM).toBe("87089990");
    expect(itens[0].CFOP).toBe("5102");
    expect(itens[0].qCom).toBe(1);
    expect(itens[0].vUnCom).toBe(100);
    expect(itens[0].vProd).toBe(100);
  });

  it("extrai total/ICMSTot", () => {
    const { total } = parseNfeXml(NFE_PROC_SAMPLE);
    expect(total.vProd).toBe(100);
    expect(total.vNF).toBe(100);
    expect(total.vDesc).toBe(0);
    expect(total.vICMS).toBe(0);
  });

  it("extrai transp e pag", () => {
    const { transp, pag } = parseNfeXml(NFE_PROC_SAMPLE);
    expect(transp?.modFrete).toBe("9");
    expect(pag).toHaveLength(1);
    expect(pag[0].tPag).toBe("90");
    expect(pag[0].vPag).toBe(0);
  });

  it("extrai protNFe (chave + protocolo + cStat)", () => {
    const { protNFe } = parseNfeXml(NFE_PROC_SAMPLE);
    expect(protNFe).not.toBeNull();
    expect(protNFe!.chNFe).toBe("35260511222333000181550010000000011120100012");
    expect(protNFe!.nProt).toBe("135260000000001");
    expect(protNFe!.cStat).toBe(100);
    expect(protNFe!.xMotivo).toBe("Autorizado o uso da NF-e");
  });
});

describe("parseNfeXml — sem wrapper nfeProc (NFe assinada antes do envio)", () => {
  it("aceita <NFe> direto sem <nfeProc>", () => {
    const semProtocol = NFE_PROC_SAMPLE
      .replace(/<nfeProc[^>]*>/, "")
      .replace(/<protNFe[\s\S]*<\/protNFe>/, "")
      .replace(/<\/nfeProc>/, "");
    const parsed = parseNfeXml(semProtocol);
    expect(parsed.chaveAcesso).toBe("35260511222333000181550010000000011120100012");
    expect(parsed.protNFe).toBeNull();
  });
});

describe("parseNfeXml — multiplos itens", () => {
  it("parseia 3 itens em array", () => {
    const tres = NFE_PROC_SAMPLE.replace(
      "</det>",
      `</det>
      <det nItem="2">
        <prod>
          <cProd>PROD-002</cProd>
          <cEAN>SEM GTIN</cEAN>
          <xProd>SEGUNDO PRODUTO</xProd>
          <NCM>11111111</NCM>
          <CFOP>5102</CFOP>
          <uCom>KG</uCom>
          <qCom>2.0000</qCom>
          <vUnCom>50.0000</vUnCom>
          <vProd>100.00</vProd>
          <cEANTrib>SEM GTIN</cEANTrib>
          <uTrib>KG</uTrib>
          <qTrib>2.0000</qTrib>
          <vUnTrib>50.0000</vUnTrib>
          <indTot>1</indTot>
        </prod>
        <imposto><ICMS><ICMSSN102><orig>0</orig><CSOSN>102</CSOSN></ICMSSN102></ICMS></imposto>
      </det>
      <det nItem="3">
        <prod>
          <cProd>PROD-003</cProd>
          <cEAN>SEM GTIN</cEAN>
          <xProd>TERCEIRO PRODUTO</xProd>
          <NCM>22222222</NCM>
          <CFOP>5102</CFOP>
          <uCom>UN</uCom>
          <qCom>5.0000</qCom>
          <vUnCom>20.0000</vUnCom>
          <vProd>100.00</vProd>
          <cEANTrib>SEM GTIN</cEANTrib>
          <uTrib>UN</uTrib>
          <qTrib>5.0000</qTrib>
          <vUnTrib>20.0000</vUnTrib>
          <indTot>1</indTot>
        </prod>
        <imposto><ICMS><ICMSSN102><orig>0</orig><CSOSN>102</CSOSN></ICMSSN102></ICMS></imposto>
      </det>`,
    );

    const { itens } = parseNfeXml(tres);
    expect(itens).toHaveLength(3);
    expect(itens[0].cProd).toBe("PROD-001");
    expect(itens[1].cProd).toBe("PROD-002");
    expect(itens[1].qCom).toBe(2);
    expect(itens[2].cProd).toBe("PROD-003");
  });
});

describe("parseNfeXml — erros", () => {
  it("rejeita XML vazio", () => {
    expect(() => parseNfeXml("")).toThrow(/vazio/);
  });

  it("rejeita XML sem <NFe>", () => {
    expect(() => parseNfeXml("<outroRoot><x/></outroRoot>")).toThrow(/<NFe>/);
  });

  it("rejeita XML malformado", () => {
    expect(() => parseNfeXml("<NFe><infNFe>unclosed")).toThrow();
  });
});

describe("parseNfeXml — XXE safety", () => {
  it("rejeita XML com entidades externas (XXE) lancando erro", () => {
    const malicious = `<?xml version="1.0"?>
<!DOCTYPE root [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
<NFe xmlns="http://www.portalfiscal.inf.br/nfe">
  <infNFe Id="NFe35260511222333000181550010000000011120100012" versao="4.00">
    <ide><cUF>35</cUF><natOp>&xxe;</natOp><mod>55</mod></ide>
  </infNFe>
</NFe>`;
    // fast-xml-parser (com processEntities=false) recusa entidades externas
    // explicitamente — em vez de silenciosamente expandi-las ou nao.
    expect(() => parseNfeXml(malicious)).toThrow(/[Ee]ntities|XXE|external/);
  });
});
