import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import axios from "axios";

// Credenciais de teste para validateMagaluConfig() passar (lê env ao vivo).
process.env.MAGALU_CLIENT_ID = "test-client";
process.env.MAGALU_CLIENT_SECRET = "test-secret";

import { MagaluOAuthService } from "../magalu-oauth.service";

vi.mock("axios");
const mockedAxios = axios as unknown as {
  post: ReturnType<typeof vi.fn>;
  isAxiosError: (e: unknown) => boolean;
};

beforeEach(() => {
  (mockedAxios as any).post = vi.fn().mockResolvedValue({ data: {} });
  (mockedAxios as any).isAxiosError = (e: any) => !!e && e.isAxiosError === true;
});

afterEach(() => {
  vi.restoreAllMocks();
});

const b64u = (o: unknown) =>
  Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (payload: Record<string, unknown>) =>
  `${b64u({ alg: "none" })}.${b64u(payload)}.sig`;

describe("MagaluOAuthService.generateAuthUrl", () => {
  it("monta a URL de consent do ID Magalu SEM PKCE", () => {
    const { authUrl, state } = MagaluOAuthService.generateAuthUrl("user-1");
    expect(authUrl).toContain("/login");
    expect(authUrl).toContain("response_type=code");
    expect(authUrl).toContain("choose_tenants=true");
    expect(authUrl).toContain("scope=");
    expect(authUrl).toContain("state=");
    expect(authUrl).toContain("redirect_uri=");
    // Magalu NÃO usa PKCE.
    expect(authUrl).not.toContain("code_challenge");
    expect(state).toBeTruthy();
  });
});

describe("MagaluOAuthService.validateState", () => {
  it("valida o state uma única vez (single-use) e associa o userId", () => {
    const { state } = MagaluOAuthService.generateAuthUrl("user-42");
    const first = MagaluOAuthService.validateState(state);
    expect(first.valid).toBe(true);
    expect(first.userId).toBe("user-42");
    // Segundo uso é inválido.
    expect(MagaluOAuthService.validateState(state).valid).toBe(false);
  });

  it("rejeita state desconhecido", () => {
    expect(MagaluOAuthService.validateState("inexistente").valid).toBe(false);
  });
});

describe("MagaluOAuthService.extractTenantId", () => {
  it("extrai tenant_id / tenant / tenants[0].id / sub do JWT", () => {
    expect(MagaluOAuthService.extractTenantId(jwt({ tenant_id: "a" }))).toBe("a");
    expect(MagaluOAuthService.extractTenantId(jwt({ tenant: "b" }))).toBe("b");
    expect(
      MagaluOAuthService.extractTenantId(jwt({ tenants: [{ id: "c" }] })),
    ).toBe("c");
    expect(MagaluOAuthService.extractTenantId(jwt({ sub: "d" }))).toBe("d");
  });

  it("retorna string vazia para token inválido", () => {
    expect(MagaluOAuthService.extractTenantId("not-a-jwt")).toBe("");
  });
});

describe("MagaluOAuthService.exchangeCodeForTokens", () => {
  it("POST /oauth/token em JSON e extrai externalUserId (tenant) do JWT", async () => {
    const token = jwt({ tenant_id: "tenant-xyz" });
    (mockedAxios as any).post.mockResolvedValue({
      data: { access_token: token, refresh_token: "r1", expires_in: 7200 },
    });

    const r = await MagaluOAuthService.exchangeCodeForTokens("code123");
    expect(r.accessToken).toBe(token);
    expect(r.refreshToken).toBe("r1");
    expect(r.expiresIn).toBe(7200);
    expect(r.externalUserId).toBe("tenant-xyz");

    const [url, body, config] = (mockedAxios as any).post.mock.calls[0];
    expect(url).toContain("/oauth/token");
    expect(body.grant_type).toBe("authorization_code");
    expect(config.headers["Content-Type"]).toBe("application/json");
  });
});

describe("MagaluOAuthService.refreshAccessToken", () => {
  it("POST /oauth/token em x-www-form-urlencoded com grant_type=refresh_token", async () => {
    (mockedAxios as any).post.mockResolvedValue({
      data: { access_token: "a2", refresh_token: "r2", expires_in: 7200 },
    });

    const r = await MagaluOAuthService.refreshAccessToken("old-refresh");
    expect(r.accessToken).toBe("a2");
    expect(r.refreshToken).toBe("r2");

    const [url, body, config] = (mockedAxios as any).post.mock.calls[0];
    expect(url).toContain("/oauth/token");
    expect(config.headers["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(String(body)).toContain("grant_type=refresh_token");
    expect(String(body)).toContain("refresh_token=old-refresh");
  });

  it("mantém o refresh_token atual quando a resposta não rotaciona", async () => {
    (mockedAxios as any).post.mockResolvedValue({
      data: { access_token: "a3", expires_in: 7200 },
    });
    const r = await MagaluOAuthService.refreshAccessToken("keep-me");
    expect(r.refreshToken).toBe("keep-me");
  });
});
