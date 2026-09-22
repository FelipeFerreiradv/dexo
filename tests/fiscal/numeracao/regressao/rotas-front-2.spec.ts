import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { makeConfig, makeDraft } from "../../__helpers__/test-draft";
import { MSG_EM_ANDAMENTO, desfechoConsulta, desfechoEmissao, type DesfechoTela, type RespostaNumeracao } from "../../../../app/notas-fiscais/lib/nfe-numeracao-ui";

// REGRESSÃO (era tests/fiscal/__verify__/rotas-front-2.spec.ts, revisão adversarial V2):
// o wizard recarregava a numeração por GET /fiscal/nfe/draft/:id depois de
// "Consultar situação" — rota que só devolve DRAFT/REJECTED e dá 404 para
// SENDING/AUTHORIZED; a tela ficava em "INCERTO" com a nota já autorizada.
//
// Contrato corrigido (Frente B):
//  - NumeracaoActions chama onChanged(d) com a RESPOSTA da consulta;
//  - o wizard aplica desfechoConsulta(d): `"numeracao" in d` ⇒ setNumeracao(d.numeracao ?? null);
//    AUTHORIZED ⇒ toast de sucesso + redireciona; nada de GET /fiscal/nfe/draft/:id;
//  - handleEmitir aplica desfechoEmissao: V2 em andamento (202/INCERTO) é toast INFO, nunca erro;
//  - GET /fiscal/nfe/draft/:id continua 404 para SENDING (não afrouxar findDraftById:
//    o wizard permite editar o que carrega). Lista/detalhe usam GET /fiscal/nfe[/:id].
//
// Tudo real, menos o transporte e a autenticação:
//  - PostgreSQL de verdade (schema descartável), repositórios reais;
//  - rotas Fastify reais (POST /issue, POST /consultar-situacao, GET /nfe/draft/:id, GET /nfe/:id);
//  - NfeEmissionUseCase real (contextoV2 → orquestrador V2 → FocusNfeV2Client real);
//  - o fetch global é o "Focus" (roteiro de respostas) e o "navegador"
//    (URL da API → app.inject). Qualquer outra URL LANÇA: nada sai da máquina;
//  - o componente REAL NumeracaoActions, montado em jsdom e clicado;
//  - handleAuthorized (DANFE/XML/cliente) é best-effort e não muda status: stub.
//
// Opt-in: NFE_TEST_DATABASE_URL=postgresql://postgres:<senha>@127.0.0.1:<porta>/nfe_test

const raw = process.env.NFE_TEST_DATABASE_URL;
const schema = `nfe_regr_${randomUUID().replace(/-/g, "")}`;
const API = "http://dexo-api.verify.local";

const h = vi.hoisted(() => ({
  configs: new Map<string, unknown>(),
  focus: { post: [] as Array<{ status: number; body: unknown }>, get: [] as Array<{ status: number; body: unknown }> },
  focusCalls: [] as string[],
  apiCalls: [] as string[],
}));

vi.mock("../../../../app/middlewares/auth.middleware", () => ({
  authMiddleware: async (request: { user?: unknown }) => {
    request.user = { id: "tenant", dataOwnerId: "tenant" };
  },
}));
// A config fica em memória para o repositório; a LINHA também é criada no banco
// porque attachFiscalLista (GET /fiscal/nfe/:id) lê CompanyFiscalConfig por SQL cru.
vi.mock("../../../../app/repositories/company-fiscal.repository", () => ({
  CompanyFiscalRepository: class {
    findByIdForUser = async (id: string) => h.configs.get(id) ?? null;
    findByUserId = async () => [...h.configs.values()][0] ?? null;
  },
}));
vi.mock("../../../../app/usecases/company-fiscal-resp-tec.usecase", () => ({ resolverRespTecEmpresa: async () => ({ origem: "OMITIR" }) }));

