import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Despacho da emissão quando a config ATUAL não é V2 mas a nota tem reserva V2 viva
// (troca de emitente no wizard, rollback da allowlist). Cair no V1 renumeraria a nota e
// deixaria o número órfão — "No fallback to V1 is allowed after any V2 mutation".
// Resposta: NumeracaoError 409 NUMERACAO_EMITENTE_FORA_V2, antes de qualquer escrita.
// Documento já registrado (AUTORIZADO/CANCELADO) e flag global desligada: nada muda.

const h = vi.hoisted(() => {
  const nota: { value: any } = { value: null };
  const config: { value: any } = { value: null };
  const reserva: { value: any } = { value: null };
  const tabelaAusente = { value: false };
  const chamadas: string[] = [];
  return { nota, config, reserva, tabelaAusente, chamadas };
});

vi.mock("../../../app/lib/prisma", () => ({ default: {} }));
vi.mock("../../../app/repositories/nfe.repository", () => ({
  NfeRepository: class {
    findDraftById = vi.fn(async () => (h.nota.value && ["DRAFT", "REJECTED"].includes(h.nota.value.status) ? h.nota.value : null));
    findNfeById = vi.fn(async () => h.nota.value);
    addAuditLog = vi.fn(async () => undefined);
  },
}));
vi.mock("../../../app/repositories/company-fiscal.repository", () => ({
  CompanyFiscalRepository: class {
    findByIdForUser = vi.fn(async () => h.config.value);
    findByUserId = vi.fn(async () => h.config.value);
  },
}));
vi.mock("../../../app/usecases/nfe-emissao-v2.orchestrator", () => ({
  NfeEmissaoV2Orchestrator: class {
    numeros = {
      reservaViva: async () => {
        h.chamadas.push("reservaViva");
        if (h.tabelaAusente.value) throw Object.assign(new Error("relation does not exist"), { code: "P2021" });
        return h.reserva.value;
      },
    };
    emitir = async (_u: string, d: { status: string }) => { h.chamadas.push(`v2.emitir:${d.status}`); return { success: true, status: d.status }; };
    consultar = async (_u: string, d: { status: string }) => { h.chamadas.push(`v2.consultar:${d.status}`); return { success: false, status: d.status }; };
  },
}));

import { NfeEmissionUseCase } from "../../../app/usecases/nfe-emission.usecase";

const CFG_V2 = "cfg-v2";
const CFG_FORA = "cfg-fora";

function nota(status: string, cfc: string) {
  return { id: "nfe-1", userId: "u1", companyFiscalConfigId: cfc, modelo: "55", serie: 1, numero: 7, status, updatedAt: new Date() };
}
function reserva(estado: string) {
  return { id: "res-1", estado, numero: 7, serie: 1, companyFiscalConfigId: CFG_V2, ambiente: "HOMOLOGACAO" };
}

beforeEach(() => {
  h.chamadas.length = 0;
  h.nota.value = nota("REJECTED", CFG_FORA);
  h.config.value = { id: CFG_FORA, userId: "u1", providerName: "SEFAZ_DIRECT", ambiente: "HOMOLOGACAO" };
  h.reserva.value = reserva("REJEITADO");
  h.tabelaAusente.value = false;
  vi.stubEnv("NFE_NUMERACAO_V2_ENABLED", "true");
  vi.stubEnv("NFE_NUMERACAO_V2_CONFIG_IDS", CFG_V2);
  vi.stubEnv("NFE_NUMERACAO_V2_MODELOS", "55");
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("contextoV2 — emitente fora da V2 com reserva viva", () => {
  it.each(["RESERVADO", "REJEITADO"])("reserva %s: emit responde 409 com o número no detalhe e não emite", async (estado) => {
    h.reserva.value = reserva(estado);
    const erro = await new NfeEmissionUseCase().emit("u1", "nfe-1").then(() => null, (e: unknown) => e);
    expect(erro).toMatchObject({
      name: "NumeracaoError", code: "NUMERACAO_EMITENTE_FORA_V2", httpStatus: 409,
      detalhes: { numero: 7, serie: 1, estado, companyFiscalConfigId: CFG_V2 },
    });
    expect((erro as Error).message).toMatch(/exclua o rascunho para descartar o número/);
    expect(h.chamadas).toEqual(["reservaViva"]);
  });

  it.each(["EM_TRANSMISSAO", "INCERTO", "BLOQUEADO"])("reserva %s: 409 orientando a consultar a situação", async (estado) => {
    h.reserva.value = reserva(estado);
    h.nota.value = nota("SENDING", CFG_FORA);
    const erro = await new NfeEmissionUseCase().consultarSituacao("u1", "nfe-1").then(() => null, (e: unknown) => e);
    expect(erro).toMatchObject({ code: "NUMERACAO_EMITENTE_FORA_V2", httpStatus: 409 });
    expect((erro as Error).message).toMatch(/Consultar situação/);
  });

  it.each(["AUTORIZADO", "CANCELADO"])("reserva %s (documento registrado): segue o comportamento atual (V1/404)", async (estado) => {
    h.reserva.value = reserva(estado);
    h.nota.value = nota(estado === "CANCELADO" ? "CANCELLED" : "AUTHORIZED", CFG_FORA);
    await expect(new NfeEmissionUseCase().consultarSituacao("u1", "nfe-1")).rejects.toMatchObject({ code: "RECURSO_INDISPONIVEL", httpStatus: 404 });
  });

  it("sem reserva viva: despacho V1 normal (404 na consulta), sem 409", async () => {
    h.reserva.value = null;
    await expect(new NfeEmissionUseCase().consultarSituacao("u1", "nfe-1")).rejects.toMatchObject({ code: "RECURSO_INDISPONIVEL" });
  });

  it("tabela fiscal ausente (DDL não aplicado): sem guarda, cai no V1", async () => {
    h.tabelaAusente.value = true;
    await expect(new NfeEmissionUseCase().consultarSituacao("u1", "nfe-1")).rejects.toMatchObject({ code: "RECURSO_INDISPONIVEL" });
  });

  it("I8: flag global desligada ⇒ nem consulta o ledger", async () => {
    vi.stubEnv("NFE_NUMERACAO_V2_ENABLED", "false");
    await expect(new NfeEmissionUseCase().consultarSituacao("u1", "nfe-1")).rejects.toMatchObject({ code: "RECURSO_INDISPONIVEL" });
    expect(h.chamadas).toEqual([]);
  });

  it("config na V2: o despacho continua indo ao orquestrador", async () => {
    h.nota.value = nota("REJECTED", CFG_V2);
    h.config.value = { id: CFG_V2, userId: "u1", providerName: "SEFAZ_DIRECT", ambiente: "HOMOLOGACAO" };
    await expect(new NfeEmissionUseCase().emit("u1", "nfe-1")).resolves.toMatchObject({ status: "REJECTED" });
    expect(h.chamadas).toEqual(["reservaViva", "v2.emitir:REJECTED"]);
  });
});
