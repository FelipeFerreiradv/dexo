import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Multi-CNPJ — CompanyFiscalConfig 1:N por tenant.
// Invariantes centrais:
//  1. findByUserId continua sendo "a config do tenant" = a PADRÃO (default
//     primeiro, mais antiga como desempate) — 1 config ⇒ idêntico ao legado.
//  2. upsert legado (PUT /fiscal/config) NUNCA cria 2ª linha quando já existe
//     config: atualiza a padrão por id.
//  3. createSecondary é gated por FISCAL_MULTI_CNPJ_ENABLED e nasce
//     isDefault=false; CNPJ duplicado no tenant → erro amigável.
//  4. setDefault é transacional (zera o padrão atual, seta o novo).
//  5. deleteById recusa padrão e config em uso (notas/sequência/contas).

const h = vi.hoisted(() => {
  const findFirst = vi.fn();
  const findMany = vi.fn();
  const create = vi.fn();
  const update = vi.fn();
  const updateMany = vi.fn();
  const deleteMany = vi.fn();
  const nfeCount = vi.fn();
  const seqCount = vi.fn();
  const accCount = vi.fn();
  const inutCount = vi.fn();
  const txConfig = { findFirst, update, updateMany };
  const prisma = {
    $transaction: vi.fn(async (fn: any) =>
      fn({ companyFiscalConfig: txConfig }),
    ),
    companyFiscalConfig: {
      findFirst,
      findMany,
      create,
      update,
      updateMany,
      deleteMany,
    },
    nfeEmitida: { count: nfeCount },
    nfeSequence: { count: seqCount },
    marketplaceAccount: { count: accCount },
    nfeInutilizacao: { count: inutCount },
  };
  return {
    prisma,
    findFirst,
    findMany,
    create,
    update,
    updateMany,
    deleteMany,
    nfeCount,
    seqCount,
    accCount,
    inutCount,
  };
});

vi.mock("../../app/lib/prisma", () => ({ default: h.prisma }));
vi.mock("@/app/lib/prisma", () => ({ default: h.prisma }));

import { CompanyFiscalRepository } from "../../app/repositories/company-fiscal.repository";
import { CompanyFiscalUseCase } from "../../app/usecases/company-fiscal.usecase";

const BASE = {
  cnpj: "11.222.333/0001-81",
  razaoSocial: "EMPRESA TESTE LTDA",
  inscricaoEstadual: "123456789",
  regimeTributario: "SIMPLES" as const,
};

const ROW_DEFAULT = {
  id: "cfg-A",
  userId: "u1",
  isDefault: true,
  cnpj: "11222333000181",
  ambiente: "HOMOLOGACAO",
  regimeTributario: "SIMPLES",
};

