import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Reprodução do crash de produção (16/09/2026, Kiko 4x4 via Focus):
// o Focus rejeita com status_sefaz "974" (STRING); handleRejected gravava
// REJECTED e depois quebrava ao gravar cStatRejeicao:"974" na coluna Int?,
// perdendo motivo e cStat e devolvendo HTTP 500.
//
// O double do prisma abaixo imita a validação do Prisma: cStatRejeicao que
// não seja inteiro/null LANÇA — exatamente a PrismaClientValidationError.

const h = vi.hoisted(() => {
  const draftRef: { value: any } = { value: null };
  const updates: any[] = [];
  const nfeUpdate = vi.fn(async (args: any) => {
    const c = args?.data?.cStatRejeicao;
    if (c !== undefined && c !== null && !Number.isInteger(c)) {
      throw new Error(
        "Invalid `prisma.nfeEmitida.update()` invocation: Argument `cStatRejeicao`: Invalid value provided. Expected Int, NullableIntFieldUpdateOperationsInput or Null, provided String.",
      );
    }
    updates.push(args);
    return {};
  });
  const prisma = {
    nfeEmitida: {
      updateMany: vi.fn(async () => ({ count: 1 })),
      update: nfeUpdate,
      findUnique: vi.fn(async () => draftRef.value),
      findFirst: vi.fn(),
    },
    user: { findUnique: vi.fn(async () => null) },
  };
  const providerResult: { value: any } = { value: null };
  const provider = {
    name: "FOCUS_NFE",
    emitir: vi.fn(async () => providerResult.value),
    consultar: vi.fn(),
  };
  return {
    draftRef,
    updates,
    nfeUpdate,
    prisma,
    providerResult,
    provider,
    addAuditLog: vi.fn(async () => undefined),
    findByUserId: vi.fn(),
    reservarProximoNumero: vi.fn(async () => 101),
  };
});

vi.mock("../../app/lib/prisma", () => ({ default: h.prisma }));
vi.mock("@/app/lib/prisma", () => ({ default: h.prisma }));
vi.mock("../../app/repositories/nfe.repository", () => ({
  NfeRepository: class {
    findDraftById = vi.fn(async () => h.draftRef.value);
    persistCalculo = vi.fn(async () => undefined);
    addAuditLog = h.addAuditLog;
  },
}));
vi.mock("../../app/repositories/company-fiscal.repository", () => ({
  CompanyFiscalRepository: class {
    findByUserId = h.findByUserId;
    findByIdForUser = h.findByUserId;
  },
}));
vi.mock("../../app/fiscal/sequence/nfe-sequence.service", () => ({
  NfeSequenceService: class {
    reservarProximoNumero = h.reservarProximoNumero;
  },
}));
vi.mock("../../app/fiscal/storage/fiscal-storage.service", () => ({
  FiscalStorageService: class {
    saveXmlOriginal = vi.fn(async () => "xml-original/nfe-1.xml");
    saveXmlAutorizado = vi.fn(async () => "xml-autorizado/nfe-1.xml");
    saveDanfePdf = vi.fn(async () => "danfe/nfe-1.pdf");
  },
}));
vi.mock("../../app/fiscal/providers/provider-factory", () => ({
  createNfeProvider: vi.fn(() => h.provider),
  createNfeProviderFromConfig: vi.fn(async () => h.provider),
}));

import { NfeEmissionUseCase } from "../../app/usecases/nfe-emission.usecase";
import { makeConfig, makeDraft } from "./__helpers__/test-draft";

const MOTIVO = "CNPJ do responsavel tecnico diverge do cadastrado";

function focusRejeita(codigoStatus: unknown) {
  h.providerResult.value = {
    success: false,
    chaveAcesso: null,
    protocolo: null,
    dataAutorizacao: null,
    status: "rejeitada",
    codigoStatus,
    mensagem: MOTIVO,
    xmlAutorizado: null,
    providerRef: null,
  };
}

function updateDeRejeicao() {
  return h.updates.find((u) => u?.data?.status === "REJECTED");
}

beforeEach(() => {
  vi.clearAllMocks();
  h.updates.length = 0;
  h.draftRef.value = { ...makeDraft({ status: "DRAFT" } as any), itens: makeDraft().itens };
  h.findByUserId.mockResolvedValue(
    makeConfig({ providerName: "FOCUS_NFE", providerToken: "tok-teste" } as any),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("handleRejected — cStat do Focus como string (flag de reemissão ligada)", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_NFE_REEMISSAO_REJEITADA_ENABLED", "true");
  });

  it.each([
    [974, 974],
    ["974", 974],
    [null, null],
    [undefined, null],
  ])(
    "cStat %j → cStatRejeicao %j, sem PrismaClientValidationError, sem 500",
    async (entrada, esperado) => {
      focusRejeita(entrada);
      const uc = new NfeEmissionUseCase();

      const r = await uc.emit("u1", "nfe-1");

      expect(r.status).toBe("REJECTED");
      expect(r.success).toBe(false);
      expect(r.mensagem).toBe(MOTIVO);
      const up = updateDeRejeicao();
      expect(up).toBeDefined();
      // UMA escrita com status + motivo + cStat (antes eram duas e a 2ª quebrava).
      expect(up.data).toEqual({
        status: "REJECTED",
        motivoRejeicao: MOTIVO,
        cStatRejeicao: esperado,
      });
      expect(h.addAuditLog).toHaveBeenCalledWith("nfe-1", "u1", "REJEITADA", {
        mensagem: MOTIVO,
      });
      // Nenhum ENVIO_INCERTO enganoso.
      const eventos = h.addAuditLog.mock.calls.map((c: any[]) => c[2]);
      expect(eventos).not.toContain("ENVIO_INCERTO");
    },
  );

  it("código textual do 422 (erro_validacao_schema) → cStat null e código preservado na auditoria", async () => {
    focusRejeita("erro_validacao_schema");
    const uc = new NfeEmissionUseCase();

    const r = await uc.emit("u1", "nfe-1");

    expect(r.status).toBe("REJECTED");
    expect(updateDeRejeicao().data.cStatRejeicao).toBeNull();
    expect(h.addAuditLog).toHaveBeenCalledWith("nfe-1", "u1", "REJEITADA", {
      mensagem: MOTIVO,
      codigoProvedor: "erro_validacao_schema",
    });
  });
});

describe("handleRejected — flag de reemissão DESLIGADA (comportamento de antes)", () => {
  it("não grava cStatRejeicao (coluna pode nem existir) e mantém motivo", async () => {
    vi.stubEnv("NEXT_PUBLIC_NFE_REEMISSAO_REJEITADA_ENABLED", "false");
    focusRejeita("974");
    const uc = new NfeEmissionUseCase();

    const r = await uc.emit("u1", "nfe-1");

    expect(r.status).toBe("REJECTED");
    const up = updateDeRejeicao();
    expect(up.data).toEqual({ status: "REJECTED", motivoRejeicao: MOTIVO });
    expect("cStatRejeicao" in up.data).toBe(false);
  });
});
