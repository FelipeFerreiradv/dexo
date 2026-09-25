import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

// Onda 5 da devolução (grupo I2): o SQL NOVO contra o schema REAL (Prisma + DDLs de 18/09).
// Os specs em memória provam a regra; este prova que o SQL existe e faz a mesma coisa:
//  - findExistingDraft: "Emitir NF-e" não pega rascunho de devolução — nem o feito à mão
//    (finalidade DEVOLUCAO sem NfeDevolucao, o nº 712 da DLS), com a empresa PADRÃO para
//    o rascunho sem empresa (subconsulta em CompanyFiscalConfig);
//  - donosDasConfigs / empresasDoUsuario (atalho de /abertas e /disponibilidade);
//  - getStats com o FILTER das entradas; o select do relatório mensal com tipo/finalidade.
//
// Opt-in: NFE_TEST_DATABASE_URL=postgresql://postgres:<senha>@127.0.0.1:<porta>/nfe_test

const raw = process.env.NFE_TEST_DATABASE_URL;
const schema = `nfe_verif_onda5_${randomUUID().replace(/-/g, "")}`;

const describePg = describe.skipIf(!raw);
describePg("onda 5 da devolução: SQL novo no Postgres real", () => {
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
    for (const arq of ["prisma/ddl/2026-09-18-nfe-numeracao-v2.sql", "prisma/ddl/2026-09-18-nfe-devolucao.sql"]) {
      const ddl = readFileSync(arq, "utf8").replace(/--[^\r\n]*/g, "");
      for (const sql of ddl.split(";").map((s) => s.trim()).filter((s) => s && !["BEGIN", "COMMIT"].includes(s))) await admin.$executeRawUnsafe(sql);
    }
    M = {
      NfeRepository: (await import("../../../../app/repositories/nfe.repository")).NfeRepository,
      DevolucaoRepo: (await import("../../../../app/fiscal/devolucao/devolucao.repository")).NfeDevolucaoRepository,
      prisma: (await import("../../../../app/lib/prisma")).default,
    };
  }, 180000);

  afterAll(async () => {
    if (M?.prisma) await M.prisma.$disconnect();
    if (admin) { await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`); await admin.$disconnect(); }
  });

  const CFC = "cfg-dls";
  beforeEach(async () => {
    vi.stubEnv("NFE_NUMERACAO_V2_ENABLED", "true");
    vi.stubEnv("NFE_NUMERACAO_V2_CONFIG_IDS", CFC);
    vi.stubEnv("NFE_NUMERACAO_V2_MODELOS", "55");
    vi.stubEnv("NFE_DEVOLUCAO_ENABLED", "true");
    vi.stubEnv("NFE_DEVOLUCAO_CONFIG_IDS", CFC);
    await admin.$executeRawUnsafe(`DELETE FROM "NfeDevolucaoItem"`);
    await admin.$executeRawUnsafe(`DELETE FROM "NfeDevolucao"`);
    await admin.$executeRawUnsafe(`DELETE FROM "NfeItem"`);
    await admin.$executeRawUnsafe(`DELETE FROM "NfeEmitida"`);
    await admin.$executeRawUnsafe(`DELETE FROM "CompanyFiscalConfig"`);
    await empresa(CFC, "tenant", true, "57502966000144", new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  async function empresa(id: string, userId: string, isDefault: boolean, cnpj: string, createdAt: Date) {
    await admin.companyFiscalConfig.create({
      data: { id, userId, isDefault, cnpj, razaoSocial: "EMPRESA " + id, inscricaoEstadual: "123", regimeTributario: "SIMPLES", ambiente: "PRODUCAO", uf: "SC", providerToken: "SEGREDO", createdAt },
    });
  }
  async function rascunho(id: string, o: Record<string, unknown> = {}) {
    await admin.nfeEmitida.create({
      data: {
        id, userId: "tenant", companyFiscalConfigId: CFC, ambiente: "PRODUCAO", modelo: "55", serie: 1, numero: -Math.floor(Math.random() * 1e6) - 1, status: "DRAFT",
        tipoOperacao: "SAIDA", finalidade: "NORMAL", destinoOperacao: "INTERNA", naturezaOperacao: "VENDA DE MERCADORIA", indPresenca: "NAO_SE_APLICA",
        destinatarioJson: {} as object, emittedByUserId: "tenant", ...o,
      } as never,
    });
  }

  it("decisão 6: o rascunho de devolução feito à mão (sem cabeçalho, sem empresa gravada) não volta em 'Emitir NF-e'; o normal volta", async () => {
    await rascunho("venda-aberta", { updatedAt: new Date("2026-09-24T20:10:00Z") });
    await rascunho("cmubl7is", { finalidade: "DEVOLUCAO", tipoOperacao: "ENTRADA", companyFiscalConfigId: null, updatedAt: new Date("2026-09-24T20:50:00Z") });
    const repo = new M.NfeRepository();
    expect((await repo.findExistingDraft("tenant", "55"))?.id).toBe("venda-aberta");
    await admin.nfeEmitida.delete({ where: { id: "venda-aberta" } });
    expect(await repo.findExistingDraft("tenant", "55")).toBeNull();
  }, 60000);

  it("o GERENCIADO (com NfeDevolucao) continua fora; empresa padrão desligada deixa o dela como antes", async () => {
    await rascunho("gerenciado", { finalidade: "DEVOLUCAO", updatedAt: new Date("2026-09-24T20:40:00Z") });
    await admin.$executeRawUnsafe(`INSERT INTO "NfeDevolucao" ("id","nfeId","userId","tipo","fonte","escopoSolicitado","indFinal","origensJson","createdByUserId") VALUES ($1,'gerenciado','tenant','COMPRA_SAIDA','XML_IMPORTADO','PARCIAL','0','[]'::jsonb,'tenant')`, randomUUID());
    const repo = new M.NfeRepository();
    expect(await repo.findExistingDraft("tenant", "55")).toBeNull();

    // Outra empresa como PADRÃO (sem a devolução): o rascunho à mão sem empresa é dela ⇒ volta, como antes.
    await admin.$executeRawUnsafe(`UPDATE "CompanyFiscalConfig" SET "isDefault"=false WHERE "id"=$1`, CFC);
    await empresa("cfg-padrao", "tenant", true, "22222222000191", new Date("2026-02-01T00:00:00Z"));
    await rascunho("a-mao-padrao", { finalidade: "DEVOLUCAO", companyFiscalConfigId: null, updatedAt: new Date("2026-09-24T20:30:00Z") });
    expect((await repo.findExistingDraft("tenant", "55"))?.id).toBe("a-mao-padrao");
  }, 60000);

  it("donosDasConfigs e empresasDoUsuario: o SQL devolve o dono e as empresas (padrão primeiro), sem colunas de segredo", async () => {
    await empresa("cfg-2", "tenant", false, "11111111000191", new Date("2026-03-01T00:00:00Z"));
    await empresa("cfg-outro", "outro", true, "33333333000191", new Date("2026-01-01T00:00:00Z"));
    const repo = new M.DevolucaoRepo();
    expect((await repo.donosDasConfigs([CFC, "cfg-2"])).sort()).toEqual(["tenant"]);
    expect(await repo.donosDasConfigs(["cfg-outro"])).toEqual(["outro"]);
    const empresas = await repo.empresasDoUsuario("tenant");
    expect(empresas.map((e: any) => [e.id, e.isDefault])).toEqual([[CFC, true], ["cfg-2", false]]);
    expect(Object.keys(empresas[0]).sort()).toEqual(["ambiente", "cnpj", "id", "isDefault", "nomeFantasia", "razaoSocial", "uf"]);
  }, 60000);

  it("getStats: valorTotal de sempre (entrada + saída) e a parte de entrada, no FILTER da mesma consulta", async () => {
    const autorizada = async (id: string, tipoOperacao: string, total: number, numero: number) => {
      await rascunho(id, { status: "AUTHORIZED", tipoOperacao, numero, totaisJson: { totalNota: total } as object, dataEmissao: new Date("2026-09-10T15:00:00Z") });
    };
    await autorizada("v1", "SAIDA", 1299.44, 711);
    await autorizada("d1", "ENTRADA", 120, 715);
    const s = await new M.NfeRepository().getStats("tenant");
    expect(s).toMatchObject({ autorizadas: 2, valorTotal: 1419.44, valorEntradas: 120, autorizadasEntrada: 1 });

    const mes = await new M.NfeRepository().findAuthorizedByEmissionMonth("tenant", new Date("2026-09-01T03:00:00Z"), new Date("2026-10-01T03:00:00Z"));
    expect(mes.map((r: any) => [r.numero, r.tipoOperacao, r.finalidade])).toEqual([[711, "SAIDA", "NORMAL"], [715, "ENTRADA", "NORMAL"]]);
  }, 60000);
});