const describePg = describe.skipIf(!raw);
describePg("REGRESSÃO rotas-front-2: wizard × numeração V2 (Focus) depois de SENDING/AUTHORIZED", () => {
  let admin: PrismaClient;
  let app: FastifyInstance;
  let React: typeof import("react");
  let NumeracaoActions: typeof import("../../../../app/notas-fiscais/components/numeracao-actions").NumeracaoActions;
  let tela: (id: string, numeracao: unknown) => string;

  async function fetchFalso(input: string | URL, init?: RequestInit) {
    const u = String(input);
    if (u.startsWith("https://homologacao.focusnfe.com.br/")) {
      const metodo = init?.method ?? "GET";
      h.focusCalls.push(`${metodo} ${u.replace("https://homologacao.focusnfe.com.br", "")}`);
      const next = (metodo === "POST" ? h.focus.post : h.focus.get).shift();
      if (!next) throw new Error(`roteiro Focus esgotado para ${metodo} ${u}`);
      return new Response(JSON.stringify(next.body), { status: next.status, headers: { "content-type": "application/json" } });
    }
    if (u.startsWith(API)) {
      h.apiCalls.push(`${init?.method ?? "GET"} ${u.slice(API.length)}`);
      const r = await app.inject({ method: (init?.method ?? "GET") as "GET", url: u.slice(API.length), headers: init?.headers as Record<string, string>, payload: init?.body as string | undefined });
      return new Response(r.body, { status: r.statusCode, headers: { "content-type": "application/json" } });
    }
    throw new Error(`fetch bloqueado no teste: ${u}`);
  }

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

    // Rotas reais (o singleton do prisma lê DATABASE_URL no import ⇒ import dinâmico).
    const { default: Fastify } = await import("fastify");
    const { fiscalRoutes } = await import("../../../../app/routes/fiscal.routes");
    const { NfeEmissionUseCase } = await import("../../../../app/usecases/nfe-emission.usecase");
    vi.spyOn(NfeEmissionUseCase.prototype as never, "handleAuthorized" as never).mockResolvedValue({} as never);
    app = Fastify();
    await app.register(fiscalRoutes, { prefix: "/fiscal" });
    await app.ready();

    // Componente REAL da tela. O esbuild do vitest compila .tsx com o runtime
    // clássico (React.createElement global).
    React = await import("react");
    const { renderToString } = await import("react-dom/server");
    (globalThis as { React?: unknown }).React = React;
    NumeracaoActions = (await import("../../../../app/notas-fiscais/components/numeracao-actions")).NumeracaoActions;
    tela = (id, numeracao) => renderToString(React.createElement(NumeracaoActions as never, { id, email: "kiko@verify.local", numeracao } as never)).replace(/<!-- -->/g, "");
  }, 180000);

  afterAll(async () => {
    await app?.close();
    const prisma = (await import("../../../../app/lib/prisma")).default as unknown as PrismaClient;
    await prisma.$disconnect();
    if (admin) {
      await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.$disconnect();
    }
  });

  beforeEach(() => {
    h.focus.post = []; h.focus.get = []; h.focusCalls = []; h.apiCalls = [];
    vi.stubEnv("API_URL", API);
    // NumeracaoActions roda "no navegador" (jsdom): getApiBaseUrl só lê NEXT_PUBLIC_*.
    vi.stubEnv("NEXT_PUBLIC_API_URL", API);
    vi.stubEnv("NFE_DEVOLUCAO_ENABLED", "false");
    vi.stubEnv("NFE_NUMERACAO_V2_ENABLED", "true");
    vi.stubEnv("NFE_NUMERACAO_V2_MODELOS", "55");
    vi.stubEnv("NFE_NUMERACAO_V2_FOCUS_ENABLED", "true");
    vi.stubGlobal("fetch", fetchFalso);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  let seqCnpj = 0;
  async function cenario() {
    const cfc = `cfg-${randomUUID().slice(0, 8)}`;
    vi.stubEnv("NFE_NUMERACAO_V2_CONFIG_IDS", cfc);
    const config = makeConfig({ id: cfc, userId: "tenant", providerName: "FOCUS_NFE", providerToken: "tok-homolog", isDefault: false });
    h.configs.set(cfc, config);
    await admin.companyFiscalConfig.create({
      // (userId, cnpj) é único e cada caso cria a sua config: CNPJ só da linha; attachFiscalLista lê id/provedor.
      data: { id: cfc, userId: "tenant", isDefault: false, cnpj: `99${String(++seqCnpj).padStart(12, "0")}`, razaoSocial: config.razaoSocial, inscricaoEstadual: config.inscricaoEstadual, regimeTributario: "SIMPLES", ambiente: "HOMOLOGACAO", providerName: "FOCUS_NFE", providerToken: "tok-homolog", uf: "SP" },
    });
    const base = makeDraft({ userId: "tenant", companyFiscalConfigId: cfc });
    const nota = await admin.nfeEmitida.create({
      data: {
        userId: "tenant", companyFiscalConfigId: cfc, ambiente: "HOMOLOGACAO", modelo: "55", serie: 1, numero: -1, status: "DRAFT",
        tipoOperacao: base.tipoOperacao, finalidade: base.finalidade, destinoOperacao: base.destinoOperacao,
        naturezaOperacao: base.naturezaOperacao, indPresenca: base.indPresenca, destinatarioJson: base.destinatarioJson as object,
        emittedByUserId: "tenant",
        itens: { create: [{ numero: 1, codigo: "P1", descricao: "PECA TESTE", ncm: "87089990", cfop: "5102", origem: 0, unidade: "UN", quantidade: 1, valorUnitario: 100, valorTotal: 100 }] },
      },
    });
    const { montarChave, chaveToString } = await import("../../../../app/fiscal/sefaz/chave-acesso");
    const chaveDe = (numero: number) => chaveToString(montarChave({ uf: "SP", ano: 2026, mes: 9, cnpj: config.cnpj, modelo: "55", serie: 1, numero, tpEmis: 1, cNF: "40718263" }));
    const post = (path: string, body?: unknown) => app.inject({ method: "POST", url: `/fiscal/nfe/${nota.id}${path}`, headers: { email: "kiko@verify.local", "content-type": "application/json" }, payload: JSON.stringify(body ?? {}) });
    const get = (path: string) => app.inject({ method: "GET", url: `/fiscal/nfe/${path}`, headers: { email: "kiko@verify.local" } });
    const statusNota = async () => (await admin.nfeEmitida.findUnique({ where: { id: nota.id }, select: { status: true, numero: true } }))!;
    return { id: nota.id, cfc, config, chaveDe, post, get, statusNota };
  }

  /** Emite: Focus POST 202 → GET imediato ainda processando ⇒ INCERTO (caminho padrão do Focus). */
  async function emitirAteIncerto(w: Awaited<ReturnType<typeof cenario>>) {
    h.focus.post.push({ status: 202, body: { status: "processando_autorizacao" } });
    h.focus.get.push({ status: 200, body: { status: "processando_autorizacao" } });
    return w.post("/issue", { confirmarDescarteNumero: false });
  }

  it("★ 'Consultar situação' autoriza ⇒ NumeracaoActions entrega a resposta ao onChanged e o wizard atualiza por ela (sem GET /nfe/draft/:id)", async () => {
    const w = await cenario();

    // 1) /issue: 202 → INCERTO. O handleEmitir mostra INFO (nunca erro) e a reserva.
    const issue = await emitirAteIncerto(w);
    expect(issue.statusCode).toBe(200);
    const corpoIssue = issue.json() as RespostaNumeracao;
    expect(corpoIssue).toMatchObject({ success: false, status: "SENDING", emAndamento: true, numeracao: { estado: "INCERTO", numero: 1 } });
    expect(await w.statusNota()).toEqual({ status: "SENDING", numero: 1 });
    const aposEmitir = desfechoEmissao(true, corpoIssue);
    expect(aposEmitir.toast).toEqual({ msg: MSG_EM_ANDAMENTO, type: "info" });
    expect(aposEmitir.numeracao).toMatchObject({ estado: "INCERTO", numero: 1 });
    expect(tela(w.id, aposEmitir.numeracao)).toContain("Nº 1: INCERTO");

    // 2) Monta o NumeracaoActions REAL (jsdom) como o wizard: onChanged ⇒ desfechoConsulta(d).
    h.focus.get.push({ status: 200, body: { status: "autorizado", status_sefaz: "100", mensagem_sefaz: "Autorizado o uso da NF-e", chave_nfe: `NFe${w.chaveDe(1)}`, protocolo: "135260000000777" } });
    const { builtinEnvironments } = await import("vitest/environments");
    const env = await builtinEnvironments.jsdom.setup(globalThis, { jsdom: { url: "http://localhost:3000/notas-fiscais/nfe" } } as never);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    globalThis.fetch = fetchFalso as never;
    const recebidos: RespostaNumeracao[] = [];
    const desfechos: DesfechoTela[] = [];
    try {
      const { createRoot } = await import("react-dom/client");
      const Wizardzinho = () => {
        const [numeracao, setNumeracao] = React.useState<unknown>(aposEmitir.numeracao);
        return React.createElement(NumeracaoActions as never, {
          id: w.id, email: "kiko@verify.local", numeracao,
          onChanged: (d: RespostaNumeracao) => {
            recebidos.push(d);
            const x = desfechoConsulta(d);
            desfechos.push(x);
            if (x.numeracao !== undefined) setNumeracao(x.numeracao);
          },
        } as never);
      };
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      await React.act(async () => { root.render(React.createElement(Wizardzinho)); });
      const botao = [...container.querySelectorAll("button")].find((b) => b.textContent === "Consultar situação");
      expect(botao, container.innerHTML).toBeTruthy();
      await React.act(async () => { botao!.click(); });
      for (let i = 0; i < 50 && recebidos.length === 0; i++) await React.act(async () => { await new Promise((r) => setTimeout(r, 20)); });

      // A consulta passou pela rota real e a RESPOSTA chegou ao onChanged.
      expect(h.apiCalls).toEqual([`POST /fiscal/nfe/${w.id}/consultar-situacao`]);
      expect(recebidos).toHaveLength(1);
      expect(recebidos[0]).toMatchObject({ success: true, status: "AUTHORIZED", numero: 1, numeracao: { estado: "AUTORIZADO", numero: 1 } });
      // O wizard: numeracao AUTORIZADO, toast de sucesso e redireciona — como o handleEmitir.
      expect(desfechos[0]).toMatchObject({ numeracao: { estado: "AUTORIZADO", numero: 1 }, toast: { type: "success" }, redirecionar: true });
      expect(desfechos[0].toast!.msg).toMatch(/^NF-e 1 autorizada! Chave: /);
      // Nenhuma recarga por GET /fiscal/nfe/draft/:id (dá 404 para AUTHORIZED).
      expect(h.apiCalls.some((c) => c.includes("/fiscal/nfe/draft/"))).toBe(false);
      // A tela saiu de INCERTO.
      expect(container.textContent).toContain("Nº 1: AUTORIZADO");
      expect(container.textContent).not.toMatch(/INCERTO|Consultar situação/);
      expect(container.querySelector("[role=status]")?.textContent).toBeTruthy();
      await React.act(async () => { root.unmount(); });
    } finally {
      env.teardown(globalThis);
    }

    expect(await w.statusNota()).toEqual({ status: "AUTHORIZED", numero: 1 });
    expect(h.focusCalls.filter((c) => c.startsWith("POST"))).toHaveLength(1);
  }, 120000);

  it("contrato: nota SENDING/INCERTO — GET /fiscal/nfe/draft/:id segue 404 (o wizard não depende dele); GET /fiscal/nfe/:id (lista/detalhe) traz a numeração", async () => {
    const w = await cenario();
    const issue = await emitirAteIncerto(w);
    expect(issue.json()).toMatchObject({ status: "SENDING", numeracao: { estado: "INCERTO" } });

    // Não afrouxar findDraftById: o wizard permite editar o que carrega.
    // (Pendência conhecida, fora desta frente: F5 em ?draft=<id> de nota SENDING
    // ainda cai em createDraft() silencioso — ver relatório da Frente B.)
    const rascunho = await w.get(`draft/${w.id}`);
    expect(rascunho.statusCode).toBe(404);

    const detalhe = await w.get(w.id);
    expect(detalhe.statusCode).toBe(200);
    expect(detalhe.json()).toMatchObject({ nfe: { id: w.id, status: "SENDING", numeracao: { estado: "INCERTO", numero: 1 } } });
  }, 120000);

  it("fora de ESTADOS_VIVOS: rejeitada (nº mantido) → reemissão DENEGADA ⇒ a resposta traz numeracao:null e a tela deixa de dizer 'mantido para nova tentativa'", async () => {
    const w = await cenario();

    // 1ª emissão: rejeição 225 ⇒ REJEITADO, nº 1 mantido.
    h.focus.post.push({ status: 200, body: { status: "erro_autorizacao", status_sefaz: "225", mensagem_sefaz: "Rejeicao: Falha no Schema XML da NFe" } });
    const r1 = (await w.post("/issue", { confirmarDescarteNumero: false })).json() as RespostaNumeracao;
    expect(r1).toMatchObject({ status: "REJECTED", numeracao: { estado: "REJEITADO", numero: 1, reutilizavel: true } });
    const d1 = desfechoEmissao(true, r1);
    expect(d1.toast?.type).toBe("error");
    let numeracao: unknown = null;
    if (d1.numeracao !== undefined) numeracao = d1.numeracao;
    expect(tela(w.id, numeracao)).toContain("Nº 1: mantido para nova tentativa");

    // Usuário corrige e reemite: Focus 202 → GET denegado (302) ⇒ DENEGADO (consumido).
    await admin.nfeEmitida.update({ where: { id: w.id }, data: { naturezaOperacao: "VENDA CORRIGIDA" } });
    h.focus.post.push({ status: 202, body: { status: "processando_autorizacao" } });
    h.focus.get.push({ status: 200, body: { status: "denegado", status_sefaz: "302", mensagem_sefaz: "Uso Denegado: Irregularidade fiscal do destinatario" } });
    const r2 = (await w.post("/issue", { confirmarDescarteNumero: false })).json() as RespostaNumeracao;
    const reservas = await admin.$queryRawUnsafe<Array<{ numero: number; estado: string }>>(`SELECT "numero","estado" FROM "NfeNumeroReserva" WHERE "nfeId"=$1`, w.id);
    expect(reservas).toEqual([{ numero: 1, estado: "DENEGADO" }]);

    // handleEmitir: `"numeracao" in data` ⇒ setNumeracao(data.numeracao ?? null).
    expect("numeracao" in r2).toBe(true);
    const d2 = desfechoEmissao(true, r2);
    expect(d2.numeracao).toBeNull();
    expect(d2.toast?.type).toBe("error");
    if (d2.numeracao !== undefined) numeracao = d2.numeracao;
    expect(tela(w.id, numeracao)).not.toContain("mantido para nova tentativa");
  }, 120000);
});
