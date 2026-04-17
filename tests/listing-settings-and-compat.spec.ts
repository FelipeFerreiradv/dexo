import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import axios from "axios";
import { MLApiService } from "../app/marketplaces/services/ml-api.service";

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

describe("MLApiService.resolveCompatibilityCatalogProducts", () => {
  beforeEach(() => {
    (mockedAxios as any).post = vi.fn();
    (mockedAxios as any).get = vi.fn();
    (mockedAxios as any).isAxiosError = () => false;
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

  it("reporta entradas não resolvidas (marca desconhecida) sem lançar", async () => {
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
    expect(result.unresolved[0].reason).toMatch(/brand not found/i);
  });
});
