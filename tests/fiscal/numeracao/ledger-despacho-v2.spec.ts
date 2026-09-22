import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Despacho pelo LEDGER (sem banco): cancelamento e exclusão de rascunho.
//
//  - Flag GLOBAL desligada ⇒ comportamento V1 idêntico ao atual e NENHUMA consulta à
//    numeração V2 (invariante I8).
//  - Flag GLOBAL ligada ⇒ a ref do cancelamento Focus, o CANCELADO e a exclusão saem da
//    RESERVA da nota, mesmo que a config atual tenha saído da allowlist (rollback) ou que
//    o rascunho tenha trocado de emitente.
//  - Ramo V2 Focus usa FocusNfeV2Client.cancelar: HTTP 200 com "erro_cancelamento" é FALHA.
//  - Tabela fiscal ausente (P2021/42P01) ⇒ cai no V1 sem quebrar.

const h = vi.hoisted(() => ({
  nota: null as Record<string, unknown> | null,
  configs: new Map<string, Record<string, unknown>>(),
  rascunho: null as Record<string, unknown> | null,
  reserva: null as Record<string, unknown> | null,
  refAutorizada: null as string | null,
  tabelaAusente: false,
  chamadas: [] as string[],
  cancelV1: [] as Array<Record<string, unknown>>,
  updates: [] as Array<Record<string, unknown>>,
  audits: [] as Array<{ evento: string; detalhes: Record<string, unknown> }>,
  fetches: [] as Array<{ url: string; metodo: string; corpo: unknown }>,
  resposta: { status: 200, json: {} as unknown },
}));

function erroTabelaAusente() {
  return Object.assign(new Error("relation does not exist"), { code: "P2021" });
}

