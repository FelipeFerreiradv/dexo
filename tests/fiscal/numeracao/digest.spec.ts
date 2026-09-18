import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

import { extrairDigestValue } from "../../../app/fiscal/sefaz/digest";
import { XmlSignerService } from "../../../app/fiscal/sefaz/xml-signer.service";
import { NfeXmlBuilderSefazService } from "../../../app/fiscal/sefaz/nfe-xml-builder-sefaz.service";
import { generateTestCertificate } from "../__helpers__/test-certificate";
import { makeConfig, makeDraft } from "../__helpers__/test-draft";

// Numeração V2: o DigestValue da assinatura do infNFe é a prova de posse numa
// duplicidade (consulta devolve digVal). Só vale a Reference do infNFe.

const CHAVE = "35260511222333000181550010000000011876543210";

function nfeSintetica(opts: {
  referencias: Array<{ uri: string; digest: string; prefixo?: string }>;
  comSupl?: boolean;
}): string {
  const refs = opts.referencias
    .map(({ uri, digest, prefixo }) => {
      const p = prefixo ? `${prefixo}:` : "";
      return (
        `<${p}Reference URI="${uri}"><${p}Transforms/>` +
        `<${p}DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"/>` +
        `<${p}DigestValue>${digest}</${p}DigestValue></${p}Reference>`
      );
    })
    .join("");
  return (
    `<NFe xmlns="http://www.portalfiscal.inf.br/nfe">` +
    `<infNFe Id="NFe${CHAVE}" versao="4.00"><ide/></infNFe>` +
    (opts.comSupl
      ? `<infNFeSupl><qrCode><![CDATA[https://x/?p=1]]></qrCode><urlChave>u</urlChave></infNFeSupl>`
      : "") +
    `<Signature xmlns="http://www.w3.org/2000/09/xmldsig#"><SignedInfo>${refs}</SignedInfo>` +
    `<SignatureValue>zzz</SignatureValue></Signature></NFe>`
  );
}

