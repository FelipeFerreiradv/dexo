import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { makeConfig, makeDraft } from "../__helpers__/test-draft";
import { criarSchemaNfe, urlTestePostgres, type SchemaNfe } from "../__harness__/pg-nfe-schema";

// Numeração V2 (SEFAZ direto) de ponta a ponta contra PostgreSQL REAL: repositórios de
// verdade (claim, reserva, tentativa, transições de status e leitura da nota pelo
// NfeRepository), só o transporte SEFAZ é simulado. Os specs com fakes não pegaram que o
// orquestrador relia a nota com findDraftById (DRAFT/REJECTED) depois de gravá-la
// AUTHORIZED/SENDING.
//
// Opt-in: NFE_TEST_DATABASE_URL=postgresql://postgres:<senha>@127.0.0.1:<porta>/nfe_test
// (só localhost e banco nfe_test; cada execução usa um schema descartável).

const raw = urlTestePostgres();

const h = vi.hoisted(() => ({ code: 100, consulta: 217, calls: [] as number[], configs: new Map<string, unknown>(), protNFeXml: null as string | null }));

vi.mock("../../../app/fiscal/providers/sefaz-direct.provider", async () => {
  const { montarChave, chaveToString } = await import("../../../app/fiscal/sefaz/chave-acesso");
  class SefazDirectProvider {
    static montarNfeProc() { return "<nfeProc/>"; }
    prepararEmissao(p: { config: { cnpj: string }; draft: { serie: number }; numero: number; cNF: string; dhEmi: Date }) {
      const chaveAcesso = chaveToString(montarChave({ uf: "SP", ano: 2026, mes: 9, cnpj: p.config.cnpj, modelo: "55", serie: p.draft.serie, numero: p.numero, tpEmis: 1, cNF: p.cNF }));
      return { numero: p.numero, cNF: p.cNF, dhEmi: p.dhEmi, chaveAcesso, signedXml: "<signed/>", digestValue: "digest", modelo: "55", tpEmis: 1 };
    }
    async transmitirPreparada(p: { numero: number; chaveAcesso: string }) {
      h.calls.push(p.numero);
      if (h.code === 0) return { transporte: "TIMEOUT", httpStatus: null, loteCStat: null, loteXMotivo: null, protCStat: null, protXMotivo: null, nProt: null, dhRecbto: null, nRec: null, chNFe: null, protNFeXml: null, xmlAutorizado: null };
      return { transporte: null, httpStatus: 200, loteCStat: 104, loteXMotivo: "Lote processado", protCStat: h.code, protXMotivo: h.code === 100 ? "Autorizado o uso da NF-e" : "Rejeicao: campo invalido", nProt: h.code === 100 ? "135260000000001" : null, dhRecbto: new Date(), nRec: null, chNFe: p.chaveAcesso, protNFeXml: null, xmlAutorizado: h.code === 100 ? "<nfeProc/>" : null };
    }
    async consultarDetalhado(chave: string) {
      return { transporte: null, httpStatus: 200, cStat: h.consulta, xMotivo: "consulta", nProt: h.consulta === 100 ? "135260000000002" : null, dhRecbto: new Date(), digVal: "digest", chNFe: chave, protNFeXml: h.protNFeXml };
    }
  }
  return { SefazDirectProvider };
});
vi.mock("../../../app/fiscal/providers/provider-factory", async () => {
  const { SefazDirectProvider } = await import("../../../app/fiscal/providers/sefaz-direct.provider");
  return { createNfeProviderFromConfig: async () => new SefazDirectProvider({} as never) };
});
// A consulta relê o emitente da tentativa; o teste não cria CompanyFiscalConfig no banco.
vi.mock("../../../app/repositories/company-fiscal.repository", () => ({ CompanyFiscalRepository: class { findByIdForUser = async (id: string) => h.configs.get(id) ?? null; } }));
vi.mock("../../../app/usecases/company-fiscal-resp-tec.usecase", () => ({ resolverRespTecEmpresa: async () => ({ origem: "OMITIR" }) }));

