import { describe, it, expect, beforeEach, vi } from "vitest";

// Multi-CNPJ — seleção do EMITENTE na criação do rascunho.
// Precedência: escolha explícita do caller > vínculo da conta de marketplace
// do pedido > CNPJ padrão. Vínculo órfão (config apagada) NUNCA bloqueia o
// rascunho — loga e cai no padrão. Escolha explícita inválida LANÇA (não
// silencia para o CNPJ errado).

const {
  findByUserIdMock,
  findByIdForUserMock,
  findExistingDraftMock,
  createDraftMock,
  updateDraftMock,
  addAuditLogMock,
  findDraftByIdMock,
  findForFiscalDraftMock,
} = vi.hoisted(() => ({
  findByUserIdMock: vi.fn(),
  findByIdForUserMock: vi.fn(),
  findExistingDraftMock: vi.fn(),
  createDraftMock: vi.fn(),
  updateDraftMock: vi.fn(),
  addAuditLogMock: vi.fn(),
  findDraftByIdMock: vi.fn(),
  findForFiscalDraftMock: vi.fn(),
}));

vi.mock("../../app/repositories/company-fiscal.repository", () => ({
  CompanyFiscalRepository: class {
    findByUserId = findByUserIdMock;
    findDefaultByUserId = findByUserIdMock;
    findByIdForUser = findByIdForUserMock;
  },
}));
vi.mock("@/app/repositories/company-fiscal.repository", () => ({
  CompanyFiscalRepository: class {
    findByUserId = findByUserIdMock;
    findDefaultByUserId = findByUserIdMock;
    findByIdForUser = findByIdForUserMock;
  },
}));
vi.mock("../../app/repositories/nfe.repository", () => ({
  NfeRepository: class {
    findExistingDraft = findExistingDraftMock;
    createDraft = createDraftMock;
    updateDraft = updateDraftMock;
    addAuditLog = addAuditLogMock;
    findDraftById = findDraftByIdMock;
  },
}));
vi.mock("@/app/repositories/nfe.repository", () => ({
  NfeRepository: class {
    findExistingDraft = findExistingDraftMock;
    createDraft = createDraftMock;
    updateDraft = updateDraftMock;
    addAuditLog = addAuditLogMock;
    findDraftById = findDraftByIdMock;
  },
}));
vi.mock("../../app/repositories/order.repository", () => ({
  orderRepository: { findForFiscalDraft: findForFiscalDraftMock },
}));
vi.mock("@/app/repositories/order.repository", () => ({
  orderRepository: { findForFiscalDraft: findForFiscalDraftMock },
}));

import { NfeDraftUseCase } from "../../app/usecases/nfe-draft.usecase";

const CFG_DEFAULT = {
  id: "cfg-A",
  isDefault: true,
  serieNfe: 1,
  serieNfce: 7,
  ambiente: "HOMOLOGACAO",
};
const CFG_B = {
  id: "cfg-B",
  isDefault: false,
  serieNfe: 5,
  serieNfce: 9,
  ambiente: "PRODUCAO",
};

