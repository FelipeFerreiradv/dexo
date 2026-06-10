import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  CertificateLoaderService,
  parsePfx,
} from "../../app/fiscal/certificate/certificate-loader.service";
import { CertificateManagerService } from "../../app/fiscal/certificate/certificate-manager.service";
import { generateTestCertificate } from "./__helpers__/test-certificate";

describe("parsePfx (puro)", () => {
  it("extrai chave + cert + notAfter + CN de um PFX self-signed", () => {
    const tc = generateTestCertificate({
      subjectCN: "DEXO PARSE TEST",
      daysValid: 30,
    });

    const loaded = parsePfx(tc.pfxBuffer, tc.password);

    expect(loaded.privateKeyPem).toContain("BEGIN RSA PRIVATE KEY");
    expect(loaded.certificatePem).toContain("BEGIN CERTIFICATE");
    expect(loaded.subjectCN).toBe("DEXO PARSE TEST");
    expect(loaded.notAfter.getTime()).toBeGreaterThan(Date.now());
    // Sem cadeia intermediária num self-signed
    expect(loaded.caChainPem).toEqual([]);
  });

  it("lanca erro quando senha esta errada", () => {
    const tc = generateTestCertificate();
    expect(() => parsePfx(tc.pfxBuffer, "senha-errada")).toThrow();
  });
});

describe("CertificateLoaderService (com I/O + cache)", () => {
  let tmpDir: string;
  let pfxPath: string;
  let encryptedPassword: string;
  let manager: CertificateManagerService;
  const password = "loader-test-pass";

  beforeAll(async () => {
    process.env.FISCAL_CERT_ENC_KEY =
      process.env.FISCAL_CERT_ENC_KEY ??
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    manager = new CertificateManagerService();
    encryptedPassword = manager.encryptPassword(password);

    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dexo-cert-"));
    pfxPath = path.join(tmpDir, "test.pfx");
    const tc = generateTestCertificate({ password, subjectCN: "DEXO LOADER" });
    await fs.promises.writeFile(pfxPath, tc.pfxBuffer);
  });

  afterAll(async () => {
    if (tmpDir) {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("carrega PFX do disco usando senha descriptografada", async () => {
    const loader = new CertificateLoaderService(manager);
    const cert = await loader.load(pfxPath, encryptedPassword);

    expect(cert.subjectCN).toBe("DEXO LOADER");
    expect(cert.privateKeyPem).toContain("BEGIN RSA PRIVATE KEY");
    expect(cert.certificatePem).toContain("BEGIN CERTIFICATE");
    expect(cert.notAfter.getTime()).toBeGreaterThan(Date.now());
  });

  it("usa cache dentro do TTL — nao reparseia o PFX", async () => {
    const loader = new CertificateLoaderService(manager, 60_000);
    const first = await loader.load(pfxPath, encryptedPassword);
    const second = await loader.load(pfxPath, encryptedPassword);
    // Mesma referência de objeto → veio do cache
    expect(first).toBe(second);
  });

  it("expira cache apos TTL", async () => {
    const loader = new CertificateLoaderService(manager, 1); // 1ms
    const first = await loader.load(pfxPath, encryptedPassword);
    await new Promise((r) => setTimeout(r, 5));
    const second = await loader.load(pfxPath, encryptedPassword);
    expect(first).not.toBe(second);
  });

  it("invalidate() força recarga", async () => {
    const loader = new CertificateLoaderService(manager, 60_000);
    const first = await loader.load(pfxPath, encryptedPassword);
    loader.invalidate(pfxPath);
    const second = await loader.load(pfxPath, encryptedPassword);
    expect(first).not.toBe(second);
  });

  it("lanca erro quando senha encriptada esta corrompida", async () => {
    const loader = new CertificateLoaderService(manager);
    await expect(
      loader.load(pfxPath, "garbage:not:hex"),
    ).rejects.toThrow();
  });

  it("lanca erro quando o arquivo nao existe", async () => {
    const loader = new CertificateLoaderService(manager);
    await expect(
      loader.load(path.join(tmpDir, "nao-existe.pfx"), encryptedPassword),
    ).rejects.toThrow();
  });
});