describe.skipIf(!raw)("PostgreSQL isolado: orquestrador V2 (SEFAZ direto) de ponta a ponta", () => {
  let db: SchemaNfe;
  let mods: {
    Orchestrator: typeof import("../../../app/usecases/nfe-emissao-v2.orchestrator").NfeEmissaoV2Orchestrator;
    NfeRepository: typeof import("../../../app/repositories/nfe.repository").NfeRepository;
    prisma: import("@prisma/client").PrismaClient;
    montarChave: typeof import("../../../app/fiscal/sefaz/chave-acesso").montarChave;
    chaveToString: typeof import("../../../app/fiscal/sefaz/chave-acesso").chaveToString;
  };

  beforeAll(async () => {
    db = await criarSchemaNfe(raw!);
    // O singleton app/lib/prisma lê DATABASE_URL no import: aponta para o schema descartável ANTES.
    process.env.DATABASE_URL = db.url;
    const chave = await import("../../../app/fiscal/sefaz/chave-acesso");
    mods = {
      Orchestrator: (await import("../../../app/usecases/nfe-emissao-v2.orchestrator")).NfeEmissaoV2Orchestrator,
      NfeRepository: (await import("../../../app/repositories/nfe.repository")).NfeRepository,
      prisma: (await import("../../../app/lib/prisma")).default,
      montarChave: chave.montarChave,
      chaveToString: chave.chaveToString,
    };
  }, 120000);

  afterAll(async () => {
    if (mods?.prisma) await mods.prisma.$disconnect();
    if (db) await db.destruir();
  });

  beforeEach(() => { h.code = 100; h.consulta = 217; h.calls = []; h.protNFeXml = null; vi.stubEnv("NFE_DEVOLUCAO_ENABLED", "false"); });

  function cenario(opts: { falharHook?: number; falharLeitura?: number } = {}) {
    const cfc = `cfg-${randomUUID().slice(0, 8)}`;
    const config = makeConfig({ id: cfc, userId: "tenant", providerName: "SEFAZ_DIRECT", isDefault: true });
    h.configs.set(cfc, config);
    const base = makeDraft({ userId: "tenant", companyFiscalConfigId: cfc });
    let falhasHook = opts.falharHook ?? 0;
    let falhasLeitura = opts.falharLeitura ?? 0;
    // Como handleAuthorized: a conclusão da pós-autorização é o evento AUTORIZADA.
    const autorizado = vi.fn(async (d: { id: string }) => {
      if (falhasHook-- > 0) throw new Error("EIO: storage indisponível");
      await db.admin.nfeAuditLog.create({ data: { nfeId: d.id, userId: "tenant", evento: "AUTORIZADA", detalhes: {} } });
      return {} as never;
    });
    const storage = {
      saveXmlTentativa: async () => "/tmp/assinado.xml",
      readFile: async () => { if (falhasLeitura-- > 0) throw new Error("EIO: i/o error, read"); return Buffer.from("<signed/>"); },
    };
    const repo = new mods.NfeRepository();
    const uc = new mods.Orchestrator({ validar: () => {}, snapshot: () => ({}), autorizado }, undefined, repo, storage as never);
    const criar = async (status = "DRAFT", numero = -1, extra: Record<string, unknown> = {}) => {
      const n = await db.admin.nfeEmitida.create({
        data: {
          userId: "tenant", companyFiscalConfigId: cfc, ambiente: "HOMOLOGACAO", modelo: "55", serie: 1, numero, status,
          tipoOperacao: base.tipoOperacao, finalidade: base.finalidade, destinoOperacao: base.destinoOperacao,
          naturezaOperacao: base.naturezaOperacao, indPresenca: base.indPresenca, destinatarioJson: base.destinatarioJson as object,
          emittedByUserId: "tenant", ...extra,
          itens: { create: [{ numero: 1, codigo: "P1", descricao: "PECA TESTE", ncm: "87089990", cfop: "5102", origem: 0, unidade: "UN", quantidade: 1, valorUnitario: 100, valorTotal: 100 }] },
        },
      });
      return n.id;
    };
    const chaveDe = (numero: number) => mods.chaveToString(mods.montarChave({ uf: "SP", ano: 2026, mes: 9, cnpj: config.cnpj, modelo: "55", serie: 1, numero, tpEmis: 1, cNF: "40718263" }));
    // Sempre relê a nota do banco, como faz o despacho real (contextoV2 → findNfeById).
    const emitir = async (id: string) => uc.emitir("tenant", (await repo.findNfeById("tenant", id))!, config);
    const consultar = async (id: string) => uc.consultar("tenant", (await repo.findNfeById("tenant", id))!, config);
    const status = async (id: string) => (await db.admin.nfeEmitida.findUnique({ where: { id }, select: { status: true, numero: true } }))!;
    const envelhecerTentativas = (id: string) => db.admin.$executeRawUnsafe(`UPDATE "NfeNumeroTentativa" SET "transmitidaEm"=NOW()-interval '1 hour' WHERE "nfeId"=$1`, id);
    return { cfc, config, uc, repo, autorizado, criar, chaveDe, emitir, consultar, status, envelhecerTentativas };
  }

  it("★ 100 autorizada → 101 rejeitada → edição (volta a DRAFT) → retry 101 autorizada → próxima 102", async () => {
    const w = cenario();
    await w.criar("AUTHORIZED", 100, { chaveAcesso: w.chaveDe(100), protocoloAutorizacao: "135250000000100" });

    const x = await w.criar();
    h.code = 225;
    expect(await w.emitir(x)).toMatchObject({ success: false, status: "REJECTED", numero: 101 });

    // bug R1 do V1: salvar o wizard rebaixa REJECTED → DRAFT. A V2 lê a reserva pela nota, não pelo status.
    await db.admin.nfeEmitida.update({ where: { id: x }, data: { status: "DRAFT", naturezaOperacao: "VENDA CORRIGIDA" } });
    h.code = 100;
    expect(await w.emitir(x)).toMatchObject({ success: true, status: "AUTHORIZED", numero: 101 });
    expect(await w.status(x)).toEqual({ status: "AUTHORIZED", numero: 101 });

    const y = await w.criar();
    expect(await w.emitir(y)).toMatchObject({ success: true, status: "AUTHORIZED", numero: 102 });

    expect(h.calls).toEqual([101, 101, 102]);
    expect(w.autorizado).toHaveBeenCalledTimes(2);
    const seq = await db.admin.$queryRawUnsafe<Array<{ proximoNumero: number }>>(`SELECT "proximoNumero" FROM "NfeSequence" WHERE "companyFiscalConfigId"=$1`, w.cfc);
    expect(seq).toEqual([{ proximoNumero: 103 }]);
    const reservas = await db.admin.$queryRawUnsafe<Array<{ numero: number; estado: string }>>(`SELECT "numero","estado" FROM "NfeNumeroReserva" WHERE "companyFiscalConfigId"=$1 ORDER BY "numero"`, w.cfc);
    expect(reservas).toEqual([{ numero: 101, estado: "AUTORIZADO" }, { numero: 102, estado: "AUTORIZADO" }]);
  }, 60000);

  it("replay de nota já autorizada responde a autorização sem transmitir de novo", async () => {
    const w = cenario();
    const x = await w.criar();
    await w.emitir(x);
    expect(await w.emitir(x)).toMatchObject({ success: true, status: "AUTHORIZED", numero: 1 });
    expect(h.calls).toEqual([1]);
    expect(w.autorizado).toHaveBeenCalledTimes(1);
  }, 60000);

  it("duplo clique concorrente transmite uma única vez e nenhuma resposta é erro", async () => {
    const w = cenario();
    const x = await w.criar();
    const nota = (await w.repo.findNfeById("tenant", x))!;
    const rs = await Promise.allSettled([w.uc.emitir("tenant", nota, w.config), w.uc.emitir("tenant", nota, w.config)]);
    expect(rs.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(h.calls).toEqual([1]);
    expect(await w.status(x)).toEqual({ status: "AUTHORIZED", numero: 1 });
  }, 60000);

  it("timeout: nota SENDING responde 'em andamento'; consulta madura autoriza o MESMO número sem reenviar", async () => {
    const w = cenario();
    const x = await w.criar();
    h.code = 0;
    expect(await w.emitir(x)).toMatchObject({ success: false, status: "SENDING", emAndamento: true, numeracao: { estado: "INCERTO", numero: 1 } });
    // novo clique não reenvia (lease/incerto) e não quebra
    expect(await w.emitir(x)).toMatchObject({ status: "SENDING", emAndamento: true });
    expect(h.calls).toEqual([1]);

    await w.envelhecerTentativas(x);
    h.consulta = 100;
    expect(await w.consultar(x)).toMatchObject({ success: true, status: "AUTHORIZED", numero: 1 });
    expect(h.calls).toEqual([1]);
    expect(w.autorizado).toHaveBeenCalledTimes(1);
  }, 60000);

  it("falha ao ler o XML assinado DEPOIS de a consulta autorizar não vira erro: a pós-autorização roda sem nfeProc", async () => {
    const w = cenario({ falharLeitura: 1 });
    const x = await w.criar();
    h.code = 0;
    await w.emitir(x);
    await w.envelhecerTentativas(x);
    h.consulta = 100;
    h.protNFeXml = "<protNFe/>";
    expect(await w.consultar(x)).toMatchObject({ success: true, status: "AUTHORIZED" });
    expect(w.autorizado).toHaveBeenCalledTimes(1);
    expect((w.autorizado.mock.calls[0] as unknown[])[3]).toBeNull();
  }, 60000);

  it("falha transitória na pós-autorização: responde autorizada com pendência, marca a auditoria e o replay conclui uma única vez", async () => {
    const w = cenario({ falharHook: 1 });
    const x = await w.criar();
    const r = await w.emitir(x);
    expect(r).toMatchObject({ success: true, status: "AUTHORIZED" });
    expect(r.mensagem).toMatch(/pendentes/);
    const pend = await db.admin.nfeAuditLog.count({ where: { nfeId: x, evento: "POS_AUTORIZACAO_PENDENTE" } });
    expect(pend).toBe(1);
    // Replay refaz a pós-autorização (que agora funciona) e não transmite de novo.
    expect(await w.emitir(x)).toMatchObject({ success: true, status: "AUTHORIZED" });
    expect(await w.emitir(x)).toMatchObject({ success: true, status: "AUTHORIZED" });
    expect(w.autorizado).toHaveBeenCalledTimes(2);
    expect(h.calls).toEqual([1]);
  }, 60000);

  it("nota travada em VALIDATING sem reserva e nunca numerada é retomada depois do lease; antes dele segue 'em andamento'", async () => {
    const w = cenario();
    const x = await w.criar("VALIDATING", -1);
    expect(await w.emitir(x)).toMatchObject({ status: "VALIDATING", emAndamento: true });
    expect(h.calls).toEqual([]);
    await db.admin.$executeRawUnsafe(`UPDATE "NfeEmitida" SET "updatedAt"=NOW()-interval '2 days' WHERE "id"=$1`, x);
    expect(await w.emitir(x)).toMatchObject({ success: true, status: "AUTHORIZED", numero: 1 });
    expect(h.calls).toEqual([1]);
  }, 60000);

  it("adoção de número legado adota também o contador da era 1-CNPJ: abandonar não cria sequência-sombra em 1", async () => {
    const w = cenario();
    // Contador legado (linha com companyFiscalConfigId NULL) e rascunho numerado pelo V1 com erro antes do envio.
    await db.admin.$executeRawUnsafe(`INSERT INTO "NfeSequence" ("id","userId","companyFiscalConfigId","ambiente","modelo","serie","proximoNumero","updatedAt") VALUES ($1,'tenant',NULL,'HOMOLOGACAO','55',1,500,NOW())`, randomUUID());
    const legado = await w.criar("DRAFT", 499);
    const t0 = Date.now() - 600_000;
    await db.admin.nfeAuditLog.create({ data: { nfeId: legado, userId: "tenant", evento: "NUMERADA", detalhes: { numero: 499, serie: 1 }, createdAt: new Date(t0) } });
    await db.admin.nfeAuditLog.create({ data: { nfeId: legado, userId: "tenant", evento: "EDITADA_DRAFT", detalhes: { motivo: "Erro antes do envio: certificado" }, createdAt: new Date(t0 + 1000) } });

    h.code = 225;
    expect(await w.emitir(legado)).toMatchObject({ success: false, status: "REJECTED", numero: 499 });
    const reservas = await db.admin.$queryRawUnsafe<Array<{ numero: number; origem: string }>>(`SELECT "numero","origem" FROM "NfeNumeroReserva" WHERE "nfeId"=$1`, legado);
    expect(reservas).toEqual([{ numero: 499, origem: "LEGADO_V1" }]);

    await w.uc.numeros.abandonarPorExclusao("tenant", legado, true);
    const seqs = await db.admin.$queryRawUnsafe<Array<{ companyFiscalConfigId: string | null; proximoNumero: number }>>(`SELECT "companyFiscalConfigId","proximoNumero" FROM "NfeSequence" WHERE "userId"='tenant' AND "ambiente"='HOMOLOGACAO' AND "modelo"='55' AND "serie"=1 AND ("companyFiscalConfigId" IS NULL OR "companyFiscalConfigId"=$1)`, w.cfc);
    // Uma única linha, adotada pelo emitente (como o V1 faz) e no mesmo número: nada recomeça do 1.
    expect(seqs).toEqual([{ companyFiscalConfigId: w.cfc, proximoNumero: 500 }]);
  }, 60000);

  it("linha antiga do V1 travada em VALIDATING com número NÃO é retomada (decisão 3)", async () => {
    const w = cenario();
    const x = await w.criar("VALIDATING", 7);
    await db.admin.$executeRawUnsafe(`UPDATE "NfeEmitida" SET "updatedAt"=NOW()-interval '2 days' WHERE "id"=$1`, x);
    expect(await w.emitir(x)).toMatchObject({ status: "VALIDATING", emAndamento: true });
    expect(h.calls).toEqual([]);
  }, 60000);
});
