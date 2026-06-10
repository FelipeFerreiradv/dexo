import { describe, it, expect, beforeAll } from "vitest";
import { XmlSignerService, extractSignatureNode } from "../../../app/fiscal/sefaz/xml-signer.service";
import {
  generateTestCertificate,
  type TestCertificate,
} from "../__helpers__/test-certificate";

describe("XmlSignerService", () => {
  let tc: TestCertificate;
  let signer: XmlSignerService;

  beforeAll(() => {
    tc = generateTestCertificate({ subjectCN: "DEXO SIGNER TEST" });
    signer = new XmlSignerService();
  });

  const buildNfeXml = (chave = "35260400000000000100550010000000011000000017") => `
<NFe xmlns="http://www.portalfiscal.inf.br/nfe">
  <infNFe Id="NFe${chave}" versao="4.00">
    <ide><cUF>35</cUF><natOp>VENDA</natOp></ide>
    <emit><CNPJ>00000000000100</CNPJ><xNome>EMPRESA TESTE</xNome></emit>
    <dest><CNPJ>11222333000181</CNPJ><xNome>CLIENTE TESTE</xNome></dest>
    <total><ICMSTot><vNF>100.00</vNF></ICMSTot></total>
  </infNFe>
</NFe>`.trim();

  it("assina infNFe e insere <Signature> apos o elemento referenciado", () => {
    const signed = signer.sign({
      xml: buildNfeXml(),
      privateKeyPem: tc.privateKeyPem,
      certificatePem: tc.certificatePem,
      referenceElement: "infNFe",
    });

    expect(signed).toContain("<Signature");
    expect(signed).toContain("</Signature>");
    // Signature deve aparecer DEPOIS de infNFe fechar e ANTES de </NFe>
    const infNfeClose = signed.indexOf("</infNFe>");
    const sigStart = signed.indexOf("<Signature");
    const nfeClose = signed.indexOf("</NFe>");
    expect(infNfeClose).toBeGreaterThan(-1);
    expect(sigStart).toBeGreaterThan(infNfeClose);
    expect(nfeClose).toBeGreaterThan(sigStart);
  });

  it("inclui Reference URI apontando para o Id do infNFe", () => {
    const chave = "35260400000000000100550010000000011000000017";
    const signed = signer.sign({
      xml: buildNfeXml(chave),
      privateKeyPem: tc.privateKeyPem,
      certificatePem: tc.certificatePem,
      referenceElement: "infNFe",
    });

    expect(signed).toMatch(new RegExp(`URI="#NFe${chave}"`));
  });

  it("usa SHA-1 + RSA-SHA1 + C14N inclusivo por default (NFe v4.00)", () => {
    const signed = signer.sign({
      xml: buildNfeXml(),
      privateKeyPem: tc.privateKeyPem,
      certificatePem: tc.certificatePem,
      referenceElement: "infNFe",
    });

    expect(signed).toContain(
      'Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"',
    );
    expect(signed).toContain('Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"');
    expect(signed).toContain(
      'Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"',
    );
    expect(signed).toContain(
      'Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"',
    );
  });

  it("inclui X509Certificate no KeyInfo (sem cabecalhos PEM)", () => {
    const signed = signer.sign({
      xml: buildNfeXml(),
      privateKeyPem: tc.privateKeyPem,
      certificatePem: tc.certificatePem,
      referenceElement: "infNFe",
    });

    expect(signed).toContain("<X509Certificate>");
    // O conteudo do X509Certificate eh apenas base64 (sem -----BEGIN-----).
    const match = signed.match(/<X509Certificate>([\s\S]*?)<\/X509Certificate>/);
    expect(match).not.toBeNull();
    expect(match![1]).not.toContain("BEGIN CERTIFICATE");
  });

  it("aceita SHA-256 quando solicitado (eventos pos-2020)", () => {
    const signed = signer.sign({
      xml: buildNfeXml(),
      privateKeyPem: tc.privateKeyPem,
      certificatePem: tc.certificatePem,
      referenceElement: "infNFe",
      digestAlgorithm: "sha256",
      signatureAlgorithm: "sha256",
    });

    expect(signed).toContain(
      'Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"',
    );
    expect(signed).toContain(
      'Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"',
    );
  });

  it("assina infEvento (cancelamento) corretamente", () => {
    const eventoXml = `
<evento xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.00">
  <infEvento Id="ID110111352604000000000001005500100000000010000000170100000001">
    <cOrgao>35</cOrgao>
    <tpAmb>2</tpAmb>
    <CNPJ>00000000000100</CNPJ>
    <chNFe>35260400000000000100550010000000011000000017</chNFe>
    <dhEvento>2026-05-14T12:00:00-03:00</dhEvento>
    <tpEvento>110111</tpEvento>
    <nSeqEvento>1</nSeqEvento>
    <verEvento>1.00</verEvento>
    <detEvento versao="1.00"><descEvento>Cancelamento</descEvento></detEvento>
  </infEvento>
</evento>`.trim();

    const signed = signer.sign({
      xml: eventoXml,
      privateKeyPem: tc.privateKeyPem,
      certificatePem: tc.certificatePem,
      referenceElement: "infEvento",
    });

    expect(signed).toContain(
      'URI="#ID110111352604000000000001005500100000000010000000170100000001"',
    );
    const sigNode = extractSignatureNode(signed);
    expect(sigNode).not.toBeNull();
  });

  it("rejeita input vazio", () => {
    expect(() =>
      signer.sign({
        xml: "",
        privateKeyPem: tc.privateKeyPem,
        certificatePem: tc.certificatePem,
        referenceElement: "infNFe",
      }),
    ).toThrow();

    expect(() =>
      signer.sign({
        xml: buildNfeXml(),
        privateKeyPem: "",
        certificatePem: tc.certificatePem,
        referenceElement: "infNFe",
      }),
    ).toThrow();
  });

  it("nao quebra a estrutura do infNFe (Id preservado)", () => {
    const xml = buildNfeXml();
    const signed = signer.sign({
      xml,
      privateKeyPem: tc.privateKeyPem,
      certificatePem: tc.certificatePem,
      referenceElement: "infNFe",
    });
    // O Id do infNFe deve continuar presente, no mesmo lugar
    expect(signed).toContain(
      'Id="NFe35260400000000000100550010000000011000000017"',
    );
    expect(signed).toContain("</infNFe>");
  });
});

describe("extractSignatureNode", () => {
  it("retorna null quando nao ha Signature", () => {
    expect(extractSignatureNode("<NFe></NFe>")).toBeNull();
  });

  it("extrai o bloco <Signature> integral", () => {
    const xml = "<NFe><Signature xmlns='ns'><a/></Signature></NFe>";
    const node = extractSignatureNode(xml);
    expect(node).toBe("<Signature xmlns='ns'><a/></Signature>");
  });
});
