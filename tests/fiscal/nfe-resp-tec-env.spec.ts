import { describe, it, expect } from "vitest";
import { resolveRespTecFromEnv } from "../../app/fiscal/sefaz/resp-tec";

// resolveRespTecFromEnv resolve o RT do ambiente (fora do builder puro).
// Kill-switch: sem NFE_RESP_TEC_CNPJ → undefined (grupo omitido). CSRT só quando
// idCSRT E csrt ambos preenchidos.

describe("resolveRespTecFromEnv", () => {
  it("kill-switch: sem NFE_RESP_TEC_CNPJ → undefined", () => {
    expect(resolveRespTecFromEnv({})).toBeUndefined();
    expect(resolveRespTecFromEnv({ NFE_RESP_TEC_CNPJ: "" })).toBeUndefined();
    expect(resolveRespTecFromEnv({ NFE_RESP_TEC_CNPJ: "   " })).toBeUndefined();
  });

  it("com CNPJ + contato/email/fone → objeto (CNPJ so digitos, campos com trim), sem CSRT", () => {
    const rt = resolveRespTecFromEnv({
      NFE_RESP_TEC_CNPJ: "51.195.502/0001-56",
      NFE_RESP_TEC_XCONTATO: "  Suporte Dexo  ",
      NFE_RESP_TEC_EMAIL: "suporte@usedexo.com.br",
      NFE_RESP_TEC_FONE: "11999999999",
    });
    expect(rt).toEqual({
      cnpj: "51195502000156",
      xContato: "Suporte Dexo",
      email: "suporte@usedexo.com.br",
      fone: "11999999999",
    });
    expect(rt).not.toHaveProperty("idCSRT");
    expect(rt).not.toHaveProperty("csrt");
  });

  it("CSRT entra so quando idCSRT E csrt ambos preenchidos", () => {
    const rt = resolveRespTecFromEnv({
      NFE_RESP_TEC_CNPJ: "51195502000156",
      NFE_RESP_TEC_XCONTATO: "X",
      NFE_RESP_TEC_EMAIL: "a@b.c",
      NFE_RESP_TEC_FONE: "1199",
      NFE_RESP_TEC_ID_CSRT: "01",
      NFE_RESP_TEC_CSRT: "SEGREDO",
    });
    expect(rt).toMatchObject({ idCSRT: "01", csrt: "SEGREDO" });
  });

  it("CSRT parcial (so idCSRT, sem csrt) → omite idCSRT/csrt", () => {
    const rt = resolveRespTecFromEnv({
      NFE_RESP_TEC_CNPJ: "51195502000156",
      NFE_RESP_TEC_ID_CSRT: "01",
    });
    expect(rt).not.toHaveProperty("idCSRT");
    expect(rt).not.toHaveProperty("csrt");
  });
});
