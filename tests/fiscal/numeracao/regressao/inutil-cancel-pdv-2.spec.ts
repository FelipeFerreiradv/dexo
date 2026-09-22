import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { makeConfig, makeDraft } from "../../__helpers__/test-draft";

// REGRESSÃO (revisão V2, achado inutil-cancel-pdv-2): com a flag GLOBAL ligada o despacho
// segue o LEDGER, não só a config atual. Trocar de emitente (ou rollback da allowlist) não
// leva ao V1 uma nota com reserva V2 viva: a exclusão abandona a reserva (com confirmação em
// PRODUÇÃO) e a emissão responde 409 NUMERACAO_EMITENTE_FORA_V2 em vez de renumerar no V1.
//
// PostgreSQL REAL (mesmo harness de tests/fiscal/numeracao/orquestrador-v2-postgres.spec.ts):
// NfeRepository, NfeNumeracaoRepository/Service, NfeDraftUseCase.update/delete e
// NfeInutilizacaoUseCase reais; só o transporte SEFAZ e a leitura de CompanyFiscalConfig
// são simulados.
//
// Opt-in: NFE_TEST_DATABASE_URL=postgresql://postgres:<senha>@127.0.0.1:<porta>/nfe_test

const raw = process.env.NFE_TEST_DATABASE_URL;
const schema = `nfe_vicp2_${randomUUID().replace(/-/g, "")}`;

const h = vi.hoisted(() => ({
  code: 100,
  calls: [] as number[],
  inutilizacoes: [] as Array<{ ini: number; fim: number }>,
  configs: new Map<string, any>(),
}));

vi.mock("../../../../app/fiscal/providers/sefaz-direct.provider", async () => {
  const { montarChave, chaveToString } = await import("../../../../app/fiscal/sefaz/chave-acesso");
  class SefazDirectProvider {
    static montarNfeProc() { return "<nfeProc/>"; }
    prepararEmissao(p: { config: { cnpj: string }; draft: { serie: number }; numero: number; cNF: string; dhEmi: Date }) {
      const chaveAcesso = chaveToString(montarChave({ uf: "SP", ano: 2026, mes: 9, cnpj: p.config.cnpj, modelo: "55", serie: p.draft.serie, numero: p.numero, tpEmis: 1, cNF: p.cNF }));
      return { numero: p.numero, cNF: p.cNF, dhEmi: p.dhEmi, chaveAcesso, signedXml: "<signed/>", digestValue: "digest", modelo: "55", tpEmis: 1 };
    }
    async transmitirPreparada(p: { numero: number; chaveAcesso: string }) {
      h.calls.push(p.numero);
      return { transporte: null, httpStatus: 200, loteCStat: 104, loteXMotivo: "Lote processado", protCStat: h.code, protXMotivo: h.code === 100 ? "Autorizado o uso da NF-e" : "Rejeicao: campo invalido", nProt: h.code === 100 ? "135260000000001" : null, dhRecbto: new Date(), nRec: null, chNFe: p.chaveAcesso, protNFeXml: null, xmlAutorizado: h.code === 100 ? "<nfeProc/>" : null };
    }
    async consultarDetalhado(chave: string) {
      return { transporte: null, httpStatus: 200, cStat: 217, xMotivo: "consulta", nProt: null, dhRecbto: new Date(), digVal: "digest", chNFe: chave, protNFeXml: null };
    }
    async inutilizar(p: { numeroInicial: number; numeroFinal: number }) {
      h.inutilizacoes.push({ ini: p.numeroInicial, fim: p.numeroFinal });
      return { success: true, protocolo: "135260000000099", mensagem: "Inutilizacao de numero homologado" };
    }
  }
  return { SefazDirectProvider };
});
vi.mock("../../../../app/fiscal/providers/provider-factory", async () => {
  const { SefazDirectProvider } = await import("../../../../app/fiscal/providers/sefaz-direct.provider");
  return {
    createNfeProviderFromConfig: async () => new SefazDirectProvider({} as never),
    // Nunca deve ser chamado neste teste (Focus V1 = HTTP real).
    createNfeProvider: () => { throw new Error("createNfeProvider não deveria ser chamado"); },
  };
});
// CompanyFiscalConfig não existe no schema descartável; a leitura é por um mapa.
vi.mock("../../../../app/repositories/company-fiscal.repository", () => ({
  CompanyFiscalRepository: class {
    findByIdForUser = async (id: string, userId: string) => { const c = h.configs.get(id); return c && c.userId === userId ? c : null; };
    findByUserId = async (userId: string) => [...h.configs.values()].find((c) => c.userId === userId && c.isDefault) ?? null;
  },
}));
vi.mock("../../../../app/usecases/company-fiscal-resp-tec.usecase", () => ({ resolverRespTecEmpresa: async () => ({ origem: "OMITIR" }) }));

