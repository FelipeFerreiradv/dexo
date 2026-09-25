import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { makeConfig, makeDraft } from "../../__helpers__/test-draft";
import { criarSchemaNfe, urlTestePostgres, type SchemaNfe } from "../../__harness__/pg-nfe-schema";

// INTEGRAÇÃO G1 × G2 (contratos C1 e C2), ponta a ponta: a TELA real chama a ROTA real, que grava no
// PostgreSQL real. Os specs dos grupos provaram cada lado contra um dublê do outro (o G2 com fetch
// simulado, o G1 com Fastify inject ou direto no caso de uso); aqui o corpo que a tela manda é o que
// o servidor lê, e o 409 que o servidor devolve é o que a tela interpreta.
//
//  C2 — linha BLOQUEADO (613 no envio, consulta sem chave referida): a lista mostra "retido para
//       conferência", o 1º clique vai com `{}` e volta 409 NUMERACAO_CONFIRMAR_DESCARTE, a
//       confirmação vai com `{confirmar:true}` e volta 200; a tela abre a nota no assistente
//       (`?draft=`), que a carrega como rascunho, e a emissão seguinte sai com número NOVO. Lista
//       velha (a mesma linha ainda BLOQUEADO na tela) ⇒ 409 NUMERACAO_NAO_BLOQUEADA vira mensagem,
//       sem pedir confirmação; nota de outro tenant ⇒ 404 com a frase do servidor.
//  C1 — "Inutilizar numeração" numa faixa com reserva REJEITADO e linha REJECTED legada: 1º POST sem
//       `confirmarDescarteNumeros` ⇒ 409 com `detalhes.numeros`; a tela lista os números e o reenvio
//       confirmado inutiliza a faixa, a nota volta a rascunho e a linha legada fica intacta.
//  V1 — config fora da V2: a mesma tela inutiliza direto (um POST, nenhum diálogo, ledger vazio).
//
// Só o transporte SEFAZ, a leitura de CompanyFiscalConfig pelo repositório e a autenticação são
// simulados. O fetch da tela vai para `app.inject`; qualquer outra URL LANÇA: nada sai da máquina.
// Opt-in: NFE_TEST_DATABASE_URL (localhost, banco nfe_test).

const raw = urlTestePostgres();
const API = "http://api.integ.local";

const h = vi.hoisted(() => {
  const flagAntes = process.env.NEXT_PUBLIC_FISCAL_MODULE_ENABLED;
  process.env.NEXT_PUBLIC_FISCAL_MODULE_ENABLED = "true";
  return {
    flagAntes,
    code: 100,
    inutilizacoes: [] as Array<{ ini: number; fim: number }>,
    configs: new Map<string, any>(),
    /** email do cabeçalho ⇒ tenant (dataOwnerId), como o authMiddleware real resolve pelo usuário. */
    tenantDoEmail: new Map<string, string>(),
    sessao: { data: { user: { email: "" } }, status: "authenticated" as const },
    navegou: [] as string[],
  };
});

