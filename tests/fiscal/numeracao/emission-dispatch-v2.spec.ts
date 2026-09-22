import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Despacho V1 × V2 em NfeEmissionUseCase (contextoV2). O repositório abaixo tem a
// semântica REAL: findDraftById só enxerga DRAFT/REJECTED; findNfeById enxerga
// qualquer status. Uma nota V2 em SENDING/AUTHORIZED precisa chegar ao
// orquestrador — senão "Consultar situação" responde 404 e o replay cai no V1.

const h = vi.hoisted(() => {
  const nota: { value: any } = { value: null };
  const config: { value: any } = { value: null };
  const chamadas: string[] = [];
  return { nota, config, chamadas };
});

vi.mock("../../../app/lib/prisma", () => ({ default: {} }));
vi.mock("../../../app/repositories/nfe.repository", () => ({
  NfeRepository: class {
    findDraftById = vi.fn(async () =>
      h.nota.value && ["DRAFT", "REJECTED"].includes(h.nota.value.status) ? h.nota.value : null,
    );
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
    numeros = { reservaViva: async () => null };
    emitir = async (_u: string, d: { status: string }) => {
      h.chamadas.push(`v2.emitir:${d.status}`);
      return { success: d.status === "AUTHORIZED", status: d.status, emAndamento: d.status === "SENDING" };
    };
    consultar = async (_u: string, d: { status: string }) => {
      h.chamadas.push(`v2.consultar:${d.status}`);
      return { success: false, status: d.status, emAndamento: true };
    };
  },
}));

import { NfeEmissionUseCase } from "../../../app/usecases/nfe-emission.usecase";

const CFG = "cfg-v2";
function nota(status: string) {
  return { id: "nfe-1", userId: "u1", companyFiscalConfigId: CFG, modelo: "55", serie: 1, numero: 7, status, updatedAt: new Date() };
}

beforeEach(() => {
  h.chamadas.length = 0;
  h.config.value = { id: CFG, userId: "u1", providerName: "SEFAZ_DIRECT", ambiente: "HOMOLOGACAO" };
  vi.stubEnv("NFE_NUMERACAO_V2_ENABLED", "true");
  vi.stubEnv("NFE_NUMERACAO_V2_CONFIG_IDS", CFG);
  vi.stubEnv("NFE_NUMERACAO_V2_MODELOS", "55");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("contextoV2 — nota V2 em qualquer status chega ao orquestrador", () => {
  it.each(["SENDING", "VALIDATING", "AUTHORIZED", "DRAFT", "REJECTED"])("consultarSituacao com nota %s consulta pela V2 (nunca 404)", async (status) => {
    h.nota.value = nota(status);
    await expect(new NfeEmissionUseCase().consultarSituacao("u1", "nfe-1")).resolves.toMatchObject({ status });
    expect(h.chamadas).toEqual([`v2.consultar:${status}`]);
  });

  it.each(["SENDING", "AUTHORIZED"])("emit com nota %s vai para a V2 (replay/em andamento), não para o V1", async (status) => {
    h.nota.value = nota(status);
    await expect(new NfeEmissionUseCase().emit("u1", "nfe-1")).resolves.toMatchObject({ status });
    expect(h.chamadas).toEqual([`v2.emitir:${status}`]);
  });
});

describe("fora do escopo V2 o despacho continua no V1", () => {
  it("flag desligada: consultarSituacao responde 404 sem tocar na V2", async () => {
    vi.stubEnv("NFE_NUMERACAO_V2_ENABLED", "false");
    h.nota.value = nota("SENDING");
    await expect(new NfeEmissionUseCase().consultarSituacao("u1", "nfe-1")).rejects.toMatchObject({ code: "RECURSO_INDISPONIVEL", httpStatus: 404 });
    expect(h.chamadas).toEqual([]);
  });

  it("config fora da allowlist: consultarSituacao responde 404 sem tocar na V2", async () => {
    vi.stubEnv("NFE_NUMERACAO_V2_CONFIG_IDS", "outra-config");
    h.nota.value = nota("SENDING");
    await expect(new NfeEmissionUseCase().consultarSituacao("u1", "nfe-1")).rejects.toMatchObject({ code: "RECURSO_INDISPONIVEL" });
    expect(h.chamadas).toEqual([]);
  });

  it("nota inexistente: 404 sem tocar na V2", async () => {
    h.nota.value = null;
    await expect(new NfeEmissionUseCase().consultarSituacao("u1", "nfe-1")).rejects.toMatchObject({ code: "RECURSO_INDISPONIVEL" });
    expect(h.chamadas).toEqual([]);
  });
});
