import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { makeDraft } from "../../__helpers__/test-draft";

// REGRESSÃO (revisão V2, achado focus-5): "Consulta de tentativa de homologação usa o token
// ATUAL da config: ao passar a Kiko para produção, sobras INCERTO ficam presas com 401".
// Correção adotada: GUARDA em CompanyFiscalUseCase (updateById/upsert) — com a V2 ligada,
// trocar ambiente ou token com reserva EM_TRANSMISSAO/INCERTO responde 409 até as notas
// serem resolvidas ("Consultar situação"). Token por ambiente fica como DECISÃO do usuário.
//
// PostgreSQL REAL (mesmo harness de tests/fiscal/numeracao/orquestrador-v2-postgres.spec.ts),
// e SEM doubles de aplicação: NfeEmissionUseCase (despacho contextoV2 → orquestrador V2),
// NfeRepository, NfeNumeracaoRepository, CompanyFiscalRepository e CompanyFiscalUseCase
// (a troca de ambiente/token que o operador faz na tela) são os REAIS; FocusNfeV2Client
// é o REAL. Só o `fetch` global é simulado, com a semântica de autenticação da Focus:
// UM token por ambiente (homologacao.focusnfe.com.br só aceita o token de homologação,
// api.focusnfe.com.br só o de produção); token errado ⇒ HTTP 401 com corpo HTML
// ("HTTP Basic: Access denied."). O repo já registrou isso em
// docs/handoff-nfe-evolucao/04-focus-cstat-resptec.md:916 ("the production 401s ... point to
// a token from the wrong environment. When switching to PRODUCAO, swap the token too").
//
// O corpo "autorizado" do fake inclui `protocolo` DE PROPÓSITO, para isolar este achado
// do focus-1 (ausência de protocolo): o controle abaixo prova que, com o token certo, a
// mesma nota autoriza.
//
// Único stub além do transporte: handleAuthorized (pós-autorização: baixar XML/DANFE da
// Focus pelo V1). Não participa da decisão fiscal; o orquestrador já o isola em try/catch.
//
// Opt-in: NFE_TEST_DATABASE_URL=postgresql://postgres:<senha>@127.0.0.1:<porta>/nfe_test

const raw = process.env.NFE_TEST_DATABASE_URL;
const schema = `nfe_vf5_${randomUUID().replace(/-/g, "")}`;

const HOMOLOG = "https://homologacao.focusnfe.com.br";
const PROD = "https://api.focusnfe.com.br";
const TOKEN_HOMOLOG = "tok-homolog-kiko-0001";
const TOKEN_PROD = "tok-prod-kiko-9999";
const CNPJ = "11222333000181";

const h = vi.hoisted(() => ({
  /** Chamadas feitas à "Focus": host, método, ref e QUAL token foi apresentado. */
  calls: [] as Array<{ host: string; metodo: string; ref: string; token: string; http: number }>,
  /** Refs registradas por ambiente (homologação e produção são bases separadas na Focus). */
  refs: new Map<string, { numero: number; serie: number; processada: boolean }>(),
  /** cNF por caso: a chave de acesso é UNIQUE no schema inteiro. */
  cNF: "40718263",
}));

