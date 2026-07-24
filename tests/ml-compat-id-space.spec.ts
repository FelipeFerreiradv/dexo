import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import axios from "axios";
import {
  MLApiService,
  __resetCompatCacheForTests,
} from "../app/marketplaces/services/ml-api.service";

/**
 * O `value_id` de uma marca vindo de `top_values` NÃO pertence ao mesmo espaço
 * de IDs dos catalog products devolvidos por `products_search/chunks`. O código
 * usava esse id de duas formas erradas: na query (known_attributes) e no filtro
 * local (igualdade de value_id). O resultado em produção foi
 * "0 of 1500 matched brand+model" — 1500 produtos buscados, todos descartados,
 * e a compatibilidade caindo no caminho por atributos que não persiste.
 *
 * A correção rastreia a PROCEDÊNCIA do id e, quando ela não é confiável, busca
 * e casa por nome normalizado. O filtro continua existindo: compatibilidade
 * errada no anúncio é pior do que compatibilidade faltando.
 */

vi.mock("axios");
const mockedAxios = axios as unknown as {
  post: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  isAxiosError: (e: unknown) => boolean;
};

const produto = (
  brandId: string,
  brandName: string,
  modelId: string,
  modelName: string,
  year: string,
  id = "MLB_P1",
) => ({
  id,
  attributes: [
    { id: "BRAND", value_id: brandId, value_name: brandName },
    { id: "MODEL", value_id: modelId, value_name: modelName },
    { id: "VEHICLE_YEAR", value_name: year },
  ],
});

/** catalog_domains com as marcas informadas (fonte confiável). */
const domainCom = (marcas: Array<{ id: string; name: string }>) => ({
  data: {
    domain_id: "MLB-CARS_AND_VANS",
    attributes: [{ id: "BRAND", values: marcas }],
  },
});

