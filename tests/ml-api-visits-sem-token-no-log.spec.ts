import { beforeEach, describe, expect, it, vi } from "vitest";
import { AxiosError, AxiosHeaders } from "axios";

/**
 * `MLApiService.getItemsVisits` era a origem das 11.994 linhas com token por
 * arquivo de log: logava o AxiosError inteiro a cada anúncio. Agora loga o
 * resumo seguro e relança o 401 para o chamador parar a conta.
 */

const TOKEN = "APP_USR-3333333333333333-091612-cccccccccccccccccccccccccccccccc-1";

const getMock = vi.hoisted(() => vi.fn());
vi.mock("axios", async (orig) => {
  const real = (await orig()) as typeof import("axios");
  return {
    ...real,
    default: { ...real.default, get: getMock, isAxiosError: real.isAxiosError },
  };
});

import { MLApiService } from "../app/marketplaces/services/ml-api.service";

function httpError(status: number, message: string) {
  const config = {
    url: "https://api.mercadolibre.com/visits/items?ids=MLB1",
    headers: new AxiosHeaders({ Authorization: `Bearer ${TOKEN}` }),
  } as any;
  return new AxiosError(`Request failed with status code ${status}`, "ERR_BAD_REQUEST", config, {}, {
    status,
    statusText: "",
    headers: {},
    config,
    data: { message },
  } as any);
}

describe("getItemsVisits", () => {
  let logs: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    logs = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      logs.push(a.map((x) => (typeof x === "string" ? x : require("util").inspect(x, { depth: 6 }))).join(" "));
    });
  });

  it("401 é relançado (para a conta) e nada é logado", async () => {
    getMock.mockRejectedValue(httpError(401, "invalid access token"));
    const p = MLApiService.getItemsVisits(TOKEN, ["MLB1", "MLB2"]);
    const assertion = expect(p).rejects.toBeTruthy();
    await vi.runAllTimersAsync();
    await assertion;
    expect(getMock).toHaveBeenCalledTimes(1);
    expect(logs).toHaveLength(0);
  });

  it("outro erro segue para o próximo id e o log não carrega o token", async () => {
    getMock
      .mockRejectedValueOnce(httpError(429, "too_many_requests"))
      .mockResolvedValueOnce({ data: [{ total_visits: 9 }] });
    const p = MLApiService.getItemsVisits(TOKEN, ["MLB1", "MLB2"]);
    await vi.runAllTimersAsync();
    await expect(p).resolves.toEqual({ MLB2: 9 });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("status=429");
    expect(logs[0]).not.toContain(TOKEN);
    expect(logs[0]).not.toMatch(/Bearer/);
  });
});