describe("extrairDigestValue — XML sintético", () => {
  it("devolve o DigestValue da Reference que aponta para o Id do infNFe", () => {
    const xml = nfeSintetica({
      referencias: [{ uri: `#NFe${CHAVE}`, digest: "q1w2e3r4t5y6u7i8o9p0asdfghj=" }],
    });
    expect(extrairDigestValue(xml)).toBe("q1w2e3r4t5y6u7i8o9p0asdfghj=");
  });

  it("ignora References de outros nós (evento/infInut) e escolhe a do infNFe", () => {
    const xml = nfeSintetica({
      referencias: [
        { uri: "#ID1101113526051122233300018155001000000001187654321001", digest: "EVENTO==" },
        { uri: "#ID35260511222333000181550010000000010000000001", digest: "INUT==" },
        { uri: `#NFe${CHAVE}`, digest: "NFE==" },
      ],
    });
    expect(extrairDigestValue(xml)).toBe("NFE==");
  });

  it("aceita prefixo de namespace (ds:Reference / ds:DigestValue)", () => {
    const xml = nfeSintetica({
      referencias: [{ uri: `#NFe${CHAVE}`, digest: "PREFIXADO=", prefixo: "ds" }],
    });
    expect(extrairDigestValue(xml)).toBe("PREFIXADO=");
  });

  it("NFC-e: <infNFeSupl> não é confundido com o infNFe", () => {
    const xml = nfeSintetica({
      referencias: [{ uri: `#NFe${CHAVE}`, digest: "NFCE=" }],
      comSupl: true,
    });
    expect(extrairDigestValue(xml)).toBe("NFCE=");
  });

  it("remove quebras de linha/espaços dentro do base64", () => {
    const xml = nfeSintetica({
      referencias: [{ uri: `#NFe${CHAVE}`, digest: "\n  abcd\r\n efgh= \n" }],
    });
    expect(extrairDigestValue(xml)).toBe("abcdefgh=");
  });

  it("Reference que não aponta para o infNFe ⇒ null (nunca pega outra)", () => {
    const xml = nfeSintetica({
      referencias: [{ uri: "#NFe99999999999999999999999999999999999999999999", digest: "OUTRA=" }],
    });
    expect(extrairDigestValue(xml)).toBeNull();
  });

  it("sem infNFe com Id (ex.: evento assinado) ⇒ null", () => {
    const evento =
      `<evento><infEvento Id="ID110111${CHAVE}01"/>` +
      `<Signature><SignedInfo><Reference URI="#ID110111${CHAVE}01">` +
      `<DigestValue>EVT=</DigestValue></Reference></SignedInfo></Signature></evento>`;
    expect(extrairDigestValue(evento)).toBeNull();
  });

  it("DigestValue vazio ou ausente ⇒ null", () => {
    expect(
      extrairDigestValue(nfeSintetica({ referencias: [{ uri: `#NFe${CHAVE}`, digest: "  " }] })),
    ).toBeNull();
    const semDigest =
      `<NFe><infNFe Id="NFe${CHAVE}"/><Signature><SignedInfo>` +
      `<Reference URI="#NFe${CHAVE}"></Reference></SignedInfo></Signature></NFe>`;
    expect(extrairDigestValue(semDigest)).toBeNull();
  });

  it("entrada vazia ou não-string ⇒ null (nunca lança)", () => {
    expect(extrairDigestValue("")).toBeNull();
    expect(extrairDigestValue(undefined as unknown as string)).toBeNull();
    expect(extrairDigestValue(null as unknown as string)).toBeNull();
    expect(extrairDigestValue(123 as unknown as string)).toBeNull();
  });

  it("é pura: chamadas repetidas dão o mesmo resultado (sem estado de RegExp global)", () => {
    const xml = nfeSintetica({ referencias: [{ uri: `#NFe${CHAVE}`, digest: "REPETE=" }] });
    for (let i = 0; i < 5; i++) expect(extrairDigestValue(xml)).toBe("REPETE=");
  });

  it("módulo não importa nada (seguro para qualquer camada)", () => {
    const fonte = fs.readFileSync(
      path.resolve(__dirname, "../../../app/fiscal/sefaz/digest.ts"),
      "utf-8",
    );
    expect(fonte).not.toMatch(/^\s*import\s/m);
    expect(fonte).not.toMatch(/require\(/);
  });
});

describe("extrairDigestValue — XML assinado de verdade (XmlSignerService)", () => {
  let privateKeyPem: string;
  let certificatePem: string;

  beforeAll(() => {
    const tc = generateTestCertificate();
    privateKeyPem = tc.privateKeyPem;
    certificatePem = tc.certificatePem;
  });

  function assinar(cNF: string): { signed: string; chave: string } {
    const built = new NfeXmlBuilderSefazService().build({
      draft: makeDraft(),
      config: makeConfig(),
      numero: 1,
      dhEmi: new Date("2026-05-14T15:00:00-03:00"),
      cNF,
    });
    const signed = new XmlSignerService().sign({
      xml: built.xml,
      privateKeyPem,
      certificatePem,
      referenceElement: "infNFe",
    });
    return { signed, chave: built.chaveAcesso };
  }

  it("extrai o SHA-1 base64 (28 chars) da Reference #NFe<chave> gerada pelo signer", () => {
    const { signed, chave } = assinar("87654321");
    const digest = extrairDigestValue(signed);
    expect(digest).not.toBeNull();
    expect(digest).toMatch(/^[A-Za-z0-9+/]{27}=$/);
    // A Reference do signer aponta para o Id do infNFe e carrega esse digest.
    expect(signed).toContain(`URI="#NFe${chave}"`);
    expect(signed).toContain(`<DigestValue>${digest}</DigestValue>`);
  });

  it("conteúdo diferente (outro cNF) ⇒ digest diferente; mesmo conteúdo ⇒ mesmo digest", () => {
    const a1 = extrairDigestValue(assinar("87654321").signed);
    const a2 = extrairDigestValue(assinar("87654321").signed);
    const b = extrairDigestValue(assinar("12348765").signed);
    expect(a1).toBe(a2);
    expect(b).not.toBe(a1);
  });
});
