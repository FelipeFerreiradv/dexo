import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { CertificateManagerService } from "../../app/fiscal/certificate/certificate-manager.service";

const VALID_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"; // 64 hex

describe("CertificateManagerService — chave de cifragem (SEG-1)", () => {
  const orig = {
    key: process.env.FISCAL_CERT_ENC_KEY,
    nodeEnv: process.env.NODE_ENV,
    prodUnlocked: process.env.FISCAL_PRODUCTION_UNLOCKED,
  };

  beforeEach(() => {
    delete process.env.FISCAL_CERT_ENC_KEY;
    delete process.env.FISCAL_PRODUCTION_UNLOCKED;
    // vitest roda com NODE_ENV=test; deixamos assim por padrao
  });

  afterEach(() => {
    restore("FISCAL_CERT_ENC_KEY", orig.key);
    restore("NODE_ENV", orig.nodeEnv);
    restore("FISCAL_PRODUCTION_UNLOCKED", orig.prodUnlocked);
  });

  it("cifra e decifra com chave hex de 64 chars valida (round-trip)", () => {
    process.env.FISCAL_CERT_ENC_KEY = VALID_KEY;
    const mgr = new CertificateManagerService();
    const senha = "senha-do-certificado-A1";
    const enc = mgr.encryptPassword(senha);
    expect(enc).not.toContain(senha);
    expect(enc.split(":")).toHaveLength(3); // iv:tag:ciphertext
    expect(mgr.decryptPassword(enc)).toBe(senha);
  });

  it("FAIL-CLOSED: aborta em producao (NODE_ENV=production) sem a chave", () => {
    process.env.NODE_ENV = "production";
    expect(() => new CertificateManagerService()).toThrow(
      /FISCAL_CERT_ENC_KEY/,
    );
  });

  it("FAIL-CLOSED: aborta quando FISCAL_PRODUCTION_UNLOCKED=true sem a chave", () => {
    process.env.FISCAL_PRODUCTION_UNLOCKED = "true";
    expect(() => new CertificateManagerService()).toThrow(
      /FISCAL_CERT_ENC_KEY/,
    );
  });

  it("FAIL-CLOSED: rejeita chave com tamanho/charset invalido em producao", () => {
    process.env.NODE_ENV = "production";
    process.env.FISCAL_CERT_ENC_KEY = "curta"; // nao-hex e < 64
    expect(() => new CertificateManagerService()).toThrow(
      /FISCAL_CERT_ENC_KEY/,
    );
  });

  it("rejeita chave hex com chars invalidos mesmo com 64 de comprimento", () => {
    process.env.NODE_ENV = "production";
    // 64 chars mas com 'z' (nao-hex) — Buffer.from truncaria silenciosamente
    process.env.FISCAL_CERT_ENC_KEY = "z".repeat(64);
    expect(() => new CertificateManagerService()).toThrow(
      /FISCAL_CERT_ENC_KEY/,
    );
  });

  it("fora de producao, sem chave, usa fallback de dev (nao aborta)", () => {
    // NODE_ENV=test (default vitest), sem prod unlock → fallback de dev
    const mgr = new CertificateManagerService();
    const enc = mgr.encryptPassword("x");
    expect(mgr.decryptPassword(enc)).toBe("x");
  });
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
