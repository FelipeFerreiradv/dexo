import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../app/marketplaces/repositories/category.repository", () => ({
  __esModule: true,
  default: {
    listWithParents: vi.fn(),
    findByExternalId: vi.fn(),
    findById: vi.fn(),
  },
  CategoryRepository: {
    listWithParents: vi.fn(),
    findByExternalId: vi.fn(),
    findById: vi.fn(),
  },
}));

vi.mock("../app/marketplaces/services/ml-api.service", () => ({
  MLApiService: {
    getCategory: vi.fn(),
  },
}));

import {
  CategoryResolutionService,
  __resetCategoryGuardCacheForTests,
} from "../app/marketplaces/services/category-resolution.service";
import CategoryRepository from "../app/marketplaces/repositories/category.repository";
import { MLApiService } from "../app/marketplaces/services/ml-api.service";

const VEHICLE_TREE = [
  { externalId: "MLB5672", fullPath: "Acessórios para Veículos", parentExternalId: null },
  { externalId: "MLB22648", fullPath: "Acessórios para Veículos > Peças de Carros > Suspensão", parentExternalId: "MLB5672" },
  { externalId: "MLB6789", fullPath: "Acessórios para Veículos > Peças de Carros > Freios", parentExternalId: "MLB5672" },
  { externalId: "MLB191703", fullPath: "Acessórios para Veículos > Peças de Carros > Mangueiras", parentExternalId: "MLB5672" },
  { externalId: "MLB1403", fullPath: "Alimentos e Bebidas", parentExternalId: null },
  { externalId: "MLB269510", fullPath: "Alimentos e Bebidas > Bebidas > Gin", parentExternalId: "MLB1403" },
];

describe("assertWithinVehicleRoot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetCategoryGuardCacheForTests();
    (CategoryRepository.listWithParents as any).mockResolvedValue(VEHICLE_TREE);
  });

  it("returns ok=true for a category under MLB1747", async () => {
    const r = await CategoryResolutionService.assertWithinVehicleRoot("MLB22648");
    expect(r.ok).toBe(true);
    expect(r.rootExternalId).toBe("MLB5672");
  });

  it("returns ok=false with reason=outside_root for Gin", async () => {
    const r = await CategoryResolutionService.assertWithinVehicleRoot("MLB269510");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("outside_root");
    expect(r.fullPath).toMatch(/Gin/);
  });

  it("returns ok=true for MLB191703 (mangueiras under vehicle root)", async () => {
    const r = await CategoryResolutionService.assertWithinVehicleRoot("MLB191703");
    expect(r.ok).toBe(true);
  });

  it("returns ok=true with reason=not_in_tree when category missing (fail-open)", async () => {
    const r = await CategoryResolutionService.assertWithinVehicleRoot("MLB999999");
    expect(r.ok).toBe(true);
    expect(r.reason).toBe("not_in_tree");
  });

  it("returns ok=false on empty/invalid id", async () => {
    const r = await CategoryResolutionService.assertWithinVehicleRoot("");
    expect(r.ok).toBe(false);
  });
});

describe("assertConditionCoherent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetCategoryGuardCacheForTests();
  });

  it("returns ok=false when category only accepts [new] and condition=used", async () => {
    (MLApiService.getCategory as any).mockResolvedValue({
      id: "MLB191703",
      settings: { item_conditions: ["new"] },
    });
    const r = await CategoryResolutionService.assertConditionCoherent(
      "MLB191703",
      "used",
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("incompatible");
    expect(r.allowedConditions).toEqual(["new"]);
  });

  it("returns ok=true when condition matches allowed list", async () => {
    (MLApiService.getCategory as any).mockResolvedValue({
      settings: { item_conditions: ["new", "used"] },
    });
    const r = await CategoryResolutionService.assertConditionCoherent(
      "MLB22648",
      "used",
    );
    expect(r.ok).toBe(true);
    expect(r.allowedConditions).toContain("used");
  });

  it("returns ok=true with reason=unknown when ML API returns no conditions (fail-open)", async () => {
    (MLApiService.getCategory as any).mockResolvedValue({ settings: {} });
    const r = await CategoryResolutionService.assertConditionCoherent(
      "MLB22648",
      "used",
    );
    expect(r.ok).toBe(true);
    expect(r.reason).toBe("unknown");
  });

  it("caches results by externalId", async () => {
    (MLApiService.getCategory as any).mockResolvedValue({
      settings: { item_conditions: ["new"] },
    });
    await CategoryResolutionService.assertConditionCoherent("MLB22648", "new");
    await CategoryResolutionService.assertConditionCoherent("MLB22648", "new");
    await CategoryResolutionService.assertConditionCoherent("MLB22648", "used");
    expect((MLApiService.getCategory as any).mock.calls.length).toBe(1);
  });

  it("fail-open on ML API error", async () => {
    (MLApiService.getCategory as any).mockRejectedValue(new Error("429"));
    const r = await CategoryResolutionService.assertConditionCoherent(
      "MLB22648",
      "used",
    );
    expect(r.ok).toBe(true);
    expect(r.reason).toBe("unknown");
  });
});
