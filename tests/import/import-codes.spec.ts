import { describe, it, expect } from "vitest";
import {
  normalizeCodeFlat,
  normPath,
  pathSegments,
  cumulativePaths,
} from "../../app/usecases/import/lib/codes";

// As DUAS variantes são intencionalmente diferentes — cada uma replica o
// script do respectivo sistema para manter a idempotência com tenants já
// migrados via CLI.
describe("import/codes — Vaapt (plana, migracao-vaapt.ts)", () => {
  it("upper + REMOVE todos os espaços", () => {
    expect(normalizeCodeFlat("Local 44 - Caixa 9")).toBe("LOCAL44-CAIXA9");
    expect(normalizeCodeFlat("LOCAL 1")).toBe("LOCAL1");
    expect(normalizeCodeFlat("  ")).toBeNull();
    expect(normalizeCodeFlat(null)).toBeNull();
  });
});

describe("import/codes — WebDesmonte (hierárquica, migracao-webdesmonte.ts)", () => {
  it("split '>', colapsa espaços internos, ' > ' uniforme, upper", () => {
    expect(normPath("GALPÃO > PRATELEIRA 1 >  NIVEL   3 > CAIXA 22")).toBe(
      "GALPÃO > PRATELEIRA 1 > NIVEL 3 > CAIXA 22",
    );
    expect(normPath("caixa 5")).toBe("CAIXA 5");
    expect(normPath(" > > ")).toBeNull();
  });
  it("pathSegments / cumulativePaths (pais antes dos filhos)", () => {
    expect(pathSegments("A > B > C")).toEqual(["A", "B", "C"]);
    expect(cumulativePaths("A > B > C")).toEqual(["A", "A > B", "A > B > C"]);
  });
});
