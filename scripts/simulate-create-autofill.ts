import {
  parseTitleToFields,
  suggestCategoryFromTitle,
  mapSuggestedCategory,
  ML_CATEGORIES,
  ML_CATEGORY_OPTIONS,
} from "../app/lib/product-parser";
import fs from "fs";

let raw = fs.readFileSync("scripts/tmp-ml-categories.json", "utf8");
// Strip BOM if present
raw = raw.replace(/^\uFEFF/, "");
try {
  // Validate JSON quickly
  JSON.parse(raw);
} catch (e) {
  console.error(
    "Failed to parse scripts/tmp-ml-categories.json, preview:",
    raw.slice(0, 100),
  );
  throw e;
}
const mlOptions = JSON.parse(raw).categories as Array<{
  id: string;
  value: string;
}>;

function norm(s?: string) {
  return (s || "").toString().trim().toLowerCase();
}

async function applyAutoFill(title: string, formState: any, prevAuto: any) {
  const detected = parseTitleToFields(title);

  let mapping: any = {};
  if (mlOptions && mlOptions.length > 0) {
    const tl = title.toLowerCase();
    const byFull = mlOptions.find((c) => tl.includes(c.value.toLowerCase()));
    if (byFull) {
      mapping = {
        topLevel: byFull.value.split(" > ")[0].trim(),
        detailedId: byFull.id,
        detailedValue: byFull.value,
      };
    } else {
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

  const isPrevAutoMl =
    prev.mlCategory && norm(prev.mlCategory) === norm(currentMlCategory || "");
  if (mapping.detailedId) {
    if (!currentMlCategory || isPrevAutoMl)
      formState.mlCategory = mapping.detailedId;
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

  const newPrev = {
    brand: detected.brand,
    model: detected.model,
    year: detected.year,
    category: mapping.topLevel || detected.category || undefined,
    mlCategory: mapping.detailedId || undefined,
  };

  return { formState, prevAuto: newPrev };
}

async function main() {
  let formState: any = {
    brand: "",
    model: "",
    year: "",
    category: "",
    mlCategory: "",
  };
  let prevAuto = null;

  console.log("Initial", JSON.stringify(formState));

  ({ formState, prevAuto } = await applyAutoFill(
    "Cubo Roda hyundai hb20 2011",
    formState,
    prevAuto,
  ));
  console.log("After first title", JSON.stringify(formState));

  // Simulate user editing name only, not touching fields
  ({ formState, prevAuto } = await applyAutoFill(
    "Cubo Roda fiat Uno 2006",
    formState,
    prevAuto,
  ));
  console.log("After second title", JSON.stringify(formState));

  // Now simulate user manually overriding brand, then changing title again
  formState.brand = "CustomBrand";
  console.log("After manual brand edit", JSON.stringify(formState));
  ({ formState, prevAuto } = await applyAutoFill(
    "Cubo Roda chevrolet Celta 2010",
    formState,
    prevAuto,
  ));
  console.log(
    "After third title with manual brand edit (should not overwrite brand)",
    JSON.stringify(formState),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
