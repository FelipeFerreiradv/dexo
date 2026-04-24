import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import axios from "axios";
import {
  MLCatalogSearchService,
  __resetCatalogSearchCacheForTests,
} from "../app/marketplaces/services/ml-catalog-search.service";

vi.mock("axios");
const mockedAxios = axios as unknown as {
  post: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  isAxiosError: (e: unknown) => boolean;
};

beforeEach(() => {
  (mockedAxios as any).get = vi.fn();
  (mockedAxios as any).post = vi.fn().mockResolvedValue({
    data: { access_token: "app-tok-123", expires_in: 1800 },
  });
  (mockedAxios as any).isAxiosError = (e: any) => !!e && e.isAxiosError === true;
  __resetCatalogSearchCacheForTests();
  process.env.ML_CLIENT_ID = "cid";
  process.env.ML_CLIENT_SECRET = "secret";
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MLCatalogSearchService.searchCatalogSuggestions", () => {
  it("retorna [] quando a query tem menos de 3 caracteres", async () => {
    const result = await MLCatalogSearchService.searchCatalogSuggestions("ab");
    expect(result).toEqual([]);
    expect((mockedAxios as any).get).not.toHaveBeenCalled();
  });

  it("chama /products/search com site_id=MLB e q normalizado", async () => {
    (mockedAxios as any).get.mockResolvedValue({
      data: {
        paging: { total: 1, offset: 0, limit: 5 },
        results: [
          {
            id: "MLB19765739",
            name: "Cubo de Roda Fiat Uno 2018",
            status: "active",
          },
        ],
      },
    });

    const results = await MLCatalogSearchService.searchCatalogSuggestions(
      "cubo de roda Fiat Uno 2018",
    );

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("MLB19765739");

    const [url] = (mockedAxios as any).get.mock.calls[0];
    expect(url).toContain("/products/search");
    expect(url).toContain("site_id=MLB");
    expect(url).toContain("q=cubo+de+roda+Fiat+Uno+2018");
    expect(url).toContain("limit=5");
  });

  it("aplica category_id e limit quando passados", async () => {
    (mockedAxios as any).get.mockResolvedValue({ data: { results: [] } });

    await MLCatalogSearchService.searchCatalogSuggestions("amortecedor", {
      categoryId: "MLB1748",
      limit: 3,
      status: "active",
    });

    const [url] = (mockedAxios as any).get.mock.calls[0];
    expect(url).toContain("category_id=MLB1748");
    expect(url).toContain("limit=3");
    expect(url).toContain("status=active");
  });

  it("retorna [] em erro de rede, sem lançar", async () => {
    (mockedAxios as any).get.mockRejectedValue(new Error("network down"));
    const result =
      await MLCatalogSearchService.searchCatalogSuggestions("filtro de óleo");
    expect(result).toEqual([]);
  });

  it("filtra hits sem id", async () => {
    (mockedAxios as any).get.mockResolvedValue({
      data: {
        results: [
          { id: "MLB1", name: "ok" },
          { name: "sem id" },
          { id: "", name: "id vazio" },
          { id: "MLB2", name: "ok2" },
        ],
      },
    });
    const result = await MLCatalogSearchService.searchCatalogSuggestions(
      "pastilha",
    );
    expect(result.map((r) => r.id)).toEqual(["MLB1", "MLB2"]);
  });

  it("usa cache: segunda chamada com mesma query não refaz o GET", async () => {
    (mockedAxios as any).get.mockResolvedValue({
      data: { results: [{ id: "MLB42", name: "x" }] },
    });
    await MLCatalogSearchService.searchCatalogSuggestions("disco de freio");
    await MLCatalogSearchService.searchCatalogSuggestions("disco de freio");
    await MLCatalogSearchService.searchCatalogSuggestions("  DISCO DE FREIO  ");
    expect((mockedAxios as any).get).toHaveBeenCalledTimes(1);
  });
});

describe("MLCatalogSearchService.getCatalogProduct", () => {
  it("retorna null para id vazio", async () => {
    expect(await MLCatalogSearchService.getCatalogProduct("")).toBeNull();
    expect((mockedAxios as any).get).not.toHaveBeenCalled();
  });

  it("chama /products/{id} e devolve o body", async () => {
    (mockedAxios as any).get.mockResolvedValue({
      data: { id: "MLB19765739", name: "Cubo", category_id: "MLB1234" },
    });
    const product =
      await MLCatalogSearchService.getCatalogProduct("MLB19765739");
    expect(product?.id).toBe("MLB19765739");
    expect(product?.category_id).toBe("MLB1234");
    const [url] = (mockedAxios as any).get.mock.calls[0];
    expect(url).toContain("/products/MLB19765739");
  });

  it("retorna null em 404 do ML", async () => {
    const err: any = new Error("not found");
    err.isAxiosError = true;
    err.response = { status: 404 };
    (mockedAxios as any).get.mockRejectedValue(err);
    expect(
      await MLCatalogSearchService.getCatalogProduct("MLB_NOT_EXIST"),
    ).toBeNull();
  });

  it("cache: segunda chamada reusa resposta", async () => {
    (mockedAxios as any).get.mockResolvedValue({
      data: { id: "MLB1", name: "x" },
    });
    await MLCatalogSearchService.getCatalogProduct("MLB1");
    await MLCatalogSearchService.getCatalogProduct("MLB1");
    expect((mockedAxios as any).get).toHaveBeenCalledTimes(1);
  });

  it("hidrata detail cache a partir dos hits de search — getCatalogProduct não refaz GET", async () => {
    (mockedAxios as any).get.mockResolvedValueOnce({
      data: {
        results: [
          {
            id: "MLBPREWARM",
            name: "Produto A",
            category_id: "MLB1",
            attributes: [{ id: "BRAND", value_name: "Ford" }],
          },
          { id: "MLB2", name: "Produto B" },
        ],
      },
    });

    await MLCatalogSearchService.searchCatalogSuggestions("amortecedor");
    // 1 chamada GET até aqui: o /products/search.
    expect((mockedAxios as any).get).toHaveBeenCalledTimes(1);

    // Imediatamente depois, buscar detalhes de um dos hits: deve vir do cache
    // pré-aquecido, SEM novo GET.
    const detail =
      await MLCatalogSearchService.getCatalogProduct("MLBPREWARM");
    expect(detail?.id).toBe("MLBPREWARM");
    expect(detail?.category_id).toBe("MLB1");
    expect((mockedAxios as any).get).toHaveBeenCalledTimes(1);
  });

  it("token OAuth é cacheado: várias chamadas não repetem POST /oauth/token", async () => {
    (mockedAxios as any).get.mockResolvedValue({
      data: { results: [{ id: "MLB1", name: "x" }] },
    });

    await MLCatalogSearchService.searchCatalogSuggestions("peça a");
    await MLCatalogSearchService.searchCatalogSuggestions("peça b");
    await MLCatalogSearchService.searchCatalogSuggestions("peça c");

    // POST /oauth/token roda só uma vez para as 3 requests.
    expect((mockedAxios as any).post).toHaveBeenCalledTimes(1);
    const postCall = (mockedAxios as any).post.mock.calls[0];
    expect(postCall[0]).toContain("/oauth/token");
  });
});
