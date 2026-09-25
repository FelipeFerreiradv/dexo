/**
 * Decisão 6 do dono: "Emitir NF-e" NUNCA reaproveita um rascunho de devolução e o
 * transforma em nota normal.
 *
 * O caso real: a DLS AUTO PEÇAS tem o rascunho cmubl7is — devolução feita À MÃO no wizard
 * (finalidade DEVOLUCAO, SEM cabeçalho NfeDevolucao), rejeitado, com a reserva do nº 712
 * viva, entre o 711 e o 713 autorizados. `findExistingDraft` só excluía rascunho COM
 * cabeçalho: o menu "Emitir NF-e" abria o cmubl7is (o rascunho 55 mais recente) e ela
 * preenchia uma venda em cima dele — número reservado junto.
 *
 * Aqui o caminho REAL do "Emitir NF-e": NfeDraftUseCase.create → NfeRepository
 * (findExistingDraft / createDraft) — só o Prisma é um banco em memória, que responde ao
 * SQL da exclusão com a MESMA regra (e o texto do SQL é conferido). A variante com
 * Postgres real está em tests/fiscal/numeracao/regressao/devolucao-onda5-sql-postgres.spec.ts
 * (opt-in, NFE_TEST_DATABASE_URL). Aqui o banco em memória aplica a regra em JS: quem
 * prende o SQL da exclusão é o teste do texto ("a exclusão procura pela FINALIDADE…").
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const CFC = "cfg-dls";

const h = vi.hoisted(() => ({
  notas: [] as Array<Record<string, any>>,
  /** nfeId com cabeçalho NfeDevolucao (rascunho gerenciado). */
  cabecalhos: [] as string[],
  configs: [] as Array<{ id: string; userId: string; isDefault: boolean; createdAt: Date }>,
  sqls: [] as string[],
  auditoria: [] as Array<{ nfeId: string; evento: string }>,
}));

vi.mock("../../../app/lib/prisma", () => {
  const SQL_EXCLUSAO = `FROM "NfeEmitida" n WHERE n."userId"=$1 AND n."status"='DRAFT' AND n."modelo"=$2`;
  return {
    default: {
      $queryRawUnsafe: async (sql: string, ...args: any[]) => {
        h.sqls.push(sql);
        if (sql.includes(SQL_EXCLUSAO)) {
          const [userId, modelo] = args;
          const padrao = h.configs.filter((c) => c.userId === userId)
            .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.createdAt.getTime() - b.createdAt.getTime())[0]?.id ?? null;
          return h.notas
            .filter((n) => n.userId === userId && n.status === "DRAFT" && n.modelo === modelo && (n.finalidade === "DEVOLUCAO" || h.cabecalhos.includes(n.id)))
            .map((n) => ({ id: n.id, companyFiscalConfigId: n.companyFiscalConfigId ?? padrao }));
        }
        throw new Error("SQL não emulado neste teste: " + sql.slice(0, 120));
      },
      nfeEmitida: {
        findFirst: async ({ where }: any) => {
          const cand = h.notas
            .filter((n) => n.userId === where.userId && n.status === where.status && n.modelo === where.modelo && !(where.id?.notIn ?? []).includes(n.id))
            .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
          return cand[0] ? { ...cand[0], itens: [] } : null;
        },
        count: async ({ where }: any) => h.notas.filter((n) => n.userId === where.userId && n.status === where.status).length,
        create: async ({ data }: any) => {
          const row = { id: `nova-${h.notas.length + 1}`, ...data, createdAt: new Date(), updatedAt: new Date(), itens: [] };
          h.notas.push(row);
          return row;
        },
      },
      nfeAuditLog: { create: async ({ data }: any) => { h.auditoria.push({ nfeId: data.nfeId, evento: data.evento }); return data; } },
    },
  };
});
vi.mock("../../../app/repositories/company-fiscal.repository", () => ({
  CompanyFiscalRepository: class {
    findByUserId = async () => ({ id: CFC, userId: "tenant", ambiente: "PRODUCAO", serieNfe: 1, isDefault: true, providerName: "SEFAZ_DIRECT" });
    findByIdForUser = async () => ({ id: CFC, userId: "tenant", ambiente: "PRODUCAO", serieNfe: 1, isDefault: true, providerName: "SEFAZ_DIRECT" });
  },
}));
// A reserva viva do rascunho (numeração V2) não é o assunto aqui.
vi.mock("../../../app/fiscal/numeracao/metadata", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../app/fiscal/numeracao/metadata")>()),
  attachNumeracao: async (_u: string, d: unknown) => d,
}));

import { NfeDraftUseCase } from "../../../app/usecases/nfe-draft.usecase";
import { NfeRepository } from "../../../app/repositories/nfe.repository";

function ligarDevolucao(configIds = CFC) {
  vi.stubEnv("NFE_NUMERACAO_V2_ENABLED", "true");
  vi.stubEnv("NFE_NUMERACAO_V2_CONFIG_IDS", configIds);
  vi.stubEnv("NFE_NUMERACAO_V2_MODELOS", "55");
  vi.stubEnv("NFE_DEVOLUCAO_ENABLED", "true");
  vi.stubEnv("NFE_DEVOLUCAO_CONFIG_IDS", configIds);
}

