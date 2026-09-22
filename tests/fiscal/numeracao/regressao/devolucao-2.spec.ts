import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { makeConfig, makeDraft } from "../../__helpers__/test-draft";

// VERIFICAÇÃO (devolucao-2): "o ambiente da validação (D19 / AMBIENTE_DIVERGENTE) e do
// modo de referência sai da LINHA do rascunho (ambiente de criação), não da config:
// rascunho criado em homologação é emitido em PRODUÇÃO referenciando nota de homologação".
//
// PostgreSQL REAL (mesmo harness de tests/fiscal/numeracao/orquestrador-v2-postgres.spec.ts),
// acrescido do DDL da devolução (prisma/ddl/2026-09-18-nfe-devolucao.sql). Repositórios REAIS
// (NfeDevolucaoRepository, NfeRepository, numeração V2), NfeDevolucaoUseCase REAL,
// orquestrador V2 REAL, NfeXmlBuilderService REAL, FocusNfeV2Client REAL e
// decorarFocusDevolucao REAL. Simulados: o `fetch` (Focus), o repositório de config (mapa em
// memória — a troca HOMOLOGACAO→PRODUCAO é o que o usuário faz na tela de configuração), o
// leitor de arquivo do XML e o parser de XML (devolve o ParsedNfe da nota original de
// homologação; o parser não participa do defeito).
//
// Opt-in: NFE_TEST_DATABASE_URL=postgresql://postgres:<senha>@127.0.0.1:<porta>/nfe_test

const raw = process.env.NFE_TEST_DATABASE_URL;
const schema = `nfe_vd2_${randomUUID().replace(/-/g, "")}`;

const h = vi.hoisted(() => ({
  configs: new Map<string, unknown>(),
  parsed: null as unknown,
  posts: [] as Array<{ url: string; body: Record<string, unknown> }>,
  cnpj: "11222333000181",
  nOriginal: 4,
}));

vi.mock("../../../../app/fiscal/providers/provider-factory", () => ({
  // Focus: o orquestrador só testa `instanceof SefazDirectProvider`; qualquer outro objeto segue o ramo Focus.
  createNfeProviderFromConfig: async () => ({ name: "FOCUS_NFE" }),
  createNfeProvider: () => ({ name: "FOCUS_NFE" }),
}));
vi.mock("../../../../app/repositories/company-fiscal.repository", () => ({
  CompanyFiscalRepository: class {
    findByIdForUser = async (id: string) => h.configs.get(id) ?? null;
    findByUserId = async () => [...h.configs.values()][0] ?? null;
  },
}));
vi.mock("../../../../app/usecases/company-fiscal-resp-tec.usecase", () => ({ resolverRespTecEmpresa: async () => ({ origem: "OMITIR" }) }));
vi.mock("../../../../app/fiscal/sefaz/nfe-xml-parser.service", async (orig) => ({
  ...(await orig<typeof import("../../../../app/fiscal/sefaz/nfe-xml-parser.service")>()),
  parseNfeXml: () => structuredClone(h.parsed),
}));