const describePg = describe.skipIf(!raw);
describePg("regressão inutil-cancel-pdv-2: despacho pelo ledger quando a nota sai da V2 pela config atual — PostgreSQL real", () => {
  let admin: PrismaClient;
  let mods: {
    Orchestrator: typeof import("../../../../app/usecases/nfe-emissao-v2.orchestrator").NfeEmissaoV2Orchestrator;
    NfeRepository: typeof import("../../../../app/repositories/nfe.repository").NfeRepository;
    NfeDraftUseCase: typeof import("../../../../app/usecases/nfe-draft.usecase").NfeDraftUseCase;
    NfeInutilizacaoUseCase: typeof import("../../../../app/usecases/nfe-inutilizacao.usecase").NfeInutilizacaoUseCase;
    NfeEmissionUseCase: typeof import("../../../../app/usecases/nfe-emission.usecase").NfeEmissionUseCase;
    prisma: PrismaClient;
    montarChave: typeof import("../../../../app/fiscal/sefaz/chave-acesso").montarChave;
    chaveToString: typeof import("../../../../app/fiscal/sefaz/chave-acesso").chaveToString;
  };

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
    const ddl = readFileSync("prisma/ddl/2026-09-18-nfe-numeracao-v2.sql", "utf8").replace(/--[^\r\n]*/g, "");
    for (const sql of ddl.split(";").map((s) => s.trim()).filter((s) => s && !["BEGIN", "COMMIT"].includes(s))) await admin.$executeRawUnsafe(sql);

    const chave = await import("../../../../app/fiscal/sefaz/chave-acesso");
    mods = {
      Orchestrator: (await import("../../../../app/usecases/nfe-emissao-v2.orchestrator")).NfeEmissaoV2Orchestrator,
      NfeRepository: (await import("../../../../app/repositories/nfe.repository")).NfeRepository,
      NfeDraftUseCase: (await import("../../../../app/usecases/nfe-draft.usecase")).NfeDraftUseCase,
      NfeInutilizacaoUseCase: (await import("../../../../app/usecases/nfe-inutilizacao.usecase")).NfeInutilizacaoUseCase,
      NfeEmissionUseCase: (await import("../../../../app/usecases/nfe-emission.usecase")).NfeEmissionUseCase,
      prisma: (await import("../../../../app/lib/prisma")).default,
      montarChave: chave.montarChave,
      chaveToString: chave.chaveToString,
    };
  }, 180000);

  afterAll(async () => {
    if (mods?.prisma) await mods.prisma.$disconnect();
    if (admin) {
      await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.$disconnect();
    }
  });

  afterEach(() => { vi.unstubAllEnvs(); });

  /**
   * Config A (allowlist, SEFAZ direto) e config B do MESMO tenant fora da allowlist
   * (Focus, como uma segunda empresa do Kiko). Flags exatamente as do canário.
   */
  function cenario(ambiente: "HOMOLOGACAO" | "PRODUCAO" = "HOMOLOGACAO") {
    h.code = 100; h.calls = []; h.inutilizacoes = [];
    const userId = `tenant-${randomUUID().slice(0, 8)}`;
    const cfcA = `cfgA-${randomUUID().slice(0, 8)}`;
    const cfcB = `cfgB-${randomUUID().slice(0, 8)}`;
    const A = makeConfig({ id: cfcA, userId, providerName: "SEFAZ_DIRECT", ambiente, isDefault: true, serieNfe: 1 } as never);
    const B = makeConfig({ id: cfcB, userId, cnpj: "33444555000181", providerName: "FOCUS_NFE", providerToken: "tok-b", ambiente, isDefault: false, serieNfe: 1 } as never);
    h.configs.set(cfcA, A);
    h.configs.set(cfcB, B);
    const allowlist = (ids: string) => {
      vi.stubEnv("NFE_NUMERACAO_V2_ENABLED", "true");
      vi.stubEnv("NFE_NUMERACAO_V2_CONFIG_IDS", ids);
      vi.stubEnv("NFE_NUMERACAO_V2_MODELOS", "55");
      vi.stubEnv("NFE_NUMERACAO_V2_FOCUS_ENABLED", "true");
      vi.stubEnv("NFE_DEVOLUCAO_ENABLED", "false");
      vi.stubEnv("NFE_RESP_TEC_EMPRESA_ENABLED", "false");
    };
    allowlist(cfcA);

    const base = makeDraft({ userId, companyFiscalConfigId: cfcA });
    const storage = { saveXmlTentativa: async () => "/tmp/assinado.xml", readFile: async () => Buffer.from("<signed/>") };
    const repo = new mods.NfeRepository();
    const orq = new mods.Orchestrator({ validar: () => {}, snapshot: () => ({}), autorizado: async () => ({}) as never }, undefined, repo, storage as never);
    const draftUc = new mods.NfeDraftUseCase();
    const inutUc = new mods.NfeInutilizacaoUseCase();
    const cnfFixo = String(Math.floor(Math.random() * 1e8)).padStart(8, "0"); // chaveAcesso é UNIQUE no schema inteiro
    const chaveDe = (numero: number) => mods.chaveToString(mods.montarChave({ uf: "SP", ano: 2026, mes: 9, cnpj: A.cnpj, modelo: "55", serie: 1, numero, tpEmis: 1, cNF: cnfFixo }));
    const criar = async (status = "DRAFT", numero = -1, extra: Record<string, unknown> = {}) => {
      const n = await admin.nfeEmitida.create({
        data: {
          userId, companyFiscalConfigId: cfcA, ambiente, modelo: "55", serie: 1, numero, status,
          tipoOperacao: base.tipoOperacao, finalidade: base.finalidade, destinoOperacao: base.destinoOperacao,
          naturezaOperacao: base.naturezaOperacao, indPresenca: base.indPresenca, destinatarioJson: base.destinatarioJson as object,
          emittedByUserId: userId, ...extra,
          itens: { create: [{ numero: 1, codigo: "P1", descricao: "PECA TESTE", ncm: "87089990", cfop: "5102", origem: 0, unidade: "UN", quantidade: 1, valorUnitario: 100, valorTotal: 100 }] },
        },
      });
      return n.id;
    };
    const emitirV2 = async (id: string) => orq.emitir(userId, (await repo.findNfeById(userId, id))!, A);
    const reservasA = () => admin.$queryRawUnsafe<Array<{ numero: number; estado: string; nfeId: string | null; requerInutilizacao: boolean }>>(
      `SELECT "numero","estado","nfeId","requerInutilizacao" FROM "NfeNumeroReserva" WHERE "companyFiscalConfigId"=$1 ORDER BY "numero"`, cfcA);
    const inutilizar7 = async () => {
      try {
        const r = await inutUc.inutilizar(userId, { serie: 1, numeroInicial: 7, numeroFinal: 7, justificativa: "Numero nao utilizado por erro de sistema", companyFiscalConfigId: cfcA });
        return { ok: true as const, status: r.status };
      } catch (e) {
        const err = e as { code?: string; message?: string };
        return { ok: false as const, code: err.code ?? null, mensagem: err.message ?? String(e) };
      }
    };
    /** Nota X rejeitada com o nº 7 na config A (nº 6 já autorizado em A). */
    const notaRejeitadaNo7 = async () => {
      await criar("AUTHORIZED", 6, { chaveAcesso: chaveDe(6), protocoloAutorizacao: "135250000000006" });
      const x = await criar();
      h.code = 225;
      expect(await emitirV2(x)).toMatchObject({ success: false, status: "REJECTED", numero: 7 });
      expect(await reservasA()).toEqual([{ numero: 7, estado: "REJEITADO", nfeId: x, requerInutilizacao: false }]);
      return x;
    };
    return { userId, cfcA, cfcB, A, B, allowlist, draftUc, inutUc, criar, emitirV2, reservasA, inutilizar7, notaRejeitadaNo7 };
  }

  it("CONTROLE: sem troca de emitente, excluir X abandona o nº 7 e a inutilização 7..7 passa", async () => {
    const w = cenario();
    const x = await w.notaRejeitadaNo7();
    await w.draftUc.delete(w.userId, x);
    expect(await w.reservasA()).toEqual([{ numero: 7, estado: "ABANDONADO", nfeId: x, requerInutilizacao: false }]);
    expect(await w.inutilizar7()).toEqual({ ok: true, status: "ACEITA" });
    expect(h.inutilizacoes).toEqual([{ ini: 7, fim: 7 }]);
    expect((await w.reservasA())[0].estado).toBe("INUTILIZADO");
  }, 60000);

  it("troca de emitente A→B (fora da allowlist) + exclusão: nº 7 de A é ABANDONADO e a inutilização 7..7 passa", async () => {
    const w = cenario();
    const x = await w.notaRejeitadaNo7();

    // Wizard troca o emitente (handleCompanyChange → PUT /draft/:id). update só valida a posse.
    await w.draftUc.update(w.userId, x, { companyFiscalConfigId: w.cfcB, serie: 1 } as never);
    // Exclusão: configNumeracao olha a config ATUAL (B, fora da allowlist) ⇒ deleteDraft do V1.
    await w.draftUc.delete(w.userId, x);

    const notaExiste = (await admin.nfeEmitida.findUnique({ where: { id: x } })) !== null;
    const reservas = await w.reservasA();
    const inut = await w.inutilizar7();
    // eslint-disable-next-line no-console
    console.log("[troca+exclusão] nota existe:", notaExiste, "| reservas A:", JSON.stringify(reservas), "| inutilizar 7..7:", JSON.stringify(inut));

    // Esperado (desenho: exclusão abandona a reserva; nenhum número fica preso):
    expect({ notaExiste, reservas: reservas.map(({ numero, estado }) => ({ numero, estado })), inutilizacao: inut.ok })
      .toEqual({ notaExiste: false, reservas: [{ numero: 7, estado: "ABANDONADO" }], inutilizacao: true });
  }, 60000);

  it("PRODUÇÃO: troca de emitente + exclusão sem confirmação pede NUMERACAO_CONFIRMAR_DESCARTE (ou marca requerInutilizacao)", async () => {
    const w = cenario("PRODUCAO");
    const x = await w.notaRejeitadaNo7();
    await w.draftUc.update(w.userId, x, { companyFiscalConfigId: w.cfcB, serie: 1 } as never);

    let erro: string | null = null;
    try { await w.draftUc.delete(w.userId, x); } catch (e) { erro = (e as { code?: string }).code ?? String(e); }
    const reservas = await w.reservasA();
    // eslint-disable-next-line no-console
    console.log("[PRODUÇÃO] erro da exclusão:", erro, "| reservas A:", JSON.stringify(reservas));

    // Esperado: ou 409 NUMERACAO_CONFIRMAR_DESCARTE (nota preservada), ou ABANDONADO com requerInutilizacao.
    const ok = erro === "NUMERACAO_CONFIRMAR_DESCARTE" || (reservas[0]?.estado === "ABANDONADO" && reservas[0]?.requerInutilizacao === true);
    expect({ erro, reservas: reservas.map(({ numero, estado, requerInutilizacao }) => ({ numero, estado, requerInutilizacao })), ok })
      .toMatchObject({ ok: true });
  }, 60000);

  it("rollback da allowlist: exclusão com A fora da lista abandona o nº 7; ao religar, a inutilização 7..7 passa", async () => {
    const w = cenario();
    const x = await w.notaRejeitadaNo7();

    w.allowlist("");                     // rollback do canário (V2 desligada para A)
    await w.draftUc.delete(w.userId, x); // V1: apaga a nota
    w.allowlist(w.cfcA);                 // canário religado

    const notaExiste = (await admin.nfeEmitida.findUnique({ where: { id: x } })) !== null;
    const reservas = await w.reservasA();
    const inut = await w.inutilizar7();
    // eslint-disable-next-line no-console
    console.log("[rollback] nota existe:", notaExiste, "| reservas A:", JSON.stringify(reservas), "| inutilizar 7..7:", JSON.stringify(inut));
    expect({ notaExiste, inutilizacao: inut.ok }).toEqual({ notaExiste: false, inutilizacao: true });
  }, 60000);

  it("emissão: com reserva V2 viva, a troca para B responde 409 NUMERACAO_EMITENTE_FORA_V2 (não cai no V1)", async () => {
    const w = cenario();
    const x = await w.notaRejeitadaNo7();
    await w.draftUc.update(w.userId, x, { companyFiscalConfigId: w.cfcB, serie: 1 } as never);

    const emission = new mods.NfeEmissionUseCase();
    const ctx = await (emission as unknown as { contextoV2(u: string, id: string): Promise<unknown> }).contextoV2(w.userId, x).catch((e: unknown) => e);
    const viva = await admin.$queryRawUnsafe<Array<{ estado: string }>>(`SELECT "estado" FROM "NfeNumeroReserva" WHERE "nfeId"=$1 AND "estado" NOT IN ('ABANDONADO','INUTILIZADO','CONSUMIDO_EXTERNO','DENEGADO')`, x);
    expect(viva).toEqual([{ estado: "REJEITADO" }]);
    // "No fallback to V1 is allowed after any V2 mutation": erro claro em vez de V1 silencioso.
    expect(ctx).toMatchObject({ name: "NumeracaoError", code: "NUMERACAO_EMITENTE_FORA_V2", httpStatus: 409, detalhes: { numero: 7, serie: 1, estado: "REJEITADO", companyFiscalConfigId: w.cfcA } });

    // Pelo caminho da rota (emit): nada é transmitido, nada muda no ledger nem na nota.
    const emitido = await emission.emit(w.userId, x).catch((e: unknown) => e);
    expect(emitido).toMatchObject({ code: "NUMERACAO_EMITENTE_FORA_V2", httpStatus: 409 });
    expect(h.calls).toEqual([7]);
    expect(await w.reservasA()).toEqual([{ numero: 7, estado: "REJEITADO", nfeId: x, requerInutilizacao: false }]);
    // (o PUT do rascunho já havia rebaixado REJECTED → DRAFT; o 409 não mexe na nota)
    expect((await admin.nfeEmitida.findUnique({ where: { id: x }, select: { status: true } }))!.status).toBe("DRAFT");
  }, 60000);

  it("emissão: rollback da allowlist com reserva viva também responde 409; ao religar, reemite reaproveitando o nº 7", async () => {
    const w = cenario();
    const x = await w.notaRejeitadaNo7();
    w.allowlist("");
    const emission = new mods.NfeEmissionUseCase();
    await expect(emission.emit(w.userId, x)).rejects.toMatchObject({ code: "NUMERACAO_EMITENTE_FORA_V2", httpStatus: 409 });
    w.allowlist(w.cfcA);
    h.code = 100;
    expect(await w.emitirV2(x)).toMatchObject({ success: true, status: "AUTHORIZED", numero: 7 });
    expect(h.calls).toEqual([7, 7]);
  }, 60000);

  it("I8: flag GLOBAL desligada — exclusão e despacho seguem o V1 sem consultar o ledger", async () => {
    const w = cenario();
    const x = await w.notaRejeitadaNo7();
    vi.stubEnv("NFE_NUMERACAO_V2_ENABLED", "false");
    const emission = new mods.NfeEmissionUseCase();
    expect(await (emission as unknown as { contextoV2(u: string, id: string): Promise<unknown> }).contextoV2(w.userId, x)).toBeNull();
    await w.draftUc.delete(w.userId, x);
    expect(await admin.nfeEmitida.findUnique({ where: { id: x } })).toBeNull();
    // V1 puro: a reserva fica como estava (comportamento anterior à V2).
    expect(await w.reservasA()).toEqual([{ numero: 7, estado: "REJEITADO", nfeId: x, requerInutilizacao: false }]);
  }, 60000);
});
