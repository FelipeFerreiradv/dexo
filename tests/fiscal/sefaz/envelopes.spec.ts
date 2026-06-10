import { describe, it, expect } from "vitest";
import {
  buildEnviNFeEnvelope,
  buildConsReciNFeEnvelope,
  buildConsSitNFeEnvelope,
  buildEnvEventoEnvelope,
  buildInutNFeEnvelope,
  SOAP_ACTIONS,
} from "../../../app/fiscal/sefaz/envelopes";

const SIGNED_NFE = "<NFe><infNFe Id='NFe1'>...</infNFe><Signature>X</Signature></NFe>";

describe("envelopes — buildEnviNFeEnvelope", () => {
  it("preserva byte-a-byte o XML assinado embarcado (nao re-canoniza)", () => {
    const env = buildEnviNFeEnvelope({
      signedNfeXml: SIGNED_NFE,
      tpAmb: "2",
      idLote: "1700000000001",
    });
    expect(env).toContain(SIGNED_NFE);
  });

  it("envelopa em SOAP 1.2 com namespace NFeAutorizacao4", () => {
    const env = buildEnviNFeEnvelope({
      signedNfeXml: SIGNED_NFE,
      tpAmb: "2",
      idLote: "1",
    });
    expect(env).toContain('xmlns:soap="http://www.w3.org/2003/05/soap-envelope"');
    expect(env).toContain(
      'xmlns:nfe="http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4"',
    );
    expect(env).toContain("<soap:Body>");
    expect(env).toContain("<nfe:nfeDadosMsg>");
    expect(env).toContain("</soap:Envelope>");
  });

  it("inclui idLote + indSinc=1 por default", () => {
    const env = buildEnviNFeEnvelope({
      signedNfeXml: SIGNED_NFE,
      tpAmb: "2",
      idLote: "123",
    });
    expect(env).toContain("<idLote>123</idLote>");
    expect(env).toContain("<indSinc>1</indSinc>");
  });

  it("indSinc=0 quando explicitamente solicitado", () => {
    const env = buildEnviNFeEnvelope({
      signedNfeXml: SIGNED_NFE,
      tpAmb: "2",
      idLote: "1",
      indSinc: "0",
    });
    expect(env).toContain("<indSinc>0</indSinc>");
  });

  it("escapa idLote contra injecao", () => {
    const env = buildEnviNFeEnvelope({
      signedNfeXml: SIGNED_NFE,
      tpAmb: "2",
      idLote: "<script>",
    });
    expect(env).toContain("&lt;script&gt;");
    expect(env).not.toContain("<idLote><script>");
  });
});

describe("envelopes — buildConsReciNFeEnvelope", () => {
  it("monta payload com nRec + tpAmb", () => {
    const env = buildConsReciNFeEnvelope({ tpAmb: "2", nRec: "987654321012345" });
    expect(env).toContain('<consReciNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">');
    expect(env).toContain("<tpAmb>2</tpAmb>");
    expect(env).toContain("<nRec>987654321012345</nRec>");
    expect(env).toContain(
      'xmlns:nfe="http://www.portalfiscal.inf.br/nfe/wsdl/NFeRetAutorizacao4"',
    );
  });
});

describe("envelopes — buildConsSitNFeEnvelope", () => {
  it("monta payload com chNFe + xServ=CONSULTAR", () => {
    const env = buildConsSitNFeEnvelope({
      tpAmb: "2",
      chNFe: "35260400000000000100550010000000011000000017",
    });
    expect(env).toContain("<xServ>CONSULTAR</xServ>");
    expect(env).toContain("<chNFe>35260400000000000100550010000000011000000017</chNFe>");
    expect(env).toContain(
      'xmlns:nfe="http://www.portalfiscal.inf.br/nfe/wsdl/NFeConsultaProtocolo4"',
    );
  });
});

describe("SOAP_ACTIONS", () => {
  it("expoe os action URIs canonicos", () => {
    expect(SOAP_ACTIONS.NFeAutorizacao4).toMatch(/nfeAutorizacaoLote$/);
    expect(SOAP_ACTIONS.NFeRetAutorizacao4).toMatch(/nfeRetAutorizacaoLote$/);
    expect(SOAP_ACTIONS.NfeConsultaProtocolo4).toMatch(/nfeConsultaNF$/);
    expect(SOAP_ACTIONS.RecepcaoEvento4).toMatch(/nfeRecepcaoEvento$/);
    expect(SOAP_ACTIONS.NfeInutilizacao4).toMatch(/nfeInutilizacaoNF$/);
  });
});

describe("envelopes — buildEnvEventoEnvelope (cancelamento / CCe)", () => {
  const SIGNED_EVENTO = '<evento versao="1.00"><infEvento Id="ID..."/><Signature/></evento>';

  it("preserva XML do evento byte-a-byte", () => {
    const env = buildEnvEventoEnvelope({
      signedEventoXml: SIGNED_EVENTO,
      idLote: "42",
    });
    expect(env).toContain(SIGNED_EVENTO);
  });

  it("monta envEvento com namespace + idLote", () => {
    const env = buildEnvEventoEnvelope({
      signedEventoXml: SIGNED_EVENTO,
      idLote: "42",
    });
    expect(env).toContain('<envEvento xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.00">');
    expect(env).toContain("<idLote>42</idLote>");
    expect(env).toContain(
      'xmlns:nfe="http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4"',
    );
  });

  it("escapa idLote", () => {
    const env = buildEnvEventoEnvelope({
      signedEventoXml: SIGNED_EVENTO,
      idLote: "<x>",
    });
    expect(env).toContain("<idLote>&lt;x&gt;</idLote>");
  });
});

describe("envelopes — buildInutNFeEnvelope", () => {
  const SIGNED_INUT = '<inutNFe versao="4.00"><infInut Id="ID..."/><Signature/></inutNFe>';

  it("preserva XML da inutilizacao byte-a-byte", () => {
    const env = buildInutNFeEnvelope({ signedInutNFeXml: SIGNED_INUT });
    expect(env).toContain(SIGNED_INUT);
  });

  it("envelopa em SOAP 1.2 com namespace NfeInutilizacao4", () => {
    const env = buildInutNFeEnvelope({ signedInutNFeXml: SIGNED_INUT });
    expect(env).toContain(
      'xmlns:nfe="http://www.portalfiscal.inf.br/nfe/wsdl/NFeInutilizacao4"',
    );
    expect(env).toContain("<soap:Body>");
    expect(env).toContain("</soap:Envelope>");
  });
});
