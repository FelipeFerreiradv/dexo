import { describe, expect, it } from "vitest";
import {
  buildPath,
  normalizeCode,
  parseLocationPath,
} from "../scripts/location-sync-helpers";

describe("location sync helpers", () => {
  it("normalizes codes by trimming, collapsing spaces, and uppercasing", () => {
    expect(normalizeCode(" caixa  01 ")).toBe("CAIXA 01");
    expect(normalizeCode("galpão-1")).toBe("GALPÃO-1");
  });

  it("parses hierarchical paths with greater-than separators", () => {
    expect(parseLocationPath("A > B > C")).toEqual(["A", "B", "C"]);
    expect(parseLocationPath("  galpão 1>andar 1> caixa-10 ")).toEqual([
      "GALPÃO 1",
      "ANDAR 1",
      "CAIXA-10",
    ]);
  });

  it("handles empty or null paths gracefully", () => {
    expect(parseLocationPath(undefined)).toEqual([]);
    expect(parseLocationPath("   ")).toEqual([]);
  });

  it("builds display path using standardized separator", () => {
    expect(buildPath(["A", "B", "C"])).toBe("A > B > C");
  });
});
