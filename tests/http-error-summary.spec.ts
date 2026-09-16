import { describe, expect, it } from "vitest";
import { inspect } from "util";
import { AxiosError, AxiosHeaders } from "axios";
import {
  describeHttpError,
  isAuthHttpError,
  redactSecrets,
} from "../app/lib/http-error-summary";

/**
 * O log de erro do sync gravava o token do Mercado Livre em texto puro porque
 * `console.error("…", error)` imprime o AxiosError inteiro. Estes testes
 * travam que o resumo nunca carrega segredo e continua útil para diagnóstico.
 */

const TOKEN = "APP_USR-1234567890123456-091612-abcdef0123456789abcdef0123456789-99887766";

function axios401(url = "https://api.mercadolibre.com/visits/items?ids=MLB123") {
  const config = {
    url,
    method: "get",
    headers: new AxiosHeaders({ Authorization: `Bearer ${TOKEN}` }),
  } as any;
  const response = {
    status: 401,
    statusText: "Unauthorized",
    headers: {},
    config,
    data: { message: "invalid access token", error: "unauthorized", status: 401 },
  } as any;
  return new AxiosError(
    "Request failed with status code 401",
    "ERR_BAD_REQUEST",
    config,
    { _header: `GET /visits HTTP/1.1\r\nAuthorization: Bearer ${TOKEN}\r\n` },
    response,
  );
}

describe("describeHttpError", () => {
  it("controle: o objeto cru (o que era logado) CONTÉM o token", () => {
    expect(inspect(axios401(), { depth: 6 })).toContain(TOKEN);
  });

  it("o resumo não contém o token nem o header Authorization", () => {
    const s = describeHttpError(axios401());
    expect(s).not.toContain(TOKEN);
    expect(s).not.toMatch(/Bearer/i);
    expect(s).not.toMatch(/APP_USR/);
  });

  it("mantém o que serve para diagnóstico: status, código, mensagem remota e caminho", () => {
    const s = describeHttpError(axios401());
    expect(s).toContain("status=401");
    expect(s).toContain("code=ERR_BAD_REQUEST");
    expect(s).toContain("unauthorized: invalid access token");
    expect(s).toContain("path=/visits/items");
  });

  it("descarta a query string (a Shopee assina com access_token na URL)", () => {
    const s = describeHttpError(
      axios401("https://partner.shopeemobile.com/api/v2/product/get_item_base_info?access_token=segredo123&shop_id=9"),
    );
    expect(s).not.toContain("segredo123");
    expect(s).toContain("path=/api/v2/product/get_item_base_info");
  });

  it("erro comum vira só a mensagem, ainda redigida", () => {
    expect(describeHttpError(new Error(`falhou com Bearer ${TOKEN}`))).toBe(
      "falhou com Bearer [REDACTED]",
    );
    expect(describeHttpError("texto")).toBe("texto");
  });
});

describe("redactSecrets", () => {
  it("redige token do ML, Bearer e access_token de query", () => {
    const out = redactSecrets(
      `a ${TOKEN} b Bearer xyz.abc c access_token=zzz&x=1 d refresh_token=yyy`,
    );
    expect(out).toBe(
      "a [REDACTED] b Bearer [REDACTED] c access_token=[REDACTED]&x=1 d refresh_token=[REDACTED]",
    );
  });
});

describe("isAuthHttpError", () => {
  it("401 do axios é token recusado", () => {
    expect(isAuthHttpError(axios401())).toBe(true);
  });

  it("Error relançado com a mensagem do ML também é", () => {
    expect(isAuthHttpError(new Error("invalid access token"))).toBe(true);
  });

  it("403 NÃO para a conta (item de outro vendedor responde 403)", () => {
    const e = axios401();
    e.response!.status = 403;
    e.response!.data = { message: "forbidden" };
    expect(isAuthHttpError(e)).toBe(false);
  });

  it("404/429/timeout não são token recusado", () => {
    const e = axios401();
    e.response!.status = 429;
    e.response!.data = { message: "too_many_requests" };
    expect(isAuthHttpError(e)).toBe(false);
    expect(isAuthHttpError(new Error("timeout of 5000ms exceeded"))).toBe(false);
  });
});
