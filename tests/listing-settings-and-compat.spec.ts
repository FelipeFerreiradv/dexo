import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import axios from "axios";
import { MLApiService } from "../app/marketplaces/services/ml-api.service";
import { ListingUseCase } from "../app/marketplaces/usecases/listing.usercase";

vi.mock("axios");
const mockedAxios = axios as unknown as {
  post: ReturnType<typeof vi.fn>;
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

  it("POSTs one request per vehicle to /items/{id}/compatibilities with domain_id MLB-CARS_AND_VANS", async () => {
    (mockedAxios as any).post.mockResolvedValue({ data: {} });

    const result = await MLApiService.setItemCompatibilities(
      "tok",
      "MLB123",
      [
        [
          { id: "BRAND", value_name: "Ford" },
          { id: "MODEL", value_name: "Ka" },
          { id: "VEHICLE_YEAR", value_name: "2018" },
        ],
        [
          { id: "BRAND", value_name: "Ford" },
          { id: "MODEL", value_name: "Ka" },
          { id: "VEHICLE_YEAR", value_name: "2019" },
        ],
      ],
    );

    expect((mockedAxios as any).post).toHaveBeenCalledTimes(2);
    const [url, body] = (mockedAxios as any).post.mock.calls[0];
    expect(url).toMatch(/\/items\/MLB123\/compatibilities$/);
    expect(body).toEqual(
      expect.objectContaining({
        domain_id: "MLB-CARS_AND_VANS",
        known_attributes: expect.arrayContaining([
          expect.objectContaining({ id: "BRAND", value_name: "Ford" }),
          expect.objectContaining({ id: "MODEL", value_name: "Ka" }),
          expect.objectContaining({ id: "VEHICLE_YEAR", value_name: "2018" }),
        ]),
      }),
    );
    expect(result.success).toBe(true);
    expect(result.createdCount).toBe(2);
    expect(result.errors).toEqual([]);
  });

  it("does not throw when a vehicle POST fails; reports in errors array", async () => {
    (mockedAxios as any).post
      .mockResolvedValueOnce({ data: {} })
      .mockRejectedValueOnce(new Error("ML 400 invalid brand"));
    (mockedAxios as any).isAxiosError = () => false;

    const result = await MLApiService.setItemCompatibilities("tok", "MLB999", [
      [{ id: "BRAND", value_name: "Ford" }],
      [{ id: "BRAND", value_name: "InvalidBrand" }],
    ]);

    expect(result.createdCount).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("ML 400");
    expect(result.success).toBe(false);
  });

  it("skips empty known_attributes entries without calling the API", async () => {
    (mockedAxios as any).post.mockResolvedValue({ data: {} });
    const result = await MLApiService.setItemCompatibilities("tok", "MLB1", [
      [],
      [{ id: "BRAND", value_name: "Ford" }],
    ]);
    expect((mockedAxios as any).post).toHaveBeenCalledTimes(1);
    expect(result.createdCount).toBe(1);
  });
});

describe("ListingUseCase.buildCompatibilityVehicles (private helper)", () => {
  const buildVehicles = (ListingUseCase as any)
    .buildCompatibilityVehicles as (p: {
    compatibilities?: Array<{
      brand: string;
      model: string;
      yearFrom?: number | null;
      yearTo?: number | null;
      version?: string | null;
    }> | null;
  }) => Array<Array<{ id: string; value_name: string }>>;

  it("expands year ranges into one entry per year", () => {
    const result = buildVehicles({
      compatibilities: [
        { brand: "Ford", model: "Ka", yearFrom: 2015, yearTo: 2017 },
      ],
    });
    expect(result).toHaveLength(3);
    expect(
      result.map((v) => v.find((a) => a.id === "VEHICLE_YEAR")?.value_name),
    ).toEqual(["2015", "2016", "2017"]);
    for (const v of result) {
      expect(v.find((a) => a.id === "BRAND")?.value_name).toBe("Ford");
      expect(v.find((a) => a.id === "MODEL")?.value_name).toBe("Ka");
    }
  });

  it("emits a year-less vehicle when neither yearFrom nor yearTo is provided", () => {
    const result = buildVehicles({
      compatibilities: [{ brand: "VW", model: "Gol" }],
    });
    expect(result).toHaveLength(1);
    expect(result[0].find((a) => a.id === "VEHICLE_YEAR")).toBeUndefined();
    expect(result[0].find((a) => a.id === "BRAND")?.value_name).toBe("VW");
    expect(result[0].find((a) => a.id === "MODEL")?.value_name).toBe("Gol");
  });

  it("drops entries missing brand or model", () => {
    const result = buildVehicles({
      compatibilities: [
        { brand: "", model: "Ka" },
        { brand: "Ford", model: "" },
        { brand: "Ford", model: "Ka", yearFrom: 2020 },
      ],
    });
    expect(result).toHaveLength(1);
    expect(result[0].find((a) => a.id === "MODEL")?.value_name).toBe("Ka");
  });

  it("deduplicates identical (brand, model, year) tuples", () => {
    const result = buildVehicles({
      compatibilities: [
        { brand: "Ford", model: "Ka", yearFrom: 2018, yearTo: 2018 },
        { brand: "Ford", model: "Ka", yearFrom: 2018, yearTo: 2018 },
      ],
    });
    expect(result).toHaveLength(1);
  });

  it("returns empty list for null/undefined compatibilities", () => {
    expect(buildVehicles({ compatibilities: null })).toEqual([]);
    expect(buildVehicles({})).toEqual([]);
  });
});
