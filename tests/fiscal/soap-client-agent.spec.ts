import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as tls from "node:tls";
import { buildAgentOptions } from "../../app/fiscal/sefaz/soap-client.service";
import type { LoadedCertificate } from "../../app/fiscal/certificate/certificate-loader.service";

const LEAF = "-----BEGIN CERTIFICATE-----\nLEAFLEAFLEAF\n-----END CERTIFICATE-----";
const INT1 = "-----BEGIN CERTIFICATE-----\nINTERMED-1\n-----END CERTIFICATE-----";
const INT2 = "-----BEGIN CERTIFICATE-----\nINTERMED-2\n-----END CERTIFICATE-----";

function certWithChain(caChainPem: string[]): LoadedCertificate {
  return {
    privateKeyPem: "-----BEGIN PRIVATE KEY-----\nKEY\n-----END PRIVATE KEY-----",
    certificatePem: LEAF,
    caChainPem,
    notAfter: new Date("2030-01-01T00:00:00Z"),
    subjectCN: "EMPRESA:11222333000181",
  };
}

describe("buildAgentOptions (mTLS SEFAZ)", () => {
  it("apresenta a cadeia do A1 (folha + intermediarios) no campo cert", () => {
    const opts = buildAgentOptions(certWithChain([INT1, INT2]), null);
    expect(opts.cert).toBe([LEAF, INT1, INT2].join("\n"));
    expect(opts.key).toContain("PRIVATE KEY");
  });

  it("NAO coloca a cadeia do A1 em ca (senao quebra a verificacao do servidor)", () => {
    const opts = buildAgentOptions(certWithChain([INT1, INT2]), null);
    // Sem bundle extra → ca indefinido → usa o trust store padrao do Node.
    expect(opts.ca).toBeUndefined();
    // Garantia explicita: os intermediarios do cliente nao viram CA confiavel.
    const caStr = JSON.stringify(opts.ca ?? "");
    expect(caStr).not.toContain("INTERMED-1");
    expect(caStr).not.toContain("INTERMED-2");
  });

  it("usa TLS 1.2+ e rejectUnauthorized", () => {
    const opts = buildAgentOptions(certWithChain([]), null);
    expect(opts.minVersion).toBe("TLSv1.2");
    expect(opts.rejectUnauthorized).toBe(true);
    // Cert sem intermediarios → cert = so a folha.
    expect(opts.cert).toBe(LEAF);
  });

  describe("com SEFAZ_CA_BUNDLE_PATH", () => {
    let bundlePath: string;
    const BUNDLE = "-----BEGIN CERTIFICATE-----\nEXTRA-CA\n-----END CERTIFICATE-----";

    beforeAll(() => {
      bundlePath = path.join(os.tmpdir(), `dexo-ca-bundle-${process.pid}.pem`);
      fs.writeFileSync(bundlePath, BUNDLE, "utf8");
    });
    afterAll(() => {
      try {
        fs.unlinkSync(bundlePath);
      } catch {
        /* noop */
      }
    });

    it("ANEXA o bundle extra ao trust store padrao (nao substitui)", () => {
      const opts = buildAgentOptions(certWithChain([INT1]), bundlePath);
      const ca = opts.ca as string[];
      expect(Array.isArray(ca)).toBe(true);
      // padrao + 1 extra
      expect(ca.length).toBe(tls.rootCertificates.length + 1);
      expect(ca).toContain(BUNDLE);
      // continua sem confiar nos intermediarios do cliente
      expect(JSON.stringify(ca)).not.toContain("INTERMED-1");
    });

    it("lanca erro claro se o bundle nao puder ser lido", () => {
      const bad = path.join(os.tmpdir(), "dexo-ca-inexistente-xyz.pem");
      expect(() => buildAgentOptions(certWithChain([]), bad)).toThrow(
        /SEFAZ_CA_BUNDLE_PATH/,
      );
    });
  });
});