const minutos = (m: number) => new Date(Date.UTC(2026, 8, 24, 20, m));
function rascunho(id: string, over: Record<string, unknown> = {}) {
  return {
    id, userId: "tenant", companyFiscalConfigId: CFC, modelo: "55", serie: 1, numero: -5, status: "DRAFT", ambiente: "PRODUCAO",
    tipoOperacao: "SAIDA", finalidade: "NORMAL", destinoOperacao: "INTERNA", naturezaOperacao: "VENDA DE MERCADORIA", indPresenca: "NAO_SE_APLICA",
    destinatarioJson: {}, createdAt: minutos(0), updatedAt: minutos(0), ...over,
  };
}
/** O cmubl7is: devolução feita à mão no wizard (sem NfeDevolucao), sem empresa gravada, o mais recente. */
const CMUBL7IS = () => rascunho("cmubl7is", { finalidade: "DEVOLUCAO", tipoOperacao: "ENTRADA", naturezaOperacao: "DEVOLUCAO DE VENDA", companyFiscalConfigId: null, updatedAt: minutos(50) });

beforeEach(() => {
  h.notas = []; h.cabecalhos = []; h.sqls = []; h.auditoria = [];
  h.configs = [{ id: CFC, userId: "tenant", isDefault: true, createdAt: minutos(0) }];
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("decisão 6: 'Emitir NF-e' não pega o rascunho de devolução", () => {
  it("o nº 712 da DLS (cmubl7is, feito à mão, sem cabeçalho): cria um rascunho NOVO e o de devolução fica intacto", async () => {
    ligarDevolucao();
    h.notas.push(CMUBL7IS());
    const d = await new NfeDraftUseCase().create("tenant", {} as never);
    expect(d.id).not.toBe("cmubl7is");
    expect(d).toMatchObject({ status: "DRAFT", finalidade: "NORMAL", tipoOperacao: "SAIDA", modelo: "55" });
    expect(h.auditoria).toEqual([{ nfeId: d.id, evento: "CRIADA" }]);
    // O rascunho de devolução continua como estava: devolução, rascunho, sem ter sido tocado.
    expect(h.notas.find((n) => n.id === "cmubl7is")).toMatchObject({ status: "DRAFT", finalidade: "DEVOLUCAO", tipoOperacao: "ENTRADA", updatedAt: minutos(50) });
  });

  it("rascunho NORMAL mais antigo continua sendo reaproveitado (só a devolução sai da disputa)", async () => {
    ligarDevolucao();
    h.notas.push(rascunho("venda-aberta", { updatedAt: minutos(10) }), CMUBL7IS());
    const d = await new NfeDraftUseCase().create("tenant", {} as never);
    expect(d.id).toBe("venda-aberta");
    expect(h.notas).toHaveLength(2);
  });

  it("o rascunho GERENCIADO (com NfeDevolucao) continua fora, como antes", async () => {
    ligarDevolucao();
    h.notas.push(rascunho("gerenciado", { finalidade: "DEVOLUCAO", updatedAt: minutos(40) }));
    h.cabecalhos.push("gerenciado");
    expect(await new NfeRepository().findExistingDraft("tenant", "55")).toBeNull();
  });

  it("a exclusão procura pela FINALIDADE, pelo cabeçalho e pelo modelo pedido — e a empresa padrão vale para o rascunho sem empresa", async () => {
    ligarDevolucao();
    await new NfeRepository().findExistingDraft("tenant", "55");
    const sql = h.sqls.find((s) => s.includes(`FROM "NfeEmitida" n`))!;
    expect(sql).toContain(`n."finalidade"='DEVOLUCAO'`);
    expect(sql).toContain(`EXISTS(SELECT 1 FROM "NfeDevolucao" d WHERE d."nfeId"=n."id"`);
    expect(sql).toContain(`COALESCE(n."companyFiscalConfigId",(SELECT c."id" FROM "CompanyFiscalConfig" c WHERE c."userId"=n."userId" ORDER BY c."isDefault" DESC,c."createdAt" ASC LIMIT 1))`);
  });
});

describe("CONTROLE: sem a devolução ligada para a empresa, nada muda", () => {
  it("devolução desligada na env: nenhuma consulta a mais e o rascunho de devolução à mão volta como antes", async () => {
    vi.stubEnv("NFE_DEVOLUCAO_ENABLED", "false");
    h.notas.push(CMUBL7IS());
    const d = await new NfeRepository().findExistingDraft("tenant", "55");
    expect(d?.id).toBe("cmubl7is");
    expect(h.sqls).toEqual([]);
  });

  it("devolução ligada só para OUTRA empresa: a desta continua como antes (a devolução à mão é do wizard antigo)", async () => {
    ligarDevolucao("cfg-de-outra-empresa");
    h.notas.push(CMUBL7IS());
    expect((await new NfeRepository().findExistingDraft("tenant", "55"))?.id).toBe("cmubl7is");
  });

  it("empresa padrão sem a devolução e o rascunho de devolução gravado na empresa que TEM: sai da disputa", async () => {
    ligarDevolucao();
    h.configs = [{ id: "cfg-padrao", userId: "tenant", isDefault: true, createdAt: minutos(0) }, { id: CFC, userId: "tenant", isDefault: false, createdAt: minutos(1) }];
    h.notas.push(rascunho("dev-cfc", { finalidade: "DEVOLUCAO", companyFiscalConfigId: CFC, updatedAt: minutos(30) }), rascunho("dev-padrao", { finalidade: "DEVOLUCAO", companyFiscalConfigId: null, updatedAt: minutos(20) }));
    // dev-cfc (empresa ligada) sai; dev-padrao (sem empresa ⇒ padrão, desligada) fica, como antes.
    expect((await new NfeRepository().findExistingDraft("tenant", "55"))?.id).toBe("dev-padrao");
  });
});
