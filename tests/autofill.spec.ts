import { describe, it, expect } from "vitest";
import {
  parseTitleToFields,
  suggestCategoryFromTitle,
  mapSuggestedCategory,
} from "../app/lib/product-parser";
import { getMeasurementsForCategory } from "../app/lib/ml-measurements";
import fs from "fs";

let mlOptions: Array<{ id: string; value: string }> = [];
const raw = fs
  .readFileSync("scripts/tmp-ml-categories.json", "utf8")
  .replace(/^\uFEFF/, "");
mlOptions = JSON.parse(raw).categories;

function norm(s?: string) {
  return (s || "").toString().trim().toLowerCase();
}

function applyAutoFill(title: string, formState: any, prevAuto: any) {
  const detected = parseTitleToFields(title);

  let mapping: any = {};
  if (mlOptions && mlOptions.length > 0) {
    const tl = title.toLowerCase();
    const byFull = mlOptions.find((c) => tl.includes(c.value.toLowerCase()));
    if (byFull)
      mapping = {
        topLevel: byFull.value.split(" > ")[0].trim(),
        detailedId: byFull.id,
        detailedValue: byFull.value,
      };
    else {
      const byLast = mlOptions.find((c) => {
        const last = c.value.split(" > ").slice(-1)[0].toLowerCase();
        return tl.includes(last);
      });
      if (byLast)
        mapping = {
          topLevel: byLast.value.split(" > ")[0].trim(),
          detailedId: byLast.id,
          detailedValue: byLast.value,
        };
    }
  }
  if (!mapping.detailedId) {
    const suggestedCategory = suggestCategoryFromTitle(title);
    const suggestedForMapping =
      detected.category || suggestedCategory || undefined;
    if (suggestedForMapping)
      mapping = mapSuggestedCategory(suggestedForMapping);
  }

  const prev = prevAuto || {};
  const currentCategory = formState.category;
  const currentMlCategory = formState.mlCategory;
  const shouldUpdateCategory =
    !currentCategory || norm(prev.category) === norm(currentCategory);

  if (shouldUpdateCategory) {
    if (mapping.topLevel) formState.category = mapping.topLevel;
    else if (detected.category) formState.category = detected.category;
  }

  const prevMl = prev.mlCategory;
  const isPrevAutoMl = prevMl && norm(prevMl) === norm(currentMlCategory || "");
  if (mapping.detailedId) {
    const externalMatch = mlOptions.find(
      (c) => c.value === mapping.detailedValue,
    );
    if (!currentMlCategory || isPrevAutoMl)
      formState.mlCategory = externalMatch?.id ?? "";
    if (mapping.topLevel && shouldUpdateCategory)
      formState.category = mapping.topLevel;
  } else {
    if (isPrevAutoMl && currentMlCategory) formState.mlCategory = "";
  }

  // brand
  const currentBrand = formState.brand;
  const shouldUpdateBrand =
    !currentBrand || norm(prev.brand) === norm(currentBrand);
  if (shouldUpdateBrand) {
    if (detected.brand) formState.brand = detected.brand;
    else if (!currentBrand) formState.brand = "";
  }

  // model
  const currentModel = formState.model;
  const shouldUpdateModel =
    !currentModel || norm(prev.model) === norm(currentModel);
  if (shouldUpdateModel) {
    if (detected.model) formState.model = detected.model;
    else if (!currentModel) formState.model = "";
  }

  // year
  const currentYear = formState.year;
  const shouldUpdateYear =
    !currentYear || norm(prev.year) === norm(currentYear);
  if (shouldUpdateYear) {
    if (detected.year) formState.year = detected.year;
    else if (!currentYear) formState.year = "";
  }

  // Merge detected into prev: preserve previously-detected values when parser returns undefined
  const newPrev = {
    brand: detected.brand ?? prev.brand,
    model: detected.model ?? prev.model,
    year: detected.year ?? prev.year,
    category:
      mapping.topLevel || detected.category || prev.category || undefined,
    mlCategory: (mapping.detailedId ?? prev.mlCategory) || undefined,
  };

  // If no explicit category was detected, attempt to auto-apply measurements
  // based on title tokens (mirrors create-product-dialog fallback behavior).
  const measurements = getMeasurementsForCategory(
    mapping.topLevel || detected.category || title,
    mapping.detailedValue,
  );
  if (measurements) {
    formState.heightCm = measurements.heightCm ?? formState.heightCm;
    formState.widthCm = measurements.widthCm ?? formState.widthCm;
    formState.lengthCm = measurements.lengthCm ?? formState.lengthCm;
    formState.weightKg = measurements.weightKg ?? formState.weightKg;
  }

  return { formState, prevAuto: newPrev };
}

