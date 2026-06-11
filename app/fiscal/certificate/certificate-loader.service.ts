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

/**
 * Extrai o CNPJ (14 dígitos) do CN de um certificado A1 e-CNPJ. O CN tem o
 * formato "RAZAO SOCIAL:CNPJ" (ex.: "CENTRO DE DESMONTE JOTABE LTDA:51195502000156").
 * Retorna o último grupo de 14 dígitos encontrado, ou null se não houver.
 */
export function extractCnpjFromCert(subjectCN: string | null): string | null {
  if (!subjectCN) return null;
  const matches = subjectCN.match(/\d{14}/g);
  return matches && matches.length ? matches[matches.length - 1] : null;
}

export interface CertEmitterValidation {
  ok: boolean;
  /** Mensagem amigável quando ok=false. */
  error?: string;
  /** Validade extraída do X.509 (presente quando o .pfx abriu). */
  notAfter?: Date;
  subjectCN?: string | null;
  /** CNPJ extraído do certificado (14 dígitos) ou null. */
  certCnpj?: string | null;
  /**
   * true quando a base de 8 dígitos do CNPJ do certificado bate com a do
   * emissor. false quando não foi possível confirmar (CN sem CNPJ ou emissor
   * vazio) — nesse caso não bloqueamos, apenas sinalizamos.
   */
  cnpjMatched?: boolean;
}

/**
 * Valida um .pfx para uso como certificado do emissor — função pura (sem I/O de
 * disco nem banco), reusada pela rota de upload e pelos testes:
 *   1. abre o PKCS#12 com a senha (prova que a senha está correta);
 *   2. confere que o certificado não está expirado;
 *   3. confere que o CNPJ do certificado pertence ao emissor pela BASE de 8
 *      dígitos — a SEFAZ rejeita NFe assinada por certificado de CNPJ diferente
 *      do emitente. Divergência de base é bloqueante; matriz/filial (mesma base,
 *      sufixo diferente) é permitido.
 */
export function validateCertForEmitter(
  pfxBuffer: Buffer,
  senha: string,
  emitterCnpj: string | null | undefined,
): CertEmitterValidation {
  let cert: LoadedCertificate;
  try {
    cert = parsePfx(pfxBuffer, senha);
  } catch {
    return {
      ok: false,
      error:
        "Não foi possível abrir o certificado com a senha informada. " +
        "Verifique a senha e se o arquivo é um A1 válido (.pfx / PKCS#12).",
    };
  }

  if (cert.notAfter.getTime() < Date.now()) {
    return {
      ok: false,
      error:
        `Certificado expirado em ${cert.notAfter.toLocaleDateString("pt-BR")}. ` +
        "Renove o A1 antes de enviar.",
      notAfter: cert.notAfter,
      subjectCN: cert.subjectCN,
    };
  }

  const certCnpj = extractCnpjFromCert(cert.subjectCN);
  const emitter = (emitterCnpj ?? "").replace(/\D/g, "");
  const baseMatches = Boolean(
    certCnpj && emitter && certCnpj.slice(0, 8) === emitter.slice(0, 8),
  );

  if (certCnpj && emitter && !baseMatches) {
    return {
      ok: false,
      error:
        `O certificado pertence ao CNPJ ${certCnpj}, diferente do CNPJ do ` +
        `emissor (${emitter}). A SEFAZ rejeita NF-e assinada por certificado ` +
        "de outro CNPJ. Use o A1 da empresa emitente ou corrija o CNPJ na " +
        "aba Identificação.",
      notAfter: cert.notAfter,
      subjectCN: cert.subjectCN,
      certCnpj,
      cnpjMatched: false,
    };
  }

  return {
    ok: true,
    notAfter: cert.notAfter,
    subjectCN: cert.subjectCN,
    certCnpj,
    cnpjMatched: baseMatches,
  };
}