vi.mock("../../../app/lib/prisma", () => ({
  default: {
    nfeEmitida: {
      findFirst: async () => h.nota,
      update: async (args: Record<string, unknown>) => { h.updates.push(args); return h.nota; },
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
  },
}));
vi.mock("../../../app/repositories/nfe.repository", () => ({
  NfeRepository: class {
    findDraftById = async () => h.rascunho;
    deleteDraft = async () => { h.chamadas.push("deleteDraft"); };
    addAuditLog = async (_id: string, _u: string, evento: string, detalhes: Record<string, unknown>) => { h.audits.push({ evento, detalhes }); };
  },
}));
vi.mock("../../../app/repositories/company-fiscal.repository", () => ({
  CompanyFiscalRepository: class {
    findByIdForUser = async (id: string) => h.configs.get(id) ?? null;
    findByUserId = async () => [...h.configs.values()][0] ?? null;
  },
}));
vi.mock("../../../app/fiscal/numeracao/numeracao.service", () => ({
  NfeNumeracaoService: class {
    async reservaViva() {
      h.chamadas.push("reservaViva");
      if (h.tabelaAusente) throw erroTabelaAusente();
      return h.reserva;
    }
    async focusRefAutorizada() {
      h.chamadas.push("focusRefAutorizada");
      if (h.tabelaAusente) throw erroTabelaAusente();
      return h.refAutorizada;
    }
    async marcarCancelado() { h.chamadas.push("marcarCancelado"); }
    async abandonarPorExclusao(_u: string, _id: string, confirmar: boolean) { h.chamadas.push(`abandonarPorExclusao:${confirmar}`); }
  },
}));
vi.mock("../../../app/fiscal/providers/provider-factory", () => {
  const provider = {
    cancelar: async (input: Record<string, unknown>) => {
      h.cancelV1.push(input);
      return { success: true, protocolo: "135-V1", mensagem: "Evento registrado e vinculado a NF-e" };
    },
  };
  return { createNfeProvider: () => provider, createNfeProviderFromConfig: async () => provider };
});

import { NfeCancelamentoUseCase } from "../../../app/usecases/nfe-cancelamento.usecase";
import { NfeDraftUseCase } from "../../../app/usecases/nfe-draft.usecase";

const CFC = "cfg-kiko";
const NFE_ID = "nfe123";
const JUSTIFICATIVA = "Cancelamento por erro de digitacao no pedido";
const CHAVE = "35260511222333000181550010000000011120100012";

function config(extra: Record<string, unknown> = {}) {
  return { id: CFC, userId: "tenant", cnpj: "11222333000181", ambiente: "HOMOLOGACAO", providerName: "FOCUS_NFE", providerToken: "tok-kiko", isDefault: true, uf: "SP", ...extra };
}
function ligarV2(ids = CFC) {
  vi.stubEnv("NFE_NUMERACAO_V2_ENABLED", "true");
  vi.stubEnv("NFE_NUMERACAO_V2_CONFIG_IDS", ids);
  vi.stubEnv("NFE_NUMERACAO_V2_MODELOS", "55");
  vi.stubEnv("NFE_NUMERACAO_V2_FOCUS_ENABLED", "true");
}

beforeEach(() => {
  h.nota = { id: NFE_ID, userId: "tenant", companyFiscalConfigId: CFC, modelo: "55", status: "AUTHORIZED", chaveAcesso: CHAVE, protocoloAutorizacao: "135260000000100", dataAutorizacao: new Date(Date.now() - 3600_000), createdAt: new Date() };
  h.rascunho = { id: NFE_ID, userId: "tenant", companyFiscalConfigId: CFC, modelo: "55", status: "REJECTED" };
  h.configs = new Map([[CFC, config()]]);
  h.reserva = null;
  h.refAutorizada = null;
  h.tabelaAusente = false;
  h.chamadas = [];
  h.cancelV1 = [];
  h.updates = [];
  h.audits = [];
  h.fetches = [];
  h.resposta = { status: 200, json: { status: "cancelado", status_sefaz: "135", mensagem_sefaz: "Evento registrado e vinculado a NF-e", protocolo: "135-V2" } };
  vi.stubEnv("NFE_DEVOLUCAO_ENABLED", "false");
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    h.fetches.push({ url: String(url), metodo: init?.method ?? "GET", corpo: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify(h.resposta.json), { status: h.resposta.status, headers: { "content-type": "application/json" } });
  });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("cancelamento — despacho V1 × V2 pelo ledger", () => {
  it("I8: flag global desligada ⇒ provider V1 com ref=nfeId e NENHUMA consulta ao ledger", async () => {
    const r = await new NfeCancelamentoUseCase().cancel("tenant", NFE_ID, JUSTIFICATIVA);
    expect(r).toMatchObject({ success: true, status: "CANCELLED", protocolo: "135-V1" });
    expect(h.cancelV1).toEqual([{ ref: NFE_ID, chaveAcesso: CHAVE, protocolo: "135260000000100", justificativa: JUSTIFICATIVA, token: "tok-kiko" }]);
    expect(h.chamadas).toEqual([]);
    expect(h.fetches).toEqual([]);
  });

  it("canário: ramo V2 Focus com a ref do ledger; 200 'cancelado' 135 ⇒ CANCELLED + marcarCancelado", async () => {
    ligarV2();
    h.reserva = { estado: "AUTORIZADO", numero: 7, serie: 1 };
    h.refAutorizada = `${NFE_ID}n7`;
    const r = await new NfeCancelamentoUseCase().cancel("tenant", NFE_ID, JUSTIFICATIVA);
    expect(r).toMatchObject({ success: true, status: "CANCELLED", protocolo: "135-V2" });
    expect(h.fetches).toEqual([{ url: `https://homologacao.focusnfe.com.br/v2/nfe/${NFE_ID}n7`, metodo: "DELETE", corpo: { justificativa: JUSTIFICATIVA } }]);
    expect(h.cancelV1).toEqual([]);
    expect(h.chamadas).toContain("marcarCancelado");
    expect(h.updates[0]).toMatchObject({ data: { status: "CANCELLED" } });
    expect(h.audits.map((a) => a.evento)).toEqual(["CANCELADA"]);
  });

  it("ramo V2: HTTP 200 com 'erro_cancelamento' ⇒ falha, nota segue AUTHORIZED e o ledger não é marcado", async () => {
    ligarV2();
    h.reserva = { estado: "AUTORIZADO", numero: 7, serie: 1 };
    h.refAutorizada = `${NFE_ID}n7`;
    h.resposta = { status: 200, json: { status: "erro_cancelamento", status_sefaz: "501", mensagem_sefaz: "Rejeicao: Prazo de cancelamento superior ao previsto na Legislacao" } };
    const r = await new NfeCancelamentoUseCase().cancel("tenant", NFE_ID, JUSTIFICATIVA);
    expect(r).toMatchObject({ success: false, status: "AUTHORIZED", protocolo: null });
    expect(r.mensagem).toContain("Prazo de cancelamento");
    expect(h.updates).toEqual([]);
    expect(h.chamadas).not.toContain("marcarCancelado");
    expect(h.audits).toEqual([{ evento: "CANCELAMENTO_REJEITADO", detalhes: expect.objectContaining({ cStat: 501, httpStatus: 200, status: "erro_cancelamento" }) }]);
  });

  it("rollback da allowlist: com reserva viva a ref e o CANCELADO continuam vindo do ledger", async () => {
    ligarV2("outra-config");
    h.reserva = { estado: "AUTORIZADO", numero: 7, serie: 1 };
    h.refAutorizada = `${NFE_ID}n7`;
    const r = await new NfeCancelamentoUseCase().cancel("tenant", NFE_ID, JUSTIFICATIVA);
    expect(r).toMatchObject({ success: true, status: "CANCELLED" });
    expect(h.fetches.map((f) => f.url)).toEqual([`https://homologacao.focusnfe.com.br/v2/nfe/${NFE_ID}n7`]);
    expect(h.chamadas).toContain("marcarCancelado");
  });

  it("nota legada (sem reserva) fora da allowlist: provider V1 com ref=nfeId, sem marcarCancelado", async () => {
    ligarV2("outra-config");
    const r = await new NfeCancelamentoUseCase().cancel("tenant", NFE_ID, JUSTIFICATIVA);
    expect(r).toMatchObject({ success: true, status: "CANCELLED" });
    expect(h.cancelV1).toEqual([expect.objectContaining({ ref: NFE_ID })]);
    expect(h.fetches).toEqual([]);
    expect(h.chamadas).not.toContain("marcarCancelado");
  });

  it("reserva viva que não é AUTORIZADO (nota autorizada pelo V1 durante rollback): não marca CANCELADO nem devolve erro", async () => {
    ligarV2();
    h.reserva = { estado: "REJEITADO", numero: 7, serie: 1 };
    const r = await new NfeCancelamentoUseCase().cancel("tenant", NFE_ID, JUSTIFICATIVA);
    expect(r).toMatchObject({ success: true, status: "CANCELLED" });
    expect(h.chamadas).not.toContain("marcarCancelado");
  });

  it("tabela fiscal ausente: cai no V1 com ref=nfeId", async () => {
    ligarV2();
    h.tabelaAusente = true;
    const r = await new NfeCancelamentoUseCase().cancel("tenant", NFE_ID, JUSTIFICATIVA);
    expect(r).toMatchObject({ success: true, status: "CANCELLED" });
    expect(h.cancelV1).toEqual([expect.objectContaining({ ref: NFE_ID })]);
    expect(h.fetches).toEqual([]);
    expect(h.chamadas).not.toContain("marcarCancelado");
  });

  it("SEFAZ direto: segue no provider V1 (sem ref Focus) e marca o ledger", async () => {
    ligarV2();
    h.configs.set(CFC, config({ providerName: "SEFAZ_DIRECT", providerToken: null }));
    h.reserva = { estado: "AUTORIZADO", numero: 7, serie: 1 };
    const r = await new NfeCancelamentoUseCase().cancel("tenant", NFE_ID, JUSTIFICATIVA);
    expect(r).toMatchObject({ success: true, status: "CANCELLED" });
    expect(h.fetches).toEqual([]);
    expect(h.chamadas).not.toContain("focusRefAutorizada");
    expect(h.chamadas).toContain("marcarCancelado");
  });
});

describe("exclusão de rascunho — despacho pelo ledger", () => {
  it("I8: flag global desligada ⇒ deleteDraft direto, sem consultar o ledger", async () => {
    await new NfeDraftUseCase().delete("tenant", NFE_ID);
    expect(h.chamadas).toEqual(["deleteDraft"]);
  });

  it("config na V2: abandona pela V2 (confirmação repassada)", async () => {
    ligarV2();
    await new NfeDraftUseCase().delete("tenant", NFE_ID, true);
    expect(h.chamadas).toEqual(["reservaViva", "abandonarPorExclusao:true"]);
  });

  it("config fora da V2 mas com reserva viva (troca de emitente/rollback): abandona pela V2", async () => {
    ligarV2("outra-config");
    h.reserva = { estado: "REJEITADO", numero: 7, serie: 1 };
    await new NfeDraftUseCase().delete("tenant", NFE_ID);
    expect(h.chamadas).toEqual(["reservaViva", "abandonarPorExclusao:false"]);
  });

  it("config fora da V2 e sem reserva: deleteDraft do V1", async () => {
    ligarV2("outra-config");
    await new NfeDraftUseCase().delete("tenant", NFE_ID);
    expect(h.chamadas).toEqual(["reservaViva", "deleteDraft"]);
  });

  it("tabela fiscal ausente: deleteDraft do V1", async () => {
    ligarV2();
    h.tabelaAusente = true;
    await new NfeDraftUseCase().delete("tenant", NFE_ID);
    expect(h.chamadas).toEqual(["reservaViva", "deleteDraft"]);
  });
});
