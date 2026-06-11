import { SignedXml } from "xml-crypto";

/**
 * Assinatura XML-DSig conforme exigido pela SEFAZ para NFe modelo 55 v4.00,
 * eventos (cancelamento/CC-e) e inutilização.
 *
 * Defaults seguem a NT 2014.002 v4.00:
 *   - CanonicalizationMethod: http://www.w3.org/TR/2001/REC-xml-c14n-20010315
 *     (C14N **inclusiva**, NÃO exclusiva — apesar da literatura genérica de
 *     XML-DSig sugerir exclusiva)
 *   - SignatureMethod: http://www.w3.org/2000/09/xmldsig#rsa-sha1
 *   - DigestMethod:    http://www.w3.org/2000/09/xmldsig#sha1
 *   - Reference Transforms:
 *       1. http://www.w3.org/2000/09/xmldsig#enveloped-signature
 *       2. http://www.w3.org/TR/2001/REC-xml-c14n-20010315
 *
 * O <Signature> é inserido como **irmão imediato à direita** do elemento
 * referenciado (infNFe / infEvento / infInut).
 */

const C14N_INCLUSIVE = "http://www.w3.org/TR/2001/REC-xml-c14n-20010315";
const RSA_SHA1 = "http://www.w3.org/2000/09/xmldsig#rsa-sha1";
const RSA_SHA256 = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";
const SHA1 = "http://www.w3.org/2000/09/xmldsig#sha1";
const SHA256 = "http://www.w3.org/2001/04/xmlenc#sha256";
const ENVELOPED = "http://www.w3.org/2000/09/xmldsig#enveloped-signature";

export type DigestAlgorithm = "sha1" | "sha256";

export interface SignOptions {
  /** XML cru (UTF-8, sem BOM). */
  xml: string;
  privateKeyPem: string;
  certificatePem: string;
  /**
   * Nome local do elemento a assinar.
   * NFe: "infNFe"; evento: "infEvento"; inutilização: "infInut".
   */
  referenceElement: "infNFe" | "infEvento" | "infInut";
  /** Default sha1 (NFe v4.00). Eventos podem requerer sha256 em casos específicos. */
  digestAlgorithm?: DigestAlgorithm;
  signatureAlgorithm?: DigestAlgorithm;
}

export class XmlSignerService {
  sign(options: SignOptions): string {
    const {
      xml,
      privateKeyPem,
      certificatePem,
      referenceElement,
      digestAlgorithm = "sha1",
      signatureAlgorithm = "sha1",
    } = options;

    if (!xml || typeof xml !== "string") {
      throw new Error("xml-signer: xml ausente");
    }
    if (!privateKeyPem || !certificatePem) {
      throw new Error("xml-signer: privateKey/certificate ausente");
    }

    const signer = new SignedXml({
      privateKey: privateKeyPem,
      publicCert: certificatePem,
      canonicalizationAlgorithm: C14N_INCLUSIVE,
      signatureAlgorithm:
        signatureAlgorithm === "sha256" ? RSA_SHA256 : RSA_SHA1,
    });

    const referenceXpath = `//*[local-name(.)='${referenceElement}']`;

    signer.addReference({
      xpath: referenceXpath,
      digestAlgorithm: digestAlgorithm === "sha256" ? SHA256 : SHA1,
      transforms: [ENVELOPED, C14N_INCLUSIVE],
    });

    signer.computeSignature(xml, {
      prefix: "",
      location: { reference: referenceXpath, action: "after" },
    });

    return signer.getSignedXml();
  }
}

/**
 * Extrai o bloco <Signature>...</Signature> de um XML assinado.
 *
 * Útil para testes e para auditoria — não é usado no fluxo normal de envio
 * (o SEFAZ recebe o XML completo com Signature inline).
 */
export function extractSignatureNode(signedXml: string): string | null {
  const match = signedXml.match(/<Signature[\s\S]*?<\/Signature>/);
  return match ? match[0] : null;
}
