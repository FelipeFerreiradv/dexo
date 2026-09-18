import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import axios from "axios";
import { inspect } from "util";

// Credenciais de teste para validateMagaluConfig() passar (lê env ao vivo).
process.env.MAGALU_CLIENT_ID = "test-client";
process.env.MAGALU_CLIENT_SECRET = "test-secret";

import { MagaluOAuthService } from "../magalu-oauth.service";

vi.mock("axios");
const prismaFindUnique = vi.hoisted(() => vi.fn());
const prismaUpdate = vi.hoisted(() => vi.fn());
vi.mock("@/app/lib/prisma", () => ({
  default: {
    marketplaceAccount: {
      findUnique: prismaFindUnique,
      update: prismaUpdate,
    },
  },
}));
const mockedAxios = axios as unknown as {
  post: ReturnType<typeof vi.fn>;
  isAxiosError: (e: unknown) => boolean;
};

beforeEach(() => {
  (mockedAxios as any).post = vi.fn().mockResolvedValue({ data: {} });
  (mockedAxios as any).isAxiosError = (e: any) => !!e && e.isAxiosError === true;
  prismaFindUnique.mockClear();
  prismaUpdate.mockClear();
  prismaFindUnique.mockResolvedValue(null);
  prismaUpdate.mockResolvedValue({});
});

afterEach(() => {
  vi.restoreAllMocks();
  [
    "acc-invalid-grant",
    "acc-transient-429",
    "acc-transient-503",
    "acc-transient-timeout",
    "acc-sanitized-error",
  ].forEach((accountId) =>
    MagaluOAuthService.clearAccountCircuitBreaker(accountId),
  );
});

const b64u = (o: unknown) =>
  Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (payload: Record<string, unknown>) =>
  `${b64u({ alg: "none" })}.${b64u(payload)}.sig`;

function axiosFailure(
  status: number | undefined,
  data: Record<string, unknown> | undefined,
  options: { code?: string; message?: string } = {},
) {
  const error = new Error(
    options.message ??
      (status ? `Request failed with status code ${status}` : "timeout"),
  ) as Error & Record<string, any>;
  error.isAxiosError = true;
  error.code = options.code;
  error.config = {
    url: "https://id.magalu.com/oauth/token",
    data: "client_secret=secret-app&refresh_token=secret-refresh",
    headers: { Authorization: "Bearer secret-access-token" },
  };
  if (status !== undefined) {
    error.response = { status, data };
  }
  return error;
}

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

  it("prioriza data.error=invalid_grant quando a descrição é apenas textual", async () => {
    (mockedAxios as any).post.mockRejectedValue(
      axiosFailure(400, {
        error: "invalid_grant",
        error_description: "The provided authorization grant is invalid",
      }),
    );

    const error = await MagaluOAuthService.refreshAccessToken("old-refresh")
      .then(() => undefined)
      .catch((err) => err);

    expect(error?.errorCode).toBe("invalid_grant");
  });

  it.each([
    ["401", axiosFailure(401, { message: "unauthorized" }), "unauthorized"],
    ["400", axiosFailure(400, { error: "invalid_request" }), "bad_request"],
  ])("preserva a classificação não-terminal de %s", async (_label, failure, expected) => {
    (mockedAxios as any).post.mockRejectedValue(failure);

    const error = await MagaluOAuthService.refreshAccessToken("old-refresh")
      .then(() => undefined)
      .catch((err) => err);

    expect(error?.errorCode).toBe(expected);
  });
});

describe("MagaluOAuthService.refreshAccessTokenForAccount", () => {
  it("invalid_grant marca ERROR, registra o evento e impede a segunda chamada HTTP", async () => {
    const accountId = "acc-invalid-grant";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    (mockedAxios as any).post.mockRejectedValue(
      axiosFailure(400, {
        error: "invalid_grant",
        error_description: "The provided authorization grant is invalid",
      }),
    );

    const firstError = await MagaluOAuthService.refreshAccessTokenForAccount(
      accountId,
      "secret-refresh",
    )
      .then(() => undefined)
      .catch((err) => err);

    expect(firstError?.errorCode).toBe("invalid_grant");
    expect(prismaUpdate).toHaveBeenCalledWith({
      where: { id: accountId },
      data: { status: "ERROR" },
    });
    expect(warn.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
      '"event":"magalu.oauth.account.auto_deactivated"',
    );

    const secondError = await MagaluOAuthService.refreshAccessTokenForAccount(
      accountId,
      "secret-refresh",
    )
      .then(() => undefined)
      .catch((err) => err);

    expect(secondError?.errorCode).toBe("invalid_grant");
    expect(secondError?.circuitBreaker).toBe(true);
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    expect(prismaUpdate).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["429", axiosFailure(429, { error: "rate_limited" })],
    ["503", axiosFailure(503, { message: "temporarily unavailable" })],
    ["timeout", axiosFailure(undefined, undefined, { code: "ECONNABORTED" })],
  ])("%s não marca ERROR nem abre o circuit breaker", async (label, failure) => {
    const accountId = `acc-transient-${label}`;
    (mockedAxios as any).post.mockRejectedValue(failure);

    const firstError = await MagaluOAuthService.refreshAccessTokenForAccount(
      accountId,
      "secret-refresh",
    )
      .then(() => undefined)
      .catch((err) => err);
    const secondError = await MagaluOAuthService.refreshAccessTokenForAccount(
      accountId,
      "secret-refresh",
    )
      .then(() => undefined)
      .catch((err) => err);

    expect(firstError?.errorCode).not.toBe("invalid_grant");
    expect(secondError?.circuitBreaker).not.toBe(true);
    expect(prismaUpdate).not.toHaveBeenCalled();
    expect(mockedAxios.post).toHaveBeenCalledTimes(2);
  });

  it("mantém client_secret, refresh_token e Authorization fora do erro embrulhado", async () => {
    const accountId = "acc-sanitized-error";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    (mockedAxios as any).post.mockRejectedValue(
      axiosFailure(503, {
        message: "temporarily unavailable",
      }),
    );

    const error = await MagaluOAuthService.refreshAccessTokenForAccount(
      accountId,
      "secret-refresh",
    )
      .then(() => undefined)
      .catch((err) => err);

    const rendered = inspect(error, { depth: 12 });
    expect(rendered).not.toContain("secret-app");
    expect(rendered).not.toContain("secret-refresh");
    expect(rendered).not.toContain("secret-access-token");
    expect(error.cause).toMatchObject({
      name: "HttpErrorCause",
      status: 503,
    });
    expect(warn).toHaveBeenCalled();
  });
});
