import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import axios from "axios";
import {
  MLApiService,
  __resetCompatCacheForTests,
} from "../app/marketplaces/services/ml-api.service";

vi.mock("axios");
const mockedAxios = axios as unknown as {
  post: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  isAxiosError: (e: unknown) => boolean;
};

describe("MLApiService.setItemCompatibilities", () => {
  beforeEach(() => {
    (mockedAxios as any).post = vi.fn();
    (mockedAxios as any).isAxiosError = () => false;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs a single batch to /items/{id}/compatibilities with products: [{id}]", async () => {
    (mockedAxios as any).post.mockResolvedValue({ data: {} });

    const result = await MLApiService.setItemCompatibilities("tok", "MLB123", [
      "MLB1000",
      "MLB1001",
      "MLB1002",
    ]);

    expect((mockedAxios as any).post).toHaveBeenCalledTimes(1);
    const [url, body] = (mockedAxios as any).post.mock.calls[0];
    expect(url).toMatch(/\/items\/MLB123\/compatibilities$/);
    expect(body).toEqual({
      products: [{ id: "MLB1000" }, { id: "MLB1001" }, { id: "MLB1002" }],
    });
    // O body NÃO deve conter domain_id ou known_attributes — ML rejeita.
    expect(body).not.toHaveProperty("domain_id");
    expect(body).not.toHaveProperty("known_attributes");
    expect(result.success).toBe(true);
    expect(result.createdCount).toBe(3);
    expect(result.errors).toEqual([]);
  });

  it("dedupa IDs antes de postar", async () => {
    (mockedAxios as any).post.mockResolvedValue({ data: {} });
    const result = await MLApiService.setItemCompatibilities("tok", "MLB1", [
      "MLB42",
      "MLB42",
      "MLB43",
    ]);
    const [, body] = (mockedAxios as any).post.mock.calls[0];
    expect(body.products).toEqual([{ id: "MLB42" }, { id: "MLB43" }]);
    expect(result.createdCount).toBe(2);
  });

  it("cai para chamadas individuais quando o batch falha, isolando IDs ruins", async () => {
    (mockedAxios as any).post
      .mockRejectedValueOnce(new Error("batch 400 one invalid id")) // batch
      .mockResolvedValueOnce({ data: {} }) // individual 1 OK
      .mockRejectedValueOnce(new Error("400 invalid catalog id")); // individual 2 fail
    (mockedAxios as any).isAxiosError = () => false;

    const result = await MLApiService.setItemCompatibilities("tok", "MLB1", [
      "MLB_OK",
      "MLB_BAD",
    ]);

    expect((mockedAxios as any).post).toHaveBeenCalledTimes(3);
    expect(result.createdCount).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("MLB_BAD");
    expect(result.success).toBe(false);
  });

  it("retorna vazio sem chamar a API quando a lista de IDs é vazia", async () => {
    const result = await MLApiService.setItemCompatibilities("tok", "MLB1", []);
    expect((mockedAxios as any).post).not.toHaveBeenCalled();
    expect(result.createdCount).toBe(0);
    expect(result.success).toBe(false);
  });

  it("ignora strings vazias e valores não-string na lista de IDs", async () => {
    (mockedAxios as any).post.mockResolvedValue({ data: {} });
    const result = await MLApiService.setItemCompatibilities(
      "tok",
      "MLB1",
      ["MLB42", "", null as any, undefined as any, "MLB43"],
    );
    const [, body] = (mockedAxios as any).post.mock.calls[0];
    expect(body.products).toEqual([{ id: "MLB42" }, { id: "MLB43" }]);
    expect(result.createdCount).toBe(2);
  });
});

