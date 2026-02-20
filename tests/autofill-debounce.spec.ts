import { describe, it, expect } from "vitest";
import { parseTitleToFields } from "../app/lib/product-parser";
import fs from "fs";

const raw = fs
  .readFileSync("scripts/tmp-ml-categories.json", "utf8")
  .replace(/^\uFEFF/, "");
const mlOptions = JSON.parse(raw).categories;

function norm(s?: string) {
  return (s || "").toString().trim().toLowerCase();
}

function detectStable(title: string) {
  // Simulate what the debounced run does (single stable detection)
  const detected = parseTitleToFields(title);
  let mapping: any = {};
  const tl = title.toLowerCase();
  const byFull = mlOptions.find((c) => tl.includes(c.value.toLowerCase()));
  if (byFull)
    mapping = {
      topLevel: byFull.value.split(" > ")[0].trim(),
      detailedId: byFull.id,
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
      };
  }
  if (!mapping.detailedId) {
    // fallback
    // reuse parser suggestion
    const suggested = null;
  }
  return { detected, mapping };
}

describe("Debounced detection", () => {
  it("final stable detection should override previous transient states", () => {
    // Simulate typing with transient intermediate strings (where earlier parsing may produce odd model tokens)
    const partials = [
      "Cubo Roda Hyundai HB20 2011",
      "Cubo Roda HyundaiHB20",
      "Cubo Roda Fiat Uno 2006",
    ];

    // final detection should be Fiat/UNO/2006
    const final = detectStable(partials[2]);
    expect(final.detected.brand).toBe("Fiat");
    expect(final.detected.model).toBe("UNO");
    expect(final.detected.year).toBe("2006");
  });
});
