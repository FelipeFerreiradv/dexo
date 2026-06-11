import * as fs from "node:fs";
import * as forge from "node-forge";

import { CertificateManagerService } from "./certificate-manager.service";

/**
 * Carrega certificado digital A1 (.pfx / PKCS#12) do filesystem, descriptografa
 * a senha armazenada no banco e extrai os artefatos necessários para mTLS +
 * assinatura XML-DSig:
 *
 *   - privateKeyPem  → chave privada em PEM (usada para assinar e para mTLS).
 *   - certificatePem → certificado público em PEM (cadeia principal).
 *   - caChainPem[]   → certificados intermediários (cadeia de confiança).
 *   - notAfter       → expiração efetiva do certificado.
 *
 * Cacheia em memória por `pfxPath` com TTL de 5min para evitar reparse a
 * cada chamada. Cache não persiste reinício de processo (segurança).
 */

export interface LoadedCertificate {
  privateKeyPem: string;
  certificatePem: string;
  /** Cadeia intermediária (sem o cert principal nem a CA raiz). */
  caChainPem: string[];
  /** Validade real extraída do X.509. */
  notAfter: Date;
  /** CN do certificado, útil para logging. */
  subjectCN: string | null;
}

interface CacheEntry {
  loadedAt: number;
  cert: LoadedCertificate;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;

export class CertificateLoaderService {
  private cache = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  private readonly manager: CertificateManagerService;

  constructor(
    manager: CertificateManagerService = new CertificateManagerService(),
    ttlMs: number = DEFAULT_TTL_MS,
  ) {
    this.manager = manager;
    this.ttlMs = ttlMs;
  }

  /**
   * Carrega um PFX e retorna os artefatos prontos para uso.
   *
   * @param pfxPath caminho absoluto ao .pfx no disco
   * @param encryptedPassword senha encriptada (formato do CertificateManagerService)
   */
  async load(
    pfxPath: string,
    encryptedPassword: string,
  ): Promise<LoadedCertificate> {
    const cached = this.cache.get(pfxPath);
    if (cached && Date.now() - cached.loadedAt < this.ttlMs) {
      return cached.cert;
    }

    const pfxBuffer = await fs.promises.readFile(pfxPath);
    const password = this.manager.decryptPassword(encryptedPassword);
    const cert = parsePfx(pfxBuffer, password);

    this.cache.set(pfxPath, { loadedAt: Date.now(), cert });
    return cert;
  }

  /** Força recarregar (útil após renovação de certificado). */
  invalidate(pfxPath: string): void {
    this.cache.delete(pfxPath);
  }

  /** Limpa cache inteiro. */
  invalidateAll(): void {
    this.cache.clear();
  }
}

/**
 * Parse standalone — útil para testes que querem evitar I/O de arquivo.
 * Aceita Buffer com o conteúdo binário do .pfx + senha em claro.
 */
export function parsePfx(pfxBuffer: Buffer, password: string): LoadedCertificate {
  const p12Der = forge.util.createBuffer(pfxBuffer.toString("binary"));
  const p12Asn1 = forge.asn1.fromDer(p12Der);
  const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, false, password);

  // ── Chave privada ──
  const pkeyBags = p12.getBags({
    bagType: forge.pki.oids.pkcs8ShroudedKeyBag,
  });
  const pkeyEntries = pkeyBags[forge.pki.oids.pkcs8ShroudedKeyBag] ?? [];
  let pkey: forge.pki.PrivateKey | undefined = pkeyEntries[0]?.key;

  if (!pkey) {
    // Fallback: PFX antigos podem usar keyBag não cifrado
    const altBags = p12.getBags({ bagType: forge.pki.oids.keyBag });
    pkey = altBags[forge.pki.oids.keyBag]?.[0]?.key;
  }

  if (!pkey) {
    throw new Error("PFX nao contem chave privada");
  }

  const privateKeyPem = forge.pki.privateKeyToPem(pkey);

  // ── Certificados ──
  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });
  const entries = certBags[forge.pki.oids.certBag] ?? [];
  const certificates = entries
    .map((b) => b.cert)
    .filter((c): c is forge.pki.Certificate => Boolean(c));

  if (certificates.length === 0) {
    throw new Error("PFX nao contem certificado");
  }

  // O primeiro certificado costuma ser o "principal" (assinante).
  // Identificamos via SubjectKeyIdentifier coincidindo com o da chave privada
  // quando possível. Senão, assume-se o primeiro.
  const primaryCert = findPrimaryCert(certificates, pkey) ?? certificates[0];
  const certificatePem = forge.pki.certificateToPem(primaryCert);

  const caChainPem = certificates
    .filter((c) => c !== primaryCert)
    .map((c) => forge.pki.certificateToPem(c));

  const notAfter = primaryCert.validity.notAfter;
  const cnAttr = primaryCert.subject.getField("CN");
  const subjectCN =
    cnAttr && typeof cnAttr.value === "string" ? cnAttr.value : null;

  return {
    privateKeyPem,
    certificatePem,
    caChainPem,
    notAfter,
    subjectCN,
  };
}

/**
 * Tenta achar o certificado cujo public key corresponde à private key passada.
 * Quando bem-sucedido elimina ambiguidade em PFX com múltiplos certificados.
 */
function findPrimaryCert(
  certificates: forge.pki.Certificate[],
  privateKey: forge.pki.PrivateKey,
): forge.pki.Certificate | null {
  if (!("n" in privateKey)) return null;
  const privModulus = (privateKey as forge.pki.rsa.PrivateKey).n;
  if (!privModulus) return null;

  for (const cert of certificates) {
    const pub = cert.publicKey;
    if (pub && "n" in pub && (pub as forge.pki.rsa.PublicKey).n) {
      if ((pub as forge.pki.rsa.PublicKey).n.equals(privModulus)) {
        return cert;
      }
    }
  }
  return null;
}
