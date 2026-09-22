import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { makeConfig, makeDraft } from "../__helpers__/test-draft";
import { criarSchemaNfe, urlTestePostgres, type SchemaNfe } from "../__harness__/pg-nfe-schema";

// Numeração V2 pela FOCUS (caminho do canário) de ponta a ponta contra PostgreSQL REAL,
// com o FocusNfeV2Client REAL: só o `fetch` é simulado, devolvendo os corpos da
// documentação pública da Focus (doc.focusnfe.com.br: emitir_nfe / consultar_nfe).
//
// Regressão dos defeitos confirmados na revisão de 22/09/2026:
//  - autorização Focus vem SEM `protocolo` (201 e consulta simples) → nunca era registrada;
//  - payload sem `data_emissao` (obrigatório) / com a data da tentativa anterior;
//  - rejeição que chega pela CONSULTA (NF-e 55 é assíncrona) virava "Envio não registrado";
//  - 539/562/613, 108/109 e 656 vindos da consulta deixavam a nota SENDING para sempre.

const raw = urlTestePostgres();
const HOST = "https://homologacao.focusnfe.com.br";

type Corpo = Record<string, unknown>;
const h = vi.hoisted(() => ({
  configs: new Map<string, unknown>(),
  posts: [] as Array<{ ref: string; payload: Record<string, unknown> }>,
  gets: [] as string[],
  post: (() => ({ status: 202, body: { status: "processando_autorizacao" } })) as (ref: string, payload: Record<string, unknown>) => { status: number; body: unknown },
  get: (() => ({ status: 200, body: { status: "processando_autorizacao" } })) as (ref: string, url: string) => { status: number; body: unknown },
}));

vi.mock("../../../app/fiscal/providers/provider-factory", () => ({ createNfeProviderFromConfig: async () => ({}) }));
vi.mock("../../../app/repositories/company-fiscal.repository", () => ({ CompanyFiscalRepository: class { findByIdForUser = async (id: string) => h.configs.get(id) ?? null; } }));
vi.mock("../../../app/usecases/company-fiscal-resp-tec.usecase", () => ({ resolverRespTecEmpresa: async () => ({ origem: "OMITIR" }) }));