describe("resolveCompatibilityCatalogProducts — espaço de value_id", () => {
  beforeEach(() => {
    (mockedAxios as any).get = vi.fn();
    (mockedAxios as any).post = vi.fn();
    (mockedAxios as any).put = vi.fn();
    (mockedAxios as any).isAxiosError = () => false;
    __resetCompatCacheForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    __resetCompatCacheForTests();
  });

  it("marca de catalog_domains: mantém filtro por value_id (comportamento atual)", async () => {
    (mockedAxios as any).get.mockResolvedValue(
      domainCom([{ id: "BR_FIAT", name: "Fiat" }]),
    );
    (mockedAxios as any).post.mockImplementation((url: string) => {
      if (url.includes("/chunks")) {
        return Promise.resolve({
          data: {
            results: [
              produto("BR_FIAT", "Fiat", "MD_UNO", "Uno", "2010", "MLB_OK"),
              // Mesmo nome, id divergente: com marca confiável isto é lixo do
              // ML ignorando o filtro e precisa ser descartado.
              produto("BR_OUTRA", "Fiat", "MD_UNO", "Uno", "2010", "MLB_LIXO"),
            ],
          },
        });
      }
      return Promise.resolve({ data: { values: [] } });
    });

    const r = await MLApiService.resolveCompatibilityCatalogProducts("tok", [
      { brand: "Fiat", model: "Uno", yearFrom: 2010, yearTo: 2010 },
    ]);

    expect(r.catalogProductIds).toContain("MLB_OK");
    expect(r.catalogProductIds).not.toContain("MLB_LIXO");
  });

  it("marca de top_values: busca por open_attributes, não por value_id", async () => {
    // catalog_domains vazio (cenário do log de prod) força o fallback.
    (mockedAxios as any).get.mockResolvedValue(domainCom([]));
    (mockedAxios as any).post.mockImplementation((url: string) => {
      if (url.includes("/attributes/BRAND/top_values")) {
        return Promise.resolve({
          data: { values: [{ id: "TV_VW", name: "Volkswagen" }] },
        });
      }
      if (url.includes("/top_values")) {
        return Promise.resolve({ data: { values: [] } });
      }
      if (url.includes("/chunks")) {
        return Promise.resolve({
          data: {
            results: [produto("CP_VW", "Volkswagen", "CP_GOL", "Gol", "2012")],
          },
        });
      }
      return Promise.resolve({ data: {} });
    });

    await MLApiService.resolveCompatibilityCatalogProducts("tok", [
      { brand: "Volkswagen", model: "Gol", yearFrom: 2012, yearTo: 2012 },
    ]);

    const chunkCall = (mockedAxios as any).post.mock.calls.find(
      ([url]: [string]) => url.includes("/chunks"),
    );
    expect(chunkCall).toBeTruthy();
    const body = chunkCall[1];
    // O id de top_values não pode ir como known_attributes: buscaria no espaço
    // errado e o ML devolveria lixo.
    expect(body.known_attributes).toBeUndefined();
    expect(body.open_attributes).toEqual([
      { id: "BRAND", value_name: "Volkswagen" },
      { id: "MODEL", value_name: "Gol" },
    ]);
  });

  it("marca de top_values: casa por nome — a regressão do 0 of 1500", async () => {
    (mockedAxios as any).get.mockResolvedValue(domainCom([]));
    (mockedAxios as any).post.mockImplementation((url: string) => {
      if (url.includes("/attributes/BRAND/top_values")) {
        return Promise.resolve({
          data: { values: [{ id: "TV_VW", name: "Volkswagen" }] },
        });
      }
      if (url.includes("/top_values")) {
        return Promise.resolve({ data: { values: [] } });
      }
      if (url.includes("/chunks")) {
        return Promise.resolve({
          data: {
            // value_id do produto é de outro espaço que o de top_values.
            // Antes, este produto era descartado — junto com os outros 1499.
            results: [
              produto("CP_VW", "Volkswagen", "CP_GOL", "Gol", "2012", "MLB_VW"),
            ],
          },
        });
      }
      return Promise.resolve({ data: {} });
    });

    const r = await MLApiService.resolveCompatibilityCatalogProducts("tok", [
      { brand: "Volkswagen", model: "Gol", yearFrom: 2012, yearTo: 2012 },
    ]);

    expect(r.catalogProductIds).toContain("MLB_VW");
    expect(r.unresolved).toHaveLength(0);
  });

  it("não afrouxa demais: nome divergente continua descartado", async () => {
    (mockedAxios as any).get.mockResolvedValue(domainCom([]));
    (mockedAxios as any).post.mockImplementation((url: string) => {
      if (url.includes("/attributes/BRAND/top_values")) {
        return Promise.resolve({
          data: { values: [{ id: "TV_VW", name: "Volkswagen" }] },
        });
      }
      if (url.includes("/top_values")) {
        return Promise.resolve({ data: { values: [] } });
      }
      if (url.includes("/chunks")) {
        return Promise.resolve({
          data: {
            results: [produto("CP_F", "Ford", "CP_KA", "Ka", "2012", "MLB_FORD")],
          },
        });
      }
      return Promise.resolve({ data: {} });
    });

    const r = await MLApiService.resolveCompatibilityCatalogProducts("tok", [
      { brand: "Volkswagen", model: "Gol", yearFrom: 2012, yearTo: 2012 },
    ]);

    expect(r.catalogProductIds).not.toContain("MLB_FORD");
    expect(r.unresolved.length).toBeGreaterThan(0);
  });

  it("casamento por nome ignora acento", async () => {
    (mockedAxios as any).get.mockResolvedValue(domainCom([]));
    (mockedAxios as any).post.mockImplementation((url: string) => {
      if (url.includes("/top_values")) {
        return Promise.resolve({ data: { values: [] } });
      }
      if (url.includes("/chunks")) {
        return Promise.resolve({
          data: {
            results: [
              produto("CP_C", "Citroën", "CP_C3", "C3", "2015", "MLB_CIT"),
            ],
          },
        });
      }
      return Promise.resolve({ data: {} });
    });

    const r = await MLApiService.resolveCompatibilityCatalogProducts("tok", [
      { brand: "Citroen", model: "C3", yearFrom: 2015, yearTo: 2015 },
    ]);

    expect(r.catalogProductIds).toContain("MLB_CIT");
  });

  it("filtro de ano por containment segue intacto", async () => {
    (mockedAxios as any).get.mockResolvedValue(
      domainCom([{ id: "BR_FIAT", name: "Fiat" }]),
    );
    (mockedAxios as any).post.mockImplementation((url: string) => {
      if (url.includes("/chunks")) {
        return Promise.resolve({
          data: {
            results: [
              produto("BR_FIAT", "Fiat", "MD_UNO", "Uno", "2008-2013", "MLB_R"),
            ],
          },
        });
      }
      return Promise.resolve({ data: { values: [] } });
    });

    const dentro = await MLApiService.resolveCompatibilityCatalogProducts(
      "tok",
      [{ brand: "Fiat", model: "Uno", yearFrom: 2010, yearTo: 2010 }],
    );
    expect(dentro.catalogProductIds).toContain("MLB_R");

    __resetCompatCacheForTests();
    const fora = await MLApiService.resolveCompatibilityCatalogProducts("tok", [
      { brand: "Fiat", model: "Uno", yearFrom: 2020, yearTo: 2020 },
    ]);
    expect(fora.catalogProductIds).not.toContain("MLB_R");
  });
});