const describePg = describe.skipIf(!raw);
describePg("devolucao-2: rascunho de devolução criado em HOMOLOGACAO, config passa a PRODUCAO — PostgreSQL real", () => {
  let admin: PrismaClient;
  let mods: {
    Orchestrator: typeof import("../../../../app/usecases/nfe-emissao-v2.orchestrator").NfeEmissaoV2Orchestrator;
    NfeRepository: typeof import("../../../../app/repositories/nfe.repository").NfeRepository;
    Devolucao: typeof import("../../../../app/usecases/nfe-devolucao.usecase").NfeDevolucaoUseCase;
    modo: typeof import("../../../../app/fiscal/devolucao/modo-referencia").modoReferenciaDevolucao;
    desde: typeof import("../../../../app/fiscal/flags").devolucaoRefItemProdDesde;
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
    for (const arq of ["prisma/ddl/2026-09-18-nfe-numeracao-v2.sql", "prisma/ddl/2026-09-18-nfe-devolucao.sql"]) {
      const ddl = readFileSync(arq, "utf8").replace(/--[^\r\n]*/g, "");
      for (const sql of ddl.split(";").map((s) => s.trim()).filter((s) => s && !["BEGIN", "COMMIT"].includes(s))) await admin.$executeRawUnsafe(sql);
    }

    const chave = await import("../../../../app/fiscal/sefaz/chave-acesso");
    mods = {
      Orchestrator: (await import("../../../../app/usecases/nfe-emissao-v2.orchestrator")).NfeEmissaoV2Orchestrator,
      NfeRepository: (await import("../../../../app/repositories/nfe.repository")).NfeRepository,
      Devolucao: (await import("../../../../app/usecases/nfe-devolucao.usecase")).NfeDevolucaoUseCase,
      modo: (await import("../../../../app/fiscal/devolucao/modo-referencia")).modoReferenciaDevolucao,
      desde: (await import("../../../../app/fiscal/flags")).devolucaoRefItemProdDesde,
      prisma: (await import("../../../../app/lib/prisma")).default,
      montarChave: chave.montarChave,
      chaveToString: chave.chaveToString,
    };
  }, 120000);

  afterAll(async () => {
    if (mods?.prisma) await mods.prisma.$disconnect();
    if (admin) {
      await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.$disconnect();
    }
  });

  beforeEach(() => {
    h.posts = [];
    vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
      const url = String(input);
      const metodo = init?.method ?? "GET";
      const ref = decodeURIComponent(metodo === "POST" ? new URL(url).searchParams.get("ref")! : new URL(url).pathname.split("/").pop()!);
      const body = metodo === "POST" ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      if (metodo === "POST") h.posts.push({ url, body });
      const numero = Number(body.numero ?? 1);
      const serie = Number(body.serie ?? 1);
      const chave44 = mods.chaveToString(mods.montarChave({ uf: "SP", ano: 2026, mes: 9, cnpj: h.cnpj, modelo: "55", serie, numero, tpEmis: 1, cNF: "40718263" }));
      // 201 síncrono "Autorizada" (formato da doc da Focus, com protocolo para isolar este achado do focus-1).
      return new Response(JSON.stringify({ cnpj_emitente: h.cnpj, ref, status: "autorizado", status_sefaz: "100", mensagem_sefaz: "Autorizado o uso da NF-e",
        chave_nfe: `NFe${chave44}`, numero: String(numero), serie: String(serie), protocolo: "135260000000999" }), { status: 201, headers: { "Content-Type": "application/json" } });
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  function flags(cfc: string) {
    // Flags do canário + devolução ligada para a MESMA empresa (o achado vale quando a devolução for ligada).
    vi.stubEnv("NFE_NUMERACAO_V2_ENABLED", "true");
    vi.stubEnv("NFE_NUMERACAO_V2_CONFIG_IDS", cfc);
    vi.stubEnv("NFE_NUMERACAO_V2_MODELOS", "55");
    vi.stubEnv("NFE_NUMERACAO_V2_FOCUS_ENABLED", "true");
    vi.stubEnv("NFE_DEVOLUCAO_ENABLED", "true");
    vi.stubEnv("NFE_DEVOLUCAO_CONFIG_IDS", cfc);
    vi.stubEnv("FISCAL_PRODUCTION_UNLOCKED", "true");
  }

  async function cenario() {
    const cfc = `cfg-${randomUUID().slice(0, 8)}`;
    flags(cfc);
    const configHomolog = makeConfig({ id: cfc, userId: "tenant", cnpj: h.cnpj, providerName: "FOCUS_NFE", providerToken: "tok-kiko", isDefault: true, serieNfe: 1 } as never);
    h.configs.set(cfc, configHomolog);
    const base = makeDraft({ userId: "tenant", companyFiscalConfigId: cfc });

    const nOriginal = ++h.nOriginal;
    // Nota ORIGINAL de venda, autorizada em HOMOLOGAÇÃO (série 1; nº distinto por cenário — chaveAcesso é única).
    const chaveOriginal = mods.chaveToString(mods.montarChave({ uf: "SP", ano: 2026, mes: 9, cnpj: h.cnpj, modelo: "55", serie: 1, numero: nOriginal, tpEmis: 1, cNF: "40718263" }));
    const original = await admin.nfeEmitida.create({
      data: {
        userId: "tenant", companyFiscalConfigId: cfc, ambiente: "HOMOLOGACAO", modelo: "55", serie: 1, numero: nOriginal, status: "AUTHORIZED",
        chaveAcesso: chaveOriginal, protocoloAutorizacao: "135260000000005", xmlAutorizadoPath: "/fiscal/original-homolog.xml",
        tipoOperacao: "SAIDA", finalidade: "NORMAL", destinoOperacao: "INTERNA", naturezaOperacao: "VENDA DE MERCADORIA",
        indPresenca: base.indPresenca, destinatarioJson: base.destinatarioJson as object, emittedByUserId: "tenant",
        itens: { create: [{ numero: 1, codigo: "P1", descricao: "PECA TESTE", ncm: "87089990", cfop: "5102", origem: 0, unidade: "UN", quantidade: 1, valorUnitario: 100, valorTotal: 100 }] },
      },
    });
    const ender = { xLgr: "RUA TESTE", nro: "100", xCpl: null, xBairro: "CENTRO", cMun: "3550308", xMun: "SAO PAULO", UF: "SP", CEP: "01000000", cPais: "1058", xPais: "BRASIL", fone: null };
    h.parsed = {
      chaveAcesso: chaveOriginal, versao: "4.00",
      ide: { idDest: 1, cUF: 35, natOp: "VENDA DE MERCADORIA", mod: "55", serie: 1, nNF: nOriginal, dhEmi: "2026-09-20T10:00:00-03:00", dhSaiEnt: null, tpNF: "1", tpAmb: "2", finNFe: "1", tpEmis: 1, cMunFG: "3550308", cDV: chaveOriginal[43] },
      emit: { CNPJ: h.cnpj, CPF: null, xNome: "EMPRESA TESTE LTDA", xFant: null, IE: "123456789", IM: null, CNAE: null, CRT: "1", ender },
      dest: { CNPJ: "00000000000100", CPF: null, idEstrangeiro: null, xNome: "NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL", IE: null, indIEDest: "9", email: null, ender },
      itens: [{ nItem: 1, cProd: "P1", cEAN: "SEM GTIN", xProd: "PECA TESTE", NCM: "87089990", CFOP: "5102", uCom: "UN", qCom: 1, vUnCom: 100, vProd: 100, vDesc: 0, CEST: null,
        imposto: { ICMS: { ICMSSN102: { orig: "0", CSOSN: "102" } }, PIS: { PISOutr: { CST: "49", vBC: "0.00", pPIS: "0.00", vPIS: "0.00" } }, COFINS: { COFINSOutr: { CST: "49", vBC: "0.00", pCOFINS: "0.00", vCOFINS: "0.00" } } } }],
      total: { vBC: 0, vICMS: 0, vProd: 100, vFrete: 0, vSeg: 0, vDesc: 0, vIPI: 0, vPIS: 0, vCOFINS: 0, vOutro: 0, vNF: 100 },
      transp: null, pag: [{ tPag: "01", vPag: 100 }], infCpl: null,
      protNFe: { chNFe: chaveOriginal, nProt: "135260000000005", dhRecbto: "2026-09-20T10:01:00-03:00", cStat: 100, xMotivo: "Autorizado o uso da NF-e", digVal: "abc=" },
    };
    const storage = { readFile: async () => Buffer.from("<nfeProc/>") };
    const dev = new mods.Devolucao(undefined, undefined, storage as never);
    const repo = new mods.NfeRepository();
    const autorizado = vi.fn(async () => ({}) as never);
    const orq = new mods.Orchestrator({ validar: () => {}, snapshot: () => ({}), autorizado }, undefined, repo, { saveXmlTentativa: async () => "/tmp/x.xml", readFile: async () => null } as never);
    const tentar = async <T>(fn: () => Promise<T>) => {
      try { return { ok: await fn(), erro: null as string | null }; }
      catch (e) { return { ok: null as T | null, erro: `${(e as { code?: string }).code ?? "?"}: ${(e as Error).message}` }; }
    };
    return { cfc, configHomolog, chaveOriginal, originalId: original.id, dev, repo, orq, autorizado, tentar };
  }

  it("CONTROLE: com a config em HOMOLOGACAO o rascunho da devolução fica emitível (ITEM) e a regra D19 existe na criação", async () => {
    const w = await cenario();
    const { draftId } = await w.dev.criar("tenant", "tenant", w.originalId, { escopo: "TOTAL" } as never);
    await w.dev.cabecalho("tenant", "tenant", draftId, { devolvidaAposEntrega: true } as never);
    const det = await w.dev.detalhe("tenant", draftId);
    expect(det.issues.filter((i) => i.severidade === "ERRO")).toEqual([]);
    expect(det.podeEmitir).toBe(true);
    expect(det.modoReferencia).toBe("ITEM");
    const linha = (await admin.nfeEmitida.findUnique({ where: { id: draftId }, select: { ambiente: true, status: true } }))!;
    expect(linha).toEqual({ ambiente: "HOMOLOGACAO", status: "DRAFT" });

    // A regra D19 funciona quando o rascunho é criado DEPOIS da troca: nova devolução de nota
    // de homologação com a config em PRODUCAO é recusada (AMBIENTE_DIVERGENTE vira DEVOLUCAO_INVALIDA).
    const w2 = await cenario();
    h.configs.set(w2.cfc, { ...w2.configHomolog, ambiente: "PRODUCAO" });
    const nova = await w2.tentar(() => w2.dev.criar("tenant", "tenant", w2.originalId, { escopo: "TOTAL" } as never));
    expect(nova.erro).toMatch(/^DEVOLUCAO_INVALIDA/);
  }, 60000);

  it("rascunho criado em HOMOLOGACAO + config trocada para PRODUCAO: deve bloquear AMBIENTE_DIVERGENTE e não transmitir", async () => {
    const w = await cenario();
    // 1) Em homologação: cria a devolução da nota de homologação e responde "entregue e devolvida".
    const { draftId } = await w.dev.criar("tenant", "tenant", w.originalId, { escopo: "TOTAL" } as never);
    await w.dev.cabecalho("tenant", "tenant", draftId, { devolvidaAposEntrega: true } as never);

    // 2) A empresa passa para PRODUÇÃO (mesma CompanyFiscalConfig). O rascunho fica pendente.
    const configProd = { ...w.configHomolog, ambiente: "PRODUCAO" };
    h.configs.set(w.cfc, configProd);

    // 3) Alguém abre o rascunho pendente (GET do detalhe)…
    const det = await w.dev.detalhe("tenant", draftId);
    const modoEsperadoProducao = mods.modo("PRODUCAO", new Date(), mods.desde());

    // 4) …e emite (despacho real: findNfeById → orquestrador V2 com a config atual).
    const draft = (await w.repo.findNfeById("tenant", draftId))!;
    const emissao = await w.tentar(() => w.orq.emitir("tenant", draft, configProd as never, { actorUserId: "tenant" }));
    const nota = (await admin.nfeEmitida.findUnique({ where: { id: draftId }, select: { status: true, ambiente: true, numero: true } }))!;
    const reservas = await admin.$queryRawUnsafe<Array<{ ambiente: string; estado: string; numero: number }>>(`SELECT "ambiente","estado","numero" FROM "NfeNumeroReserva" WHERE "nfeId"=$1`, draftId);
    const post = h.posts[0];
    const itensPost = (post?.body.items as Array<Record<string, unknown>> | undefined) ?? [];

    // Evidência bruta (aparece no log do vitest).
    console.log("DETALHE_PROD", JSON.stringify({ issues: det.issues.map((i) => i.code), podeEmitir: det.podeEmitir, modoReferencia: det.modoReferencia, modoEsperadoProducao }));
    console.log("EMISSAO", JSON.stringify({ erro: emissao.erro, status: emissao.ok?.status, nota, reservas }));
    console.log("POST_FOCUS", JSON.stringify({ url: post?.url, finalidade: post?.body.finalidade_emissao,
      notas_referenciadas: post?.body.notas_referenciadas ?? null,
      itens: itensPost.map((i) => ({ chave_acesso_dfe_referenciado: i.chave_acesso_dfe_referenciado, numero_item_dfe_referenciado: i.numero_item_dfe_referenciado })) }));
    console.log("CHAVE_ORIGINAL_HOMOLOGACAO", w.chaveOriginal);

    expect({
      issuesDetalhe: det.issues.filter((i) => i.severidade === "ERRO").map((i) => i.code),
      podeEmitir: det.podeEmitir,
      modoReferencia: det.modoReferencia,
      erroEmissao: emissao.erro?.split(":")[0] ?? null,
      transmissoesFocus: h.posts.length,
      nota,
      reservas: reservas.length,
    }).toEqual({
      issuesDetalhe: ["AMBIENTE_DIVERGENTE"],
      podeEmitir: false,
      modoReferencia: modoEsperadoProducao,
      erroEmissao: "DEVOLUCAO_INVALIDA",
      transmissoesFocus: 0,
      nota: { status: "DRAFT", ambiente: "HOMOLOGACAO", numero: expect.any(Number) },
      reservas: 0,
    });
  }, 60000);
});