describe.skipIf(!raw)("PostgreSQL isolado: orquestrador V2 pela Focus (corpos da documentação)", () => {
  let db: SchemaNfe;
  let mods: {
    Orchestrator: typeof import("../../../app/usecases/nfe-emissao-v2.orchestrator").NfeEmissaoV2Orchestrator;
    NfeRepository: typeof import("../../../app/repositories/nfe.repository").NfeRepository;
    prisma: import("@prisma/client").PrismaClient;
    montarChave: typeof import("../../../app/fiscal/sefaz/chave-acesso").montarChave;
    chaveToString: typeof import("../../../app/fiscal/sefaz/chave-acesso").chaveToString;
  };

  beforeAll(async () => {
    db = await criarSchemaNfe(raw!, "nfe_focus");
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

  beforeEach(() => {
    h.posts = []; h.gets = [];
    h.post = () => ({ status: 202, body: { status: "processando_autorizacao" } });
    h.get = () => ({ status: 200, body: { status: "processando_autorizacao" } });
    vi.stubEnv("NFE_DEVOLUCAO_ENABLED", "false");
    vi.stubEnv("NFE_NUMERACAO_V2_FOCUS_PAUSAS_MS", "0");
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const u = String(url);
      if (init.method === "POST" && u.startsWith(`${HOST}/v2/nfe?ref=`)) {
        const ref = decodeURIComponent(u.split("ref=")[1]);
        const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
        h.posts.push({ ref, payload });
        const r = h.post(ref, payload);
        return new Response(JSON.stringify(r.body), { status: r.status });
      }
      if (init.method === "GET" && u.startsWith(`${HOST}/v2/nfe/`)) {
        const ref = decodeURIComponent(u.slice(`${HOST}/v2/nfe/`.length).split("?")[0]);
        h.gets.push(u);
        const r = h.get(ref, u);
        return new Response(JSON.stringify(r.body), { status: r.status });
      }
      return new Response("<html>not found</html>", { status: 404 });
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  function cenario() {
    const cfc = `cfg-${randomUUID().slice(0, 8)}`;
    const config = makeConfig({ id: cfc, userId: "tenant", providerName: "FOCUS_NFE", providerToken: "token-homolog", isDefault: true });
    h.configs.set(cfc, config);
    const base = makeDraft({ userId: "tenant", companyFiscalConfigId: cfc });
    const autorizado = vi.fn(async (d: { id: string }) => {
      await db.admin.nfeAuditLog.create({ data: { nfeId: d.id, userId: "tenant", evento: "AUTORIZADA", detalhes: {} } });
      return {} as never;
    });
    const repo = new mods.NfeRepository();
    const uc = new mods.Orchestrator({ validar: () => {}, snapshot: () => ({}), autorizado }, undefined, repo, {} as never);
    const criar = async () => (await db.admin.nfeEmitida.create({
      data: {
        userId: "tenant", companyFiscalConfigId: cfc, ambiente: "HOMOLOGACAO", modelo: "55", serie: 1, numero: -1, status: "DRAFT",
        tipoOperacao: base.tipoOperacao, finalidade: base.finalidade, destinoOperacao: base.destinoOperacao,
        naturezaOperacao: base.naturezaOperacao, indPresenca: base.indPresenca, destinatarioJson: base.destinatarioJson as object,
        emittedByUserId: "tenant",
        itens: { create: [{ numero: 1, codigo: "P1", descricao: "PECA TESTE", ncm: "87089990", cfop: "5102", origem: 0, unidade: "UN", quantidade: 1, valorUnitario: 100, valorTotal: 100 }] },
      },
    })).id;
    // chaveAcesso é única no banco inteiro: um cNF por cenário.
    const montar = (numero: number, cNF: string) => mods.chaveToString(mods.montarChave({ uf: "SP", ano: 2026, mes: 9, cnpj: config.cnpj, modelo: "55", serie: 1, numero, tpEmis: 1, cNF }));
    let cnf = "";
    for (;;) { cnf = String(10_000_000 + Math.floor(Math.random() * 89_999_999)); try { montar(1, cnf); break; } catch { /* cNF proibido (sequência/repetição): sorteia outro */ } }
    const chaveDe = (numero: number, cNF = cnf) => montar(numero, cNF);
    // Corpos da documentação da Focus.
    const autorizadaSimples = (numero: number): Corpo => ({ cnpj_emitente: config.cnpj, ref: "x", status: "autorizado", status_sefaz: "100", mensagem_sefaz: "Autorizado o uso da NF-e", chave_nfe: `NFe${chaveDe(numero)}`, numero: String(numero), serie: "1", caminho_xml_nota_fiscal: "/arquivos/x-nfe.xml", caminho_danfe: "/arquivos/x.pdf" });
    const autorizadaCompleta = (numero: number): Corpo => ({ ...autorizadaSimples(numero), protocolo: "135260000000999", protocolo_nota_fiscal: { data_recebimento: "2026-09-22T10:40:40-03:00", numero_protocolo: "135260000000999", status: "100" } });
    const erroAutorizacao = (cStat: number, mensagem: string): Corpo => ({ cnpj_emitente: config.cnpj, ref: "x", status: "erro_autorizacao", status_sefaz: String(cStat), mensagem_sefaz: mensagem, erros: [{ codigo: "", mensagem }] });
    const emitir = async (id: string) => uc.emitir("tenant", (await repo.findNfeById("tenant", id))!, config);
    const consultar = async (id: string) => uc.consultar("tenant", (await repo.findNfeById("tenant", id))!, config);
    const nota = async (id: string) => (await db.admin.nfeEmitida.findUnique({ where: { id }, select: { status: true, numero: true, motivoRejeicao: true, cStatRejeicao: true, protocoloAutorizacao: true, dataAutorizacao: true, dataEmissao: true } }))!;
    const reservas = (id: string) => db.admin.$queryRawUnsafe<Array<{ numero: number; estado: string; ultimoCStat: number | null; bloqueadoAte: Date | null }>>(`SELECT "numero","estado","ultimoCStat","bloqueadoAte" FROM "NfeNumeroReserva" WHERE "nfeId"=$1 ORDER BY "createdAt"`, id);
    const envelhecer = (id: string) => db.admin.$executeRawUnsafe(`UPDATE "NfeNumeroTentativa" SET "transmitidaEm"=NOW()-interval '1 hour' WHERE "nfeId"=$1`, id);
    const liberar = (id: string) => db.admin.$executeRawUnsafe(`UPDATE "NfeNumeroReserva" SET "leaseAte"=NULL,"bloqueadoAte"=NULL WHERE "nfeId"=$1`, id);
    return { cfc, config, uc, autorizado, criar, chaveDe, autorizadaSimples, autorizadaCompleta, erroAutorizacao, emitir, consultar, nota, reservas, envelhecer, liberar };
  }

  it("202 → consulta completa autorizada: registra protocolo e data do protocolo_nota_fiscal; payload leva numero/serie/data_emissao", async () => {
    const w = cenario();
    const x = await w.criar();
    h.get = () => ({ status: 200, body: w.autorizadaCompleta(1) });
    const antes = Date.now();
    expect(await w.emitir(x)).toMatchObject({ success: true, status: "AUTHORIZED", numero: 1, serie: 1 });
    expect(h.gets[0]).toMatch(/\?completa=1$/);
    const p = h.posts[0].payload;
    expect(p).toMatchObject({ numero: "1", serie: "1" });
    const dataEmissao = Date.parse(String(p.data_emissao));
    expect(dataEmissao).toBeGreaterThanOrEqual(antes - 1000);
    const n = await w.nota(x);
    expect(n).toMatchObject({ status: "AUTHORIZED", protocoloAutorizacao: "135260000000999" });
    expect(n.dataAutorizacao?.toISOString()).toBe("2026-09-22T13:40:40.000Z");
    expect(Math.abs(n.dataEmissao!.getTime() - dataEmissao)).toBeLessThan(1000);
    expect(w.autorizado).toHaveBeenCalledTimes(1);
  }, 60000);

  it("201 síncrono 'autorizado' SEM protocolo (formato da doc) é registrado como autorização", async () => {
    const w = cenario();
    const x = await w.criar();
    h.post = (_ref, payload) => ({ status: 201, body: w.autorizadaSimples(Number(payload.numero)) });
    expect(await w.emitir(x)).toMatchObject({ success: true, status: "AUTHORIZED", numero: 1 });
    expect(await w.nota(x)).toMatchObject({ status: "AUTHORIZED", protocoloAutorizacao: null });
    expect((await w.reservas(x))[0]).toMatchObject({ numero: 1, estado: "AUTORIZADO" });
    expect(w.autorizado).toHaveBeenCalledTimes(1);
    expect(h.gets).toEqual([]);
  }, 60000);

  it("rejeição que chega pela consulta mostra o motivo e o cStat reais; corrigir e reenviar mantém o número e a ref", async () => {
    const w = cenario();
    const x = await w.criar();
    h.get = () => ({ status: 200, body: w.erroAutorizacao(598, "Rejeicao: Total da NF difere do somatorio dos valores") });
    const r = await w.emitir(x);
    expect(r).toMatchObject({ success: false, status: "REJECTED", numero: 1 });
    expect(r.mensagem).toMatch(/598|Total da NF/);
    expect(await w.nota(x)).toMatchObject({ status: "REJECTED", cStatRejeicao: 598 });
    expect((await w.nota(x)).motivoRejeicao).toMatch(/Total da NF/);
    expect((await w.reservas(x))[0]).toMatchObject({ numero: 1, estado: "REJEITADO", ultimoCStat: 598 });

    // Corrige (o wizard rebaixa a DRAFT e muda o conteúdo) e reenvia: mesmo número, mesma ref.
    await db.admin.nfeEmitida.update({ where: { id: x }, data: { status: "DRAFT", naturezaOperacao: "VENDA CORRIGIDA" } });
    h.get = () => ({ status: 200, body: w.autorizadaCompleta(1) });
    expect(await w.emitir(x)).toMatchObject({ success: true, status: "AUTHORIZED", numero: 1 });
    expect(h.posts.map((p) => p.ref)).toEqual([x, x]);
    expect(h.posts.map((p) => p.payload.numero)).toEqual(["1", "1"]);
  }, 60000);

  it("reenvio dias depois leva a data da NOVA tentativa, não a da anterior", async () => {
    const w = cenario();
    const x = await w.criar();
    h.get = () => ({ status: 200, body: w.erroAutorizacao(225, "Rejeicao: Falha no Schema XML") });
    await w.emitir(x);
    await db.admin.$executeRawUnsafe(`UPDATE "NfeEmitida" SET "dataEmissao"=NOW()-interval '40 days',"status"='DRAFT',"naturezaOperacao"='CORRIGIDA' WHERE "id"=$1`, x);
    h.get = () => ({ status: 200, body: w.autorizadaCompleta(1) });
    const antes = Date.now();
    await w.emitir(x);
    const segunda = Date.parse(String(h.posts[1].payload.data_emissao));
    expect(segunda).toBeGreaterThanOrEqual(antes - 1000);
    expect(Math.abs((await w.nota(x)).dataEmissao!.getTime() - segunda)).toBeLessThan(1000);
  }, 60000);

  it.each([539, 562, 613])("consulta com %s citando chave do MESMO emitente/série/número: número consumido fora, nota sai de SENDING e a próxima emissão usa outro número com ref alfanumérica", async (cStat) => {
    const w = cenario();
    const x = await w.criar();
    const alheia = w.chaveDe(1, "51829374");
    h.get = () => ({ status: 200, body: w.erroAutorizacao(cStat, `Rejeicao: Duplicidade de NF-e com diferenca na Chave de Acesso [chNFe: ${alheia}]`) });
    const r = await w.emitir(x);
    expect(r).toMatchObject({ success: false, status: "REJECTED" });
    expect(r.mensagem).toContain(alheia);
    expect((await w.reservas(x))[0]).toMatchObject({ numero: 1, estado: "CONSUMIDO_EXTERNO" });

    await db.admin.nfeEmitida.update({ where: { id: x }, data: { status: "DRAFT" } });
    h.get = () => ({ status: 200, body: w.autorizadaCompleta(2) });
    expect(await w.emitir(x)).toMatchObject({ success: true, status: "AUTHORIZED", numero: 2 });
    expect(h.posts.map((p) => p.ref)).toEqual([x, `${x}n2`]);
    expect(h.posts[1].ref).toMatch(/^[a-z0-9]+$/i);
  }, 60000);

  it("consulta com duplicidade sem chave legível vai para conferência manual (BLOQUEADO), nunca fica INCERTO para sempre", async () => {
    const w = cenario();
    const x = await w.criar();
    h.get = () => ({ status: 200, body: w.erroAutorizacao(539, "Rejeicao: Duplicidade de NF-e com diferenca na Chave de Acesso") });
    await w.emitir(x);
    expect((await w.reservas(x))[0]).toMatchObject({ estado: "BLOQUEADO" });
    await expect(w.emitir(x)).rejects.toMatchObject({ code: "NUMERACAO_BLOQUEADA" });
  }, 60000);

  it.each([108, 109])("consulta com %s (SEFAZ indisponível) fecha a tentativa: nº mantido e reenvio liberado", async (cStat) => {
    const w = cenario();
    const x = await w.criar();
    h.get = () => ({ status: 200, body: w.erroAutorizacao(cStat, "Rejeicao: Servico Paralisado Momentaneamente") });
    await w.emitir(x);
    expect(await w.nota(x)).toMatchObject({ status: "REJECTED", cStatRejeicao: cStat });
    expect((await w.reservas(x))[0]).toMatchObject({ numero: 1, estado: "RESERVADO" });
    await w.liberar(x);
    await db.admin.nfeEmitida.update({ where: { id: x }, data: { status: "DRAFT", naturezaOperacao: "OUTRA" } });
    h.get = () => ({ status: 200, body: w.autorizadaCompleta(1) });
    expect(await w.emitir(x)).toMatchObject({ success: true, status: "AUTHORIZED", numero: 1 });
  }, 60000);

  it("consulta com 656 (consumo indevido): nota REJECTED com o cStat e reserva REJEITADO com espera", async () => {
    const w = cenario();
    const x = await w.criar();
    h.get = () => ({ status: 200, body: w.erroAutorizacao(656, "Rejeicao: Consumo Indevido") });
    await w.emitir(x);
    expect(await w.nota(x)).toMatchObject({ status: "REJECTED", cStatRejeicao: 656 });
    const [res] = await w.reservas(x);
    expect(res).toMatchObject({ numero: 1, estado: "REJEITADO" });
    expect(res.bloqueadoAte!.getTime()).toBeGreaterThan(Date.now());
  }, 60000);

  it("depois do 202, as consultas curtas trazem a autorização na mesma chamada", async () => {
    vi.stubEnv("NFE_NUMERACAO_V2_FOCUS_PAUSAS_MS", "5,5,5");
    const w = cenario();
    const x = await w.criar();
    let n = 0;
    h.get = () => (++n < 2 ? { status: 200, body: { status: "processando_autorizacao" } } : { status: 200, body: w.autorizadaCompleta(1) });
    expect(await w.emitir(x)).toMatchObject({ success: true, status: "AUTHORIZED", numero: 1 });
    expect(h.gets).toHaveLength(2);
  }, 60000);

  it("processando depois das consultas curtas: responde 'em andamento' (não erro) e 'Consultar situação' conclui", async () => {
    vi.stubEnv("NFE_NUMERACAO_V2_FOCUS_PAUSAS_MS", "5,5");
    const w = cenario();
    const x = await w.criar();
    expect(await w.emitir(x)).toMatchObject({ status: "SENDING", emAndamento: true, numeracao: { estado: "INCERTO", numero: 1 } });
    expect(h.gets).toHaveLength(2);
    h.get = () => ({ status: 200, body: w.autorizadaCompleta(1) });
    expect(await w.consultar(x)).toMatchObject({ success: true, status: "AUTHORIZED", numero: 1 });
    expect(h.posts).toHaveLength(1);
  }, 60000);
});
