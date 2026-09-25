import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { makeConfig } from "../../__helpers__/test-draft";

// VERIFICAÇÃO (achado devolucao-1): a guarda do cancelamento da original procura
// devoluções pela chave CRUA de NfeEmitida.chaveAcesso. O Focus V1 grava "NFe"+44
// (focus-nfe.provider.ts: chaveAcesso = body.chave_nfe); o lado da devolução grava
// 44 dígitos (montagem normaliza; CHECK ^[0-9]{44}$ em NfeDevolucaoItem).
// PostgreSQL REAL, repositórios e usecases reais; só o transporte (provedor) e o
// repositório de config (o teste não cria CompanyFiscalConfig) são simulados.
//
// Opt-in: NFE_TEST_DATABASE_URL=postgresql://postgres:<senha>@127.0.0.1:<porta>/nfe_test

const raw = process.env.NFE_TEST_DATABASE_URL;
const schema = `nfe_verif_dev1_${randomUUID().replace(/-/g, "")}`;

const h = vi.hoisted(() => ({
  configs: new Map<string, any>(),
  cancelCalls: [] as any[],
  /** Atraso do provedor no cancelamento (G3: corrida com a emissão da devolução). */
  atrasoMs: 0,
}));

vi.mock("../../../../app/repositories/company-fiscal.repository", () => ({
  CompanyFiscalRepository: class {
    findByIdForUser = async (id: string) => h.configs.get(id) ?? null;
    findByUserId = async () => [...h.configs.values()].find((c) => c.isDefault) ?? null;
  },
}));
vi.mock("../../../../app/fiscal/providers/provider-factory", () => {
  const p = {
    cancelar: async (i: any) => {
      h.cancelCalls.push(i);
      if (h.atrasoMs) await new Promise((r) => setTimeout(r, h.atrasoMs));
      return { success: true, protocolo: "135CANC", mensagem: "ok" };
    },
    buscarXml: async () => null,
  };
  return { createNfeProvider: () => p, createNfeProviderFromConfig: async () => p };
});
vi.mock("../../../../app/usecases/company-fiscal-resp-tec.usecase", () => ({ resolverRespTecEmpresa: async () => ({ origem: "OMITIR" }) }));

const XML_ORIGINAL = readFileSync("tests/fiscal/golden/__fixtures__/nfe-proc-sample.xml", "utf8");
const CHAVE44 = "35260511222333000181550010000000011120100012"; // = chNFe do XML acima
const CHAVE_FOCUS_V1 = `NFe${CHAVE44}`; // formato que o Focus V1 devolve em chave_nfe e o V1 persiste

