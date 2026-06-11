import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { CertificateManagerService } from "../../app/fiscal/certificate/certificate-manager.service";

const VALID_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"; // 64 hex

describe("CertificateManagerService — chave de cifragem (SEG-1)", () => {
  beforeEach(() => {
    vi.stubEnv("FISCAL_CERT_ENC_KEY", "");
    vi.stubEnv("FISCAL_PRODUCTION_UNLOCKED", "");
    // NODE_ENV permanece o do vitest (test) por padrao; testes que precisam de
    // producao fazem stub explicito.
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("cifra e decifra com chave hex de 64 chars valida (round-trip)", () => {
    vi.stubEnv("FISCAL_CERT_ENC_KEY", VALID_KEY);
    const mgr = new CertificateManagerService();
    const senha = "senha-do-certificado-A1";
    const enc = mgr.encryptPassword(senha);
    expect(enc).not.toContain(senha);
    expect(enc.split(":")).toHaveLength(3); // iv:tag:ciphertext
    expect(mgr.decryptPassword(enc)).toBe(senha);
  });

  it("FAIL-CLOSED: aborta em producao (NODE_ENV=production) sem a chave", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => new CertificateManagerService()).toThrow(
      /FISCAL_CERT_ENC_KEY/,
    );
  });

  it("FAIL-CLOSED: aborta quando FISCAL_PRODUCTION_UNLOCKED=true sem a chave", () => {
    vi.stubEnv("FISCAL_PRODUCTION_UNLOCKED", "true");
    expect(() => new CertificateManagerService()).toThrow(
      /FISCAL_CERT_ENC_KEY/,
    );
  });

  it("FAIL-CLOSED: rejeita chave com tamanho/charset invalido em producao", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("FISCAL_CERT_ENC_KEY", "curta"); // nao-hex e < 64
    expect(() => new CertificateManagerService()).toThrow(
      /FISCAL_CERT_ENC_KEY/,
    );
  });

  it("rejeita chave hex com chars invalidos mesmo com 64 de comprimento", () => {
    vi.stubEnv("NODE_ENV", "production");
    // 64 chars mas com 'z' (nao-hex) — Buffer.from truncaria silenciosamente
    vi.stubEnv("FISCAL_CERT_ENC_KEY", "z".repeat(64));
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
