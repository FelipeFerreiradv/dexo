import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { makeConfig, makeDraft } from "../../__helpers__/test-draft";
import { criarSchemaNfe, urlTestePostgres, type SchemaNfe } from "../../__harness__/pg-nfe-schema";

// BLOQ-2 da prontidão V2 — reserva BLOQUEADO de NF-e comum tem saída, PostgreSQL REAL.
//
// 613 ("Chave de Acesso difere da existente em BD") no envio ⇒ INCERTO ⇒ a consulta não acha
// chave referida legível ⇒ BLOQUEADO (conferência manual). A nota volta a REJECTED com o 613,
// mas "Emitir" responde 409 NUMERACAO_BLOQUEADA e a única saída era excluir o rascunho — que a
// tela só oferece nos quadros de devolução. No V1 a mesma nota seria reemitida com número novo.
//
// `NfeDraftUseCase.descartarNumeroBloqueado` (rota POST /fiscal/nfe/:id/numeracao/descartar-bloqueado)
// descarta SÓ o número, com confirmação: BLOQUEADO → ABANDONADO (+ requerInutilizacao em produção),
// evento NUMERACAO_DESCARTADA, nota de volta a DRAFT com placeholder; "Emitir" reserva X+1.
//
// Opt-in: NFE_TEST_DATABASE_URL (localhost, banco nfe_test).

const raw = urlTestePostgres();

const h = vi.hoisted(() => ({ code: 100, calls: [] as number[], inutilizacoes: [] as Array<{ ini: number; fim: number }>, configs: new Map<string, any>() }));

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
      const autorizada = h.code === 100;
      return { transporte: null, httpStatus: 200, loteCStat: 104, loteXMotivo: "Lote processado", protCStat: h.code,
        protXMotivo: autorizada ? "Autorizado o uso da NF-e" : h.code === 613 ? "Rejeicao: Chave de Acesso difere da existente em BD" : "Rejeicao: Falha no Schema XML",
        nProt: autorizada ? "135260000000001" : null, dhRecbto: new Date(), nRec: null, chNFe: p.chaveAcesso, protNFeXml: null, xmlAutorizado: autorizada ? "<nfeProc/>" : null };
    }
    async consultarDetalhado(chave: string) {
      return { transporte: null, httpStatus: 200, cStat: 217, xMotivo: "Rejeicao: NF-e nao consta na base de dados da SEFAZ", nProt: null, dhRecbto: new Date(), digVal: null, chNFe: chave, protNFeXml: null };
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
    createNfeProvider: () => { throw new Error("createNfeProvider não deveria ser chamado"); },
  };
});
vi.mock("../../../../app/repositories/company-fiscal.repository", () => ({
  CompanyFiscalRepository: class {
    findByIdForUser = async (id: string, userId: string) => { const c = h.configs.get(id); return c && c.userId === userId ? c : null; };
    findByUserId = async (userId: string) => [...h.configs.values()].find((c) => c.userId === userId && c.isDefault) ?? null;
  },
}));
vi.mock("../../../../app/usecases/company-fiscal-resp-tec.usecase", () => ({ resolverRespTecEmpresa: async () => ({ origem: "OMITIR" }) }));

