import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// G3 sem banco (complementa os IT de Postgres g3-cancelamento-transacao e g3-devolucao-rollback):
//  - NfeDevolucaoRepository.temCabecalho: `SELECT 1 … LIMIT 1`, tabela ausente ⇒ false, outro
//    erro sobe (nunca engolir falha de banco como "não tem cabeçalho");
//  - NfeDevolucaoRepository.empresaDoRascunhoGerenciado (proteção do updateDraft): cabeçalho e
//    empresa na MESMA ida ao banco, e o erro do rollback com a frase certa;
//  - cancelamento com a devolução DESLIGADA para a config: a trava da original roda FORA de
//    transação, tolera tabela ausente, não engole outro erro e — com o gate global desligado —
//    não consulta nada (V1 byte a byte, o mesmo contrato de focus-v1-cancelamento-recusado);
//  - cancelamento com a devolução LIGADA: a 1ª instrução da transação é o SET LOCAL do
//    idle_in_transaction_session_timeout, e as opções são timeout 600 s / maxWait 30 s.

const h = vi.hoisted(() => {
  const sqlFora: string[] = [];
  const sqlTx: string[] = [];
  const state = {
    nota: null as any,
    linhasFora: (): Promise<unknown[]> => Promise.resolve([]),
    config: null as any,
  };
  const prisma = {
    nfeEmitida: {
      findFirst: vi.fn(async () => state.nota),
      update: vi.fn(async () => ({})),
    },
    $queryRawUnsafe: vi.fn(async (sql: string) => { sqlFora.push(sql); return state.linhasFora(); }),
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>, _opts?: unknown) => fn({
      $executeRawUnsafe: async (sql: string) => { sqlTx.push(sql); return 0; },
      $queryRawUnsafe: async (sql: string) => { sqlTx.push(sql); return []; },
    })),
  };
  return {
    sqlFora, sqlTx, state, prisma,
    addAuditLog: vi.fn(async () => undefined),
    cancelar: vi.fn(async () => ({ success: true, protocolo: "135CANC", mensagem: "ok" })),
  };
});

vi.mock("../../app/lib/prisma", () => ({ default: h.prisma }));
vi.mock("@/app/lib/prisma", () => ({ default: h.prisma }));
vi.mock("../../app/repositories/nfe.repository", () => ({
  NfeRepository: class { addAuditLog = h.addAuditLog; },
}));
vi.mock("../../app/repositories/company-fiscal.repository", () => ({
  CompanyFiscalRepository: class {
    findByIdForUser = async () => h.state.config;
    findByUserId = async () => h.state.config;
  },
}));
vi.mock("../../app/fiscal/providers/provider-factory", () => ({
  createNfeProvider: () => ({ cancelar: h.cancelar }),
  createNfeProviderFromConfig: async () => ({ cancelar: h.cancelar }),
}));
// O ledger da V2 não é o assunto: sem reserva viva.
vi.mock("../../app/fiscal/numeracao/numeracao.service", () => ({
  NfeNumeracaoService: class {
    reservaViva = async () => null;
    focusRefAutorizada = async () => null;
    marcarCancelado = async () => undefined;
  },
}));

import { NfeDevolucaoRepository, erroRascunhoComDevolucaoDesligada } from "../../app/fiscal/devolucao/devolucao.repository";
import { NfeCancelamentoUseCase } from "../../app/usecases/nfe-cancelamento.usecase";
import { DevolucaoError } from "../../app/fiscal/devolucao/devolucao.errors";
import { makeConfig } from "./__helpers__/test-draft";

const CFC = "cfg-dls";
const CHAVE = "35260511222333000181550010000000011120100012";
const JUSTIFICATIVA = "Cancelamento de teste por erro de digitacao";
const ausente = (code = "P2021") => Object.assign(new Error("relation does not exist"), { code });

