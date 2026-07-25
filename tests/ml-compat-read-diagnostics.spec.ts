import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import axios from "axios";
import {
  MLApiService,
  classifyCompatReadFailure,
  countCompatibilitiesFromPayload,
  __resetCompatCacheForTests,
} from "../app/marketplaces/services/ml-api.service";

/**
 * A leitura de compatibilidade tinha `catch { return { available: false } }`:
 * 404, 403, 429, timeout e erro de rede colapsavam no MESMO silêncio, e o
 * relatório só sabia dizer "inconclusivo".
 *
 * Em produção (25/07/2026) isso escondeu 451 anúncios da conta
 * JOTABE-AUTOPECAS. Sondados um a um, a causa real era HTTP 404 — vínculo
 * quebrado da importação de 18/05, e não problema de compatibilidade. O
 * diagnóstico correto muda a ação: 404 pede conserto de vínculo, 429 pede
 * apenas repetir.
 *
 * Estes testes travam duas coisas: que a causa é classificada corretamente, e
 * que `available` continua sendo quem manda — o campo novo é diagnóstico, não
 * pode virar caminho de decisão.
 */

vi.mock("axios");
const mockedAxios = axios as unknown as {
  get: ReturnType<typeof vi.fn>;
  isAxiosError: (e: unknown) => boolean;
};

/** Erro no formato que o axios entrega quando HÁ resposta do servidor. */
function axiosHttpError(status: number, data: unknown = {}): unknown {
  return { isAxiosError: true, response: { status, data }, message: `HTTP ${status}` };
}

/** Corpo real do 404 capturado em produção (MLB4451944479). */
const PROD_404_BODY = {
  message: "Item with id MLB4451944479 not found",
  error: "not_found",
  status: 404,
  cause: [],
};

/** Corpo real do 403 capturado em produção no endpoint de compatibilidades. */
const PROD_403_BODY = {
  error: "forbidden",
  message:
    "Access denied: Item MLB4451944479 not found or you don't have permission to access it.",
  status: 403,
};

describe("classifyCompatReadFailure", () => {
  beforeEach(() => {
    (mockedAxios as any).isAxiosError = (e: unknown) =>
      !!e && typeof e === "object" && (e as any).isAxiosError === true;
  });

  it("404 é vínculo quebrado, não falha de compatibilidade", () => {
    expect(classifyCompatReadFailure(axiosHttpError(404, PROD_404_BODY))).toEqual(
      { reason: "item_inexistente", httpStatus: 404 },
    );
  });

  it("403 é anúncio de outra conta", () => {
    expect(classifyCompatReadFailure(axiosHttpError(403, PROD_403_BODY))).toEqual(
      { reason: "sem_permissao", httpStatus: 403 },
    );
  });

  it("429 é throttling — o dado existe, só não foi lido agora", () => {
    expect(classifyCompatReadFailure(axiosHttpError(429))).toEqual({
      reason: "rate_limit",
      httpStatus: 429,
    });
  });

  it("outros status viram erro_http preservando o número", () => {
    expect(classifyCompatReadFailure(axiosHttpError(500))).toEqual({
      reason: "erro_http",
      httpStatus: 500,
    });
    expect(classifyCompatReadFailure(axiosHttpError(401))).toEqual({
      reason: "erro_http",
      httpStatus: 401,
    });
  });

  it("timeout é detectado por code, não por status", () => {
    // O axios NÃO popula `response` quando estoura o tempo — procurar status
    // aqui daria sempre undefined e cairia em erro_rede.
    expect(
      classifyCompatReadFailure({ isAxiosError: true, code: "ECONNABORTED" }),
    ).toEqual({ reason: "timeout" });
    expect(
      classifyCompatReadFailure({ isAxiosError: true, code: "ETIMEDOUT" }),
    ).toEqual({ reason: "timeout" });
  });

  it("axios sem resposta e sem code de tempo é erro de rede", () => {
    expect(
      classifyCompatReadFailure({ isAxiosError: true, code: "ECONNREFUSED" }),
    ).toEqual({ reason: "erro_rede" });
  });

  it("erro que não é do axios não inventa status", () => {
    expect(classifyCompatReadFailure(new Error("boom"))).toEqual({
      reason: "erro_rede",
    });
    expect(classifyCompatReadFailure(null)).toEqual({ reason: "erro_rede" });
  });
});

