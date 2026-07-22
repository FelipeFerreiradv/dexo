import { describe, it, expect, beforeEach, vi } from "vitest";

// NFC-e (Fase 2) — campos novos da config fiscal: validação no usecase,
// saneamento/preserve-when-blank no repository e sanitize na rota.

const h = vi.hoisted(() => {
  // Multi-CNPJ: o @unique(userId) saiu do schema; o repo.upsert legado passou
  // de prisma.upsert para findFirst (config padrão) + update/create. Mesmas
  // semânticas de preserve-when-blank — o mock acompanha a forma da chamada.
  const findFirst = vi.fn(async (): Promise<any> => null);
  const create = vi.fn(async (args: any) => ({
    id: "cfg-1",
    ...args.data,
  }));
  const update = vi.fn(async (args: any) => ({
    id: args.where.id,
    userId: "u1",
    ...args.data,
  }));
  const prisma = {
    companyFiscalConfig: { findFirst, create, update },
  };
  return { prisma, findFirst, create, update };
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
  h.findFirst.mockReset();
  h.findFirst.mockResolvedValue(null);
  h.create.mockClear();
  h.update.mockClear();
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
  const EXISTING = { id: "cfg-1", userId: "u1", isDefault: true };

  it("cscToken vazio NÃO entra no update (preserva o salvo); cscId/ncmPadrao saneados", async () => {
    // Config existente → ramo de UPDATE (era o `update` do prisma.upsert).
    h.findFirst.mockResolvedValue(EXISTING);
    const repo = new CompanyFiscalRepository();
    await repo.upsert("u1", {
      ...BASE,
      cscId: "  000001  ",
      cscToken: "",
      ncmPadrao: "8708.99.90",
      serieNfce: 3,
    });

    const data = h.update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("cscToken");
    expect(data.cscId).toBe("000001");
    expect(data.ncmPadrao).toBe("87089990");
    expect(data.serieNfce).toBe(3);

    // Primeira configuração (sem linha) → ramo de CREATE: segredo nulo
    // quando não informado (era o `create` do prisma.upsert).
    h.findFirst.mockResolvedValue(null);
    h.create.mockClear();
    await repo.upsert("u1", { ...BASE, cscToken: "" });
    expect(h.create.mock.calls[0][0].data.cscToken).toBeNull();
  });

  it("cscToken informado ENTRA no update (substitui o salvo)", async () => {
    h.findFirst.mockResolvedValue(EXISTING);
    const repo = new CompanyFiscalRepository();
    await repo.upsert("u1", { ...BASE, cscToken: "  NOVO-CSC  " });
    expect(h.update.mock.calls[0][0].data.cscToken).toBe("NOVO-CSC");

    h.findFirst.mockResolvedValue(null);
    await repo.upsert("u1", { ...BASE, cscToken: "  NOVO-CSC  " });
    expect(h.create.mock.calls[0][0].data.cscToken).toBe("NOVO-CSC");
  });

  it("REGRESSAO: providerToken mantém o preserve-when-blank original", async () => {
    h.findFirst.mockResolvedValue(EXISTING);
    const repo = new CompanyFiscalRepository();
    await repo.upsert("u1", { ...BASE, providerToken: "" });
    expect(h.update.mock.calls[0][0].data).not.toHaveProperty("providerToken");

    h.update.mockClear();
    await repo.upsert("u1", { ...BASE, providerToken: "tok" });
    expect(h.update.mock.calls[0][0].data.providerToken).toBe("tok");
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
