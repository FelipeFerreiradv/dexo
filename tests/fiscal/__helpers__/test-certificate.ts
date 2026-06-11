import * as forge from "node-forge";

export interface TestCertificate {
  /** Buffer com o conteúdo binário do PFX. */
  pfxBuffer: Buffer;
  /** Senha em claro do PFX. */
  password: string;
  /** PEM da chave privada (mesmo conteúdo que sai do parser do PFX). */
  privateKeyPem: string;
  /** PEM do certificado público. */
  certificatePem: string;
  /** Validade (notAfter). */
  notAfter: Date;
  /** CN do subject. */
  subjectCN: string;
}

/**
 * Gera um certificado RSA self-signed + chave privada + PFX em memória.
 * Pensado para testes que precisem parsear PFX, assinar XML ou exercitar mTLS
 * — sem depender de fixtures binárias no repo.
 */
export function generateTestCertificate(options?: {
  password?: string;
  subjectCN?: string;
  daysValid?: number;
  keyBits?: number;
}): TestCertificate {
  const password = options?.password ?? "test-pass";
  const subjectCN = options?.subjectCN ?? "DEXO TEST CERT";
  const daysValid = options?.daysValid ?? 365;
  const keyBits = options?.keyBits ?? 2048;

  const keypair = forge.pki.rsa.generateKeyPair(keyBits);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keypair.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(
    Date.now() + daysValid * 24 * 60 * 60 * 1000,
  );

  const attrs: forge.pki.CertificateField[] = [
    { name: "commonName", value: subjectCN },
    { name: "countryName", value: "BR" },
    { name: "organizationName", value: "Dexo Test" },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs); // self-signed
  cert.setExtensions([
    { name: "basicConstraints", cA: false },
    {
      name: "keyUsage",
      digitalSignature: true,
      keyEncipherment: true,
    },
    {
      name: "extKeyUsage",
      clientAuth: true,
    },
  ]);
  cert.sign(keypair.privateKey, forge.md.sha256.create());

  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(
    keypair.privateKey,
    [cert],
    password,
    { algorithm: "3des" },
  );
  const p12Der = forge.asn1.toDer(p12Asn1).getBytes();
  const pfxBuffer = Buffer.from(p12Der, "binary");

  return {
    pfxBuffer,
    password,
    privateKeyPem: forge.pki.privateKeyToPem(keypair.privateKey),
    certificatePem: forge.pki.certificateToPem(cert),
    notAfter: cert.validity.notAfter,
    subjectCN,
  };
}
