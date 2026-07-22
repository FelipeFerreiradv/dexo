/**
 * `getItemsDetails` é o multiget usado pelo "Importar anúncios". Ele roda com
 * 4 workers dentro de um Promise.all, e era o ÚNICO dos três multiget sem
 * timeout de axios — um socket pendurado travava a importação inteira.
 *
 * O retry no MESMO chunk não é enfeite: o método é tudo-ou-nada (um throw
 * rejeita o Promise.all e descarta a importação da conta, mexendo em
 * errorCount/totalItems). Com a repetição, qualquer chunk que realisticamente
 * completaria continua completando.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGet } = vi.hoisted(() => ({ mockGet: vi.fn() }));

vi.mock("axios", () => {
  const isAxiosError = (e: unknown) =>
    !!(e as { isAxiosError?: boolean } | null)?.isAxiosError;
  return {
    default: { get: mockGet, isAxiosError },
    isAxiosError,
  };
});

import { MLApiService } from "../app/marketplaces/services/ml-api.service";

/** Erro de timeout do axios: sem `response` e com code de conexão abortada. */
function timeoutError(code = "ECONNABORTED") {
  return { isAxiosError: true, code, message: "timeout of 30000ms exceeded" };
}

/** Erro HTTP de verdade: o servidor RESPONDEU (não é timeout). */
function httpError(status: number) {
  return {
    isAxiosError: true,
    response: { status, data: { message: "invalid token" } },
    message: `Request failed with status code ${status}`,
  };
}

const ok = (ids: string[]) => ({
  data: ids.map((id) => ({ code: 200, body: { id, title: `item ${id}` } })),
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("MLApiService.getItemsDetails — timeout com retry no mesmo chunk", () => {
  it("passa timeout no request (sem ele a importação pendurava para sempre)", async () => {
    mockGet.mockResolvedValueOnce(ok(["MLB1"]));

    await MLApiService.getItemsDetails("token", ["MLB1"]);

    expect(mockGet).toHaveBeenCalledTimes(1);
    const [, config] = mockGet.mock.calls[0];
    expect(config.timeout).toBe(30_000);
    expect(config.headers.Authorization).toBe("Bearer token");
  });

  it("timeout na 1ª tentativa e sucesso na 2ª: o conjunto de itens é o MESMO", async () => {
    mockGet
      .mockRejectedValueOnce(timeoutError())
      .mockResolvedValueOnce(ok(["MLB1", "MLB2"]));

    const items = await MLApiService.getItemsDetails("token", ["MLB1", "MLB2"]);

    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(items.map((i) => i.id)).toEqual(["MLB1", "MLB2"]);
  });

  it("ETIMEDOUT também é repetido", async () => {
    mockGet
      .mockRejectedValueOnce(timeoutError("ETIMEDOUT"))
      .mockResolvedValueOnce(ok(["MLB1"]));

    const items = await MLApiService.getItemsDetails("token", ["MLB1"]);

    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(items).toHaveLength(1);
  });

  it("esgotadas as tentativas (1 + 2 retries), propaga o erro", async () => {
    mockGet.mockRejectedValue(timeoutError());

    await expect(
      MLApiService.getItemsDetails("token", ["MLB1"]),
    ).rejects.toThrow(/detalhes dos items/i);

    expect(mockGet).toHaveBeenCalledTimes(3);
  });

  it("erro HTTP (servidor respondeu) NÃO é repetido — falha na 1ª", async () => {
    mockGet.mockRejectedValue(httpError(401));

    await expect(
      MLApiService.getItemsDetails("token", ["MLB1"]),
    ).rejects.toThrow(/invalid token/i);

    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it("itens com code ≠ 200 continuam sendo omitidos (comportamento inalterado)", async () => {
    mockGet.mockResolvedValueOnce({
      data: [
        { code: 200, body: { id: "MLB1" } },
        { code: 404, body: { id: "MLB2" } },
      ],
    });

    const items = await MLApiService.getItemsDetails("token", ["MLB1", "MLB2"]);

    expect(items.map((i) => i.id)).toEqual(["MLB1"]);
  });

  it("lista vazia não toca a rede", async () => {
    expect(await MLApiService.getItemsDetails("token", [])).toEqual([]);
    expect(mockGet).not.toHaveBeenCalled();
  });
});