describe.skipIf(!raw)("BLOQ-2: descartar o nº BLOQUEADO sem excluir a NF-e — PostgreSQL real", () => {
  let db: SchemaNfe;
  let mods: {
    Orchestrator: typeof import("../../../../app/usecases/nfe-emissao-v2.orchestrator").NfeEmissaoV2Orchestrator;
    NfeRepository: typeof import("../../../../app/repositories/nfe.repository").NfeRepository;
    NfeDraftUseCase: typeof import("../../../../app/usecases/nfe-draft.usecase").NfeDraftUseCase;
    NfeInutilizacaoUseCase: typeof import("../../../../app/usecases/nfe-inutilizacao.usecase").NfeInutilizacaoUseCase;
    prisma: import("@prisma/client").PrismaClient;
    montarChave: typeof import("../../../../app/fiscal/sefaz/chave-acesso").montarChave;
    chaveToString: typeof import("../../../../app/fiscal/sefaz/chave-acesso").chaveToString;
  };

  beforeAll(async () => {
    db = await criarSchemaNfe(raw!, "nfe_g1bloq");
    process.env.DATABASE_URL = db.url;
    const chave = await import("../../../../app/fiscal/sefaz/chave-acesso");
    mods = {
      Orchestrator: (await import("../../../../app/usecases/nfe-emissao-v2.orchestrator")).NfeEmissaoV2Orchestrator,
      NfeRepository: (await import("../../../../app/repositories/nfe.repository")).NfeRepository,
      NfeDraftUseCase: (await import("../../../../app/usecases/nfe-draft.usecase")).NfeDraftUseCase,
      NfeInutilizacaoUseCase: (await import("../../../../app/usecases/nfe-inutilizacao.usecase")).NfeInutilizacaoUseCase,
      prisma: (await import("../../../../app/lib/prisma")).default,
      montarChave: chave.montarChave,
      chaveToString: chave.chaveToString,
    };
  }, 180000);

  afterAll(async () => {
    if (mods?.prisma) await mods.prisma.$disconnect();
    if (db) await db.destruir();
  });

  afterEach(() => { vi.unstubAllEnvs(); });

  function cenario(ambiente: "HOMOLOGACAO" | "PRODUCAO" = "PRODUCAO") {
    h.code = 100; h.calls = []; h.inutilizacoes = [];
    const userId = `tenant-${randomUUID().slice(0, 8)}`;
    const cfc = `cfg-${randomUUID().slice(0, 8)}`;
    const config = makeConfig({ id: cfc, userId, providerName: "SEFAZ_DIRECT", ambiente, isDefault: true, serieNfe: 1 } as never);
    h.configs.set(cfc, config);
    vi.stubEnv("NFE_NUMERACAO_V2_ENABLED", "true");
    vi.stubEnv("NFE_NUMERACAO_V2_CONFIG_IDS", cfc);
    vi.stubEnv("NFE_NUMERACAO_V2_MODELOS", "55");
    vi.stubEnv("NFE_NUMERACAO_V2_FOCUS_ENABLED", "false");
    vi.stubEnv("NFE_DEVOLUCAO_ENABLED", "false");
    vi.stubEnv("NFE_RESP_TEC_EMPRESA_ENABLED", "false");

    const base = makeDraft({ userId, companyFiscalConfigId: cfc });
    const storage = { saveXmlTentativa: async () => "/tmp/assinado.xml", readFile: async () => Buffer.from("<signed/>") };
    const repo = new mods.NfeRepository();
    const orq = new mods.Orchestrator({ validar: () => {}, snapshot: () => ({}), autorizado: async () => ({}) as never }, undefined, repo, storage as never);
    const draftUc = new mods.NfeDraftUseCase();
    const cnfFixo = String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
    const chaveDe = (numero: number) => mods.chaveToString(mods.montarChave({ uf: "SP", ano: 2026, mes: 9, cnpj: config.cnpj, modelo: "55", serie: 1, numero, tpEmis: 1, cNF: cnfFixo }));
    const criar = async (status = "DRAFT", numero = -1, extra: Record<string, unknown> = {}) => {
      const n = await db.admin.nfeEmitida.create({
        data: {
          userId, companyFiscalConfigId: cfc, ambiente, modelo: "55", serie: 1, numero, status,
          tipoOperacao: base.tipoOperacao, finalidade: base.finalidade, destinoOperacao: base.destinoOperacao,
          naturezaOperacao: base.naturezaOperacao, indPresenca: base.indPresenca, destinatarioJson: base.destinatarioJson as object,
          emittedByUserId: userId, ...extra,
          itens: { create: [{ numero: 1, codigo: "P1", descricao: "PECA TESTE", ncm: "87089990", cfop: "5102", origem: 0, unidade: "UN", quantidade: 1, valorUnitario: 100, valorTotal: 100 }] },
        },
      });
      return n.id;
    };
    const emitir = async (id: string) => orq.emitir(userId, (await repo.findNfeById(userId, id))!, config);
    const nota = async (id: string) => (await db.admin.nfeEmitida.findUnique({
      where: { id }, select: { status: true, numero: true, cStatRejeicao: true, motivoRejeicao: true, chaveAcesso: true },
    }))!;
    const reservas = (id: string) => db.admin.$queryRawUnsafe<Array<{ numero: number; estado: string; requerInutilizacao: boolean; motivo: string | null }>>(
      `SELECT "numero","estado","requerInutilizacao","motivo" FROM "NfeNumeroReserva" WHERE "nfeId"=$1 ORDER BY "createdAt","numero"`, id);
    const eventos = (id: string) => db.admin.$queryRawUnsafe<Array<{ evento: string; detalhes: Record<string, unknown> | null }>>(
      `SELECT "evento","detalhes" FROM "NfeAuditLog" WHERE "nfeId"=$1 ORDER BY "createdAt","id"`, id);
    /** 613 no envio, consulta sem chave referida ⇒ BLOQUEADO no nº 501 (nº 500 já autorizado). */
    const bloqueadaNo501 = async () => {
      await criar("AUTHORIZED", 500, { chaveAcesso: chaveDe(500), protocoloAutorizacao: "135250000000500" });
      const x = await criar();
      h.code = 613;
      await emitir(x);
      expect(await reservas(x)).toMatchObject([{ numero: 501, estado: "BLOQUEADO" }]);
      expect(await nota(x)).toMatchObject({ status: "REJECTED", numero: 501, cStatRejeicao: 613 });
      // Hoje: "Emitir" de novo esbarra no bloqueio manual.
      await expect(emitir(x)).rejects.toMatchObject({ code: "NUMERACAO_BLOQUEADA", httpStatus: 409 });
      h.calls = [];
      return x;
    };
    return { userId, cfc, config, draftUc, chaveDe, criar, emitir, nota, reservas, eventos, bloqueadaNo501 };
  }

  it("SEM confirmação ⇒ 409 NUMERACAO_CONFIRMAR_DESCARTE {numero, serie}; nada muda", async () => {
    const w = cenario();
    const x = await w.bloqueadaNo501();
    const antes = { nota: await w.nota(x), reservas: await w.reservas(x) };
    await expect(w.draftUc.descartarNumeroBloqueado(w.userId, x, false, "colab-1")).rejects.toMatchObject({
      code: "NUMERACAO_CONFIRMAR_DESCARTE", httpStatus: 409, detalhes: { numero: 501, serie: 1 },
    });
    expect({ nota: await w.nota(x), reservas: await w.reservas(x) }).toEqual(antes);
    expect((await w.eventos(x)).some((e) => e.evento === "NUMERACAO_DESCARTADA")).toBe(false);
  }, 60000);

  it("COM confirmação ⇒ 501 ABANDONADO (requerInutilizacao), nota DRAFT placeholder, auditoria; emitir o MESMO id pega 502", async () => {
    const w = cenario();
    const x = await w.bloqueadaNo501();
    const antes = await w.nota(x);

    expect(await w.draftUc.descartarNumeroBloqueado(w.userId, x, true, "colab-1")).toEqual({ numero: 501, serie: 1 });

    expect(await w.reservas(x)).toEqual([{ numero: 501, estado: "ABANDONADO", requerInutilizacao: true, motivo: "NUMERO_RETIDO_DESCARTADO" }]);
    const depois = await w.nota(x);
    expect(depois.status).toBe("DRAFT");
    expect(depois.numero).toBeLessThan(0);
    expect(depois.cStatRejeicao).toBe(613);
    expect(depois.motivoRejeicao).toBe(antes.motivoRejeicao);
    expect(depois.chaveAcesso).toBeNull();
    const descarte = (await w.eventos(x)).filter((e) => e.evento === "NUMERACAO_DESCARTADA");
    expect(descarte).toHaveLength(1);
    expect(descarte[0].detalhes).toMatchObject({ actorUserId: "colab-1", numero: 501, serie: 1, motivo: "NUMERO_RETIDO_DESCARTADO", confirmado: true });

    h.code = 100;
    expect(await w.emitir(x)).toMatchObject({ success: true, status: "AUTHORIZED", numero: 502 });
    expect(h.calls).toEqual([502]);
    expect((await w.reservas(x)).map(({ numero, estado }) => ({ numero, estado })))
      .toEqual([{ numero: 501, estado: "ABANDONADO" }, { numero: 502, estado: "AUTORIZADO" }]);

    // E o 501 descartado se inutiliza pela tela, sem confirmação nova (ABANDONADO não barra).
    const inut = await new mods.NfeInutilizacaoUseCase().inutilizar(w.userId, { serie: 1, numeroInicial: 501, numeroFinal: 501, justificativa: "Numero retido por duplicidade e descartado", companyFiscalConfigId: w.cfc });
    expect(inut.status).toBe("ACEITA");
    expect((await w.reservas(x))[0]).toMatchObject({ numero: 501, estado: "INUTILIZADO", requerInutilizacao: false });
  }, 60000);

  it("reserva viva que não está em BLOQUEADO ⇒ 409 NUMERACAO_NAO_BLOQUEADA; nota sem reserva idem", async () => {
    const w = cenario();
    await w.criar("AUTHORIZED", 500, { chaveAcesso: w.chaveDe(500), protocoloAutorizacao: "135250000000500" });
    const x = await w.criar();
    h.code = 225;
    await w.emitir(x);
    expect((await w.reservas(x))[0].estado).toBe("REJEITADO");
    await expect(w.draftUc.descartarNumeroBloqueado(w.userId, x, true)).rejects.toMatchObject({ code: "NUMERACAO_NAO_BLOQUEADA", httpStatus: 409 });
    expect((await w.reservas(x))[0].estado).toBe("REJEITADO");

    const semReserva = await w.criar();
    await expect(w.draftUc.descartarNumeroBloqueado(w.userId, semReserva, true)).rejects.toMatchObject({ code: "NUMERACAO_NAO_BLOQUEADA", httpStatus: 409 });
  }, 60000);

  it("nota inexistente ou de outro tenant ⇒ 404, e a reserva do dono segue BLOQUEADO", async () => {
    const w = cenario();
    const x = await w.bloqueadaNo501();
    await expect(w.draftUc.descartarNumeroBloqueado("outro-tenant", x, true)).rejects.toMatchObject({ httpStatus: 404 });
    await expect(w.draftUc.descartarNumeroBloqueado(w.userId, "nao-existe", true)).rejects.toMatchObject({ httpStatus: 404 });
    expect((await w.reservas(x))[0].estado).toBe("BLOQUEADO");
  }, 60000);
});
