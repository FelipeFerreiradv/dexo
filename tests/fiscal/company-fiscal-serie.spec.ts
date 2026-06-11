import { describe, it, expect, vi } from "vitest";
import { CompanyFiscalUseCase } from "../../app/usecases/company-fiscal.usecase";

// CNPJ válido clássico de teste (passa no mod-11 do isValidCnpj).
const VALID_CNPJ = "11222333000181";

function baseConfig() {
  return {
    cnpj: VALID_CNPJ,
    razaoSocial: "EMPRESA TESTE LTDA",
    inscricaoEstadual: "ISENTO",
    regimeTributario: "SIMPLES" as const,
  };
}

function makeUseCase() {
  const upsert = vi.fn(async (userId: string, data: any) => ({
    id: "cfg-1",
    userId,
    ...data,
  }));
  const repo = { upsert, findByUserId: vi.fn() };
  const useCase = new CompanyFiscalUseCase(repo as any);
  return { useCase, upsert };
}

describe("CompanyFiscalUseCase.upsert — série da NF-e", () => {
  it("aceita e repassa a série quando válida (1–999)", async () => {
    const { useCase, upsert } = makeUseCase();
    await useCase.upsert("u1", { ...baseConfig(), serieNfe: 4 });
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0][1].serieNfe).toBe(4);
  });

  it("aceita config sem série (mantém comportamento padrão)", async () => {
    const { useCase, upsert } = makeUseCase();
    await useCase.upsert("u1", baseConfig());
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it("rejeita série acima de 999", async () => {
    const { useCase, upsert } = makeUseCase();
    await expect(
      useCase.upsert("u1", { ...baseConfig(), serieNfe: 1000 }),
    ).rejects.toThrow(/[Ss]érie/);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("rejeita série zero/negativa", async () => {
    const { useCase, upsert } = makeUseCase();
    await expect(
      useCase.upsert("u1", { ...baseConfig(), serieNfe: 0 }),
    ).rejects.toThrow(/[Ss]érie/);
    await expect(
      useCase.upsert("u1", { ...baseConfig(), serieNfe: -1 }),
    ).rejects.toThrow(/[Ss]érie/);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("rejeita série não-inteira", async () => {
    const { useCase, upsert } = makeUseCase();
    await expect(
      useCase.upsert("u1", { ...baseConfig(), serieNfe: 2.5 }),
    ).rejects.toThrow(/[Ss]érie/);
    expect(upsert).not.toHaveBeenCalled();
  });
});