vi.mock("../../../../app/fiscal/providers/sefaz-direct.provider", async () => {
  const { montarChave, chaveToString } = await import("../../../../app/fiscal/sefaz/chave-acesso");
  const XMOTIVO: Record<number, string> = { 225: "Rejeicao: Falha no Schema XML", 613: "Rejeicao: Chave de Acesso difere da existente em BD" };
  class SefazDirectProvider {
    static montarNfeProc() { return "<nfeProc/>"; }
    prepararEmissao(p: { config: { cnpj: string }; draft: { serie: number }; numero: number; cNF: string; dhEmi: Date }) {
      const chaveAcesso = chaveToString(montarChave({ uf: "SP", ano: 2026, mes: 9, cnpj: p.config.cnpj, modelo: "55", serie: p.draft.serie, numero: p.numero, tpEmis: 1, cNF: p.cNF }));
      return { numero: p.numero, cNF: p.cNF, dhEmi: p.dhEmi, chaveAcesso, signedXml: "<signed/>", digestValue: "digest", modelo: "55", tpEmis: 1 };
    }
    async transmitirPreparada(p: { chaveAcesso: string }) {
      const ok = h.code === 100;
      return { transporte: null, httpStatus: 200, loteCStat: 104, loteXMotivo: "Lote processado", protCStat: h.code, protXMotivo: ok ? "Autorizado o uso da NF-e" : XMOTIVO[h.code] ?? "Rejeicao",
        nProt: ok ? "135260000000001" : null, dhRecbto: new Date(), nRec: null, chNFe: p.chaveAcesso, protNFeXml: null, xmlAutorizado: ok ? "<nfeProc/>" : null };
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
// Admin do tenant (sem parentUserId): exigeAcessoFiscal passa sem I/O, como em produção.
vi.mock("../../../../app/middlewares/auth.middleware", () => ({
  authMiddleware: async (request: { headers: Record<string, unknown>; user?: unknown }) => {
    const email = String(request.headers.email ?? "");
    request.user = { id: `colab-${email}`, dataOwnerId: h.tenantDoEmail.get(email) ?? "tenant-desconhecido" };
  },
}));

// ── Frontend: só o que o jsdom não tem ou o que não participa do contrato ──
vi.mock("next-auth/react", () => ({ useSession: () => h.sessao }));
vi.mock("next/navigation", () => {
  const router = { push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, prefetch: () => {} };
  return { useRouter: () => router, usePathname: () => "/notas-fiscais/inutilizar-numero", useSearchParams: () => new URLSearchParams() };
});
vi.mock("@/lib/api", () => ({ getApiBaseUrl: () => API, authHeaders: () => ({}) }));
vi.mock("../../../../app/notas-fiscais/lib/nfe-navegacao", () => ({ navegarPara: (u: string) => { h.navegou.push(u); } }));
vi.mock("@/components/ui/toast-viewport", async () => {
  const { createElement: e } = await import("react");
  return { ToastViewport: (p: any) => e("div", { role: "status" }, p.children) };
});
vi.mock("@/components/page-header", async () => {
  const { createElement: e } = await import("react");
  return { PageHeader: ({ title }: any) => e("h1", null, title) };
});
vi.mock("@/components/ui/alert-dialog", async () => {
  const { createElement: e } = await import("react");
  return {
    AlertDialog: ({ open, children }: any) => (open ? e("section", { "data-testid": "dialogo" }, children) : null),
    AlertDialogContent: ({ children }: any) => e("div", null, children),
    AlertDialogHeader: ({ children }: any) => e("div", null, children),
    AlertDialogFooter: ({ children }: any) => e("div", null, children),
    AlertDialogTitle: ({ children }: any) => e("h2", null, children),
    AlertDialogDescription: ({ children }: any) => e("div", null, children),
    AlertDialogCancel: ({ children, onClick, disabled }: any) => e("button", { type: "button", onClick, disabled }, children),
  };
});

const JUSTIFICATIVA = "Numeros presos em notas nao emitidas";

describe.skipIf(!raw)("INTEGRAÇÃO C1/C2: tela real × rota real × PostgreSQL real", () => {
  let db: SchemaNfe;
  let app: FastifyInstance;
  let mods: {
    Orchestrator: typeof import("../../../../app/usecases/nfe-emissao-v2.orchestrator").NfeEmissaoV2Orchestrator;
    NfeRepository: typeof import("../../../../app/repositories/nfe.repository").NfeRepository;
    prisma: import("@prisma/client").PrismaClient;
    montarChave: typeof import("../../../../app/fiscal/sefaz/chave-acesso").montarChave;
    chaveToString: typeof import("../../../../app/fiscal/sefaz/chave-acesso").chaveToString;
    isCnfProibido: typeof import("../../../../app/fiscal/sefaz/chave-acesso").isCnfProibido;
  };
  /** Toda chamada da tela à API: método, caminho, corpo e o status que voltou. */
  let chamadas: Array<{ metodo: string; caminho: string; corpo: any; status: number }> = [];

  beforeAll(async () => {
    db = await criarSchemaNfe(raw!, "nfe_integ");
    process.env.DATABASE_URL = db.url;
    const chave = await import("../../../../app/fiscal/sefaz/chave-acesso");
    mods = {
      Orchestrator: (await import("../../../../app/usecases/nfe-emissao-v2.orchestrator")).NfeEmissaoV2Orchestrator,
      NfeRepository: (await import("../../../../app/repositories/nfe.repository")).NfeRepository,
      prisma: (await import("../../../../app/lib/prisma")).default,
      montarChave: chave.montarChave,
      chaveToString: chave.chaveToString,
      isCnfProibido: chave.isCnfProibido,
    };
    const { default: Fastify } = await import("fastify");
    const { fiscalRoutes } = await import("../../../../app/routes/fiscal.routes");
    app = Fastify();
    await app.register(fiscalRoutes, { prefix: "/fiscal" });
    await app.ready();
  }, 180000);

  afterAll(async () => {
    if (app) await app.close();
    if (mods?.prisma) await mods.prisma.$disconnect();
    if (db) await db.destruir();
    if (h.flagAntes === undefined) delete process.env.NEXT_PUBLIC_FISCAL_MODULE_ENABLED;
    else process.env.NEXT_PUBLIC_FISCAL_MODULE_ENABLED = h.flagAntes;
  });

  afterEach(() => { vi.unstubAllEnvs(); });

  /** O "navegador": a URL da API vai para a rota real; qualquer outra lança. */
  let emVoo = 0;
  async function fetchDaTela(input: string | URL, init?: RequestInit) {
    const u = String(input);
    if (!u.startsWith(API)) throw new Error(`fetch bloqueado no teste: ${u}`);
    const metodo = String(init?.method ?? "GET");
    emVoo++;
    try {
      const r = await app.inject({ method: metodo as "GET", url: u.slice(API.length), headers: init?.headers as Record<string, string>, payload: init?.body as string | undefined });
      chamadas.push({ metodo, caminho: u.slice(API.length), corpo: init?.body ? JSON.parse(String(init.body)) : undefined, status: r.statusCode });
      return new Response(r.body, { status: r.statusCode, headers: { "content-type": "application/json" } });
    } finally {
      emVoo--;
    }
  }

  /** jsdom só durante a parte de tela: o backend (Prisma, Fastify) sobe e roda em node. */
  async function comTela<T>(fn: (t: {
    React: typeof import("react");
    container: HTMLDivElement;
    render: (el: unknown) => Promise<void>;
    esperar: () => Promise<void>;
    clicar: (rotulo: string, dentro?: ParentNode) => Promise<void>;
    digitar: (seletor: string, valor: string) => Promise<void>;
  }) => Promise<T>): Promise<T> {
    const { builtinEnvironments } = await import("vitest/environments");
    const env = await builtinEnvironments.jsdom.setup(globalThis, { jsdom: { url: "http://localhost:3000/notas-fiscais/emitidas" } } as never);
    const fetchOriginal = globalThis.fetch;
    globalThis.fetch = fetchDaTela as never;
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const React = await import("react");
    (globalThis as any).React = React;
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    // Espera a tela assentar: nenhuma chamada à API em voo por 5 ticks seguidos (teto de 20 s).
    const esperar = async () => {
      const limite = Date.now() + 20000;
      for (let quietos = 0; quietos < 5 && Date.now() < limite;) {
        await React.act(async () => { await new Promise((r) => setTimeout(r, 10)); });
        quietos = emVoo === 0 ? quietos + 1 : 0;
      }
    };
    const botao = (rotulo: string, dentro: ParentNode = container) => {
      const b = Array.from(dentro.querySelectorAll("button")).find((x) => (x.textContent ?? "").includes(rotulo));
      if (!b) throw new Error(`botão "${rotulo}" não está na tela. Texto: ${container.textContent}`);
      return b as HTMLButtonElement;
    };
    try {
      return await fn({
        React, container,
        render: async (el) => { await React.act(async () => { root.render(el as never); }); await esperar(); },
        esperar,
        clicar: async (rotulo, dentro) => { await React.act(async () => { botao(rotulo, dentro).click(); }); await esperar(); },
        digitar: async (seletor, valor) => {
          const el = container.querySelector(seletor) as HTMLInputElement | HTMLTextAreaElement;
          const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          await React.act(async () => {
            Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, valor);
            el.dispatchEvent(new Event("input", { bubbles: true }));
          });
        },
      });
    } finally {
      await React.act(async () => { root.unmount(); });
      container.remove();
      globalThis.fetch = fetchOriginal;
      env.teardown(globalThis);
    }
  }

  async function cenario(opts: { ambiente?: "HOMOLOGACAO" | "PRODUCAO"; naV2?: boolean } = {}) {
    const ambiente = opts.ambiente ?? "PRODUCAO";
    h.code = 100; h.inutilizacoes = []; h.navegou = []; chamadas = [];
    const userId = `tenant-${randomUUID().slice(0, 8)}`;
    const email = `${userId}@integ.local`;
    h.tenantDoEmail.set(email, userId);
    h.sessao = { data: { user: { email } }, status: "authenticated" };
    const cfc = `cfg-${randomUUID().slice(0, 8)}`;
    const config = makeConfig({ id: cfc, userId, providerName: "SEFAZ_DIRECT", ambiente, isDefault: true, serieNfe: 1 } as never);
    h.configs.set(cfc, config);
    // attachFiscalLista (GET /fiscal/nfe/:id) lê CompanyFiscalConfig por SQL cru: a linha existe no banco também.
    await db.admin.companyFiscalConfig.create({ data: { id: cfc, userId, isDefault: true, cnpj: config.cnpj, razaoSocial: "DESMANCHE INTEG", inscricaoEstadual: "123456789", regimeTributario: "SIMPLES", ambiente, providerName: "SEFAZ_DIRECT", uf: "SP" } });
    vi.stubEnv("NFE_NUMERACAO_V2_ENABLED", "true");
    vi.stubEnv("NFE_NUMERACAO_V2_CONFIG_IDS", opts.naV2 === false ? "cfg-de-outra-empresa" : cfc);
    vi.stubEnv("NFE_NUMERACAO_V2_MODELOS", "55");
    vi.stubEnv("NFE_NUMERACAO_V2_FOCUS_ENABLED", "false");
    vi.stubEnv("NFE_DEVOLUCAO_ENABLED", "false");
    vi.stubEnv("NFE_RESP_TEC_EMPRESA_ENABLED", "false");

    const base = makeDraft({ userId, companyFiscalConfigId: cfc });
    const storage = { saveXmlTentativa: async () => "/tmp/assinado.xml", readFile: async () => Buffer.from("<signed/>") };
    const repo = new mods.NfeRepository();
    const orq = new mods.Orchestrator({ validar: () => {}, snapshot: () => ({}), autorizado: async () => ({}) as never }, undefined, repo, storage as never);
    // cNF próprio do cenário: o CNPJ do makeConfig é o mesmo em todos, e a chave é única no banco.
    let cNF = "";
    do cNF = String(Math.floor(Math.random() * 1e8)).padStart(8, "0"); while (mods.isCnfProibido(cNF));
    const chaveDe = (numero: number) => mods.chaveToString(mods.montarChave({ uf: "SP", ano: 2026, mes: 9, cnpj: config.cnpj, modelo: "55", serie: 1, numero, tpEmis: 1, cNF }));
    const criar = async (status = "DRAFT", numero = -1, extra: Record<string, unknown> = {}) => (await db.admin.nfeEmitida.create({
      data: {
        userId, companyFiscalConfigId: cfc, ambiente, modelo: "55", serie: 1, numero, status,
        tipoOperacao: base.tipoOperacao, finalidade: base.finalidade, destinoOperacao: base.destinoOperacao,
        naturezaOperacao: base.naturezaOperacao, indPresenca: base.indPresenca, destinatarioJson: base.destinatarioJson as object,
        emittedByUserId: userId, ...extra,
        itens: { create: [{ numero: 1, codigo: "P1", descricao: "PECA TESTE", ncm: "87089990", cfop: "5102", origem: 0, unidade: "UN", quantidade: 1, valorUnitario: 100, valorTotal: 100 }] },
      },
    })).id;
    const emitir = async (id: string) => orq.emitir(userId, (await repo.findNfeById(userId, id))!, config);
    const nota = async (id: string) => (await db.admin.nfeEmitida.findUnique({ where: { id }, select: { status: true, numero: true, cStatRejeicao: true, chaveAcesso: true } }))!;
    const reservas = (id: string) => db.admin.$queryRawUnsafe<Array<{ numero: number; estado: string; requerInutilizacao: boolean; motivo: string | null }>>(
      `SELECT "numero","estado","requerInutilizacao","motivo" FROM "NfeNumeroReserva" WHERE "nfeId"=$1 ORDER BY "createdAt","numero"`, id);
    const doLedger = () => db.admin.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM "NfeNumeroReserva" WHERE "companyFiscalConfigId"=$1`, cfc);
    await criar("AUTHORIZED", 500, { chaveAcesso: chaveDe(500), protocoloAutorizacao: "135250000000500" });
    return { userId, email, cfc, criar, emitir, nota, reservas, doLedger };
  }

  it("C2: lista com BLOQUEADO ⇒ {} dá 409 e a confirmação, {confirmar:true} dá 200 e abre o assistente; a nota volta a rascunho e sai com número novo", async () => {
    const w = await cenario();
    const x = await w.criar();
    h.code = 613;
    await w.emitir(x);
    expect(await w.reservas(x)).toMatchObject([{ numero: 501, estado: "BLOQUEADO" }]);

    // A linha como a lista recebe (GET /fiscal/nfe/:id passa por attachFiscalLista).
    const linha = (await (await fetchDaTela(`${API}/fiscal/nfe/${x}`, { headers: { email: w.email } })).json()).nfe;
    expect(linha.numeracao).toMatchObject({ estado: "BLOQUEADO", numero: 501, serie: 1, reutilizavel: false });
    chamadas = [];

    await comTela(async (t) => {
      const { NumeracaoActions } = await import("../../../../app/notas-fiscais/components/numeracao-actions");
      // Como a lista monta (sem onDescartado ⇒ abre a nota no assistente).
      await t.render(t.React.createElement(NumeracaoActions as never, { id: x, email: w.email, numeracao: linha.numeracao, retomavel: linha.retomavel, compacto: true } as never));
      expect(t.container.textContent).toContain("Nº 501: retido para conferência");

      await t.clicar("Descartar o nº 501 e emitir com número novo");
      expect(chamadas).toEqual([{ metodo: "POST", caminho: `/fiscal/nfe/${x}/numeracao/descartar-bloqueado`, corpo: {}, status: 409 }]);
      const pergunta = t.container.querySelector('[role="alertdialog"]');
      expect(pergunta, t.container.textContent ?? "").toBeTruthy();
      // A frase é a do SERVIDOR (confirmar que NÃO foi autorizado), mais a consequência na tela.
      expect(pergunta!.textContent).toContain("O nº 501 (série 1) está retido para conferência: confirme que ele NÃO foi autorizado na SEFAZ");
      expect(pergunta!.textContent).toContain("Descartado, a nota volta a ser rascunho");
      expect(await w.reservas(x)).toMatchObject([{ numero: 501, estado: "BLOQUEADO" }]);

      await t.clicar("Confirmo: descartar o número", pergunta!);
      expect(chamadas[1]).toEqual({ metodo: "POST", caminho: `/fiscal/nfe/${x}/numeracao/descartar-bloqueado`, corpo: { confirmar: true }, status: 200 });
      expect(chamadas).toHaveLength(2);
      expect(h.navegou).toEqual([`/notas-fiscais/nfe?draft=${encodeURIComponent(x)}`]);
    });

    expect(await w.reservas(x)).toEqual([{ numero: 501, estado: "ABANDONADO", requerInutilizacao: true, motivo: "NUMERO_RETIDO_DESCARTADO" }]);
    expect(await w.nota(x)).toMatchObject({ status: "DRAFT", cStatRejeicao: 613, chaveAcesso: null });
    expect((await w.nota(x)).numero).toBeLessThan(0);

    // O destino da navegação existe: o assistente carrega a nota por GET /fiscal/nfe/draft/:id.
    const rascunho = await fetchDaTela(`${API}/fiscal/nfe/draft/${x}`, { headers: { email: w.email } });
    expect(rascunho.status).toBe(200);
    // Mesmo formato que o loadDraft do assistente lê (`data.draft`).
    expect((await rascunho.json()).draft).toMatchObject({ id: x, status: "DRAFT" });

    h.code = 100;
    expect(await w.emitir(x)).toMatchObject({ success: true, status: "AUTHORIZED", numero: 502 });
  }, 120000);

  it("C2: tela velha (a linha ainda BLOQUEADO) ⇒ 409 NUMERACAO_NAO_BLOQUEADA vira mensagem, sem confirmação; outro tenant ⇒ 404", async () => {
    const w = await cenario();
    const x = await w.criar();
    h.code = 613;
    await w.emitir(x);
    const linhaVelha = (await (await fetchDaTela(`${API}/fiscal/nfe/${x}`, { headers: { email: w.email } })).json()).nfe;
    expect(linhaVelha.numeracao).toMatchObject({ estado: "BLOQUEADO", numero: 501 });
    // Alguém descartou por outra aba.
    expect((await fetchDaTela(`${API}/fiscal/nfe/${x}/numeracao/descartar-bloqueado`, { method: "POST", headers: { "Content-Type": "application/json", email: w.email }, body: JSON.stringify({ confirmar: true }) })).status).toBe(200);
    chamadas = [];

    await comTela(async (t) => {
      const { NumeracaoActions } = await import("../../../../app/notas-fiscais/components/numeracao-actions");
      await t.render(t.React.createElement(NumeracaoActions as never, { id: x, email: w.email, numeracao: linhaVelha.numeracao, compacto: true } as never));
      await t.clicar("Descartar o nº 501 e emitir com número novo");
      expect(chamadas).toEqual([{ metodo: "POST", caminho: `/fiscal/nfe/${x}/numeracao/descartar-bloqueado`, corpo: {}, status: 409 }]);
      expect(t.container.querySelector('[role="alertdialog"]')).toBeNull();
      expect(t.container.querySelector('[role="status"]')?.textContent).toBe("O número desta NF-e não está retido para conferência — não há o que descartar");
      expect(h.navegou).toEqual([]);
    });

    // Outro tenant: a mesma chamada da tela (lib do G2) recebe o 404 do servidor, e nada muda.
    const outro = `intruso-${randomUUID().slice(0, 6)}@integ.local`;
    h.tenantDoEmail.set(outro, "tenant-intruso");
    const { descartarNumeroBloqueado } = await import("../../../../app/notas-fiscais/lib/nfe-numeracao-ui");
    expect(await descartarNumeroBloqueado({ base: API, email: outro, nfeId: x, confirmar: true, fetchImpl: fetchDaTela as never }))
      .toEqual({ ok: false, confirmar: false, mensagem: "NF-e não encontrada" });
    expect(await w.reservas(x)).toMatchObject([{ numero: 501, estado: "ABANDONADO" }]);
  }, 120000);

  it("C1: inutilizar faixa com reserva REJEITADO ⇒ 409 com os números, a tela confirma e reenvia com confirmarDescarteNumeros:true; a legada fica intacta", async () => {
    const w = await cenario();
    const y = await w.criar();
    h.code = 225;
    await w.emitir(y);
    expect(await w.reservas(y)).toMatchObject([{ numero: 501, estado: "REJEITADO" }]);
    // Linha REJECTED do V1 (sem reserva) dentro da faixa: não barra e fica como está.
    const legada = await w.criar("REJECTED", 502, { cStatRejeicao: 225, motivoRejeicao: "Rejeicao: Falha no Schema XML" });
    chamadas = [];

    await comTela(async (t) => {
      const { default: InutilizarNumeroPage } = await import("../../../../app/notas-fiscais/inutilizar-numero/page");
      await t.render(t.React.createElement(InutilizarNumeroPage));
      await t.digitar("#serie", "1");
      await t.digitar("#numero-inicial", "501");
      await t.digitar("#numero-final", "502");
      await t.digitar("#justificativa", JUSTIFICATIVA);
      await t.clicar("Inutilizar Numeracao");
      await t.clicar("Confirmar Inutilizacao");

      const posts = () => chamadas.filter((c) => c.metodo === "POST");
      expect(posts()).toEqual([{ metodo: "POST", caminho: "/fiscal/inutilizacao", corpo: { serie: 1, numeroInicial: 501, numeroFinal: 502, justificativa: JUSTIFICATIVA }, status: 409 }]);
      expect(h.inutilizacoes).toEqual([]);
      const dialogos = t.container.querySelectorAll('[data-testid="dialogo"]');
      expect(dialogos).toHaveLength(1);
      expect(dialogos[0].textContent).toContain("Números presos em notas não emitidas");
      // Os números e a série vêm de `detalhes` do 409 real; a frase de cima é a do servidor.
      expect(dialogos[0].textContent).toContain("O nº 501 da série 1 está reservado para uma nota que ainda não foi autorizada");
      expect(dialogos[0].textContent).toContain("O nº 501 (série 1) está reservado para uma NF-e não autorizada");
      expect(dialogos[0].textContent).not.toContain("502 da série");

      await t.clicar("Descartar os números e inutilizar", dialogos[0]);
      expect(posts()[1]).toEqual({ metodo: "POST", caminho: "/fiscal/inutilizacao", corpo: { serie: 1, numeroInicial: 501, numeroFinal: 502, justificativa: JUSTIFICATIVA, confirmarDescarteNumeros: true }, status: 200 });
      expect(posts()).toHaveLength(2);
      expect(t.container.querySelectorAll('[data-testid="dialogo"]')).toHaveLength(0);
    });

    expect(h.inutilizacoes).toEqual([{ ini: 501, fim: 502 }]);
    expect(await w.reservas(y)).toMatchObject([{ numero: 501, estado: "INUTILIZADO" }]);
    expect(await w.nota(y)).toMatchObject({ status: "DRAFT", cStatRejeicao: 225, chaveAcesso: null });
    expect(await w.nota(legada)).toMatchObject({ status: "REJECTED", numero: 502, cStatRejeicao: 225 });
    const inut = await db.admin.$queryRawUnsafe<Array<{ status: string; numeroInicial: number; numeroFinal: number }>>(
      `SELECT "status","numeroInicial","numeroFinal" FROM "NfeInutilizacao" WHERE "userId"=$1`, w.userId);
    expect(inut).toEqual([{ status: "ACEITA", numeroInicial: 501, numeroFinal: 502 }]);
  }, 120000);

  it("V1 (config fora da V2): a mesma tela inutiliza direto — um POST, sem diálogo, ledger vazio, linha intacta", async () => {
    const w = await cenario({ naV2: false });
    const legada = await w.criar("REJECTED", 7, { cStatRejeicao: 225, motivoRejeicao: "Rejeicao: Falha no Schema XML" });
    chamadas = [];

    await comTela(async (t) => {
      const { default: InutilizarNumeroPage } = await import("../../../../app/notas-fiscais/inutilizar-numero/page");
      await t.render(t.React.createElement(InutilizarNumeroPage));
      await t.digitar("#serie", "1");
      await t.digitar("#numero-inicial", "7");
      await t.digitar("#numero-final", "7");
      await t.digitar("#justificativa", JUSTIFICATIVA);
      await t.clicar("Inutilizar Numeracao");
      await t.clicar("Confirmar Inutilizacao");
      expect(chamadas.filter((c) => c.metodo === "POST")).toEqual([{ metodo: "POST", caminho: "/fiscal/inutilizacao", corpo: { serie: 1, numeroInicial: 7, numeroFinal: 7, justificativa: JUSTIFICATIVA }, status: 200 }]);
      expect(t.container.querySelectorAll('[data-testid="dialogo"]')).toHaveLength(0);
    });

    expect(h.inutilizacoes).toEqual([{ ini: 7, fim: 7 }]);
    expect(await w.nota(legada)).toMatchObject({ status: "REJECTED", numero: 7 });
    expect(await w.doLedger()).toEqual([{ n: 0 }]);
  }, 120000);
});