const describePg = describe.skipIf(!raw);
describePg("regressão focus-5: troca de ambiente/token com envio pendente — PostgreSQL real", () => {
  let admin: PrismaClient;
  let mods: {
    NfeEmissionUseCase: typeof import("../../../../app/usecases/nfe-emission.usecase").NfeEmissionUseCase;
    CompanyFiscalUseCase: typeof import("../../../../app/usecases/company-fiscal.usecase").CompanyFiscalUseCase;
    NfeNumeracaoService: typeof import("../../../../app/fiscal/numeracao/numeracao.service").NfeNumeracaoService;
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
    const emission = await import("../../../../app/usecases/nfe-emission.usecase");
    // Pós-autorização (download de XML/DANFE pelo V1) fora do escopo; o orquestrador já o isola.
    vi.spyOn(emission.NfeEmissionUseCase.prototype as never, "handleAuthorized" as never).mockResolvedValue({} as never);
    mods = {
      NfeEmissionUseCase: emission.NfeEmissionUseCase,
      CompanyFiscalUseCase: (await import("../../../../app/usecases/company-fiscal.usecase")).CompanyFiscalUseCase,
      NfeNumeracaoService: (await import("../../../../app/fiscal/numeracao/numeracao.service")).NfeNumeracaoService,
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

  function tokenDoHeader(init?: RequestInit): string {
    const auth = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "");
    const b64 = auth.replace(/^Basic\s+/i, "");
    return Buffer.from(b64, "base64").toString("utf8").replace(/:$/, "");
  }

  function json(status: number, corpo: unknown): Response {
    return new Response(JSON.stringify(corpo), { status, headers: { "Content-Type": "application/json" } });
  }

  beforeEach(() => {
    h.calls = [];
    h.refs = new Map();
    h.cNF = String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
    vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
      const url = new URL(String(input));
      const host = url.origin;
      const metodo = init?.method ?? "GET";
      const token = tokenDoHeader(init);
      const ambiente = host === PROD ? "PRODUCAO" : host === HOMOLOG ? "HOMOLOGACAO" : null;
      const tokenValido = (ambiente === "PRODUCAO" && token === TOKEN_PROD) || (ambiente === "HOMOLOGACAO" && token === TOKEN_HOMOLOG);
      const partes = url.pathname.split("/");
      const ref = decodeURIComponent(metodo === "POST" ? (url.searchParams.get("ref") ?? "") : (partes[partes.length - 1] ?? ""));
      const registrar = (http: number) => h.calls.push({ host, metodo, ref, token: token === TOKEN_PROD ? "PROD" : token === TOKEN_HOMOLOG ? "HOMOLOG" : token, http });
      if (!ambiente || !url.pathname.startsWith("/v2/nfe")) { registrar(404); return new Response("not found", { status: 404 }); }
      if (!tokenValido) {
        // Focus: token de outro ambiente ⇒ 401 com HTML (não JSON).
        registrar(401);
        return new Response("HTTP Basic: Access denied.\n", { status: 401, headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      const chaveRef = `${ambiente}:${ref}`;
      if (metodo === "POST") {
        const payload = JSON.parse(String(init.body)) as { numero: string; serie: string };
        h.refs.set(chaveRef, { numero: Number(payload.numero), serie: Number(payload.serie), processada: false });
        registrar(202);
        return json(202, { cnpj_emitente: CNPJ, ref, status: "processando_autorizacao" });
      }
      const nota = h.refs.get(chaveRef);
      if (!nota) { registrar(404); return json(404, { codigo: "nao_encontrado", mensagem: "Nota fiscal não encontrada" }); }
      registrar(200);
      if (!nota.processada) return json(200, { cnpj_emitente: CNPJ, ref, status: "processando_autorizacao" });
      const chave44 = mods.chaveToString(mods.montarChave({ uf: "SP", ano: 2026, mes: 9, cnpj: CNPJ, modelo: "55", serie: nota.serie, numero: nota.numero, tpEmis: 1, cNF: h.cNF }));
      return json(200, {
        cnpj_emitente: CNPJ, ref, status: "autorizado", status_sefaz: "100", mensagem_sefaz: "Autorizado o uso da NF-e",
        chave_nfe: `NFe${chave44}`, numero: String(nota.numero), serie: String(nota.serie), protocolo: "135260000000555",
      });
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  /** Kiko: Focus, homologação, token de homologação; canário V2 ligado só para ela. */
  async function cenario() {
    const cfc = `cfg-kiko-${randomUUID().slice(0, 8)}`;
    const USER = `tenant-kiko-${randomUUID().slice(0, 8)}`;
    const dadosEmpresa = {
      cnpj: CNPJ, razaoSocial: "KIKO 4X4 PECAS LTDA", nomeFantasia: "KIKO 4X4", inscricaoEstadual: "123456789",
      regimeTributario: "SIMPLES" as const, cep: "01000000", logradouro: "RUA TESTE", numero: "100", bairro: "CENTRO",
      municipio: "SAO PAULO", codMunicipio: "3550308", uf: "SP", providerName: "FOCUS_NFE", serieNfe: 1,
    };
    await admin.companyFiscalConfig.create({ data: { id: cfc, userId: USER, isDefault: true, ...dadosEmpresa, ambiente: "HOMOLOGACAO", providerToken: TOKEN_HOMOLOG } });
    vi.stubEnv("NFE_NUMERACAO_V2_ENABLED", "true");
    vi.stubEnv("NFE_NUMERACAO_V2_CONFIG_IDS", cfc);
    vi.stubEnv("NFE_NUMERACAO_V2_MODELOS", "55");
    vi.stubEnv("NFE_NUMERACAO_V2_FOCUS_ENABLED", "true");
    vi.stubEnv("NFE_DEVOLUCAO_ENABLED", "false");
    vi.stubEnv("NFE_RESP_TEC_EMPRESA_ENABLED", "false");

    const base = makeDraft({ userId: USER, companyFiscalConfigId: cfc });
    const nota = await admin.nfeEmitida.create({
      data: {
        userId: USER, companyFiscalConfigId: cfc, ambiente: "HOMOLOGACAO", modelo: "55", serie: 1, numero: -1, status: "DRAFT",
        tipoOperacao: base.tipoOperacao, finalidade: base.finalidade, destinoOperacao: base.destinoOperacao,
        naturezaOperacao: base.naturezaOperacao, indPresenca: base.indPresenca, destinatarioJson: base.destinatarioJson as object,
        emittedByUserId: USER,
        itens: { create: [{ numero: 1, codigo: "P1", descricao: "PECA TESTE", ncm: "87089990", cfop: "5102", origem: 0, unidade: "UN", quantidade: 1, valorUnitario: 100, valorTotal: 100 }] },
      },
    });
    const uc = new mods.NfeEmissionUseCase();
    /** O operador troca a Kiko para PRODUÇÃO pela tela de config (mesmo caminho da rota PUT). */
    const passarParaProducao = async () => {
      vi.stubEnv("FISCAL_PRODUCTION_UNLOCKED", "true");
      await new mods.CompanyFiscalUseCase().updateById(cfc, USER, { ...dadosEmpresa, ambiente: "PRODUCAO", providerToken: TOKEN_PROD });
    };
    /** A SEFAZ de homologação terminou de processar a ref na Focus (a nota FOI autorizada lá). */
    const focusAutoriza = () => { for (const [k, v] of h.refs) if (k.startsWith("HOMOLOGACAO:")) v.processada = true; };
    /** Envelhece a tentativa (a consulta deixa de ser "recente"). */
    const amadurecer = () => admin.$executeRawUnsafe(`UPDATE "NfeNumeroTentativa" SET "transmitidaEm"=NOW()-interval '2 hours' WHERE "nfeId"=$1`, nota.id);
    const estado = async () => {
      const n = (await admin.nfeEmitida.findUnique({ where: { id: nota.id }, select: { status: true, numero: true, ambiente: true } }))!;
      const r = await admin.$queryRawUnsafe<Array<{ estado: string; ambiente: string; numero: number }>>(`SELECT "estado","ambiente","numero" FROM "NfeNumeroReserva" WHERE "nfeId"=$1 ORDER BY "createdAt" DESC`, nota.id);
      return { nota: n, reserva: r[0] ?? null };
    };
    return { cfc, user: USER, id: nota.id, uc, dadosEmpresa, passarParaProducao, focusAutoriza, amadurecer, estado };
  }

  it("CONTROLE: sem trocar a config, a mesma nota de homologação autoriza pela consulta", async () => {
    const w = await cenario();
    const emitida = await w.uc.emit(w.user, w.id);
    expect(emitida).toMatchObject({ status: "SENDING", emAndamento: true, numeracao: { estado: "INCERTO", ambiente: "HOMOLOGACAO" } });

    w.focusAutoriza();
    await w.amadurecer();
    const r = await w.uc.consultarSituacao(w.user, w.id);
    expect(r).toMatchObject({ success: true, status: "AUTHORIZED", numero: 1 });
    expect((await w.estado()).reserva).toMatchObject({ estado: "AUTORIZADO", ambiente: "HOMOLOGACAO" });
    expect(h.calls.filter((c) => c.metodo === "GET").every((c) => c.host === HOMOLOG && c.token === "HOMOLOG" && c.http === 200)).toBe(true);
  }, 120000);

  it("GUARDA: com nota INCERTO, trocar ambiente+token responde 409 e não altera a config; a consulta com o token certo resolve e a troca passa", async () => {
    const w = await cenario();
    const emitida = await w.uc.emit(w.user, w.id);
    expect(emitida).toMatchObject({ status: "SENDING", emAndamento: true, numeracao: { estado: "INCERTO", ambiente: "HOMOLOGACAO" } });

    // 1) Troca bloqueada enquanto houver envio sem desfecho.
    const erro = await w.passarParaProducao().then(() => null, (e: unknown) => e);
    expect(erro).toMatchObject({
      name: "NumeracaoError", code: "NUMERACAO_PENDENTE_TROCA_CREDENCIAL", httpStatus: 409,
      detalhes: { pendentes: [{ numero: 1, serie: 1, ambiente: "HOMOLOGACAO", modelo: "55", estado: "INCERTO" }] },
    });
    expect((erro as Error).message).toMatch(/Consultar situação/);
    const cfg = await admin.companyFiscalConfig.findUnique({ where: { id: w.cfc }, select: { ambiente: true, providerToken: true } });
    expect(cfg).toEqual({ ambiente: "HOMOLOGACAO", providerToken: TOKEN_HOMOLOG });

    // 2) Como a config não mudou, a consulta usa o token de homologação e registra a autorização.
    w.focusAutoriza();
    await w.amadurecer();
    h.calls = [];
    const r = await w.uc.consultarSituacao(w.user, w.id);
    expect(r).toMatchObject({ success: true, status: "AUTHORIZED", numero: 1 });
    expect(h.calls.filter((c) => c.metodo === "GET").map((c) => `${c.host} token=${c.token} http=${c.http}`)).toEqual([`${HOMOLOG} token=HOMOLOG http=200`]);
    expect(await w.estado()).toEqual({ nota: { status: "AUTHORIZED", numero: 1, ambiente: "HOMOLOGACAO" }, reserva: { estado: "AUTORIZADO", ambiente: "HOMOLOGACAO", numero: 1 } });

    // 3) Sem pendência, a troca para produção passa.
    await w.passarParaProducao();
    expect(await admin.companyFiscalConfig.findUnique({ where: { id: w.cfc }, select: { ambiente: true, providerToken: true } })).toEqual({ ambiente: "PRODUCAO", providerToken: TOKEN_PROD });
  }, 120000);

  it("GUARDA: só o token (mesmo ambiente) também é bloqueado; PUT legado da config padrão idem; salvar sem trocar ambiente/token passa", async () => {
    const w = await cenario();
    await w.uc.emit(w.user, w.id);
    const uc = new mods.CompanyFiscalUseCase();
    await expect(uc.updateById(w.cfc, w.user, { ...w.dadosEmpresa, ambiente: "HOMOLOGACAO", providerToken: "tok-homolog-novo" }))
      .rejects.toMatchObject({ code: "NUMERACAO_PENDENTE_TROCA_CREDENCIAL", httpStatus: 409 });
    vi.stubEnv("FISCAL_PRODUCTION_UNLOCKED", "true");
    await expect(uc.upsert(w.user, { ...w.dadosEmpresa, ambiente: "PRODUCAO" }))
      .rejects.toMatchObject({ code: "NUMERACAO_PENDENTE_TROCA_CREDENCIAL", httpStatus: 409 });
    // Token em branco = "manter o salvo" (repositório); mesmo token = sem troca; outros campos livres.
    await uc.updateById(w.cfc, w.user, { ...w.dadosEmpresa, ambiente: "HOMOLOGACAO", providerToken: TOKEN_HOMOLOG });
    await uc.updateById(w.cfc, w.user, { ...w.dadosEmpresa, razaoSocial: "KIKO 4X4 PECAS EIRELI", ambiente: "HOMOLOGACAO", providerToken: "" });
    expect(await admin.companyFiscalConfig.findUnique({ where: { id: w.cfc }, select: { ambiente: true, providerToken: true, razaoSocial: true } }))
      .toEqual({ ambiente: "HOMOLOGACAO", providerToken: TOKEN_HOMOLOG, razaoSocial: "KIKO 4X4 PECAS EIRELI" });
  }, 120000);

  it("I8: flag GLOBAL desligada — a troca passa sem guarda (comportamento atual)", async () => {
    const w = await cenario();
    await w.uc.emit(w.user, w.id);
    vi.stubEnv("NFE_NUMERACAO_V2_ENABLED", "false");
    await w.passarParaProducao();
    expect(await admin.companyFiscalConfig.findUnique({ where: { id: w.cfc }, select: { ambiente: true, providerToken: true } })).toEqual({ ambiente: "PRODUCAO", providerToken: TOKEN_PROD });
  }, 120000);
});