beforeEach(() => {
  vi.clearAllMocks();
  h.nfeCount.mockResolvedValue(0);
  h.seqCount.mockResolvedValue(0);
  h.accCount.mockResolvedValue(0);
  h.inutCount.mockResolvedValue(0);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("CompanyFiscalRepository — multi-CNPJ", () => {
  it("findByUserId busca a config PADRÃO (default primeiro, mais antiga como desempate)", async () => {
    h.findFirst.mockResolvedValue(ROW_DEFAULT);
    const repo = new CompanyFiscalRepository();
    const cfg = await repo.findByUserId("u1");
    expect(cfg?.id).toBe("cfg-A");
    expect(h.findFirst).toHaveBeenCalledWith({
      where: { userId: "u1" },
      orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    });
  });

  it("upsert legado com config existente ATUALIZA por id — nunca cria 2ª linha", async () => {
    h.findFirst.mockResolvedValue(ROW_DEFAULT);
    h.update.mockResolvedValue({ ...ROW_DEFAULT, razaoSocial: "NOVA" });
    const repo = new CompanyFiscalRepository();
    await repo.upsert("u1", BASE);

    expect(h.create).not.toHaveBeenCalled();
    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.update.mock.calls[0][0].where).toEqual({ id: "cfg-A" });
  });

  it("upsert legado sem config cria a PRIMEIRA como padrão (isDefault=true)", async () => {
    h.findFirst.mockResolvedValue(null);
    h.create.mockResolvedValue({ ...ROW_DEFAULT });
    const repo = new CompanyFiscalRepository();
    await repo.upsert("u1", BASE);

    const data = h.create.mock.calls[0][0].data;
    expect(data.isDefault).toBe(true);
    expect(data.userId).toBe("u1");
  });

  it("createSecondary nasce isDefault=false; P2002 (userId+cnpj) → erro amigável", async () => {
    h.create.mockResolvedValue({ ...ROW_DEFAULT, id: "cfg-B", isDefault: false });
    const repo = new CompanyFiscalRepository();
    await repo.createSecondary("u1", BASE);
    expect(h.create.mock.calls[0][0].data.isDefault).toBe(false);

    h.create.mockRejectedValue(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
    );
    await expect(repo.createSecondary("u1", BASE)).rejects.toThrow(
      /Já existe uma empresa com este CNPJ/,
    );
  });

  it("setDefault é transacional: zera o padrão atual e seta o novo", async () => {
    h.findFirst.mockResolvedValue({ id: "cfg-B" });
    h.updateMany.mockResolvedValue({ count: 1 });
    h.update.mockResolvedValue({});
    const repo = new CompanyFiscalRepository();
    await repo.setDefault("cfg-B", "u1");

    expect(h.updateMany).toHaveBeenCalledWith({
      where: { userId: "u1", isDefault: true },
      data: { isDefault: false },
    });
    expect(h.update).toHaveBeenCalledWith({
      where: { id: "cfg-B" },
      data: { isDefault: true },
    });
  });

  it("deleteById recusa a config padrão", async () => {
    h.findFirst.mockResolvedValue(ROW_DEFAULT);
    const repo = new CompanyFiscalRepository();
    await expect(repo.deleteById("cfg-A", "u1")).rejects.toThrow(
      /padrão não pode ser removida/,
    );
    expect(h.deleteMany).not.toHaveBeenCalled();
  });

  it("deleteById recusa config EM USO (notas emitidas referenciando)", async () => {
    h.findFirst.mockResolvedValue({ ...ROW_DEFAULT, id: "cfg-B", isDefault: false });
    h.nfeCount.mockResolvedValue(2);
    const repo = new CompanyFiscalRepository();
    await expect(repo.deleteById("cfg-B", "u1")).rejects.toThrow(/em uso/);
    expect(h.deleteMany).not.toHaveBeenCalled();
  });

  it("deleteById remove config secundária livre (guardada por isDefault=false)", async () => {
    h.findFirst.mockResolvedValue({ ...ROW_DEFAULT, id: "cfg-B", isDefault: false });
    h.deleteMany.mockResolvedValue({ count: 1 });
    const repo = new CompanyFiscalRepository();
    await repo.deleteById("cfg-B", "u1");
    expect(h.deleteMany).toHaveBeenCalledWith({
      where: { id: "cfg-B", userId: "u1", isDefault: false },
    });
  });

  it("updateCertificate legado resolve a padrão e atualiza a MESMA linha", async () => {
    h.findFirst.mockResolvedValue(ROW_DEFAULT);
    h.updateMany.mockResolvedValue({ count: 1 });
    const repo = new CompanyFiscalRepository();
    await repo.updateCertificate("u1", {
      certificadoPath: "/certs/u1.pfx",
      certificadoSenhaEnc: "iv:tag:cipher",
      certificadoValidoAte: new Date("2027-01-01"),
      certificadoSubjectCN: "EMPRESA:11222333000181",
    });
    expect(h.updateMany.mock.calls[0][0].where).toEqual({
      id: "cfg-A",
      userId: "u1",
    });
  });
});

describe("CompanyFiscalUseCase — gate e guards do multi-CNPJ", () => {
  function makeUseCase(repo: Record<string, any>) {
    return new CompanyFiscalUseCase(repo as any);
  }

  it("createSecondary BLOQUEADO sem FISCAL_MULTI_CNPJ_ENABLED", async () => {
    vi.stubEnv("FISCAL_MULTI_CNPJ_ENABLED", "");
    const repo = { findDefaultByUserId: vi.fn(), createSecondary: vi.fn() };
    const uc = makeUseCase(repo);
    await expect(uc.createSecondary("u1", BASE)).rejects.toThrow(
      /não está habilitado/,
    );
    expect(repo.createSecondary).not.toHaveBeenCalled();
  });

  it("createSecondary exige a empresa principal já configurada", async () => {
    vi.stubEnv("FISCAL_MULTI_CNPJ_ENABLED", "true");
    const repo = {
      findDefaultByUserId: vi.fn(async () => null),
      createSecondary: vi.fn(),
    };
    const uc = makeUseCase(repo);
    await expect(uc.createSecondary("u1", BASE)).rejects.toThrow(
      /empresa principal/,
    );
    expect(repo.createSecondary).not.toHaveBeenCalled();
  });

  it("createSecondary com flag + principal existente valida e delega ao repo", async () => {
    vi.stubEnv("FISCAL_MULTI_CNPJ_ENABLED", "true");
    const repo = {
      findDefaultByUserId: vi.fn(async () => ({ id: "cfg-A" })),
      createSecondary: vi.fn(async () => ({ id: "cfg-B" })),
    };
    const uc = makeUseCase(repo);
    await expect(uc.createSecondary("u1", BASE)).resolves.toMatchObject({
      id: "cfg-B",
    });
    expect(repo.createSecondary).toHaveBeenCalledWith("u1", BASE);

    // Validações compartilhadas continuam valendo (CNPJ inválido barra).
    await expect(
      uc.createSecondary("u1", { ...BASE, cnpj: "123" }),
    ).rejects.toThrow(/CNPJ inválido/);
  });

  it("REGRESSAO: upsert legado continua validando e delegando ao repo.upsert", async () => {
    const repo = { upsert: vi.fn(async () => ({ id: "cfg-A" })) };
    const uc = makeUseCase(repo);
    await expect(uc.upsert("u1", BASE)).resolves.toMatchObject({ id: "cfg-A" });
    expect(repo.upsert).toHaveBeenCalledWith("u1", BASE);
    await expect(uc.upsert("u1", { ...BASE, cnpj: "123" })).rejects.toThrow(
      /CNPJ inválido/,
    );
  });
});