describe("Auto-fill behavior", () => {
  it("updates auto-filled fields when title changes", () => {
    let formState: any = {
      brand: "",
      model: "",
      year: "",
      category: "",
      mlCategory: "",
    };
    let prevAuto: any = null;

    ({ formState, prevAuto } = applyAutoFill(
      "Cubo Roda hyundai hb20 2011",
      formState,
      prevAuto,
    ));
    expect(formState.brand).toBe("Hyundai");
    expect(formState.model).toBe("HB20");
    expect(formState.year).toBe("2011");

    ({ formState, prevAuto } = applyAutoFill(
      "Cubo Roda fiat Uno 2006",
      formState,
      prevAuto,
    ));
    expect(formState.brand).toBe("Fiat");
    expect(formState.model).toBe("UNO");
    expect(formState.year).toBe("2006");
  });

  it("preserves manual edits and does not overwrite them", () => {
    let formState: any = {
      brand: "",
      model: "",
      year: "",
      category: "",
      mlCategory: "",
    };
    let prevAuto: any = null;

    ({ formState, prevAuto } = applyAutoFill(
      "Cubo Roda hyundai hb20 2011",
      formState,
      prevAuto,
    ));
    // user manually edits brand
    formState.brand = "CustomBrand";

    ({ formState, prevAuto } = applyAutoFill(
      "Cubo Roda chevrolet celta 2010",
      formState,
      prevAuto,
    ));
    expect(formState.brand).toBe("CustomBrand");
    expect(formState.model).toBe("CELTA");
    expect(formState.year).toBe("2010");
  });

  it("does not lose previous auto-detection when intermediate detection is partial (category-only)", () => {
    let formState: any = {
      brand: "",
      model: "",
      year: "",
      category: "",
      mlCategory: "",
    };
    let prevAuto: any = null;

    // 1) detects Hyundai HB20 2011
    ({ formState, prevAuto } = applyAutoFill(
      "Cubo Roda hyundai hb20 2011",
      formState,
      prevAuto,
    ));
    expect(formState.brand).toBe("Hyundai");

    // 2) detects Fiat UNO 2006 (overwrites because previous auto value matches current)
    ({ formState, prevAuto } = applyAutoFill(
      "Cubo Roda fiat Uno 2006",
      formState,
      prevAuto,
    ));
    expect(formState.brand).toBe("Fiat");

    // 3) intermediate title that only provides category (parser returns no brand/model/year)
    ({ formState, prevAuto } = applyAutoFill("Porta", formState, prevAuto));
    // prevAuto should still remember last auto-detected brand/model/year (Fiat/UNO/2006)
    expect(prevAuto.brand).toBe("Fiat");

    // 4) final title detects Hyundai HB20 2013 — brand should update (since currentBrand equals prevAuto.brand)
    ({ formState, prevAuto } = applyAutoFill(
      "Porta Diantera Hyundai Hb20 2013",
      formState,
      prevAuto,
    ));
    expect(formState.brand).toBe("Hyundai");
    expect(formState.model).toBe("HB20");
    expect(formState.year).toBe("2013");
  });

  it("applies measurement suggestions when category is detected", () => {
    let formState: any = {
      category: "",
      heightCm: undefined,
      widthCm: undefined,
      lengthCm: undefined,
      weightKg: undefined,
    };

    // Simulate detection of a category that exists in the measurements map
    const m = getMeasurementsForCategory("Calotas");
    expect(m).toBeDefined();

    // Simulate the auto-fill applying those measurements
    if (m) {
      formState.heightCm = m.heightCm ?? undefined;
      formState.widthCm = m.widthCm ?? undefined;
      formState.lengthCm = m.lengthCm ?? undefined;
      formState.weightKg = m.weightKg ?? undefined;
    }

    expect(formState.heightCm).toBe(35);
    expect(formState.widthCm).toBe(35);
    expect(formState.lengthCm).toBe(35);
    expect(formState.weightKg).toBe(2);
  });

  it("applies measurement suggestions when title contains a measurement keyword (singular/plural tolerant)", () => {
    let formState: any = {
      category: "",
      heightCm: undefined,
      widthCm: undefined,
      lengthCm: undefined,
      weightKg: undefined,
    };
    let prevAuto: any = null;

    ({ formState, prevAuto } = applyAutoFill(
      "Roda Fiat Uno 2017",
      formState,
      prevAuto,
    ));

    // 'roda' should match the 'rodas' entry in the measurements map
    expect(formState.heightCm).toBe(25);
    expect(formState.widthCm).toBe(25);
    expect(formState.lengthCm).toBe(45);
    expect(formState.weightKg).toBe(10);
  });
});
