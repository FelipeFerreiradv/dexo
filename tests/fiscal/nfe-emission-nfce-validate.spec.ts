import { describe, it, expect, beforeEach, vi } from "vitest";

// NFC-e (Fase 2) — validações do pipeline de emissão para modelo 65.
// Invariante central: TODO guard de 65 falha ANTES do claim atômico
// (updateMany) — nenhum número é queimado e o draft permanece DRAFT.

const h = vi.hoisted(() => {
  const draftRef: { value: any } = { value: null };
  const configRef: { value: any } = { value: null };
  const findDraftById = vi.fn(async () => draftRef.value);
  const persistCalculo = vi.fn(async () => {
    throw new Error("PARADA-CONTROLADA");
  });
  const addAuditLog = vi.fn(async () => undefined);
  const forceStatus = vi.fn(async () => undefined);
  const findByNumeroPedidoAndModelo = vi.fn(async () => null);
  const findByUserId = vi.fn(async () => configRef.value);
  const updateMany = vi.fn(async () => ({ count: 1 }));
  const prisma = {
    nfeEmitida: {
      updateMany,
      update: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
  };
  return {
    draftRef,
    configRef,
    findDraftById,
    persistCalculo,
    addAuditLog,
    forceStatus,
    findByNumeroPedidoAndModelo,
    findByUserId,
    updateMany,
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
    findByNumeroPedidoAndModelo = h.findByNumeroPedidoAndModelo;
  },
}));
vi.mock("../../app/repositories/company-fiscal.repository", () => ({
  CompanyFiscalRepository: class {
    findByUserId = h.findByUserId;
  },
}));

import { NfeEmissionUseCase } from "../../app/usecases/nfe-emission.usecase";
import { makeConfig, makeDraft, makeItem } from "./__helpers__/test-draft";

function config65(overrides: Record<string, any> = {}) {
  return makeConfig({
    providerName: "SEFAZ_DIRECT",
    uf: "SC",
    codMunicipio: "4205407",
    cscId: "000001",
    cscToken: "CSC-TESTE",
    ...overrides,
  });
}

function draft65(overrides: Record<string, any> = {}) {
  return makeDraft({
    modelo: "65",
    pagamentosJson: [{ meio: "PIX", valor: 100 }] as any,
    ...overrides,
  });
}

beforeEach(() => {
  h.updateMany.mockClear();
  h.persistCalculo.mockClear();
});

describe("NfeEmissionUseCase.emit — guards do modelo 65 (antes do claim)", () => {
  it("total > R$ 10.000 → erro claro e NENHUM claim/numero", async () => {
    h.draftRef.value = draft65({
      totaisJson: { totalNota: 10000.01 } as any,
    });
    h.configRef.value = config65();
    const uc = new NfeEmissionUseCase();
    await expect(uc.emit("u1", "nfe-1")).rejects.toThrow(/R\$ 10\.000/);
    expect(h.updateMany).not.toHaveBeenCalled();
  });

  it("sem pagamentos → erro; sem claim", async () => {
    h.draftRef.value = draft65({ pagamentosJson: [] as any });
    h.configRef.value = config65();
    const uc = new NfeEmissionUseCase();
    await expect(uc.emit("u1", "nfe-1")).rejects.toThrow(
      /forma de pagamento/,
    );
    expect(h.updateMany).not.toHaveBeenCalled();
  });

  it("SEFAZ_DIRECT sem CSC → erro acionável; sem claim", async () => {
    h.draftRef.value = draft65();
    h.configRef.value = config65({ cscToken: null });
    const uc = new NfeEmissionUseCase();
    await expect(uc.emit("u1", "nfe-1")).rejects.toThrow(/CSC nao configurado/);
    expect(h.updateMany).not.toHaveBeenCalled();
  });

  it("UF sem autorizador NFC-e (AM) → erro claro; sem claim", async () => {
    h.draftRef.value = draft65();
    h.configRef.value = config65({ uf: "AM", codMunicipio: "1302603" });
    const uc = new NfeEmissionUseCase();
    await expect(uc.emit("u1", "nfe-1")).rejects.toThrow(
      /nao suportada para NFC-e/,
    );
    expect(h.updateMany).not.toHaveBeenCalled();
  });

  it("item sem NCM → mensagem cita o NCM padrao da config; sem claim", async () => {
    h.draftRef.value = draft65({ itens: [makeItem({ ncm: "" })] });
    h.configRef.value = config65();
    const uc = new NfeEmissionUseCase();
    await expect(uc.emit("u1", "nfe-1")).rejects.toThrow(/NCM padrao/);
    expect(h.updateMany).not.toHaveBeenCalled();
  });

  it("65 SEM destinatario PASSA na validacao (claim acontece)", async () => {
    h.draftRef.value = draft65({ destinatarioJson: null as any });
    h.configRef.value = config65();
    const uc = new NfeEmissionUseCase();
    // A parada controlada em persistCalculo prova que passamos da validacao
    // e do claim — o dest opcional NAO barrou.
    await expect(uc.emit("u1", "nfe-1")).rejects.toThrow("PARADA-CONTROLADA");
    expect(h.updateMany).toHaveBeenCalledTimes(1);
  });

  it("REGRESSAO 55: sem destinatario continua barrando (validate intacta)", async () => {
    h.draftRef.value = makeDraft({ destinatarioJson: null as any });
    h.configRef.value = makeConfig({ providerName: "SEFAZ_DIRECT" });
    const uc = new NfeEmissionUseCase();
    await expect(uc.emit("u1", "nfe-1")).rejects.toThrow(
      /Destinatario incompleto/,
    );
    expect(h.updateMany).not.toHaveBeenCalled();
  });
});