describe("countCompatibilitiesFromPayload — causa da indisponibilidade", () => {
  it("corpo irreconhecível marca shape_desconhecido", () => {
    const r = countCompatibilitiesFromPayload({ algo: "inesperado" });
    expect(r.available).toBe(false);
    expect(r.reason).toBe("shape_desconhecido");
  });

  it("leitura bem-sucedida NÃO carrega motivo", () => {
    const r = countCompatibilitiesFromPayload({
      products: [{ id: "MLB123" }, { id: "MLB456" }],
    });
    expect(r.available).toBe(true);
    expect(r.count).toBe(2);
    expect(r.reason).toBeUndefined();
    expect(r.httpStatus).toBeUndefined();
  });

  it("universal continua sendo leitura VÁLIDA e sem motivo", () => {
    const r = countCompatibilitiesFromPayload({ universal: true });
    expect(r.available).toBe(true);
    expect(r.universal).toBe(true);
    expect(r.reason).toBeUndefined();
  });

  it("lista vazia é leitura válida com zero — não é indisponível", () => {
    // Regressão: "li e está vazio" é MUITO diferente de "não consegui ler".
    const r = countCompatibilitiesFromPayload({ products: [] });
    expect(r.available).toBe(true);
    expect(r.count).toBe(0);
    expect(r.reason).toBeUndefined();
  });
});

describe("MLApiService — propagação da causa até o chamador", () => {
  beforeEach(() => {
    (mockedAxios as any).get = vi.fn();
    (mockedAxios as any).isAxiosError = (e: unknown) =>
      !!e && typeof e === "object" && (e as any).isAxiosError === true;
    __resetCompatCacheForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("getItemCompatibilities entrega o 404 em vez de engolir", async () => {
    (mockedAxios as any).get = vi
      .fn()
      .mockRejectedValue(axiosHttpError(404, PROD_404_BODY));

    const r = await MLApiService.getItemCompatibilities("tok", "MLB4451944479");

    expect(r.available).toBe(false);
    expect(r.count).toBe(0);
    expect(r.reason).toBe("item_inexistente");
    expect(r.httpStatus).toBe(404);
  });

  it("readCompatibilities preserva o motivo do /items quando não há user product", async () => {
    (mockedAxios as any).get = vi
      .fn()
      .mockRejectedValue(axiosHttpError(403, PROD_403_BODY));

    const r = await MLApiService.readCompatibilities("tok", "MLB4451944479");

    expect(r.available).toBe(false);
    expect(r.reason).toBe("sem_permissao");
    expect((mockedAxios as any).get).toHaveBeenCalledTimes(1);
  });

  it("com os DOIS endpoints falhando, prevalece o motivo do /items", async () => {
    // O endpoint de user-product responde 400 na leitura por contrato do ML;
    // deixar o motivo dele vencer esconderia o 404/403 que é acionável.
    (mockedAxios as any).get = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/user-products/")) {
        return Promise.reject(axiosHttpError(400, { message: "Missing request parameter" }));
      }
      return Promise.reject(axiosHttpError(404, PROD_404_BODY));
    });

    const r = await MLApiService.readCompatibilities("tok", "MLB1", "MLBU9");

    expect(r.available).toBe(false);
    expect(r.reason).toBe("item_inexistente");
    expect(r.httpStatus).toBe(404);
  });

  it("se o user product RESPONDE, a leitura dele vence e não vira erro", async () => {
    (mockedAxios as any).get = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/user-products/")) {
        return Promise.resolve({ data: { products: [{ id: "MLB7" }] } });
      }
      return Promise.reject(axiosHttpError(404, PROD_404_BODY));
    });

    const r = await MLApiService.readCompatibilities("tok", "MLB1", "MLBU9");

    expect(r.available).toBe(true);
    expect(r.count).toBe(1);
    expect(r.reason).toBeUndefined();
  });

  it("EGRESS: o /items continua sendo tentado PRIMEIRO", async () => {
    const chamadas: string[] = [];
    (mockedAxios as any).get = vi.fn().mockImplementation((url: string) => {
      chamadas.push(url);
      return Promise.reject(axiosHttpError(404, PROD_404_BODY));
    });

    await MLApiService.readCompatibilities("tok", "MLB1", "MLBU9");

    expect(chamadas[0]).toContain("/items/MLB1/compatibilities");
    expect(chamadas[1]).toContain("/user-products/MLBU9/compatibilities");
  });

  it("leitura OK não ganha motivo nem gasta a chamada do user product", async () => {
    (mockedAxios as any).get = vi
      .fn()
      .mockResolvedValue({ data: { products: [{ id: "MLB1" }, { id: "MLB2" }] } });

    const r = await MLApiService.readCompatibilities("tok", "MLB1", "MLBU9");

    expect(r.available).toBe(true);
    expect(r.count).toBe(2);
    expect(r.reason).toBeUndefined();
    expect((mockedAxios as any).get).toHaveBeenCalledTimes(1);
  });
});
