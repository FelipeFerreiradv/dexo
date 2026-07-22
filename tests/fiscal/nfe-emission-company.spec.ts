import { describe, it, expect, beforeEach, vi } from "vitest";

// Multi-CNPJ — emissão e eventos usam o config do EMITENTE da nota.
// Invariantes centrais:
//  1. Draft com companyFiscalConfigId → emit resolve via findByIdForUser
//     (nunca o findByUserId do tenant) — snapshot/certificado/CSC do CNPJ certo.
//  2. Config do draft apagada → erro claro ANTES do claim (nenhum número
//     queimado), sem fallback silencioso para outro CNPJ.
//  3. Draft legado sem configId → findByUserId (padrão) — regressão zero.
//  4. A reserva de número recebe o emitente (opts) — contador POR CNPJ.
//  5. Cancelamento resolve o config da NOTA (certificado do CNPJ emissor).

const h = vi.hoisted(() => {
  const draftRef: { value: any } = { value: null };
  const findDraftById = vi.fn(async () => draftRef.value);
  const persistCalculo = vi.fn(async (): Promise<any> => {
    throw new Error("PARADA-CONTROLADA");
  });
  const addAuditLog = vi.fn(async () => undefined);
  const forceStatus = vi.fn(async () => undefined);
  const findByUserId = vi.fn();
  const findByIdForUser = vi.fn();
  const reservarProximoNumero = vi.fn(async () => 101);
  const nfeUpdate = vi.fn(async (..._args: any[]): Promise<any> => ({}));
  const nfeUpdateMany = vi.fn(async () => ({ count: 1 }));
  const nfeFindUnique = vi.fn();
  const nfeFindFirst = vi.fn();
  const prisma = {
    nfeEmitida: {
      updateMany: nfeUpdateMany,
      update: nfeUpdate,
      findUnique: nfeFindUnique,
      findFirst: nfeFindFirst,
    },
  };
  return {
    draftRef,
    findDraftById,
    persistCalculo,
    addAuditLog,
    forceStatus,
    findByUserId,
    findByIdForUser,
    reservarProximoNumero,
    nfeUpdate,
    nfeUpdateMany,
    nfeFindUnique,
    nfeFindFirst,
    prisma,
  };
});

vi.mock("../../app/lib/prisma", () => ({ default: h.prisma }));
vi.mock("@/app/lib/prisma", () => ({ default: h.prisma }));
vi.mock("../../app/repositories/nfe.repository", () => ({
  NfeRepository: class {
    findDraftById = h.findDraftById;
    persistCalculo = h.persistCalculo;
    addAuditLog = h.addAuditLog;
    forceStatus = h.forceStatus;
  },
}));
vi.mock("../../app/repositories/company-fiscal.repository", () => ({
  CompanyFiscalRepository: class {
    findByUserId = h.findByUserId;
    findDefaultByUserId = h.findByUserId;
    findByIdForUser = h.findByIdForUser;
  },
}));
vi.mock("../../app/fiscal/sequence/nfe-sequence.service", () => ({
  NfeSequenceService: class {
    reservarProximoNumero = h.reservarProximoNumero;
  },
}));

import { NfeEmissionUseCase } from "../../app/usecases/nfe-emission.usecase";
import { NfeCancelamentoUseCase } from "../../app/usecases/nfe-cancelamento.usecase";
import { makeConfig, makeDraft } from "./__helpers__/test-draft";

const CFG_B = makeConfig({ id: "cfg-B", isDefault: false, cnpj: "99888777000166" });

beforeEach(() => {
  vi.clearAllMocks();
  h.persistCalculo.mockRejectedValue(new Error("PARADA-CONTROLADA"));
  h.nfeUpdateMany.mockResolvedValue({ count: 1 });
});