describe("cache de catálogo — envenenamento e TTL de vazio", () => {
  beforeEach(() => {
    (mockedAxios as any).get = vi.fn();
    (mockedAxios as any).post = vi.fn();
    (mockedAxios as any).isAxiosError = () => false;
    __resetCompatCacheForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    __resetCompatCacheForTests();
  });

  it("marca vinda de top_values não entra no cache global de marcas", async () => {
    // O push acontecia no array devolvido POR REFERÊNCIA pelo cache, que é
    // compartilhado entre contas e serve o endpoint público de marcas.
    (mockedAxios as any).get.mockResolvedValue(
      domainCom([{ id: "BR_FIAT", name: "Fiat" }]),
    );
    (mockedAxios as any).post.mockImplementation((url: string) => {
      if (url.includes("/attributes/BRAND/top_values")) {
        return Promise.resolve({
          data: { values: [{ id: "TV_VW", name: "Volkswagen" }] },
        });
      }
      if (url.includes("/top_values")) {
        return Promise.resolve({ data: { values: [] } });
      }
      if (url.includes("/chunks")) {
        return Promise.resolve({ data: { results: [] } });
      }
      return Promise.resolve({ data: {} });
    });

    const antes = await MLApiService.listCompatibilityBrands("tok");
    const countAntes = antes.length;

    await MLApiService.resolveCompatibilityCatalogProducts("tok", [
      { brand: "Volkswagen", model: "Gol", yearFrom: 2012, yearTo: 2012 },
    ]);

    const depois = await MLApiService.listCompatibilityBrands("tok");
    expect(depois).toHaveLength(countAntes);
    expect(depois.map((b) => b.name)).not.toContain("Volkswagen");
  });

  it("lista de marcas vazia expira em 30s, não em 10 min", async () => {
    // Uma falha momentânea do catalog_domains grudava por 10 minutos e
    // derrubava a resolução de compat de todas as contas do processo.
    vi.useFakeTimers();
    (mockedAxios as any).get.mockResolvedValue(domainCom([]));

    await MLApiService.listCompatibilityBrands("tok");
    expect((mockedAxios as any).get).toHaveBeenCalledTimes(1);

    // Dentro da janela curta ainda usa o cache.
    vi.advanceTimersByTime(10_000);
    await MLApiService.listCompatibilityBrands("tok");
    expect((mockedAxios as any).get).toHaveBeenCalledTimes(1);

    // Passados 30s, consulta de novo.
    vi.advanceTimersByTime(25_000);
    await MLApiService.listCompatibilityBrands("tok");
    expect((mockedAxios as any).get).toHaveBeenCalledTimes(2);
  });

  it("lista de marcas populada mantém o TTL longo", async () => {
    vi.useFakeTimers();
    (mockedAxios as any).get.mockResolvedValue(
      domainCom([{ id: "BR_FIAT", name: "Fiat" }]),
    );

    await MLApiService.listCompatibilityBrands("tok");
    vi.advanceTimersByTime(60_000);
    await MLApiService.listCompatibilityBrands("tok");
    expect((mockedAxios as any).get).toHaveBeenCalledTimes(1);
  });

  it("top_values entra em cache (era o endpoint mais chamado, sem cache nenhum)", async () => {
    (mockedAxios as any).post.mockResolvedValue({
      data: { values: [{ id: "TV_VW", name: "Volkswagen" }] },
    });

    await MLApiService.getCompatAttributeTopValues("tok", "BRAND");
    await MLApiService.getCompatAttributeTopValues("tok", "BRAND");
    expect((mockedAxios as any).post).toHaveBeenCalledTimes(1);

    // Filtro diferente é chave diferente.
    await MLApiService.getCompatAttributeTopValues("tok", "MODEL", [
      { id: "BRAND", value_id: "TV_VW" },
    ]);
    expect((mockedAxios as any).post).toHaveBeenCalledTimes(2);
  });
});
