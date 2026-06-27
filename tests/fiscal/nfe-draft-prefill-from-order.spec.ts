import { describe, it, expect, beforeEach, vi } from "vitest";

// ──────────────────────────────────────────────────────────────────────────
// Autopreenchimento RICO do rascunho de NF-e a partir do pedido.
//
// `NfeDraftUseCase.create({ orderId })` agora cria um draft FRESCO já populado
// com destinatário (nome/email) + itens (produto/quantidade/valor) + pagamento
// (= total dos itens), espelhando o padrão da venda balcão. NCM e CFOP entram
// VAZIOS de propósito (Product não tem NCM; CFOP depende da UF do destinatário,
// desconhecida no pedido) — guardrail contra nota errada. Mockamos os repos
// para provar o mapeamento sem tocar no banco; o fluxo de emissão é intocado.
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

beforeEach(() => {
  vi.clearAllMocks();
  findByUserIdMock.mockResolvedValue({ serieNfe: 1, ambiente: "HOMOLOGACAO" });
  createDraftMock.mockResolvedValue({ id: "draft-1", serie: 1, status: "DRAFT" });
  updateDraftMock.mockImplementation(async (_u: string, _id: string, input: any) => ({
    id: "draft-1",
    ...input,
  }));
  addAuditLogMock.mockResolvedValue(undefined);
  findForFiscalDraftMock.mockResolvedValue({
    id: "o-1",
    externalOrderId: "PED-123",
    customerName: "Maria Cliente",
    customerEmail: "maria@ex.com",
    items: [
      {
        productId: "p1",
        quantity: 2,
        unitPrice: 49.9,
        product: { sku: "ABC-1", name: "Tampa de Combustível" },
      },
      {
        productId: "p2",
        quantity: 1,
        unitPrice: 100,
        product: { sku: "XYZ-9", name: "Retrovisor" },
      },
    ],
  });
});

describe("NfeDraftUseCase.create — autopreenchimento a partir do pedido", () => {
  it("popula itens com produto + quantidade + valor do pedido", async () => {
    const uc = new NfeDraftUseCase();
    await uc.create("user-1", { orderId: "o-1" });

    expect(updateDraftMock).toHaveBeenCalledTimes(1);
    const payload = updateDraftMock.mock.calls[0][2];
    expect(payload.itens).toHaveLength(2);

    expect(payload.itens[0]).toMatchObject({
      numero: 1,
      productId: "p1",
      codigo: "ABC-1",
      descricao: "Tampa de Combustível",
      quantidade: 2,
      valorUnitario: 49.9,
      valorTotal: 99.8,
      unidade: "UN",
      origem: 0,
    });
    expect(payload.itens[1]).toMatchObject({
      numero: 2,
      codigo: "XYZ-9",
      descricao: "Retrovisor",
      quantidade: 1,
      valorUnitario: 100,
      valorTotal: 100,
    });
  });

  it("GUARDRAIL: NCM e CFOP entram VAZIOS (não inventa valor que rejeita a nota)", async () => {
    const uc = new NfeDraftUseCase();
    await uc.create("user-1", { orderId: "o-1" });

    const payload = updateDraftMock.mock.calls[0][2];
    for (const item of payload.itens) {
      expect(item.ncm).toBe("");
      expect(item.cfop).toBe("");
    }
  });

  it("popula destinatário com nome/email; cpfCnpj e endereço ficam em branco", async () => {
    const uc = new NfeDraftUseCase();
    await uc.create("user-1", { orderId: "o-1" });

    const payload = updateDraftMock.mock.calls[0][2];
    expect(payload.destinatarioJson).toMatchObject({
      tipoPessoa: "PF",
      nome: "Maria Cliente",
      email: "maria@ex.com",
      cpfCnpj: "",
      logradouro: null,
      uf: null,
    });
    expect(payload.numeroPedido).toBe("PED-123");
  });

  it("pagamento = soma dos itens (total da nota), meio OUTROS", async () => {
    const uc = new NfeDraftUseCase();
    await uc.create("user-1", { orderId: "o-1" });

    const payload = updateDraftMock.mock.calls[0][2];
    expect(payload.pagamentosJson).toEqual([{ meio: "OUTROS", valor: 199.8 }]);
  });

  it("é escopado por usuário (multi-tenant): findForFiscalDraft recebe orderId + userId", async () => {
    const uc = new NfeDraftUseCase();
    await uc.create("user-1", { orderId: "o-1" });

    expect(findForFiscalDraftMock).toHaveBeenCalledWith("o-1", "user-1");
  });

  it("pedido não encontrado (ou de outro tenant) → lança e não cria draft", async () => {
    findForFiscalDraftMock.mockResolvedValue(null);

    const uc = new NfeDraftUseCase();
    await expect(uc.create("user-1", { orderId: "o-1" })).rejects.toThrow(
      /Pedido não encontrado/i,
    );
    expect(createDraftMock).not.toHaveBeenCalled();
  });
});
