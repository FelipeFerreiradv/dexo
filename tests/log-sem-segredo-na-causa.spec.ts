import { beforeEach, describe, expect, it, vi } from "vitest";
import { inspect } from "util";
import { AxiosError, AxiosHeaders } from "axios";

/**
 * Os serviços de marketplace penduravam o AxiosError ORIGINAL em `wrapped.cause`.
 * Na renovação de token, `config.data` desse erro carrega `client_secret` e
 * `refresh_token` — e o `console.error("…", err)` do sync-loop imprimia tudo.
 * Medido em produção (16/09/2026): o client_secret do app Magalu em todos os
 * arquivos do dexo-sync-orders-error.
 */

const CLIENT_SECRET = "segredo-do-app-0123456789abcdefghijklmnopq";
const REFRESH = "refresh-do-vendedor-9876543210";
const TOKEN = "APP_USR-4444444444444444-091612-dddddddddddddddddddddddddddddddd-1";

const postMock = vi.hoisted(() => vi.fn());
vi.mock("axios", async (orig) => {
  const real = (await orig()) as typeof import("axios");
  return {
    ...real,
    default: { ...real.default, post: postMock, isAxiosError: real.isAxiosError },
  };
});

import { safeHttpCause } from "../app/lib/http-error-summary";
import { MagaluOAuthService } from "../app/marketplaces/services/magalu-oauth.service";
import { MLOAuthService } from "../app/marketplaces/services/ml-oauth.service";

function refreshRecusado(url: string) {
  const data = `grant_type=refresh_token&client_id=abc&client_secret=${CLIENT_SECRET}&refresh_token=${REFRESH}`;
  const config = {
    url,
    method: "post",
    data,
    headers: new AxiosHeaders({ "Content-Type": "application/x-www-form-urlencoded" }),
  } as any;
  return new AxiosError(
    "Request failed with status code 400",
    "ERR_BAD_REQUEST",
    config,
    { _header: `POST /oauth/token HTTP/1.1\r\nAuthorization: Bearer ${TOKEN}\r\n` },
    {
      status: 400,
      statusText: "Bad Request",
      headers: {},
      config,
      data: { error: "invalid_grant", error_description: "The provided authorization grant is invalid" },
    } as any,
  );
}

function semSegredo(err: unknown) {
  const tudo = inspect(err, { depth: 12 });
  expect(tudo).not.toContain(CLIENT_SECRET);
  expect(tudo).not.toContain(REFRESH);
  expect(tudo).not.toContain(TOKEN);
  return tudo;
}

describe("safeHttpCause", () => {
  it("controle: o AxiosError cru contém o client_secret", () => {
    expect(inspect(refreshRecusado("https://id.magalu.com/oauth/token"), { depth: 12 })).toContain(CLIENT_SECRET);
  });

  it("a causa segura não carrega segredo e mantém status, código e mensagem", () => {
    const c = safeHttpCause(refreshRecusado("https://id.magalu.com/oauth/token"));
    const txt = semSegredo(c);
    expect(c.name).toBe("HttpErrorCause");
    expect((c as any).status).toBe(400);
    expect((c as any).code).toBe("ERR_BAD_REQUEST");
    expect(txt).toContain("invalid_grant");
  });
});

describe("renovação de token com falha não vaza segredo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("Magalu", async () => {
    postMock.mockRejectedValue(refreshRecusado("https://id.magalu.com/oauth/token"));
    const err = await MagaluOAuthService.refreshAccessToken(REFRESH, "abc", CLIENT_SECRET).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("Erro ao renovar token (Magalu)");
    // classificação existente preservada (a mensagem "authorization grant is invalid"
    // não casa o regex invalid_grant e cai em bad_request, como em produção)
    expect(err.errorCode).toBe("bad_request");
    semSegredo(err);
  });

  it("Mercado Livre", async () => {
    postMock.mockRejectedValue(refreshRecusado("https://api.mercadolibre.com/oauth/token"));
    const err = await MLOAuthService.refreshAccessToken(REFRESH, "abc", CLIENT_SECRET).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("Erro ao renovar token");
    semSegredo(err);
  });
});
