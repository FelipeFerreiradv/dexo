import { describe, it, expect, beforeEach, vi } from "vitest";

// ──────────────────────────────────────────────────────────────────────────
// REGRESSÃO (incidente em PROD, 2026-07-20): o wizard da NF-e 55 reaproveitava
// o rascunho MAIS RECENTE do usuário sem olhar o modelo. Desde a Fase 2 do PDV
// existem rascunhos modelo 65 (NFC-e) no banco — o wizard capturava um deles, o
// usuário preenchia uma NF-e e o motor emitia NFC-e. Sintoma real: nota
// rejeitada com cStat 706 ("NFC-e para operação de entrada"). Risco maior:
// emitir NFC-e autorizada quando o usuário queria NF-e (documento errado).
//
// Contrato pinado aqui: o wizard SEMPRE consulta rascunhos do modelo "55".
// ──────────────────────────────────────────────────────────────────────────

const {
  findByUserIdMock,
  findExistingDraftMock,
  createDraftMock,
  updateDraftMock,
  addAuditLogMock,
} = vi.hoisted(() => ({
  findByUserIdMock: vi.fn(),
  findExistingDraftMock: vi.fn(),
  createDraftMock: vi.fn(),
  updateDraftMock: vi.fn(),
  addAuditLogMock: vi.fn(),
}));

vi.mock("../../app/repositories/company-fiscal.repository", () => ({
  CompanyFiscalRepository: class {
    findByUserId = findByUserIdMock;
  },
}));
vi.mock("@/app/repositories/company-fiscal.repository", () => ({
  CompanyFiscalRepository: class {
    findByUserId = findByUserIdMock;
  },
}));
vi.mock("../../app/repositories/nfe.repository", () => ({
  NfeRepository: class {
    findExistingDraft = findExistingDraftMock;
    createDraft = createDraftMock;
    updateDraft = updateDraftMock;
    addAuditLog = addAuditLogMock;
  },
}));
vi.mock("@/app/repositories/nfe.repository", () => ({
  NfeRepository: class {
    findExistingDraft = findExistingDraftMock;
    createDraft = createDraftMock;
    updateDraft = updateDraftMock;
    addAuditLog = addAuditLogMock;
  },
}));

import { NfeDraftUseCase } from "../../app/usecases/nfe-draft.usecase";

beforeEach(() => {
  vi.clearAllMocks();
  findByUserIdMock.mockResolvedValue({
    ambiente: "PRODUCAO",
    serieNfe: 4,
    serieNfce: 4,
  });
  createDraftMock.mockImplementation(async (_u: string, input: any) => ({
    id: "draft-novo",
    serie: input.serie,
    modelo: input.modelo ?? "55",
    status: "DRAFT",
    itens: [],
  }));
  addAuditLogMock.mockResolvedValue(undefined);
  findExistingDraftMock.mockResolvedValue(null);
});

describe("wizard NF-e 55 × rascunhos NFC-e 65", () => {
  it("consulta rascunho existente SEMPRE com modelo '55'", async () => {
    const uc = new NfeDraftUseCase();
    await uc.create("user-1", {} as any);

    expect(findExistingDraftMock).toHaveBeenCalledWith("user-1", "55");
  });

  it("rascunho 65 no banco NÃO é reaproveitado: cria rascunho 55 novo", async () => {
    // O repo agora filtra por modelo — com só um rascunho 65 existindo, a
    // consulta do wizard não acha nada e um rascunho 55 fresco é criado.
    findExistingDraftMock.mockImplementation(
      async (_userId: string, modelo: "55" | "65") =>
        modelo === "65"
          ? { id: "draft-65-do-pdv", modelo: "65", status: "DRAFT", itens: [] }
          : null,
    );

    const uc = new NfeDraftUseCase();
    const draft = await uc.create("user-1", {} as any);

    expect(draft.id).toBe("draft-novo");
    expect(draft.id).not.toBe("draft-65-do-pdv");
    expect(createDraftMock).toHaveBeenCalledTimes(1);
  });

  it("REGRESSÃO: rascunho 55 existente continua sendo reaproveitado", async () => {
    findExistingDraftMock.mockResolvedValue({
      id: "draft-55-antigo",
      modelo: "55",
      status: "DRAFT",
      itens: [],
    });

    const uc = new NfeDraftUseCase();
    const draft = await uc.create("user-1", {} as any);

    expect(draft.id).toBe("draft-55-antigo");
    expect(createDraftMock).not.toHaveBeenCalled();
  });
});
