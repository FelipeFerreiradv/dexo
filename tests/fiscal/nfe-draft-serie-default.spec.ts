import { describe, it, expect, beforeEach, vi } from "vitest";

// ──────────────────────────────────────────────────────────────────────────
// C1 — Série padrão na emissão.
//
// O backend (NfeDraftUseCase.create) resolve a série inicial do rascunho a
// partir de CompanyFiscalConfig.serieNfe: `input.serie ?? config.serieNfe ?? 1`.
// Aqui mockamos os repositórios (a usecase os instancia via `new`) para provar
// essa resolução sem tocar no banco — e garantir que a série explícita do input
// nunca é sobrescrita pela config e que o fallback seguro é 1.
//
// NOTA: com orderId, `create` roteia por `createPopulatedFromOrder` (autopreen-
// chimento a partir do pedido) — por isso mockamos também o order.repository e
// o updateDraft. A série continua sendo resolvida e passada ao createDraft.
// ──────────────────────────────────────────────────────────────────────────

const {
  findByUserIdMock,
  findExistingDraftMock,
  createDraftMock,
  updateDraftMock,
  addAuditLogMock,
  findForFiscalDraftMock,
} = vi.hoisted(() => ({
  findByUserIdMock: vi.fn(),
  findExistingDraftMock: vi.fn(),
  createDraftMock: vi.fn(),
  updateDraftMock: vi.fn(),
  addAuditLogMock: vi.fn(),
  findForFiscalDraftMock: vi.fn(),
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
vi.mock("../../app/repositories/order.repository", () => ({
  orderRepository: { findForFiscalDraft: findForFiscalDraftMock },
}));
vi.mock("@/app/repositories/order.repository", () => ({
  orderRepository: { findForFiscalDraft: findForFiscalDraftMock },
}));

import { NfeDraftUseCase } from "../../app/usecases/nfe-draft.usecase";

let lastCreated: any;

beforeEach(() => {
  vi.clearAllMocks();
  // O repo devolve o draft "como criado" — a série é eco do que recebeu.
  createDraftMock.mockImplementation(async (_userId: string, input: any) => {
    lastCreated = {
      id: "draft-1",
      serie: input.serie,
      status: "DRAFT",
      itens: [],
    };
    return lastCreated;
  });
  // `create` com orderId retorna o resultado do updateDraft (draft populado).
  updateDraftMock.mockImplementation(async () => lastCreated);
  addAuditLogMock.mockResolvedValue(undefined);
  findExistingDraftMock.mockResolvedValue(null);
  findForFiscalDraftMock.mockResolvedValue({
    id: "o-1",
    externalOrderId: "EXT-1",
    customerName: "Cliente Teste",
    customerEmail: null,
    items: [
      {
        productId: "p1",
        quantity: 1,
        unitPrice: 10,
        product: { sku: "SKU1", name: "Peça" },
      },
    ],
  });
});

describe("NfeDraftUseCase.create — série padrão da config fiscal", () => {
  it("usa CompanyFiscalConfig.serieNfe (ex.: 4) quando o input não traz série", async () => {
    findByUserIdMock.mockResolvedValue({ serieNfe: 4, ambiente: "PRODUCAO" });

    const uc = new NfeDraftUseCase();
    const draft = await uc.create("user-1", { orderId: "o-1" });

    expect(createDraftMock).toHaveBeenCalledTimes(1);
    expect(createDraftMock.mock.calls[0][1]).toMatchObject({ serie: 4 });
    expect(draft.serie).toBe(4);
  });

  it("fallback para 1 quando a config não tem série definida", async () => {
    findByUserIdMock.mockResolvedValue({ serieNfe: null, ambiente: "HOMOLOGACAO" });

    const uc = new NfeDraftUseCase();
    await uc.create("user-1", { orderId: "o-1" });

    expect(createDraftMock.mock.calls[0][1]).toMatchObject({ serie: 1 });
  });

  it("respeita a série explícita do input — não sobrescreve com a config", async () => {
    findByUserIdMock.mockResolvedValue({ serieNfe: 4, ambiente: "PRODUCAO" });

    const uc = new NfeDraftUseCase();
    await uc.create("user-1", { orderId: "o-1", serie: 9 });

    expect(createDraftMock.mock.calls[0][1]).toMatchObject({ serie: 9 });
  });

  it("sem configuração fiscal → lança erro e NÃO cria rascunho", async () => {
    findByUserIdMock.mockResolvedValue(null);

    const uc = new NfeDraftUseCase();
    await expect(uc.create("user-1", { orderId: "o-1" })).rejects.toThrow(
      /Configuração fiscal não encontrada/i,
    );
    expect(createDraftMock).not.toHaveBeenCalled();
  });
});
