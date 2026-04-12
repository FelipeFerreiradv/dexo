import { describe, it, expect } from "vitest";
import {
  composeCanonicalVersion,
  mapCatalogProductToVehicle,
} from "../app/marketplaces/services/ml-api.service";

describe("composeCanonicalVersion", () => {
  it("prefers TRIM when present", () => {
    expect(
      composeCanonicalVersion({
        trim: "Attractive 1.8 8V Flex",
        shortVersion: "1.8",
        engine: "1.8 8V Flex",
      }),
    ).toBe("Attractive 1.8 8V Flex");
  });

  it("falls back to SHORT_VERSION + ENGINE when engine is not fully contained", () => {
    expect(
      composeCanonicalVersion({
        trim: null,
        shortVersion: "EX 2.0",
        engine: "2.0 16V Flex",
      }),
    ).toBe("EX 2.0 2.0 16V Flex");
  });

  it("does not append engine already contained in short_version", () => {
    expect(
      composeCanonicalVersion({
        shortVersion: "Attractive 1.8 8V Flex",
        engine: "1.8 8V Flex",
      }),
    ).toBe("Attractive 1.8 8V Flex");
  });

  it("returns short_version alone when engine missing", () => {
    expect(
      composeCanonicalVersion({ shortVersion: "LX", engine: null }),
    ).toBe("LX");
  });

  it("returns engine alone when short_version missing", () => {
    expect(
      composeCanonicalVersion({ shortVersion: null, engine: "1.6 16V" }),
    ).toBe("1.6 16V");
  });

  it("returns empty string when everything missing", () => {
    expect(composeCanonicalVersion({})).toBe("");
  });

  it("combines when engine is different from short_version", () => {
    const result = composeCanonicalVersion({
      shortVersion: "EX",
      engine: "2.0 16V",
    });
    expect(result).toBe("EX 2.0 16V");
  });
});

describe("mapCatalogProductToVehicle", () => {
  const buildProduct = (attrs: Array<{ id: string; value_name?: string; value_id?: string }>) => ({
    id: "MLBP123",
    attributes: attrs,
  });

  it("returns null when brand or model is missing", () => {
    expect(
      mapCatalogProductToVehicle(
        buildProduct([{ id: "MODEL", value_name: "Stilo" }]),
      ),
    ).toBeNull();
    expect(
      mapCatalogProductToVehicle(
        buildProduct([{ id: "BRAND", value_name: "Fiat" }]),
      ),
    ).toBeNull();
  });

  it("extracts brand, model, year and canonical version using TRIM", () => {
    const vehicle = mapCatalogProductToVehicle(
      buildProduct([
        { id: "BRAND", value_name: "Fiat", value_id: "B1" },
        { id: "MODEL", value_name: "Stilo", value_id: "M1" },
        { id: "VEHICLE_YEAR", value_name: "2010" },
        { id: "TRIM", value_name: "Attractive 1.8 8V Flex" },
      ]),
    );
    expect(vehicle).not.toBeNull();
    expect(vehicle?.brand).toBe("Fiat");
    expect(vehicle?.model).toBe("Stilo");
    expect(vehicle?.year).toBe(2010);
    expect(vehicle?.version).toBe("Attractive 1.8 8V Flex");
    expect(vehicle?.label).toBe("2010 Attractive 1.8 8V Flex");
  });

  it("composes version from SHORT_VERSION + ENGINE when TRIM is absent", () => {
    const vehicle = mapCatalogProductToVehicle(
      buildProduct([
        { id: "BRAND", value_name: "Honda" },
        { id: "MODEL", value_name: "Civic" },
        { id: "VEHICLE_YEAR", value_name: "2018" },
        { id: "SHORT_VERSION", value_name: "EX" },
        { id: "ENGINE", value_name: "2.0 16V Flex" },
      ]),
    );
    expect(vehicle?.version).toBe("EX 2.0 16V Flex");
    expect(vehicle?.label).toBe("2018 EX 2.0 16V Flex");
  });

  it("does not emit an empty artifact when engine info is missing", () => {
    const vehicle = mapCatalogProductToVehicle(
      buildProduct([
        { id: "BRAND", value_name: "Fiat" },
        { id: "MODEL", value_name: "Uno" },
        { id: "VEHICLE_YEAR", value_name: "2015" },
      ]),
    );
    expect(vehicle?.version).toBe("");
    expect(vehicle?.label).toBe("2015");
  });

  it("tolerates year encoded inside value_name", () => {
    const vehicle = mapCatalogProductToVehicle(
      buildProduct([
        { id: "BRAND", value_name: "Fiat" },
        { id: "MODEL", value_name: "Stilo" },
        { id: "VEHICLE_YEAR", value_name: "Ano 2011" },
      ]),
    );
    expect(vehicle?.year).toBe(2011);
  });
});