beforeEach(() => {
  vi.clearAllMocks();
  h.sqlFora.length = 0; h.sqlTx.length = 0;
  h.state.nota = {
    id: "nfe-1", userId: "tenant", companyFiscalConfigId: CFC, modelo: "55", status: "AUTHORIZED",
    chaveAcesso: CHAVE, protocoloAutorizacao: "135260000000001", dataAutorizacao: new Date(Date.now() - 3600_000), createdAt: new Date(),
  };
  h.state.config = makeConfig({ id: CFC, userId: "tenant", providerName: "SEFAZ_DIRECT" } as never);
  h.state.linhasFora = () => Promise.resolve([]);
  // Rollback por config: gates globais ligados, a config fora das duas listas.
  vi.stubEnv("NFE_NUMERACAO_V2_ENABLED", "true");
  vi.stubEnv("NFE_NUMERACAO_V2_CONFIG_IDS", "cfg-outra");
  vi.stubEnv("NFE_NUMERACAO_V2_MODELOS", "55");
  vi.stubEnv("NFE_NUMERACAO_V2_FOCUS_ENABLED", "false");
  vi.stubEnv("NFE_DEVOLUCAO_ENABLED", "true");
  vi.stubEnv("NFE_DEVOLUCAO_CONFIG_IDS", "cfg-outra");
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("NfeDevolucaoRepository.temCabecalho", () => {
  it("SELECT 1 com LIMIT 1 pelo nfeId e userId; linha ⇒ true, nenhuma ⇒ false", async () => {
    const chamadas: Array<{ sql: string; args: unknown[] }> = [];
    const db = (rows: unknown[]) => ({ $queryRawUnsafe: async (sql: string, ...args: unknown[]) => { chamadas.push({ sql, args }); return rows; } }) as never;
    const repo = new NfeDevolucaoRepository();
    expect(await repo.temCabecalho("tenant", "nfe-1", db([{ "?column?": 1 }]))).toBe(true);
    expect(await repo.temCabecalho("tenant", "nfe-1", db([]))).toBe(false);
    expect(chamadas[0].sql).toMatch(/^SELECT 1 FROM "NfeDevolucao" WHERE .* LIMIT 1$/);
    expect(chamadas[0].args).toEqual(["nfe-1", "tenant"]);
  });

  it.each(["P2021", "42P01"])("tabela ausente (%s) ⇒ false", async (code) => {
    const db = { $queryRawUnsafe: async () => { throw ausente(code); } } as never;
    expect(await new NfeDevolucaoRepository().temCabecalho("tenant", "nfe-1", db)).toBe(false);
  });

  it("outro erro de banco SOBE (não vira 'sem cabeçalho')", async () => {
    const db = { $queryRawUnsafe: async () => { throw new Error("connection reset"); } } as never;
    await expect(new NfeDevolucaoRepository().temCabecalho("tenant", "nfe-1", db)).rejects.toThrow("connection reset");
  });
});

describe("NfeDevolucaoRepository.empresaDoRascunhoGerenciado (proteção do updateDraft)", () => {
  it("UMA consulta: existência do cabeçalho E a empresa (padrão quando a nota não tem), LIMIT 1 pelo id e userId", async () => {
    const chamadas: Array<{ sql: string; args: unknown[] }> = [];
    const db = (rows: unknown[]) => ({ $queryRawUnsafe: async (sql: string, ...args: unknown[]) => { chamadas.push({ sql, args }); return rows; } }) as never;
    const repo = new NfeDevolucaoRepository();
    expect(await repo.empresaDoRascunhoGerenciado("tenant", "nfe-1", db([{ companyFiscalConfigId: CFC }]))).toEqual({ companyFiscalConfigId: CFC });
    expect(await repo.empresaDoRascunhoGerenciado("tenant", "nfe-1", db([]))).toBeNull();
    expect(chamadas).toHaveLength(2);
    const sql = chamadas[0].sql.replace(/\s+/g, " ");
    expect(sql).toMatch(/JOIN "NfeDevolucao" d ON d\."nfeId"=n\."id" AND d\."userId"=n\."userId"/);
    expect(sql).toMatch(/COALESCE\(n\."companyFiscalConfigId",\(SELECT c\."id" FROM "CompanyFiscalConfig" c WHERE c\."userId"=n\."userId" ORDER BY c\."isDefault" DESC,c\."createdAt" ASC LIMIT 1\)\)/);
    expect(sql).toMatch(/WHERE n\."id"=\$1 AND n\."userId"=\$2 LIMIT 1$/);
    expect(chamadas[0].args).toEqual(["nfe-1", "tenant"]);
  });

  it.each(["P2021", "42P01"])("tabela ausente (%s) ⇒ null (sem cabeçalho)", async (code) => {
    const db = { $queryRawUnsafe: async () => { throw ausente(code); } } as never;
    expect(await new NfeDevolucaoRepository().empresaDoRascunhoGerenciado("tenant", "nfe-1", db)).toBeNull();
  });

  it("outro erro de banco SOBE (não vira 'sem cabeçalho' e não libera campo protegido)", async () => {
    const db = { $queryRawUnsafe: async () => { throw new Error("connection reset"); } } as never;
    await expect(new NfeDevolucaoRepository().empresaDoRascunhoGerenciado("tenant", "nfe-1", db)).rejects.toThrow("connection reset");
  });

  it("erro do rollback: EXIGE_NUMERACAO_V2 (422, fora do 'tente novamente' do RASCUNHO_ALTERADO) com o rascunho e a frase que só promete o que existe", () => {
    const e = erroRascunhoComDevolucaoDesligada("nfe-1");
    expect(e).toBeInstanceOf(DevolucaoError);
    expect({ code: e.code, http: e.httpStatus, draftId: e.draftId }).toEqual({ code: "EXIGE_NUMERACAO_V2", http: 422, draftId: "nfe-1" });
    expect(e.message).toMatch(/desligada para esta empresa/);
    expect(e.message).toMatch(/suporte do Dexo/);
    expect(e.message).not.toMatch(/tente novamente|Reative/i);
  });
});

describe("cancelamento com a devolução DESLIGADA para a config (fora de transação)", () => {
  it("original com devolução AUTORIZADA ⇒ ORIGINAL_COM_DEVOLUCAO, sem transação e sem provedor", async () => {
    h.state.linhasFora = () => Promise.resolve([{ chave: CHAVE, nItem: 1, quantidade: "1", statusDevolucao: "AUTHORIZED", devolucaoNfeId: "dev-1", quantidadeOriginal: "1", fonteDevolucao: "XML", numeroDevolucao: 2, serieDevolucao: 1, criadaEm: new Date() }]);
    const err = await new NfeCancelamentoUseCase().cancel("tenant", "nfe-1", JUSTIFICATIVA).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DevolucaoError);
    expect((err as DevolucaoError).code).toBe("ORIGINAL_COM_DEVOLUCAO");
    expect(h.cancelar).not.toHaveBeenCalled();
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
    expect(h.sqlFora).toHaveLength(1);
    expect(h.sqlFora[0]).toContain(`FROM "NfeDevolucaoItem"`);
  });

  it.each(["P2021", "42P01"])("tabela da devolução ausente (%s) ⇒ cancela como no V1", async (code) => {
    h.state.linhasFora = () => Promise.reject(ausente(code));
    const r = await new NfeCancelamentoUseCase().cancel("tenant", "nfe-1", JUSTIFICATIVA);
    expect(r).toMatchObject({ success: true, status: "CANCELLED" });
    expect(h.cancelar).toHaveBeenCalledTimes(1);
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("outro erro na consulta SOBE antes do provedor (não cancela às cegas)", async () => {
    h.state.linhasFora = () => Promise.reject(new Error("connection reset"));
    await expect(new NfeCancelamentoUseCase().cancel("tenant", "nfe-1", JUSTIFICATIVA)).rejects.toThrow("connection reset");
    expect(h.cancelar).not.toHaveBeenCalled();
  });

  it("gate global desligado: nenhuma consulta nova (V1 byte a byte)", async () => {
    vi.stubEnv("NFE_DEVOLUCAO_ENABLED", "false");
    vi.stubEnv("NFE_NUMERACAO_V2_ENABLED", "false");
    const r = await new NfeCancelamentoUseCase().cancel("tenant", "nfe-1", JUSTIFICATIVA);
    expect(r).toMatchObject({ success: true, status: "CANCELLED" });
    expect(h.prisma.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe("cancelamento com a devolução LIGADA para a config (dentro da transação)", () => {
  it("1ª instrução: SET LOCAL idle_in_transaction_session_timeout = '11min'; opções timeout 600 s e maxWait 30 s", async () => {
    vi.stubEnv("NFE_NUMERACAO_V2_CONFIG_IDS", CFC);
    vi.stubEnv("NFE_DEVOLUCAO_CONFIG_IDS", CFC);
    const r = await new NfeCancelamentoUseCase().cancel("tenant", "nfe-1", JUSTIFICATIVA);
    expect(r).toMatchObject({ success: true, status: "CANCELLED" });
    expect(h.sqlTx[0]).toBe(`SET LOCAL idle_in_transaction_session_timeout = '11min'`);
    expect(h.sqlTx[1]).toContain("pg_advisory_xact_lock");
    expect(h.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 600000, maxWait: 30000 });
    // Nada fora da transação: o saldo é lido sob o lock (a corrida com a emissão continua fechada).
    expect(h.sqlFora).toEqual([]);
  });
});
