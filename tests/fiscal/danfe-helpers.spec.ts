import { describe, it, expect } from "vitest";
import { resolveCstCsosn } from "../../app/fiscal/generators/danfe-helpers";

describe("resolveCstCsosn", () => {
  it("Simples Nacional usa CSOSN com default 102", () => {
    expect(resolveCstCsosn("SIMPLES")).toEqual({
      label: "CSOSN",
      value: "102",
    });
  });

  it("Simples respeita um CSOSN específico", () => {
    expect(resolveCstCsosn("SIMPLES", "500")).toEqual({
      label: "CSOSN",
      value: "500",
    });
  });

  it("regime normal usa CST com default 00", () => {
    expect(resolveCstCsosn("LUCRO_PRESUMIDO")).toEqual({
      label: "CST",
      value: "00",
    });
    expect(resolveCstCsosn("LUCRO_REAL")).toEqual({
      label: "CST",
      value: "00",
    });
  });

  it("regime normal respeita um CST específico", () => {
    expect(resolveCstCsosn("LUCRO_REAL", "20")).toEqual({
      label: "CST",
      value: "20",
    });
  });

  it("cstIcms vazio/branco cai no default do regime", () => {
    expect(resolveCstCsosn("SIMPLES", "").value).toBe("102");
    expect(resolveCstCsosn("SIMPLES", "   ").value).toBe("102");
    expect(resolveCstCsosn("LUCRO_PRESUMIDO", null).value).toBe("00");
  });

  it("regime nulo/desconhecido é tratado como normal (CST)", () => {
    expect(resolveCstCsosn(null)).toEqual({ label: "CST", value: "00" });
    expect(resolveCstCsosn(undefined)).toEqual({ label: "CST", value: "00" });
  });
});
