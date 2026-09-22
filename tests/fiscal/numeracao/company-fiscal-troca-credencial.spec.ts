import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Guarda de troca de ambiente/token (achado focus-5): a consulta de uma tentativa sem
// desfecho usa o token e o ambiente ATUAIS da config; a Focus tem UM token por ambiente e
// a config guarda um só. Com a numeração V2 ligada (global), trocar ambiente ou token com
// reserva EM_TRANSMISSAO/INCERTO responde 409 até as notas serem resolvidas.
// Flag global desligada ⇒ nenhuma consulta (I8). Tabela fiscal ausente ⇒ sem guarda.

const h = vi.hoisted(() => ({
  pendentes: [] as Array<Record<string, unknown>>,
  consultas: [] as Array<{ sql: string; params: unknown[] }>,
  erro: null as Error | null,
}));

vi.mock("../../../app/lib/prisma", () => ({
  default: {
    $queryRawUnsafe: async (sql: string, ...params: unknown[]) => {
      h.consultas.push({ sql, params });
      if (h.erro) throw h.erro;
      return h.pendentes;
    },
  },
}));

import { CompanyFiscalUseCase } from "../../../app/usecases/company-fiscal.usecase";

const CFC = "cfg-kiko";
const ATUAL = {
  id: CFC,
  userId: "tenant",
  ambiente: "HOMOLOGACAO" as const,
  providerName: "FOCUS_NFE",
  providerToken: "tok-homolog",
};
const DADOS = {
  cnpj: "11222333000181",
  razaoSocial: "KIKO 4X4 PECAS LTDA",
  inscricaoEstadual: "123456789",
  regimeTributario: "SIMPLES" as const,
};

function useCase(atual: Record<string, unknown> | null = ATUAL) {
  const updateById = vi.fn(async () => ({ ...atual }));
  const upsert = vi.fn(async () => ({ ...atual }));
  const repo = {
    updateById,
    upsert,
    findByIdForUser: vi.fn(async () => atual),
    findDefaultByUserId: vi.fn(async () => atual),
    findByUserId: vi.fn(async () => atual),
  };
  return { uc: new CompanyFiscalUseCase(repo as never), updateById, upsert };
}

beforeEach(() => {
  h.pendentes = [{ numero: 1, serie: 1, ambiente: "HOMOLOGACAO", modelo: "55", estado: "INCERTO" }];
  h.consultas = [];
  h.erro = null;
  vi.stubEnv("NFE_NUMERACAO_V2_ENABLED", "true");
  vi.stubEnv("FISCAL_PRODUCTION_UNLOCKED", "true");
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("CompanyFiscalUseCase — guarda de ambiente/token com envio pendente", () => {
  it("troca de ambiente com reserva INCERTO ⇒ 409 e nada é gravado", async () => {
    const { uc, updateById } = useCase();
    const erro = await uc.updateById(CFC, "tenant", { ...DADOS, ambiente: "PRODUCAO", providerToken: "tok-prod" }).then(() => null, (e: unknown) => e);
    expect(erro).toMatchObject({ name: "NumeracaoError", code: "NUMERACAO_PENDENTE_TROCA_CREDENCIAL", httpStatus: 409 });
    expect((erro as Error).message).toContain("nº 1 (série 1, homologação)");
    expect((erro as Error).message).toContain("Consultar situação");
    expect(updateById).not.toHaveBeenCalled();
    expect(h.consultas[0].params).toEqual(["tenant", CFC]);
  });

  it("troca só do token (mesmo ambiente) também é bloqueada", async () => {
    const { uc, updateById } = useCase();
    await expect(uc.updateById(CFC, "tenant", { ...DADOS, ambiente: "HOMOLOGACAO", providerToken: "tok-novo" }))
      .rejects.toMatchObject({ code: "NUMERACAO_PENDENTE_TROCA_CREDENCIAL" });
    expect(updateById).not.toHaveBeenCalled();
  });

  it("PUT legado (config padrão) segue a mesma guarda", async () => {
    const { uc, upsert } = useCase();
    await expect(uc.upsert("tenant", { ...DADOS, ambiente: "PRODUCAO" }))
      .rejects.toMatchObject({ code: "NUMERACAO_PENDENTE_TROCA_CREDENCIAL" });
    expect(upsert).not.toHaveBeenCalled();
  });

  it.each([
    ["mesmo ambiente e token em branco (o repositório preserva o salvo)", { ambiente: "HOMOLOGACAO" as const, providerToken: "" }],
    ["mesmo ambiente e MESMO token", { ambiente: "HOMOLOGACAO" as const, providerToken: "tok-homolog" }],
  ])("sem troca de credencial (%s): salva sem consultar o ledger", async (_nome, extra) => {
    const { uc, updateById } = useCase();
    await uc.updateById(CFC, "tenant", { ...DADOS, ...extra });
    expect(updateById).toHaveBeenCalledTimes(1);
    expect(h.consultas).toEqual([]);
  });

  it("sem reservas pendentes: a troca passa", async () => {
    h.pendentes = [];
    const { uc, updateById } = useCase();
    await uc.updateById(CFC, "tenant", { ...DADOS, ambiente: "PRODUCAO", providerToken: "tok-prod" });
    expect(updateById).toHaveBeenCalledTimes(1);
    expect(h.consultas).toHaveLength(1);
  });

  it("I8: flag global desligada ⇒ salva sem nenhuma consulta", async () => {
    vi.stubEnv("NFE_NUMERACAO_V2_ENABLED", "false");
    const { uc, updateById } = useCase();
    await uc.updateById(CFC, "tenant", { ...DADOS, ambiente: "PRODUCAO", providerToken: "tok-prod" });
    expect(updateById).toHaveBeenCalledTimes(1);
    expect(h.consultas).toEqual([]);
  });

  it("tabela fiscal ausente (DDL não aplicado): sem guarda, a troca passa", async () => {
    h.erro = Object.assign(new Error("relation \"NfeNumeroReserva\" does not exist"), { code: "P2021" });
    const { uc, updateById } = useCase();
    await uc.updateById(CFC, "tenant", { ...DADOS, ambiente: "PRODUCAO", providerToken: "tok-prod" });
    expect(updateById).toHaveBeenCalledTimes(1);
  });

  it("empresa inexistente: segue para o repositório (que decide o erro)", async () => {
    const { uc, updateById } = useCase(null);
    await uc.updateById("nao-existe", "tenant", { ...DADOS, ambiente: "PRODUCAO", providerToken: "tok-prod" });
    expect(updateById).toHaveBeenCalledTimes(1);
    expect(h.consultas).toEqual([]);
  });

  it("validação continua antes da guarda (CNPJ inválido não consulta o ledger)", async () => {
    const { uc, updateById } = useCase();
    await expect(uc.updateById(CFC, "tenant", { ...DADOS, cnpj: "123", ambiente: "PRODUCAO" })).rejects.toThrow(/CNPJ/);
    expect(updateById).not.toHaveBeenCalled();
    expect(h.consultas).toEqual([]);
  });
});
