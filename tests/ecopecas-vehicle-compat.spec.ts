import { beforeEach, describe, expect, it, vi } from "vitest";
import axios from "axios";
import {
  getModelsForBrand,
  getVehicleBrands,
  getYearsForModel,
  matchesVehicleQuery,
} from "../app/lib/vehicle-catalog";
import {
  findExactOrUniqueCompatName,
  findMarketplaceVehicleModel,
  marketplaceVehicleBrandName,
} from "../app/marketplaces/lib/vehicle-compatibility-aliases";
import {
  MLApiService,
  __resetCompatCacheForTests,
} from "../app/marketplaces/services/ml-api.service";

vi.mock("axios");
const mockedAxios = axios as unknown as {
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  isAxiosError: (error: unknown) => boolean;
};

describe("Eco Peças — marcas e modelos", () => {
  it("mantém Chery antiga distinta de CAOA Chery e não retira outras marcas", () => {
    const brands = getVehicleBrands();
    expect(brands).toContain("Chery");
    expect(brands).toContain("CAOA Chery");
    expect(brands).toContain("Effa");
    expect(brands).toContain("Volkswagen");
    expect(getModelsForBrand("Chery")).toEqual(
      expect.arrayContaining(["Tiggo", "QQ", "Face", "Celer", "Celer Sedan"]),
    );
    expect(getModelsForBrand("CAOA Chery")).toContain("Tiggo 2");
    expect(getModelsForBrand("CAOA Chery")).not.toContain("Tiggo");
    expect(getYearsForModel("Chery", "Tiggo")).toContain(2011);
    expect(matchesVehicleQuery("Celer Sedan", "Celer")).toBe(true);
  });

  it("expõe EFFA por carroceria e preserva anos observados no ML", () => {
    expect(getModelsForBrand("Effa")).toEqual(
      expect.arrayContaining(["V21 Pick Up", "V22 Pick Up", "v25 Furgão"]),
    );
    expect(getYearsForModel("Effa", "V21 Pick Up")).toContain(2019);
    expect(getYearsForModel("Effa", "V21 Pick-Up")).toContain(2026);
    expect(getYearsForModel("Effa", "v25 Furgão")).toContain(2027);
  });

  it("alias de marca é exato; substring de modelo ambígua não escolhe Tiggo 2", () => {
    expect(marketplaceVehicleBrandName("CAOA Chery")).toBe("Chery");
    expect(marketplaceVehicleBrandName("caоa chery")).not.toBe("Chery");
    expect(marketplaceVehicleBrandName("Chery")).toBe("Chery");
    expect(marketplaceVehicleBrandName("Volkswagen")).toBe("Volkswagen");
    const values = [{ name: "Tiggo 2" }, { name: "Tiggo 7" }];
    expect(findExactOrUniqueCompatName(values, "Tiggo")).toBeNull();
    expect(findExactOrUniqueCompatName(values, "Tiggo 2")).toEqual(values[0]);
    expect(findMarketplaceVehicleModel([values[0]], "Tiggo")).toBeNull();
  });
});

describe("Eco Peças — resolução de compatibilidade no ML", () => {
  beforeEach(() => {
    mockedAxios.get = vi.fn().mockResolvedValue({
      data: {
        domain_id: "MLB-CARS_AND_VANS",
        attributes: [{ id: "BRAND", suggested_values: [{ value_id: "389168", value_name: "Chery" }] }],
      },
    });
    mockedAxios.post = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/top_values")) return Promise.resolve({ data: { values: [] } });
      if (url.includes("/chunks")) {
        return Promise.resolve({
          data: {
            results: [
              {
                id: "MLB_CHERY_2020",
                attributes: [
                  { id: "BRAND", value_id: "389168", value_name: "Chery" },
                  { id: "MODEL", value_id: "8818127", value_name: "Tiggo 5X" },
                  { id: "VEHICLE_YEAR", value_name: "2020" },
                ],
              },
            ],
          },
        });
      }
      return Promise.resolve({ data: {} });
    });
    mockedAxios.isAxiosError = () => false;
    __resetCompatCacheForTests();
  });

  it("resolve CAOA Chery pelo ID Chery sem degradar para open_attributes", async () => {
    const result = await MLApiService.resolveCompatibilityCatalogProducts("token", [
      { brand: "CAOA Chery", model: "Tiggo 5X", yearFrom: 2020, yearTo: 2020 },
    ]);
    expect(result.catalogProductIds).toContain("MLB_CHERY_2020");
    const finalBodies = (mockedAxios.post.mock.calls as Array<[string, any]>)
      .filter(([url]) => url.includes("/chunks"))
      .map(([, body]) => body)
      .filter((body: any) => (body.known_attributes ?? []).some((a: any) => a.id === "MODEL"));
    expect(finalBodies).toHaveLength(1);
    expect(finalBodies[0].known_attributes).toEqual([
      { id: "BRAND", value_ids: ["389168"] },
      { id: "MODEL", value_ids: ["8818127"] },
    ]);
    expect(finalBodies[0].open_attributes).toBeUndefined();
  });

  it("não vincula o Tiggo original ao Tiggo 5X mesmo quando só ele volta na página", async () => {
    const result = await MLApiService.resolveCompatibilityCatalogProducts("token", [
      { brand: "Chery", model: "Tiggo", yearFrom: 2020, yearTo: 2020 },
    ]);
    expect(result.catalogProductIds).not.toContain("MLB_CHERY_2020");
    expect(result.unresolved).toHaveLength(1);
  });
});