describe("MLApiService.setItemCompatibilitiesByAttributes", () => {
  beforeEach(() => {
    (mockedAxios as any).post = vi.fn();
    (mockedAxios as any).get = vi.fn();
    (mockedAxios as any).put = vi.fn();
    (mockedAxios as any).isAxiosError = () => false;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("envia PUT com value_id resolvido via top_values quando brand/model estão no catálogo", async () => {
    (mockedAxios as any).put = vi.fn().mockResolvedValue({ data: {} });
    (mockedAxios as any).get = vi.fn().mockResolvedValue({
      data: { category_id: "MLB438074" },
    });
    (mockedAxios as any).post = vi
      .fn()
      // top_values BRAND retorna Ford
      .mockResolvedValueOnce({
        data: { values: [{ id: "66432", name: "Ford" }] },
      })
      // top_values MODEL com BRAND=Ford retorna Ka
      .mockResolvedValueOnce({
        data: { values: [{ id: "889", name: "Ka" }] },
      });

    await MLApiService.setItemCompatibilitiesByAttributes("tok", "MLB123", [
      { brand: "Ford", model: "Ka", yearFrom: 2018, yearTo: 2018 },
    ]);

    const [, body] = (mockedAxios as any).put.mock.calls[0];
    expect(body.create.products_families[0].attributes).toEqual([
      { id: "BRAND", value_id: "66432", value_name: "Ford" },
      { id: "MODEL", value_id: "889", value_name: "Ka" },
      { id: "YEAR", value_name: "2018" },
    ]);
  });

  it("envia PUT com domain_id + category_id no root e products_families dentro de create", async () => {
    (mockedAxios as any).put = vi.fn().mockResolvedValue({ data: {} });
    (mockedAxios as any).get = vi.fn().mockResolvedValue({
      data: { category_id: "MLB438074" },
    });

    const result = await MLApiService.setItemCompatibilitiesByAttributes(
      "tok",
      "MLB123",
      [{ brand: "Chevrolet", model: "Camaro", yearFrom: 2010, yearTo: 2010 }],
    );

    expect((mockedAxios as any).put).toHaveBeenCalledTimes(1);
    const [url, body] = (mockedAxios as any).put.mock.calls[0];
    expect(url).toMatch(/\/items\/MLB123\/compatibilities$/);
    expect(body).toEqual({
      domain_id: "MLB-CARS_AND_VANS",
      category_id: "MLB438074",
      create: {
        products_families: [
          {
            domain_id: "MLB-CARS_AND_VANS",
            attributes: [
              { id: "BRAND", value_name: "Chevrolet" },
              { id: "MODEL", value_name: "Camaro" },
              { id: "YEAR", value_name: "2010" },
            ],
          },
        ],
        universal: false,
      },
    });
    expect(result.success).toBe(true);
    expect(result.createdCount).toBe(1);
  });

  it("omite category_id do body quando GET /items não devolve", async () => {
    (mockedAxios as any).put = vi.fn().mockResolvedValue({ data: {} });
    (mockedAxios as any).get = vi.fn().mockResolvedValue({ data: {} });

    await MLApiService.setItemCompatibilitiesByAttributes("tok", "MLB123", [
      { brand: "Chevrolet", model: "Camaro", yearFrom: 2010, yearTo: 2010 },
    ]);

    const [, body] = (mockedAxios as any).put.mock.calls[0];
    expect(body).not.toHaveProperty("category_id");
    expect(body.domain_id).toBe("MLB-CARS_AND_VANS");
  });

  it("expande range de anos e dedupa tuplos (brand, model, year)", async () => {
    (mockedAxios as any).put = vi.fn().mockResolvedValue({ data: {} });

    const result = await MLApiService.setItemCompatibilitiesByAttributes(
      "tok",
      "MLB1",
      [
        { brand: "Fiat", model: "Uno", yearFrom: 2008, yearTo: 2010 },
        { brand: "Fiat", model: "Uno", yearFrom: 2009, yearTo: 2009 },
      ],
    );

    const [, body] = (mockedAxios as any).put.mock.calls[0];
    expect(body.create.products_families).toHaveLength(3);
    expect(result.createdCount).toBe(3);
  });

  it("omite YEAR quando não há ano informado", async () => {
    (mockedAxios as any).put = vi.fn().mockResolvedValue({ data: {} });

    await MLApiService.setItemCompatibilitiesByAttributes("tok", "MLB1", [
      { brand: "Fiat", model: "Uno" },
    ]);

    const [, body] = (mockedAxios as any).put.mock.calls[0];
    expect(body.create.products_families[0].attributes).toEqual([
      { id: "BRAND", value_name: "Fiat" },
      { id: "MODEL", value_name: "Uno" },
    ]);
  });

  it("cai para chamadas individuais quando batch falha, isolando veículos ruins", async () => {
    (mockedAxios as any).put = vi
      .fn()
      .mockRejectedValueOnce(new Error("batch 400"))
      .mockResolvedValueOnce({ data: {} })
      .mockRejectedValueOnce(new Error("400 invalid model"));

    const result = await MLApiService.setItemCompatibilitiesByAttributes(
      "tok",
      "MLB1",
      [
        { brand: "Chevrolet", model: "Camaro", yearFrom: 2010, yearTo: 2010 },
        { brand: "Fake", model: "Nada", yearFrom: 1800, yearTo: 1800 },
      ],
    );

    expect((mockedAxios as any).put).toHaveBeenCalledTimes(3);
    expect(result.createdCount).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("Fake/Nada/1800");
  });

  it("retorna vazio sem chamar API quando lista é vazia", async () => {
    (mockedAxios as any).put = vi.fn();
    const result = await MLApiService.setItemCompatibilitiesByAttributes(
      "tok",
      "MLB1",
      [],
    );
    expect((mockedAxios as any).put).not.toHaveBeenCalled();
    expect(result.createdCount).toBe(0);
  });

  it("ignora entradas sem brand ou model", async () => {
    (mockedAxios as any).put = vi.fn().mockResolvedValue({ data: {} });

    const result = await MLApiService.setItemCompatibilitiesByAttributes(
      "tok",
      "MLB1",
      [
        { brand: "", model: "Uno", yearFrom: 2010 },
        { brand: "Fiat", model: "", yearFrom: 2010 },
        { brand: "Fiat", model: "Uno", yearFrom: 2010 },
      ],
    );

    const [, body] = (mockedAxios as any).put.mock.calls[0];
    expect(body.create.products_families).toHaveLength(1);
    expect(result.createdCount).toBe(1);
  });

  it("usa /user-products/{id}/compatibilities quando GET /items retorna user_product_id", async () => {
    (mockedAxios as any).isAxiosError = (e: unknown) =>
      Boolean((e as any)?.isAxiosError);
    (mockedAxios as any).put = vi.fn().mockResolvedValue({ data: {} });
    (mockedAxios as any).get = vi.fn().mockResolvedValueOnce({
      data: { user_product_id: "UP-99" },
    });

    const result = await MLApiService.setItemCompatibilitiesByAttributes(
      "tok",
      "MLB1",
      [{ brand: "Fiat", model: "Uno", yearFrom: 2010, yearTo: 2010 }],
    );

    expect((mockedAxios as any).put).toHaveBeenCalledTimes(1);
    const [url] = (mockedAxios as any).put.mock.calls[0];
    expect(url).toMatch(/\/user-products\/UP-99\/compatibilities$/);
    expect(result.success).toBe(true);
    expect(result.createdCount).toBe(1);
  });

  it("cai para /items/{id}/compatibilities quando /user-products falha mas GET retornou um id", async () => {
    (mockedAxios as any).isAxiosError = (e: unknown) =>
      Boolean((e as any)?.isAxiosError);
    (mockedAxios as any).put = vi
      .fn()
      .mockRejectedValueOnce(new Error("up failed")) // /user-products/UP-99 falha
      .mockResolvedValueOnce({ data: {} }); // /items/MLB1 ok
    (mockedAxios as any).get = vi.fn().mockResolvedValueOnce({
      data: { user_product_id: "UP-99" },
    });

    const result = await MLApiService.setItemCompatibilitiesByAttributes(
      "tok",
      "MLB1",
      [{ brand: "Fiat", model: "Uno", yearFrom: 2010, yearTo: 2010 }],
    );

    const urls = (mockedAxios as any).put.mock.calls.map(
      (c: unknown[]) => c[0],
    );
    expect(urls[0]).toMatch(/\/user-products\/UP-99\/compatibilities$/);
    expect(urls[1]).toMatch(/\/items\/MLB1\/compatibilities$/);
    expect(result.success).toBe(true);
  });

  it("usa /items/{id}/compatibilities quando item não tem user_product_id", async () => {
    (mockedAxios as any).isAxiosError = (e: unknown) =>
      Boolean((e as any)?.isAxiosError);
    (mockedAxios as any).put = vi.fn().mockResolvedValue({ data: {} });
    (mockedAxios as any).get = vi.fn().mockResolvedValueOnce({
      data: {},
    });

    const result = await MLApiService.setItemCompatibilitiesByAttributes(
      "tok",
      "MLB1",
      [{ brand: "Fiat", model: "Uno", yearFrom: 2010, yearTo: 2010 }],
    );

    expect((mockedAxios as any).put).toHaveBeenCalledTimes(1);
    const [url] = (mockedAxios as any).put.mock.calls[0];
    expect(url).toMatch(/\/items\/MLB1\/compatibilities$/);
    expect(result.success).toBe(true);
  });
});

describe("MLApiService.resolveCompatibilityCatalogProducts", () => {
  beforeEach(() => {
    (mockedAxios as any).post = vi.fn();
    (mockedAxios as any).get = vi.fn();
    (mockedAxios as any).isAxiosError = () => false;
    __resetCompatCacheForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolve marca/modelo/ano textuais em catalog product IDs via chunks search", async () => {
    // Primeiro get: catalog_domains (listar marcas)
    (mockedAxios as any).get.mockResolvedValueOnce({
      data: {
        attributes: [
          {
            id: "BRAND",
            values: [{ id: "BR_FORD", name: "Ford" }],
          },
        ],
      },
    });
    // Posts em sequência: 1) models search (listCompatibilityModels),
    // 2) chunks search para (brand+model+ano)
    (mockedAxios as any).post
      .mockResolvedValueOnce({
        data: {
          results: [
            {
              id: "MLB_KA_2018",
              attributes: [
                { id: "BRAND", value_id: "BR_FORD", value_name: "Ford" },
                { id: "MODEL", value_id: "MD_KA", value_name: "Ka" },
                { id: "VEHICLE_YEAR", value_id: "Y2018", value_name: "2018" },
              ],
            },
          ],
          paging: { total: 1 },
        },
      })
      .mockResolvedValueOnce({
        data: {
          results: [
            {
              id: "MLB_KA_2018",
              attributes: [
                { id: "VEHICLE_YEAR", value_id: "Y2018", value_name: "2018" },
              ],
            },
            {
              id: "MLB_KA_2019",
              attributes: [
                { id: "VEHICLE_YEAR", value_id: "Y2019", value_name: "2019" },
              ],
            },
          ],
          paging: { total: 2 },
        },
      });

    const result = await MLApiService.resolveCompatibilityCatalogProducts(
      "tok",
      [{ brand: "Ford", model: "Ka", yearFrom: 2018, yearTo: 2018 }],
    );

    expect(result.catalogProductIds).toContain("MLB_KA_2018");
    expect(result.catalogProductIds).not.toContain("MLB_KA_2019");
    expect(result.unresolved).toEqual([]);
  });

  it("reporta entradas não resolvidas quando fallback por nome também volta vazio", async () => {
    // Quando a marca não está no cache do /catalog_domains, caímos para
    // open_attributes (match por nome). Se o ML também não retornar nada,
    // reportamos "no catalog products" — delegamos o matching ao ML e a
    // ausência de resultados é o sinal final de falha.
    (mockedAxios as any).get.mockResolvedValueOnce({
      data: {
        attributes: [
          {
            id: "BRAND",
            values: [{ id: "BR_FIAT", name: "Fiat" }],
          },
        ],
      },
    });
    (mockedAxios as any).post.mockResolvedValue({ data: { results: [] } });

    const result = await MLApiService.resolveCompatibilityCatalogProducts(
      "tok",
      [{ brand: "MarcaInexistente", model: "Foo", yearFrom: 2020 }],
    );

    expect(result.catalogProductIds).toEqual([]);
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0].reason).toMatch(/no catalog products/i);
  });

  it("usa open_attributes como fallback quando marca não está no catalog_domains (ex.: BMW)", async () => {
    (mockedAxios as any).get.mockResolvedValueOnce({
      data: {
        attributes: [
          {
            id: "BRAND",
            values: [{ id: "BR_FIAT", name: "Fiat" }],
          },
        ],
      },
    });
    (mockedAxios as any).post.mockResolvedValueOnce({
      data: {
        results: [
          {
            id: "MLB_BMW_IX_2023",
            attributes: [
              { id: "BRAND", value_id: "BR_BMW", value_name: "BMW" },
              { id: "MODEL", value_id: "MD_IX", value_name: "iX" },
              { id: "VEHICLE_YEAR", value_name: "2023" },
            ],
          },
        ],
        paging: { total: 1 },
      },
    });

    const result = await MLApiService.resolveCompatibilityCatalogProducts(
      "tok",
      [{ brand: "BMW", model: "iX", yearFrom: 2023, yearTo: 2023 }],
    );

    const postCalls = (mockedAxios as any).post.mock.calls as unknown[][];
    const lastBody = postCalls[postCalls.length - 1]?.[1] as
      | { open_attributes?: unknown; known_attributes?: unknown }
      | undefined;
    expect(lastBody?.open_attributes).toEqual([
      { id: "BRAND", value_name: "BMW" },
      { id: "MODEL", value_name: "iX" },
    ]);
    expect(lastBody?.known_attributes).toBeUndefined();
    expect(result.catalogProductIds).toContain("MLB_BMW_IX_2023");
    expect(result.unresolved).toEqual([]);
  });

  it("aceita catalog product cujo VEHICLE_YEAR vem como range '2008-2013' quando ano pedido está dentro", async () => {
    (mockedAxios as any).get.mockResolvedValueOnce({
      data: {
        attributes: [
          {
            id: "BRAND",
            values: [{ id: "BR_FIAT", name: "Fiat" }],
          },
        ],
      },
    });
    (mockedAxios as any).post
      // listCompatibilityModels
      .mockResolvedValueOnce({
        data: {
          results: [
            {
              id: "MLB_UNO_RANGE",
              attributes: [
                { id: "BRAND", value_id: "BR_FIAT", value_name: "Fiat" },
                { id: "MODEL", value_id: "MD_UNO", value_name: "Uno" },
              ],
            },
          ],
          paging: { total: 1 },
        },
      })
      // chunks search com marca+modelo — produto cobre range "2008-2013"
      .mockResolvedValueOnce({
        data: {
          results: [
            {
              id: "MLB_UNO_RANGE",
              attributes: [
                { id: "BRAND", value_id: "BR_FIAT", value_name: "Fiat" },
                { id: "MODEL", value_id: "MD_UNO", value_name: "Uno" },
                { id: "VEHICLE_YEAR", value_name: "2008-2013" },
              ],
            },
          ],
          paging: { total: 1 },
        },
      });

    const result = await MLApiService.resolveCompatibilityCatalogProducts(
      "tok",
      [{ brand: "Fiat", model: "Uno", yearFrom: 2010, yearTo: 2010 }],
    );

    expect(result.catalogProductIds).toContain("MLB_UNO_RANGE");
    expect(result.unresolved).toEqual([]);
  });

  it("descarta catalog product quando ano pedido está fora do range do VEHICLE_YEAR", async () => {
    (mockedAxios as any).get.mockResolvedValueOnce({
      data: {
        attributes: [
          {
            id: "BRAND",
            values: [{ id: "BR_FIAT", name: "Fiat" }],
          },
        ],
      },
    });
    (mockedAxios as any).post
      .mockResolvedValueOnce({
        data: {
          results: [
            {
              id: "MLB_UNO_OLD",
              attributes: [
                { id: "BRAND", value_id: "BR_FIAT", value_name: "Fiat" },
                { id: "MODEL", value_id: "MD_UNO", value_name: "Uno" },
              ],
            },
          ],
          paging: { total: 1 },
        },
      })
      .mockResolvedValueOnce({
        data: {
          results: [
            {
              id: "MLB_UNO_OLD",
              attributes: [
                { id: "VEHICLE_YEAR", value_name: "1984-2013" },
              ],
            },
          ],
          paging: { total: 1 },
        },
      });

    const result = await MLApiService.resolveCompatibilityCatalogProducts(
      "tok",
      [{ brand: "Fiat", model: "Uno", yearFrom: 2024, yearTo: 2024 }],
    );

    expect(result.catalogProductIds).not.toContain("MLB_UNO_OLD");
    expect(result.unresolved).toHaveLength(1);
  });

  it("inclui catalog product sem atributo VEHICLE_YEAR (tratado como compatível com qualquer ano)", async () => {
    (mockedAxios as any).get.mockResolvedValueOnce({
      data: {
        attributes: [
          {
            id: "BRAND",
            values: [{ id: "BR_FIAT", name: "Fiat" }],
          },
        ],
      },
    });
    (mockedAxios as any).post
      .mockResolvedValueOnce({
        data: {
          results: [
            {
              id: "MLB_UNO_ANY",
              attributes: [
                { id: "BRAND", value_id: "BR_FIAT", value_name: "Fiat" },
                { id: "MODEL", value_id: "MD_UNO", value_name: "Uno" },
              ],
            },
          ],
          paging: { total: 1 },
        },
      })
      .mockResolvedValueOnce({
        data: {
          results: [
            {
              id: "MLB_UNO_ANY",
              attributes: [
                { id: "BRAND", value_id: "BR_FIAT", value_name: "Fiat" },
                { id: "MODEL", value_id: "MD_UNO", value_name: "Uno" },
              ],
            },
          ],
          paging: { total: 1 },
        },
      });

    const result = await MLApiService.resolveCompatibilityCatalogProducts(
      "tok",
      [{ brand: "Fiat", model: "Uno", yearFrom: 2002, yearTo: 2002 }],
    );

    expect(result.catalogProductIds).toContain("MLB_UNO_ANY");
    expect(result.unresolved).toEqual([]);
  });

  it("envia site_id: MLB em todas as chamadas ao /catalog_compatibilities/products_search/chunks", async () => {
    (mockedAxios as any).get.mockResolvedValueOnce({
      data: {
        attributes: [
          {
            id: "BRAND",
            values: [{ id: "BR_FORD", name: "Ford" }],
          },
        ],
      },
    });
    (mockedAxios as any).post.mockResolvedValue({
      data: { results: [], paging: { total: 0 } },
    });

    await MLApiService.resolveCompatibilityCatalogProducts("tok", [
      { brand: "Ford", model: "Ka", yearFrom: 2020 },
    ]);

    const postCalls = (mockedAxios as any).post.mock.calls as unknown[][];
    for (const call of postCalls) {
      const [url, body] = call as [string, { site_id?: string }];
      if (typeof url === "string" && url.includes("products_search/chunks")) {
        expect(body.site_id).toBe("MLB");
      }
    }
  });

  it("range multi-ano faz 1 única busca ao chunks por (brand, model), não N buscas idênticas", async () => {
    (mockedAxios as any).get.mockResolvedValueOnce({
      data: {
        attributes: [
          {
            id: "BRAND",
            values: [{ id: "BR_FIAT", name: "Fiat" }],
          },
        ],
      },
    });
    // 1x listCompatibilityModels + 1x chunks search deveriam bastar para
    // cobrir um range de 2008..2013 (6 anos). A paginação é encerrada pelo
    // `paging.total`. Se houver chamada extra, a fixture de erro dispara.
    (mockedAxios as any).post
      .mockResolvedValueOnce({
        data: {
          results: [
            {
              id: "MLB_UNO_RANGE",
              attributes: [
                { id: "BRAND", value_id: "BR_FIAT", value_name: "Fiat" },
                { id: "MODEL", value_id: "MD_UNO", value_name: "Uno" },
              ],
            },
          ],
          paging: { total: 1 },
        },
      })
      .mockResolvedValueOnce({
        data: {
          results: [
            {
              id: "MLB_UNO_RANGE",
              attributes: [
                { id: "BRAND", value_id: "BR_FIAT", value_name: "Fiat" },
                { id: "MODEL", value_id: "MD_UNO", value_name: "Uno" },
                { id: "VEHICLE_YEAR", value_name: "2008-2013" },
              ],
            },
          ],
          paging: { total: 1 },
        },
      })
      .mockRejectedValue(
        new Error("regressão: fetch duplicado por ano no range"),
      );

    const result = await MLApiService.resolveCompatibilityCatalogProducts(
      "tok",
      [{ brand: "Fiat", model: "Uno", yearFrom: 2008, yearTo: 2013 }],
    );

    // 2 chamadas esperadas: 1 para listCompatibilityModels + 1 para a busca
    // única de catalog products (que agora cobre o range inteiro de 6 anos).
    // Antes da otimização eram 7 (1 + 6 iterações idênticas).
    const chunkCalls = (
      (mockedAxios as any).post.mock.calls as unknown[][]
    ).filter((call) => {
      const url = call[0];
      return typeof url === "string" && url.includes("products_search/chunks");
    });
    expect(chunkCalls).toHaveLength(2);
    expect(result.catalogProductIds).toContain("MLB_UNO_RANGE");
    expect(result.unresolved).toEqual([]);
  });
});
