import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import axios from "axios";
import {
  MLApiService,
  __resetCompatCacheForTests,
} from "../app/marketplaces/services/ml-api.service";

/**
 * Sonda contra a API real (24/07/2026) estabeleceu dois fatos que guiam estes
 * testes:
 *
 * 1. `GET /catalog_domains/MLB-CARS_AND_VANS` devolve as marcas em
 *    `suggested_values` ({value_id, value_name}), NÃO em `values`. Ler só
 *    `values` produzia lista sempre vazia — a origem do
 *    "brandsCache loaded: 0 brands" do log de produção.
 *
 * 2. catalog_domains, top_values e os catalog products compartilham o MESMO
 *    espaço de IDs (Volkswagen = 60249 nos três). Quem devolve lixo é
 *    `open_attributes`: pedindo BRAND=Volkswagen + MODEL=Gol por nome, o ML
 *    respondeu com Fiat Mobi. É isso que produz o
 *    "0 of 1500 matched brand+model" — o filtro local está CERTO ao descartar.
 *
 * Logo: privilegiar known_attributes sempre que houver value_id, e manter o
 * filtro por value_id. Compatibilidade errada no anúncio é pior do que
 * compatibilidade faltando.
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

/** catalog_domains no formato legado (`values`). */
const domainCom = (marcas: Array<{ id: string; name: string }>) => ({
  data: {
    domain_id: "MLB-CARS_AND_VANS",
    attributes: [{ id: "BRAND", values: marcas }],
  },
});

/** catalog_domains no formato REAL do ML hoje (`suggested_values`). */
const domainComSuggested = (marcas: Array<{ id: string; name: string }>) => ({
  data: {
    domain_id: "MLB-CARS_AND_VANS",
    attributes: [
      {
        id: "BRAND",
        suggested_values: marcas.map((m) => ({
          value_id: m.id,
          value_name: m.name,
        })),
      },
    ],
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

  it("lê as marcas de suggested_values (formato real do ML)", async () => {
    // Fix da causa-raiz do "brandsCache loaded: 0 brands": o parser lia
    // `values`, que o ML não preenche neste endpoint.
    (mockedAxios as any).get.mockResolvedValue(
      domainComSuggested([{ id: "60249", name: "Volkswagen" }]),
    );

    const marcas = await MLApiService.listCompatibilityBrands("tok");
    expect(marcas).toHaveLength(1);
    expect(marcas[0]).toMatchObject({ valueId: "60249", name: "Volkswagen" });
  });

  it("marca resolvida por top_values usa known_attributes (ids são o mesmo espaço)", async () => {
    // catalog_domains vazio força o fallback por top_values. O id de lá é
    // válido para a busca — open_attributes é que devolve lixo.
    (mockedAxios as any).get.mockResolvedValue(domainCom([]));
    (mockedAxios as any).post.mockImplementation((url: string) => {
      if (url.includes("/attributes/BRAND/top_values")) {
        return Promise.resolve({
          data: { values: [{ id: "60249", name: "Volkswagen" }] },
        });
      }
      if (url.includes("/attributes/MODEL/top_values")) {
        return Promise.resolve({
          data: { values: [{ id: "62109", name: "Gol" }] },
        });
      }
      if (url.includes("/top_values")) {
        return Promise.resolve({ data: { values: [] } });
      }
      if (url.includes("/chunks")) {
        return Promise.resolve({
          data: {
            results: [
              produto("60249", "Volkswagen", "62109", "Gol", "2012", "MLB_VW"),
            ],
          },
        });
      }
      return Promise.resolve({ data: {} });
    });

    const r = await MLApiService.resolveCompatibilityCatalogProducts("tok", [
      { brand: "Volkswagen", model: "Gol", yearFrom: 2012, yearTo: 2012 },
    ]);

    // A primeira chamada ao chunks é a de listCompatibilityModels (só BRAND);
    // a que interessa é a busca final, com BRAND + MODEL.
    const buscaFinal = (mockedAxios as any).post.mock.calls
      .filter(([url]: [string]) => url.includes("/chunks"))
      .map(([, body]: [string, any]) => body)
      .find((b: any) =>
        (b.known_attributes ?? []).some((a: any) => a.id === "MODEL"),
      );
    expect(buscaFinal).toBeTruthy();
    expect(buscaFinal.known_attributes).toEqual([
      { id: "BRAND", value_ids: ["60249"] },
      { id: "MODEL", value_ids: ["62109"] },
    ]);
    expect(buscaFinal.open_attributes).toBeUndefined();
    expect(r.catalogProductIds).toContain("MLB_VW");
  });

  it("marca que não resolve em fonte nenhuma cai em open_attributes e o lixo é descartado", async () => {
    // Cenário real do log: "CAOA Chery" não casa com "Chery" do catálogo. Sem
    // value_id, a busca vai por nome e o ML devolve produto de outra marca —
    // o filtro local descartar isso é o comportamento CORRETO.
    (mockedAxios as any).get.mockResolvedValue(domainCom([]));
    (mockedAxios as any).post.mockImplementation((url: string) => {
      if (url.includes("/top_values")) {
        return Promise.resolve({ data: { values: [] } });
      }
      if (url.includes("/chunks")) {
        return Promise.resolve({
          data: {
            results: [
              produto("67781", "Fiat", "275412", "Mobi", "2023", "MLB_LIXO"),
            ],
          },
        });
      }
      return Promise.resolve({ data: {} });
    });

    const r = await MLApiService.resolveCompatibilityCatalogProducts("tok", [
      { brand: "CAOA Chery", model: "iCar", yearFrom: 2024, yearTo: 2024 },
    ]);

    expect(r.catalogProductIds).not.toContain("MLB_LIXO");
    expect(r.unresolved.length).toBeGreaterThan(0);
    expect(r.unresolved[0].reason).toContain("ML ignored filter");
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
