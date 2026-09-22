import { describe, it, expect, beforeEach, vi } from "vitest";

// Nota que fica em SENDING no fluxo V1 (provedor respondeu "processando" e a consulta
// não concluiu) precisa deixar EVIDÊNCIA. Antes desta correção a auditoria ficava em
// branco: em 22/09/2026, 20 notas de produção só tiveram o desfecho descoberto
// consultando a chave direto na SEFAZ — todas duplicidade (539/613), porque o contador
// do Dexo estava abaixo da numeração real do cliente. Sem o registro, a nota some do
// radar e ninguém sabe o que a SEFAZ respondeu.

const h = vi.hoisted(() => {
  const draftRef: { value: any } = { value: null };
  const prisma = {
    nfeEmitida: {
      updateMany: vi.fn(async () => ({ count: 1 })),
      update: vi.fn(async () => ({})),
      findUnique: vi.fn(async () => draftRef.value),
      findFirst: vi.fn(),
    },
    user: { findUnique: vi.fn(async () => null) },
  };
  const envio: { value: any } = { value: null };
  const consulta: { value: any } = { value: null };
  const provider = {
    name: "SEFAZ_DIRECT",
    emitir: vi.fn(async () => envio.value),
    consultar: vi.fn(async () => consulta.value),
    consultarRecibo: vi.fn(async () => consulta.value),
  };
  return {
    draftRef,
    prisma,
    envio,
    consulta,
    provider,
    addAuditLog: vi.fn(async () => undefined),
    findByUserId: vi.fn(),
    reservarProximoNumero: vi.fn(async () => 501),
  };
});

vi.mock("../../app/lib/prisma", () => ({ default: h.prisma }));
vi.mock("@/app/lib/prisma", () => ({ default: h.prisma }));
vi.mock("../../app/repositories/nfe.repository", () => ({
  NfeRepository: class {
    findDraftById = vi.fn(async () => h.draftRef.value);
    findNfeById = vi.fn(async () => h.draftRef.value);
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
    reservarPorEmitente = h.reservarProximoNumero;
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

const CHAVE = "42260757502966000144550010000005011697983280";

beforeEach(() => {
  vi.clearAllMocks();
  h.draftRef.value = { ...makeDraft({ status: "DRAFT" } as any), itens: makeDraft().itens };
  h.findByUserId.mockResolvedValue(makeConfig({ providerName: "SEFAZ_DIRECT", uf: "SC", certificadoPath: "/cert.pfx", certificadoSenhaEnc: "enc" } as any));
  // Envio aceito pela SEFAZ ("processando"): é o caminho do lote 103/104 e da duplicidade.
  h.envio.value = {
    success: true,
    chaveAcesso: CHAVE,
    protocolo: null,
    dataAutorizacao: null,
    status: "processando",
    codigoStatus: 104,
    mensagem: "Lote processado",
    xmlAutorizado: null,
    providerRef: null,
  };
  // Consulta inconclusiva: cStat que o mapeador não conhece (>= 600) vira "erro".
  h.consulta.value = {
    status: "erro",
    codigoStatus: 613,
    mensagem: "Rejeicao: Chave de Acesso difere da existente em BD",
    chaveAcesso: CHAVE,
    protocolo: null,
    dataAutorizacao: null,
    xmlAutorizado: null,
  };
});

describe("V1: nota que fica em SENDING registra o que a SEFAZ respondeu", () => {
  it("grava ENVIO_PENDENTE com o cStat do envio e o da consulta", async () => {
    const r = await new NfeEmissionUseCase().emit("u1", "nfe-1");

    expect(r.status).toBe("SENDING");
    const chamadas = h.addAuditLog.mock.calls as unknown as unknown[][];
    const evento = chamadas.find((c) => c[2] === "ENVIO_PENDENTE");
    expect(evento, "a nota ficou em SENDING sem nenhuma evidência na auditoria").toBeDefined();
    const detalhes = evento![3] as Record<string, unknown>;
    expect(detalhes).toMatchObject({
      providerName: "SEFAZ_DIRECT",
      envioCStat: 104,
      consultaStatus: "erro",
      consultaCStat: 613,
      chaveAcesso: CHAVE,
    });
    expect(String(detalhes.consultaMensagem)).toContain("Chave de Acesso difere");
  });

  it("não muda o resto do fluxo: segue SENDING, sem rejeitar nem autorizar a nota", async () => {
    const r = await new NfeEmissionUseCase().emit("u1", "nfe-1");

    expect(r).toMatchObject({ status: "SENDING", success: true, chaveAcesso: CHAVE });
    const eventos = (h.addAuditLog.mock.calls as unknown as unknown[][]).map((c) => c[2]);
    expect(eventos).not.toContain("REJEITADA");
    expect(eventos).not.toContain("AUTORIZADA");
    expect(h.prisma.nfeEmitida.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "REJECTED" }) }),
    );
  });

  it("consulta conclusiva continua rejeitando a nota (sem ENVIO_PENDENTE)", async () => {
    h.consulta.value = { ...h.consulta.value, status: "rejeitada", codigoStatus: 225, mensagem: "Rejeicao: Falha no Schema XML" };

    const r = await new NfeEmissionUseCase().emit("u1", "nfe-1");

    expect(r.status).toBe("REJECTED");
    const eventos = (h.addAuditLog.mock.calls as unknown as unknown[][]).map((c) => c[2]);
    expect(eventos).toContain("REJEITADA");
    expect(eventos).not.toContain("ENVIO_PENDENTE");
  });
});