describe("NfeEmissionUseCase.emit — emitente do draft (multi-CNPJ)", () => {
  it("draft com companyFiscalConfigId resolve via findByIdForUser — nunca o findByUserId do tenant", async () => {
    h.draftRef.value = makeDraft({ companyFiscalConfigId: "cfg-B" } as any);
    h.findByIdForUser.mockResolvedValue(CFG_B);

    const uc = new NfeEmissionUseCase();
    await expect(uc.emit("u1", "nfe-1")).rejects.toThrow(/PARADA-CONTROLADA/);

    expect(h.findByIdForUser).toHaveBeenCalledWith("cfg-B", "u1");
    expect(h.findByUserId).not.toHaveBeenCalled();
  });

  it("config do draft apagada → erro claro SEM claim (nenhum número queimado)", async () => {
    h.draftRef.value = makeDraft({ companyFiscalConfigId: "cfg-apagada" } as any);
    h.findByIdForUser.mockResolvedValue(null);

    const uc = new NfeEmissionUseCase();
    await expect(uc.emit("u1", "nfe-1")).rejects.toThrow(
      /Configuracao fiscal do emitente nao encontrada/,
    );
    expect(h.nfeUpdateMany).not.toHaveBeenCalled();
    expect(h.reservarProximoNumero).not.toHaveBeenCalled();
  });

  it("REGRESSAO: draft legado sem configId usa findByUserId (padrão do tenant)", async () => {
    h.draftRef.value = makeDraft();
    h.findByUserId.mockResolvedValue(makeConfig({ id: "cfg-A" }));

    const uc = new NfeEmissionUseCase();
    await expect(uc.emit("u1", "nfe-1")).rejects.toThrow(/PARADA-CONTROLADA/);

    expect(h.findByUserId).toHaveBeenCalledWith("u1");
    expect(h.findByIdForUser).not.toHaveBeenCalled();
  });

  it("reserva de número recebe o EMITENTE (opts) e a numeração grava o configId", async () => {
    const draft = makeDraft({ companyFiscalConfigId: "cfg-B" } as any);
    h.draftRef.value = draft;
    h.findByIdForUser.mockResolvedValue(CFG_B);
    // Deixa o pipeline passar do cálculo e parar no update de numeração.
    h.persistCalculo.mockResolvedValue(undefined as any);
    h.nfeFindUnique.mockResolvedValue({ ...draft, itens: [] });
    h.nfeUpdate.mockRejectedValue(new Error("PARADA-NUMERACAO"));

    const uc = new NfeEmissionUseCase();
    await expect(uc.emit("u1", "nfe-1")).rejects.toThrow();

    expect(h.reservarProximoNumero).toHaveBeenCalledWith(
      "u1",
      "HOMOLOGACAO",
      1,
      "55",
      { companyFiscalConfigId: "cfg-B", isDefaultConfig: false },
    );
    // O update de numeração grava o emitente na linha emitida.
    const updateArgs = h.nfeUpdate.mock.calls[0]?.[0] as any;
    expect(updateArgs.data.companyFiscalConfigId).toBe("cfg-B");
  });
});

describe("NfeCancelamentoUseCase — config do CNPJ emissor da nota", () => {
  function notaAutorizada(companyFiscalConfigId: string | null) {
    return {
      id: "nfe-1",
      userId: "u1",
      status: "AUTHORIZED",
      modelo: "55",
      chaveAcesso: "3".repeat(44),
      protocoloAutorizacao: "135250000000001",
      dataAutorizacao: new Date(),
      createdAt: new Date(),
      companyFiscalConfigId,
    };
  }

  it("nota com configId → cancelamento resolve o config DELA (certificado certo)", async () => {
    h.nfeFindFirst.mockResolvedValue(notaAutorizada("cfg-B"));
    h.findByIdForUser.mockResolvedValue(null); // corta o fluxo após a resolução

    const uc = new NfeCancelamentoUseCase();
    await expect(
      uc.cancel("u1", "nfe-1", "cancelamento de teste com justificativa"),
    ).rejects.toThrow(/Configuracao fiscal do emitente nao encontrada/);

    expect(h.findByIdForUser).toHaveBeenCalledWith("cfg-B", "u1");
    expect(h.findByUserId).not.toHaveBeenCalled();
  });

  it("REGRESSAO: nota legada sem configId → config padrão do tenant", async () => {
    h.nfeFindFirst.mockResolvedValue(notaAutorizada(null));
    h.findByUserId.mockResolvedValue(null); // corta o fluxo após a resolução

    const uc = new NfeCancelamentoUseCase();
    await expect(
      uc.cancel("u1", "nfe-1", "cancelamento de teste com justificativa"),
    ).rejects.toThrow(/Configuracao fiscal do emitente nao encontrada/);

    expect(h.findByUserId).toHaveBeenCalledWith("u1");
    expect(h.findByIdForUser).not.toHaveBeenCalled();
  });
});
