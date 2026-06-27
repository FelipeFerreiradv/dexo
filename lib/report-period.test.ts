import { describe, it, expect } from "vitest";
import { presetRange, resolveSelectedRange } from "./report-period";

describe("report-period", () => {
  it("custom incompleto ⇒ null; completo ⇒ as datas escolhidas", () => {
    expect(resolveSelectedRange("custom", "", "")).toBeNull();
    expect(resolveSelectedRange("custom", "2026-06-01", "")).toBeNull();
    expect(resolveSelectedRange("custom", "2026-06-01", "2026-06-10")).toEqual({
      start: "2026-06-01",
      end: "2026-06-10",
    });
  });

  it("presetRange(custom) é null; presets retornam start<=end", () => {
    expect(presetRange("custom")).toBeNull();
    for (const id of ["today", "7d", "30d", "month"] as const) {
      const r = presetRange(id)!;
      expect(r.start <= r.end).toBe(true);
    }
    expect(presetRange("today")!.start).toBe(presetRange("today")!.end);
  });
});