const describePg = describe.skipIf(!raw);
describePg("verificação devolucao-1: guarda do cancelamento × chave 'NFe'+44 do Focus V1 (Postgres real)", () => {
  let admin: PrismaClient;
  let M: any;

  beforeAll(async () => {
    const url = new URL(raw!);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !url.pathname.includes("nfe_test")) {
      throw new Error("NFE_TEST_DATABASE_URL deve apontar a banco nfe_test em localhost");
    }
    url.searchParams.set("schema", schema);
    process.env.DATABASE_URL = url.toString();
    admin = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    const diff = execFileSync("npx", ["prisma", "migrate", "diff", "--from-empty", "--to-schema-datamodel", "prisma/schema.prisma", "--script"], { encoding: "utf8", shell: true, env: process.env });
    const doDdl = /"(NfeNumeroReserva|NfeNumeroTentativa|CompanyFiscalRespTec|NfeDevolucao|NfeDevolucaoItem)"/;
    const stmts = diff.split(/;\s*(?:\r?\n|$)/).map((s) => s.replace(/^\s*--[^\n]*\n/gm, "").trim()).filter((s) => s && !/FOREIGN KEY/.test(s) && !doDdl.test(s));
    for (const sql of stmts) await admin.$executeRawUnsafe(sql);
    await admin.$executeRawUnsafe(`CREATE UNIQUE INDEX "NfeSequence_cfcId_ambiente_serie_modelo_key" ON "NfeSequence"("companyFiscalConfigId","ambiente","serie","modelo") WHERE "companyFiscalConfigId" IS NOT NULL`);
    await admin.$executeRawUnsafe(`CREATE UNIQUE INDEX "NfeEmitida_cfcId_ambiente_serie_numero_modelo_key" ON "NfeEmitida"("companyFiscalConfigId","ambiente","serie","numero","modelo") WHERE "companyFiscalConfigId" IS NOT NULL AND "numero" > 0`);
    for (const arq of ["prisma/ddl/2026-09-18-nfe-numeracao-v2.sql", "prisma/ddl/2026-09-18-nfe-devolucao.sql"]) {
      const ddl = readFileSync(arq, "utf8").replace(/--[^\r\n]*/g, "");
      for (const sql of ddl.split(";").map((s) => s.trim()).filter((s) => s && !["BEGIN", "COMMIT"].includes(s))) await admin.$executeRawUnsafe(sql);
    }
    M = {
      Cancel: (await import("../../../../app/usecases/nfe-cancelamento.usecase")).NfeCancelamentoUseCase,
      Devolucao: (await import("../../../../app/usecases/nfe-devolucao.usecase")).NfeDevolucaoUseCase,
      DevolucaoRepo: (await import("../../../../app/fiscal/devolucao/devolucao.repository")).NfeDevolucaoRepository,
      DevolucaoError: (await import("../../../../app/fiscal/devolucao/devolucao.errors")).DevolucaoError,
      prisma: (await import("../../../../app/lib/prisma")).default,
    };
  }, 180000);

  afterAll(async () => {
    if (M?.prisma) await M.prisma.$disconnect();
    if (admin) { await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`); await admin.$disconnect(); }
  });

  let cfc: string;
  beforeEach(async () => {
    cfc = `cfg-${randomUUID().slice(0, 8)}`;
    h.configs.clear(); h.cancelCalls = []; h.atrasoMs = 0;
    // Mesmo CNPJ/ambiente do XML de amostra (emit 11222333000181, tpAmb 2).
    h.configs.set(cfc, makeConfig({ id: cfc, userId: "tenant", providerName: "FOCUS_NFE", providerToken: "tok", isDefault: true } as any));
    // Canário + devolução ligada para a empresa (pré-condição do achado).
    vi.stubEnv("NFE_NUMERACAO_V2_ENABLED", "true");
    vi.stubEnv("NFE_NUMERACAO_V2_CONFIG_IDS", cfc);
    vi.stubEnv("NFE_NUMERACAO_V2_MODELOS", "55");
    vi.stubEnv("NFE_NUMERACAO_V2_FOCUS_ENABLED", "true");
    vi.stubEnv("NFE_DEVOLUCAO_ENABLED", "true");
    vi.stubEnv("NFE_DEVOLUCAO_CONFIG_IDS", cfc);
    // Isolamento entre casos: a mesma chave é @unique em NfeEmitida.
    await admin.$executeRawUnsafe(`DELETE FROM "NfeDevolucaoItem"`);
    await admin.$executeRawUnsafe(`DELETE FROM "NfeDevolucao"`);
    await admin.$executeRawUnsafe(`DELETE FROM "NfeItem"`);
    await admin.$executeRawUnsafe(`DELETE FROM "NfeEmitida"`);
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  /** Original 55 autorizada há 1 h pelo caminho V1 (sem reserva V2), com a chave no formato dado. */
  async function criarOriginal(chaveGravada: string): Promise<string> {
    const n = await admin.nfeEmitida.create({
      data: {
        userId: "tenant", companyFiscalConfigId: cfc, ambiente: "HOMOLOGACAO", modelo: "55", serie: 1, numero: 1, status: "AUTHORIZED",
        tipoOperacao: "SAIDA", finalidade: "NORMAL", destinoOperacao: "INTERNA", naturezaOperacao: "VENDA DE MERCADORIA", indPresenca: "PRESENCIAL",
        destinatarioJson: { nome: "CLIENTE TESTE LTDA", cpfCnpj: "00000000000100" } as object,
        emittedByUserId: "tenant",
        chaveAcesso: chaveGravada, protocoloAutorizacao: "135260000000001",
        dataAutorizacao: new Date(Date.now() - 60 * 60 * 1000), xmlAutorizadoPath: "/fiscal/tenant/orig.xml",
        itens: { create: [{ numero: 1, codigo: "PROD-001", descricao: "PRODUTO TESTE", ncm: "87089990", cfop: "5102", origem: 0, unidade: "UN", quantidade: 1, valorUnitario: 100, valorTotal: 100 }] },
      } as any,
    });
    return n.id;
  }

  /** POST /nfe/:id/devolucao pelo usecase REAL, depois a devolução é AUTORIZADA (como faria a emissão V2). */
  async function devolucaoAutorizada(originalId: string): Promise<string> {
    const storage = { readFile: async () => Buffer.from(XML_ORIGINAL, "utf8") };
    const uc = new M.Devolucao(new M.DevolucaoRepo(), undefined, storage as never);
    const r = await uc.criar("tenant", "tenant", originalId, { escopo: "TOTAL" });
    expect(r.reutilizado).toBe(false);
    await admin.$executeRawUnsafe(
      `UPDATE "NfeEmitida" SET "status"='AUTHORIZED',"numero"=2,"chaveAcesso"=$2,"protocoloAutorizacao"='135260000000002',"dataAutorizacao"=NOW() WHERE "id"=$1`,
      r.draftId, "35260511222333000181550010000000021120100019",
    );
    return r.draftId;
  }

  async function estado(id: string) {
    return (await admin.nfeEmitida.findUnique({ where: { id }, select: { status: true } }))!.status;
  }

  it("controle: original gravada com 44 dígitos → cancelamento BLOQUEADO (ORIGINAL_COM_DEVOLUCAO)", async () => {
    const original = await criarOriginal(CHAVE44);
    await devolucaoAutorizada(original);
    const linhas = await admin.$queryRawUnsafe<Array<{ chaveAcessoOriginal: string }>>(`SELECT "chaveAcessoOriginal" FROM "NfeDevolucaoItem"`);
    expect(linhas).toEqual([{ chaveAcessoOriginal: CHAVE44 }]);

    const err = await new M.Cancel().cancel("tenant", original, "Cancelamento de teste por erro de digitacao").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(M.DevolucaoError);
    expect((err as any).code).toBe("ORIGINAL_COM_DEVOLUCAO");
    expect(h.cancelCalls).toEqual([]);
    expect(await estado(original)).toBe("AUTHORIZED");
  }, 60000);

  it("★ achado: original gravada como 'NFe'+44 (Focus V1) com devolução AUTORIZADA → cancelamento deve ser BLOQUEADO", async () => {
    const original = await criarOriginal(CHAVE_FOCUS_V1);
    await devolucaoAutorizada(original);
    // O lado da devolução só consegue gravar 44 dígitos (normaliza + CHECK do DDL).
    const linhas = await admin.$queryRawUnsafe<Array<{ chaveAcessoOriginal: string }>>(`SELECT "chaveAcessoOriginal" FROM "NfeDevolucaoItem"`);
    expect(linhas).toEqual([{ chaveAcessoOriginal: CHAVE44 }]);
    // A consulta que a guarda faz, com a chave CRUA da original, não enxerga a devolução.
    const vistasPelaGuarda = await new M.DevolucaoRepo().linhasSaldo("tenant", CHAVE_FOCUS_V1);
    const vistasNormalizadas = await new M.DevolucaoRepo().linhasSaldo("tenant", CHAVE44);
    expect(vistasNormalizadas.map((l: any) => l.statusDevolucao)).toEqual(["AUTHORIZED"]);

    const r = await new M.Cancel().cancel("tenant", original, "Cancelamento de teste por erro de digitacao").then(
      (v: unknown) => ({ ok: v }), (e: unknown) => ({ erro: e }),
    );
    // Diagnóstico visível na falha.
    const diag = { guardaViu: vistasPelaGuarda.length, resultado: "ok" in r ? r.ok : String((r as any).erro), provedorChamadoCom: h.cancelCalls.map((c) => c.chaveAcesso), statusOriginal: await estado(original) };
    expect(diag, JSON.stringify(diag)).toMatchObject({ provedorChamadoCom: [], statusOriginal: "AUTHORIZED" });
    expect("erro" in r && (r as any).erro instanceof M.DevolucaoError && (r as any).erro.code).toBe("ORIGINAL_COM_DEVOLUCAO");
  }, 60000);

  // G3 (A3/F2): o SET LOCAL e o maxWait novos não podem afrouxar a serialização. Com o
  // cancelamento parado no provedor (lock da original seguro DENTRO da transação), a validação
  // da reserva de uma devolução da MESMA original (validarReserva, o passo da emissão V2) tem de
  // ESPERAR o lock e, ao entrar, ver a original já CANCELLED — nunca AUTHORIZED. Se o saldo/lock
  // saíssem da transação ("checa e solta"), a devolução passaria com a original sendo cancelada.
  it("corrida: devolução validada durante o cancelamento em voo espera o lock e vê a original CANCELLED", async () => {
    // SEFAZ direto: o cancelamento passa pelo provedor simulado (a Focus V2 faria HTTP real).
    h.configs.set(cfc, makeConfig({ id: cfc, userId: "tenant", providerName: "SEFAZ_DIRECT", isDefault: true } as any));
    const original = await criarOriginal(CHAVE44);
    const storage = { readFile: async () => Buffer.from(XML_ORIGINAL, "utf8") };
    const uc = new M.Devolucao(new M.DevolucaoRepo(), undefined, storage as never);
    const { draftId } = await uc.criar("tenant", "tenant", original, { escopo: "TOTAL" });
    const antes = await new M.DevolucaoRepo().get("tenant", draftId);

    h.atrasoMs = 2000;
    const ordem: string[] = [];
    const cancelamento = new M.Cancel().cancel("tenant", original, "Cancelamento de teste por erro de digitacao")
      .then((v: any) => { ordem.push("cancelamento-fim"); return v; });
    for (let i = 0; i < 100 && h.cancelCalls.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(h.cancelCalls).toHaveLength(1); // provedor em voo, lock da original seguro

    const repo = new M.DevolucaoRepo();
    const validacao = await repo.transaction((tx: any) => uc.validarReserva("tenant", draftId, antes, tx))
      .then(() => ({ ok: true }), (e: any) => ({ code: e?.code, issues: (e?.issues ?? []).map((i: any) => i.code) }));
    ordem.push("validacao-fim");
    expect(await cancelamento).toMatchObject({ success: true, status: "CANCELLED" });
    expect({ ordem, validacao }).toMatchObject({ ordem: ["cancelamento-fim", "validacao-fim"], validacao: { code: "DEVOLUCAO_INVALIDA" } });
    expect(await estado(original)).toBe("CANCELLED");
  }, 60000);
});
