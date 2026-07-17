import { describe, it, expect, beforeEach, vi } from "vitest";

// NFC-e (Fase 2) — campos novos da config fiscal: validação no usecase,
// saneamento/preserve-when-blank no repository e sanitize na rota.

const h = vi.hoisted(() => {
  const upsert = vi.fn(async (args: any) => ({
    id: "cfg-1",
    userId: args.where.userId,
    ...args.create,
  }));
  const prisma = {
    companyFiscalConfig: { upsert, findUnique: vi.fn() },
  };
  return { prisma, upsert };
});

vi.mock("../../app/lib/prisma", () => ({ default: h.prisma }));
vi.mock("@/app/lib/prisma", () => ({ default: h.prisma }));

import { CompanyFiscalRepository } from "../../app/repositories/company-fiscal.repository";
import { CompanyFiscalUseCase } from "../../app/usecases/company-fiscal.usecase";
import { sanitizeFiscalConfig } from "../../app/routes/fiscal.routes";

const BASE = {
  cnpj: "11.222.333/0001-81",
  razaoSocial: "EMPRESA TESTE LTDA",
  inscricaoEstadual: "123456789",
  regimeTributario: "SIMPLES" as const,
};

beforeEach(() => {
  h.upsert.mockClear();
});

describe("CompanyFiscalUseCase — validações NFC-e", () => {
  it("serieNfce fora de 1..999 → erro; ncmPadrao != 8 dígitos → erro", async () => {
    const uc = new CompanyFiscalUseCase();
    await expect(
      uc.upsert("u1", { ...BASE, serieNfce: 0 }),
    ).rejects.toThrow(/Série da NFC-e/);
    await expect(
      uc.upsert("u1", { ...BASE, serieNfce: 1000 }),
    ).rejects.toThrow(/Série da NFC-e/);
    await expect(
      uc.upsert("u1", { ...BASE, ncmPadrao: "1234" }),
    ).rejects.toThrow(/NCM padrão/);
  });

  it("valores válidos passam (serieNfce 1..999; ncmPadrao vazio ou 8 dígitos)", async () => {
    const uc = new CompanyFiscalUseCase();
    await expect(
      uc.upsert("u1", { ...BASE, serieNfce: 2, ncmPadrao: "8708.99.90" }),
    ).resolves.toBeTruthy();
    await expect(
      uc.upsert("u1", { ...BASE, ncmPadrao: "" }),
    ).resolves.toBeTruthy();
  });
});

describe("CompanyFiscalRepository — saneamento + preserve-when-blank do CSC", () => {
  it("cscToken vazio NÃO entra no update (preserva o salvo); cscId/ncmPadrao saneados", async () => {
    const repo = new CompanyFiscalRepository();
    await repo.upsert("u1", {
      ...BASE,
      cscId: "  000001  ",
      cscToken: "",
      ncmPadrao: "8708.99.90",
      serieNfce: 3,
    });

    const args = h.upsert.mock.calls[0][0];
    expect(args.update).not.toHaveProperty("cscToken");
    expect(args.update.cscId).toBe("000001");
    expect(args.update.ncmPadrao).toBe("87089990");
    expect(args.update.serieNfce).toBe(3);
    // create de primeira configuração: segredo nulo quando não informado.
    expect(args.create.cscToken).toBeNull();
  });

  it("cscToken informado ENTRA no update (substitui o salvo)", async () => {
    const repo = new CompanyFiscalRepository();
    await repo.upsert("u1", { ...BASE, cscToken: "  NOVO-CSC  " });
    const args = h.upsert.mock.calls[0][0];
    expect(args.update.cscToken).toBe("NOVO-CSC");
    expect(args.create.cscToken).toBe("NOVO-CSC");
  });

  it("REGRESSAO: providerToken mantém o preserve-when-blank original", async () => {
    const repo = new CompanyFiscalRepository();
    await repo.upsert("u1", { ...BASE, providerToken: "" });
    let args = h.upsert.mock.calls[0][0];
    expect(args.update).not.toHaveProperty("providerToken");

    h.upsert.mockClear();
    await repo.upsert("u1", { ...BASE, providerToken: "tok" });
    args = h.upsert.mock.calls[0][0];
    expect(args.update.providerToken).toBe("tok");
  });
});

describe("sanitizeFiscalConfig — segredos NFC-e", () => {
  it("remove cscToken e expõe só cscConfigurado (padrão providerToken)", () => {
    const safe = sanitizeFiscalConfig({
      id: "cfg-1",
      userId: "u1",
      cnpj: "11222333000181",
      razaoSocial: "X",
      inscricaoEstadual: "1",
      regimeTributario: "SIMPLES",
      ambiente: "HOMOLOGACAO",
      certificadoPath: null,
      certificadoSenhaEnc: null,
      certificadoSubjectCN: null,
      providerName: "SEFAZ_DIRECT",
      providerToken: null,
      serieNfe: 1,
      serieNfce: 1,
      cscId: "000001",
      cscToken: "SEGREDO",
      ncmPadrao: "87089990",
    } as any)!;

    expect(safe.cscToken).toBeUndefined();
    expect(safe.cscConfigurado).toBe(true);
    expect(safe.cscId).toBe("000001");
    expect(safe.ncmPadrao).toBe("87089990");
    expect(safe.providerToken).toBeUndefined();
  });

  it("sem CSC salvo → cscConfigurado=false; null config → null", () => {
    const safe = sanitizeFiscalConfig({
      id: "cfg-1",
      userId: "u1",
      cnpj: "1",
      razaoSocial: "X",
      inscricaoEstadual: "1",
      regimeTributario: "SIMPLES",
      ambiente: "HOMOLOGACAO",
      certificadoPath: null,
      certificadoSenhaEnc: null,
      certificadoSubjectCN: null,
      providerName: null,
      providerToken: null,
      serieNfe: 1,
      cscToken: null,
    } as any)!;
    expect(safe.cscConfigurado).toBe(false);
    expect(sanitizeFiscalConfig(null)).toBeNull();
  });
});
