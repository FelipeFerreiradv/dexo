import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * PR-A5 (infra) — cifra AES-256-GCM para tokens em repouso.
 * Importante: o módulo resolve a chave UMA vez (cache). Para alternar
 * enabled/disabled entre testes, recarregamos o módulo com vi.resetModules.
 */

const KEY = "a".repeat(64); // 32 bytes hex válidos

async function loadCipher() {
  const mod = await import("../../app/lib/secret-cipher");
  return mod.SecretCipher;
}

describe("PR-A5: SecretCipher desligada (sem chave) = no-op", () => {
  beforeEach(() => {
    delete process.env.MARKETPLACE_TOKEN_ENC_KEY;
    vi.resetModules();
  });

  it("isEnabled false; encrypt/tryDecrypt devolvem o valor como está", async () => {
    const Cipher = await loadCipher();
    expect(Cipher.isEnabled()).toBe(false);
    expect(Cipher.encrypt("plain-token")).toBe("plain-token");
    expect(Cipher.tryDecrypt("plain-token")).toBe("plain-token");
  });
});

describe("PR-A5: SecretCipher ligada (com chave)", () => {
  beforeEach(() => {
    process.env.MARKETPLACE_TOKEN_ENC_KEY = KEY;
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.MARKETPLACE_TOKEN_ENC_KEY;
  });

  it("encrypt produz formato iv:tag:ct e roundtrip decifra", async () => {
    const Cipher = await loadCipher();
    expect(Cipher.isEnabled()).toBe(true);
    const enc = Cipher.encrypt("APP_USR-secret-123");
    expect(enc).not.toBe("APP_USR-secret-123");
    expect(Cipher.looksEncrypted(enc)).toBe(true);
    expect(Cipher.tryDecrypt(enc)).toBe("APP_USR-secret-123");
  });

  it("tryDecrypt em texto plano legado devolve o original (migração transparente)", async () => {
    const Cipher = await loadCipher();
    expect(Cipher.tryDecrypt("legacy-plain-token")).toBe("legacy-plain-token");
  });

  it("encrypt idempotente: não recifra um valor já cifrado", async () => {
    const Cipher = await loadCipher();
    const enc = Cipher.encrypt("tok");
    expect(Cipher.encrypt(enc)).toBe(enc);
  });

  it("vazio/null tratados com segurança", async () => {
    const Cipher = await loadCipher();
    expect(Cipher.encrypt("")).toBe("");
    expect(Cipher.tryDecrypt("")).toBe("");
  });
});