function makeOrder(companyFiscalConfigId: string | null) {
  return {
    id: "o-1",
    externalOrderId: "PED-1",
    customerName: "Maria",
    customerEmail: null,
    marketplaceAccount: companyFiscalConfigId
      ? {
          id: "acc-1",
          platform: "MERCADO_LIVRE",
          shopId: null,
          accessToken: null,
          refreshToken: null,
          expiresAt: null,
          companyFiscalConfigId,
        }
      : null,
    items: [
      {
        productId: "p1",
        quantity: 1,
        unitPrice: 10,
        product: { sku: "SKU-1", name: "Peça" },
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  findByUserIdMock.mockResolvedValue(CFG_DEFAULT);
  findByIdForUserMock.mockResolvedValue(null);
  findExistingDraftMock.mockResolvedValue(null);
  createDraftMock.mockImplementation(async (_u: string, input: any) => ({
    id: "draft-1",
    status: "DRAFT",
    ...input,
  }));
  updateDraftMock.mockImplementation(
    async (_u: string, id: string, input: any) => ({ id, ...input }),
  );
  addAuditLogMock.mockResolvedValue(undefined);
});

describe("NfeDraftUseCase — seleção de emitente (multi-CNPJ)", () => {
  it("pedido de conta VINCULADA → draft nasce com o config da conta (serie/ambiente dele)", async () => {
    findForFiscalDraftMock.mockResolvedValue(makeOrder("cfg-B"));
    findByIdForUserMock.mockResolvedValue(CFG_B);

    const uc = new NfeDraftUseCase();
    await uc.create("u1", { orderId: "o-1" });

    expect(findByIdForUserMock).toHaveBeenCalledWith("cfg-B", "u1");
    const input = createDraftMock.mock.calls[0][1];
    expect(input.companyFiscalConfigId).toBe("cfg-B");
    expect(input.serie).toBe(5);
    expect(input.ambiente).toBe("PRODUCAO");
  });

  it("pedido de conta SEM vínculo → CNPJ padrão (comportamento atual)", async () => {
    findForFiscalDraftMock.mockResolvedValue(makeOrder(null));

    const uc = new NfeDraftUseCase();
    await uc.create("u1", { orderId: "o-1" });

    expect(findByIdForUserMock).not.toHaveBeenCalled();
    const input = createDraftMock.mock.calls[0][1];
    expect(input.companyFiscalConfigId).toBe("cfg-A");
    expect(input.serie).toBe(1);
    expect(input.ambiente).toBe("HOMOLOGACAO");
  });

  it("vínculo ÓRFÃO (config apagada) → fallback ao padrão SEM lançar", async () => {
    findForFiscalDraftMock.mockResolvedValue(makeOrder("cfg-apagada"));
    findByIdForUserMock.mockResolvedValue(null);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const uc = new NfeDraftUseCase();
    await uc.create("u1", { orderId: "o-1" });

    const input = createDraftMock.mock.calls[0][1];
    expect(input.companyFiscalConfigId).toBe("cfg-A");
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("escolha EXPLÍCITA vence o vínculo da conta", async () => {
    findForFiscalDraftMock.mockResolvedValue(makeOrder("cfg-B"));
    findByIdForUserMock.mockResolvedValue(CFG_B);
    const CFG_EXP = { ...CFG_B, id: "cfg-EXP", serieNfe: 8 };
    findByIdForUserMock.mockImplementation(async (id: string) =>
      id === "cfg-EXP" ? CFG_EXP : CFG_B,
    );

    const uc = new NfeDraftUseCase();
    await uc.create("u1", { orderId: "o-1", companyFiscalConfigId: "cfg-EXP" });

    const input = createDraftMock.mock.calls[0][1];
    expect(input.companyFiscalConfigId).toBe("cfg-EXP");
    expect(input.serie).toBe(8);
  });

  it("escolha explícita INVÁLIDA lança — nunca cai no padrão silenciosamente", async () => {
    findByIdForUserMock.mockResolvedValue(null);
    const uc = new NfeDraftUseCase();
    await expect(
      uc.create("u1", { orderId: "o-1", companyFiscalConfigId: "cfg-x" }),
    ).rejects.toThrow(/Emitente selecionado não encontrado/);
    expect(createDraftMock).not.toHaveBeenCalled();
  });

  it("REGRESSAO: sem orderId e sem seleção, draft novo carrega o config padrão", async () => {
    const uc = new NfeDraftUseCase();
    await uc.create("u1", {});
    const input = createDraftMock.mock.calls[0][1];
    expect(input.companyFiscalConfigId).toBe("cfg-A");
    expect(input.serie).toBe(1);
  });

  it("balcão/PDV: createPopulatedFromReceivable respeita o emitente selecionado (série NFC-e DELE)", async () => {
    findByIdForUserMock.mockResolvedValue(CFG_B);
    const uc = new NfeDraftUseCase();
    await uc.createPopulatedFromReceivable("u1", {
      customerId: "c1",
      receivableId: "r1",
      destinatario: { nome: "X" } as any,
      itens: [],
      pagamentos: [],
      modelo: "65",
      companyFiscalConfigId: "cfg-B",
    });

    expect(findByIdForUserMock).toHaveBeenCalledWith("cfg-B", "u1");
    const input = createDraftMock.mock.calls[0][1];
    expect(input.companyFiscalConfigId).toBe("cfg-B");
    expect(input.serie).toBe(9); // serieNfce do cfg-B
  });

  it("update do draft valida a posse do emitente novo; inválido lança", async () => {
    findDraftByIdMock.mockResolvedValue({ id: "draft-1", status: "DRAFT" });
    findByIdForUserMock.mockResolvedValue(null);
    const uc = new NfeDraftUseCase();
    await expect(
      uc.update("u1", "draft-1", { companyFiscalConfigId: "cfg-x" }),
    ).rejects.toThrow(/Emitente selecionado não encontrado/);
    expect(updateDraftMock).not.toHaveBeenCalled();

    findByIdForUserMock.mockResolvedValue(CFG_B);
    await uc.update("u1", "draft-1", { companyFiscalConfigId: "cfg-B" });
    expect(updateDraftMock).toHaveBeenCalledWith("u1", "draft-1", {
      companyFiscalConfigId: "cfg-B",
    });
  });
});
