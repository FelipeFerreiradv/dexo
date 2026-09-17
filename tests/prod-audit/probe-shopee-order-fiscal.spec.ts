import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const probeSource = readFileSync(
  path.resolve(__dirname, "../../scripts/prod-audit/probe-shopee-order-fiscal.ts"),
  "utf8",
);

describe("probe-shopee-order-fiscal — contrato read-only", () => {
  it("não importa nem chama OAuth/refresh e não seleciona refresh_token", () => {
    expect(probeSource).not.toContain("ShopeeOAuthService");
    expect(probeSource).not.toMatch(/refreshAccessToken/);
    expect(probeSource).not.toMatch(/refreshToken\s*:/);
  });

  it("aborta com status de falha quando o access token não é utilizável", () => {
    expect(probeSource).toContain("Token de acesso ausente");
    expect(probeSource).toContain("Token de acesso expirado");
    expect(probeSource).toContain("process.exitCode = 1");
  });
});
