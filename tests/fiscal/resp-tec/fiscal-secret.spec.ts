import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Chaves de TESTE (64 hex = 32 bytes). Nunca usadas fora da suíte.
const CHAVE_TESTE =
  "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const OUTRA_CHAVE_TESTE =
  "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100";

type ModuloSegredo = typeof import("../../../app/fiscal/certificate/fiscal-secret");
type ModuloCert = typeof import("../../../app/fiscal/certificate/certificate-manager.service");

/** Importa o módulo do zero (a instância é preguiçosa e fica em cache no módulo). */
async function carregar(): Promise<ModuloSegredo> {
  vi.resetModules();
  return import("../../../app/fiscal/certificate/fiscal-secret");
}

async function carregarCert(): Promise<ModuloCert> {
  return import("../../../app/fiscal/certificate/certificate-manager.service");
}

describe("fiscal-secret — cifragem de segredos fiscais", () => {
  beforeEach(() => {
    vi.stubEnv("FISCAL_CERT_ENC_KEY", CHAVE_TESTE);
    vi.stubEnv("FISCAL_PRODUCTION_UNLOCKED", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("round-trip de CSRTs de vários formatos", async () => {
    const { encryptFiscalSecret, decryptFiscalSecret } = await carregar();
    for (const segredo of [
      "A",
      "CSRT-SENTINELA-123456",
      "G8063VRTNDMO886SFNK5LDUDEI24XJ22YIPO",
      "x".repeat(128),
      "çãõ€-unicode",
    ]) {
      const enc = encryptFiscalSecret(segredo);
      expect(decryptFiscalSecret(enc)).toBe(segredo);
    }
  });

  it("o cifrado nunca é igual ao texto puro nem o contém", async () => {
    const { encryptFiscalSecret } = await carregar();
    // Segredos com caracteres fora do alfabeto hex e longos o bastante para
    // que uma coincidência acidental no texto hex seja impossível na prática.
    for (const segredo of [
      "CSRT-SENTINELA-123456",
      "QWERTYUIOPLKJHGZXVNM",
      "x".repeat(128),
    ]) {
      const enc = encryptFiscalSecret(segredo);
      expect(enc).not.toBe(segredo);
      expect(enc).not.toContain(segredo);
      expect(enc.toLowerCase()).not.toContain(
        Buffer.from(segredo, "utf8").toString("hex"),
      );
      expect(enc).toMatch(/^[0-9a-f]{32}:[0-9a-f]{32}:[0-9a-f]+$/);
    }
  });

  it("IV aleatório: cifrar duas vezes o mesmo valor dá cifrados diferentes", async () => {
    const { encryptFiscalSecret, decryptFiscalSecret } = await carregar();
    const a = encryptFiscalSecret("CSRT-SENTINELA");
    const b = encryptFiscalSecret("CSRT-SENTINELA");
    expect(a).not.toBe(b);
    expect(decryptFiscalSecret(a)).toBe(decryptFiscalSecret(b));
  });

  it("mesmo formato e chave da senha do certificado (interoperável com CertificateManagerService)", async () => {
    const { encryptFiscalSecret, decryptFiscalSecret } = await carregar();
    const { CertificateManagerService } = await carregarCert();
    const mgr = new CertificateManagerService();
    expect(mgr.decryptPassword(encryptFiscalSecret("CSRT-1"))).toBe("CSRT-1");
    expect(decryptFiscalSecret(mgr.encryptPassword("CSRT-2"))).toBe("CSRT-2");
  });

  it("chave diferente → erro genérico, sem cifrado nem texto puro na mensagem", async () => {
    const primeiro = await carregar();
    const enc = primeiro.encryptFiscalSecret("CSRT-SENTINELA-OUTRA-CHAVE");

    vi.stubEnv("FISCAL_CERT_ENC_KEY", OUTRA_CHAVE_TESTE);
    const segundo = await carregar();
    let erro: Error | null = null;
    try {
      segundo.decryptFiscalSecret(enc);
    } catch (e) {
      erro = e as Error;
    }
    expect(erro).not.toBeNull();
    expect(erro!.message).toMatch(/Segredo fiscal ilegivel/);
    expect(erro!.message).not.toContain("SENTINELA");
    expect(erro!.message).not.toContain(enc);
    expect((erro as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  it("cifrado adulterado ou malformado → erro", async () => {
    const { encryptFiscalSecret, decryptFiscalSecret } = await carregar();
    const enc = encryptFiscalSecret("CSRT-SENTINELA");
    const [iv, tag, ct] = enc.split(":");
    const ultimo = ct.slice(-1) === "0" ? "1" : "0";
    const adulterado = `${iv}:${tag}:${ct.slice(0, -1)}${ultimo}`;
    expect(() => decryptFiscalSecret(adulterado)).toThrow(/Segredo fiscal ilegivel/);
    expect(() => decryptFiscalSecret("abc")).toThrow(/Segredo fiscal ilegivel/);
    expect(() => decryptFiscalSecret("a:b")).toThrow(/Segredo fiscal ilegivel/);
  });

  it("vazios são recusados", async () => {
    const { encryptFiscalSecret, decryptFiscalSecret } = await carregar();
    expect(() => encryptFiscalSecret("")).toThrow(/vazio/);
    expect(() => decryptFiscalSecret("")).toThrow(/ausente/);
  });

  it("instância preguiçosa: importar sem chave em produção não aborta; usar aborta (fail-closed)", async () => {
    vi.stubEnv("FISCAL_CERT_ENC_KEY", "");
    vi.stubEnv("NODE_ENV", "production");
    const mod = await carregar();
    expect(() => mod.encryptFiscalSecret("CSRT")).toThrow(/FISCAL_CERT_ENC_KEY/);
  });
});
