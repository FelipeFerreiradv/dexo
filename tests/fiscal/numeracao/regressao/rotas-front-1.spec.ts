import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { makeConfig, makeDraft } from "../../__helpers__/test-draft";

// REGRESSÃO (era tests/fiscal/__verify__/rotas-front-1.spec.ts, revisão adversarial V2):
//   Nota V2 rejeitada com nº MANTIDO (reserva RESERVADO, reutilizavel:true) ficava
//   sem o botão "Tentar novamente" na lista, porque nfe-list.tsx gateava o botão
//   no `reaproveitavel` da V1 (derivado de cStatRejeicao), e a V2 grava REJECTED
//   com cStatRejeicao NULL em recusa pré-envio do Focus (HTTP 422
//   erro_validacao_schema). Correção: linha com `numeracao` decide por
//   numeracao.reutilizavel (app/notas-fiscais/lib/nfe-numeracao-ui.ts).
//
// Parte 1 (PostgreSQL REAL, repositórios reais, só o transporte Focus simulado):
//   emite pela V2 → 422 erro_validacao_schema → lê a lista com o
//   NfeRepository.findEmitted REAL (inclui attachFiscalLista).
// Parte 2 (DOM real via jsdom): monta o NfeList de verdade alimentado com o
//   corpo que a Parte 1 produziu e procura a ação de reabrir a nota.
//
// Opt-in: NFE_TEST_DATABASE_URL=postgresql://postgres:<senha>@127.0.0.1:<porta>/nfe_test

const raw = process.env.NFE_TEST_DATABASE_URL;
const schema = `nfe_vrf_${randomUUID().replace(/-/g, "")}`;
const CFC = `cfg-kiko-${randomUUID().slice(0, 8)}`;
const EMAIL = "kiko@teste.local";

const h = vi.hoisted(() => ({
  configs: new Map<string, unknown>(),
  focusPosts: [] as Array<{ ref: string; numero: string }>,
  // "schema" = HTTP 422 erro_validacao_schema (sem cStat); "sefaz225" = rejeição SEFAZ com cStat (controle).
  focusModo: "schema" as "schema" | "sefaz225",
  push: [] as string[],
  session: { data: { user: { email: "kiko@teste.local" } }, status: "authenticated" as const },
  router: null as unknown,
}));

// Transporte Focus simulado: a SEFAZ nunca é tocada, o Focus recusa o schema.
vi.mock("../../../../app/fiscal/providers/focus-nfe-v2.client", () => ({
  FocusNfeV2Client: class {
    constructor(readonly ambiente: string, readonly modelo: string) {}
    async emitir(payload: Record<string, unknown>, ref: string) {
      h.focusPosts.push({ ref, numero: String(payload.numero) });
      if (h.focusModo === "sefaz225") {
        return {
          httpStatus: 200,
          transporte: null,
          retryAfterMs: null,
          corpo: { status: "erro_autorizacao", status_sefaz: "225", mensagem_sefaz: "Rejeicao: Falha no Schema XML da NFe" },
        };
      }
      return {
        httpStatus: 422,
        transporte: null,
        retryAfterMs: null,
        corpo: {
          codigo: "erro_validacao_schema",
          mensagem: "Erro de validação do Schema XML, consulte o campo erros",
          erros: [{ codigo: "schema", campo: "NFe/infNFe/det/prod/NCM", mensagem: "NCM inválido" }],
        },
      };
    }
    async consultar() {
      throw new Error("não deveria consultar: 422 pré-envio é conclusivo");
    }
  },
}));
// Qualquer coisa que NÃO seja SefazDirectProvider ⇒ o orquestrador segue o ramo Focus.
vi.mock("../../../../app/fiscal/providers/provider-factory", () => ({
  createNfeProviderFromConfig: async () => ({ provedor: "FOCUS_NFE" }),
}));
vi.mock("../../../../app/repositories/company-fiscal.repository", () => ({
  CompanyFiscalRepository: class {
    findByIdForUser = async (id: string) => h.configs.get(id) ?? null;
    findByUserId = async () => h.configs.get(CFC) ?? null;
  },
}));
vi.mock("../../../../app/usecases/company-fiscal-resp-tec.usecase", () => ({
  resolverRespTecEmpresa: async () => ({ origem: "OMITIR" }),
}));

// ── Frontend: só o que o jsdom não tem ou o que não participa da decisão ──
vi.mock("next-auth/react", () => ({ useSession: () => h.session }));
vi.mock("next/navigation", () => {
  const router = { push: (u: string) => h.push.push(u), replace: () => {}, refresh: () => {}, back: () => {}, prefetch: () => {} };
  return { useRouter: () => router, usePathname: () => "/notas-fiscais/emitidas", useSearchParams: () => new URLSearchParams() };
});
vi.mock("@/lib/api", () => ({ getApiBaseUrl: () => "http://api.test", authHeaders: () => ({}) }));
// Radix Select/Tooltip precisam de ResizeObserver/PointerEvent; os stubs expõem o
// conteúdo inline (o texto do tooltip do botão fica visível no DOM).
vi.mock("@/components/ui/select", async () => {
  const { createElement: e } = await import("react");
  return {
    Select: ({ children }: any) => e("div", null, children),
    SelectTrigger: ({ children }: any) => e("div", null, children),
    SelectValue: ({ placeholder }: any) => e("span", null, placeholder),
    SelectContent: ({ children }: any) => e("div", null, children),
    SelectItem: ({ value, children }: any) => e("div", { "data-item": value }, children),
  };
});
vi.mock("@/components/ui/tooltip", async () => {
  const { createElement: e, Fragment } = await import("react");
  return {
    TooltipProvider: ({ children }: any) => e(Fragment, null, children),
    Tooltip: ({ children }: any) => e(Fragment, null, children),
    TooltipTrigger: ({ children }: any) => e(Fragment, null, children),
    TooltipContent: ({ children }: any) => e("span", { "data-tooltip": "" }, children),
  };
});
vi.mock("../../../../app/notas-fiscais/components/nfe-detail-sheet", () => ({ NfeDetailSheet: () => null }));
vi.mock("../../../../app/notas-fiscais/components/nfe-cancel-dialog", () => ({ NfeCancelDialog: () => null }));
vi.mock("../../../../app/notas-fiscais/components/nfe-send-email-dialog", () => ({ NfeSendEmailDialog: () => null }));
vi.mock("../../../../app/notas-fiscais/components/devolucao-manual", () => ({ DevolucaoManual: () => null }));

const describePg = describe.skipIf(!raw);
describePg("REGRESSÃO rotas-front-1: REJECTED V2 com nº mantido e a ação 'Tentar novamente' da lista", () => {
  let admin: PrismaClient;
  let mods: {
    Orchestrator: typeof import("../../../../app/usecases/nfe-emissao-v2.orchestrator").NfeEmissaoV2Orchestrator;
    NfeRepository: typeof import("../../../../app/repositories/nfe.repository").NfeRepository;
    prisma: PrismaClient;
  };
  // Corpo EXATO que GET /fiscal/nfe devolveria (a rota repassa findEmitted sem transformar).
  let corpoLista: any;
  let nfeRejeitada: string;
  let nfeControle: string;

  beforeAll(async () => {
    const url = new URL(raw!);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !url.pathname.includes("nfe_test")) {
      throw new Error("NFE_TEST_DATABASE_URL deve apontar a banco nfe_test em localhost");
    }
    url.searchParams.set("schema", schema);
    process.env.DATABASE_URL = url.toString();
    // Flags do canário Kiko (Focus, homologação, só modelo 55) + valor de produção
    // da reemissão (HANDOFF_CODEX_NFE_EVOLUCAO.md:146).
    vi.stubEnv("NFE_NUMERACAO_V2_ENABLED", "true");
    vi.stubEnv("NFE_NUMERACAO_V2_CONFIG_IDS", CFC);
    vi.stubEnv("NFE_NUMERACAO_V2_MODELOS", "55");
    vi.stubEnv("NFE_NUMERACAO_V2_FOCUS_ENABLED", "true");
    vi.stubEnv("NFE_DEVOLUCAO_ENABLED", "false");
    vi.stubEnv("NFE_RESP_TEC_EMPRESA_ENABLED", "false");
    vi.stubEnv("NEXT_PUBLIC_NFE_REEMISSAO_REJEITADA_ENABLED", "true");

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

    mods = {
      Orchestrator: (await import("../../../../app/usecases/nfe-emissao-v2.orchestrator")).NfeEmissaoV2Orchestrator,
      NfeRepository: (await import("../../../../app/repositories/nfe.repository")).NfeRepository,
      prisma: (await import("../../../../app/lib/prisma")).default,
    };
  }, 180000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    if (mods?.prisma) await mods.prisma.$disconnect();
    if (admin) {
      await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.$disconnect();
    }
  });

  it("Parte 1 (Postgres real): 422 erro_validacao_schema ⇒ REJECTED, reserva RESERVADO, e a lista traz reaproveitavel:false com numeracao.reutilizavel:true", async () => {
    const config = makeConfig({ id: CFC, userId: "tenant", providerName: "FOCUS_NFE", providerToken: "token-homolog", isDefault: true, ambiente: "HOMOLOGACAO" });
    h.configs.set(CFC, config);
    // attachFiscalLista lê CompanyFiscalConfig por SQL cru: a linha precisa existir.
    await admin.companyFiscalConfig.create({
      data: { id: CFC, userId: "tenant", isDefault: true, cnpj: config.cnpj, razaoSocial: config.razaoSocial, inscricaoEstadual: config.inscricaoEstadual, regimeTributario: "SIMPLES", ambiente: "HOMOLOGACAO", providerName: "FOCUS_NFE", providerToken: "token-homolog", uf: "SP" },
    });
    const base = makeDraft({ userId: "tenant", companyFiscalConfigId: CFC });
    const repo = new mods.NfeRepository();
    const uc = new mods.Orchestrator({ validar: () => {}, snapshot: () => ({}), autorizado: async () => ({}) as never }, undefined, repo, { saveXmlTentativa: async () => "/tmp/x.xml", readFile: async () => Buffer.from("") } as never);
    const criar = async () => (await admin.nfeEmitida.create({
      data: {
        userId: "tenant", companyFiscalConfigId: CFC, ambiente: "HOMOLOGACAO", modelo: "55", serie: 1, numero: -1, status: "DRAFT",
        tipoOperacao: base.tipoOperacao, finalidade: base.finalidade, destinoOperacao: base.destinoOperacao,
        naturezaOperacao: base.naturezaOperacao, indPresenca: base.indPresenca, destinatarioJson: base.destinatarioJson as object,
        emittedByUserId: "tenant",
        itens: { create: [{ numero: 1, codigo: "P1", descricao: "PECA TESTE", ncm: "87089990", cfop: "5102", origem: 0, unidade: "UN", quantidade: 1, valorUnitario: 100, valorTotal: 100 }] },
      },
    })).id;

    nfeRejeitada = await criar();
    const r1 = await uc.emitir("tenant", (await repo.findNfeById("tenant", nfeRejeitada))!, config);
    expect(r1).toMatchObject({ success: false, status: "REJECTED", numero: 1, numeracao: { estado: "RESERVADO", reutilizavel: true } });
    expect(h.focusPosts).toEqual([{ ref: nfeRejeitada, numero: "1" }]);

    const linha = await admin.nfeEmitida.findUnique({ where: { id: nfeRejeitada }, select: { status: true, numero: true, cStatRejeicao: true } });
    expect(linha).toEqual({ status: "REJECTED", numero: 1, cStatRejeicao: null });
    const reservas = await admin.$queryRawUnsafe<Array<{ numero: number; estado: string; nfeId: string }>>(`SELECT "numero","estado","nfeId" FROM "NfeNumeroReserva" WHERE "companyFiscalConfigId"=$1 ORDER BY "numero"`, CFC);
    expect(reservas).toEqual([{ numero: 1, estado: "RESERVADO", nfeId: nfeRejeitada }]);

    // Corpo real de GET /fiscal/nfe (NfeListingUseCase.list → findEmitted, repassado como está).
    corpoLista = JSON.parse(JSON.stringify(await repo.findEmitted("tenant", { page: 1, limit: 10 } as never)));
    const item = corpoLista.notas.find((n: any) => n.id === nfeRejeitada);
    // O backend SABE que o nº foi mantido (numeracao.reutilizavel) mas o campo que o
    // botão da lista lê (reaproveitavel, V1 via cStat) sai false.
    expect(item).toMatchObject({ status: "REJECTED", numero: 1, numeracao: { estado: "RESERVADO", numero: 1, reutilizavel: true } });
    expect(item.reaproveitavel).toBe(false);

    // "Emitir NF-e" (createDraft) só reaproveita DRAFT: a nota REJECTED não volta.
    expect(await repo.findExistingDraft("tenant", "55")).toBeNull();
    // Nova nota ⇒ nº 2; o nº 1 continua RESERVADO preso à nota rejeitada.
    // CONTROLE: a nº 2 é rejeitada pela SEFAZ COM cStat (225) — também nº mantido
    // (REJEITADO ⇒ reutilizavel), mas com cStatRejeicao gravado.
    h.focusModo = "sefaz225";
    nfeControle = await criar();
    const r2 = await uc.emitir("tenant", (await repo.findNfeById("tenant", nfeControle))!, config);
    expect(r2).toMatchObject({ status: "REJECTED", numero: 2, numeracao: { estado: "REJEITADO", reutilizavel: true } });
    const depois = await admin.$queryRawUnsafe<Array<{ numero: number; estado: string }>>(`SELECT "numero","estado" FROM "NfeNumeroReserva" WHERE "companyFiscalConfigId"=$1 ORDER BY "numero"`, CFC);
    expect(depois).toEqual([{ numero: 1, estado: "RESERVADO" }, { numero: 2, estado: "REJEITADO" }]);
    // relista para a Parte 2 com as duas notas
    corpoLista = JSON.parse(JSON.stringify(await repo.findEmitted("tenant", { page: 1, limit: 10 } as never)));
    const controle = corpoLista.notas.find((n: any) => n.id === nfeControle);
    expect(controle).toMatchObject({ status: "REJECTED", numero: 2, reaproveitavel: true, numeracao: { estado: "REJEITADO", reutilizavel: true } });
  }, 120000);

  it("Parte 2 (DOM real): a lista oferece 'Tentar novamente' para a nota REJECTED cujo nº foi mantido", async () => {
    expect(corpoLista, "Parte 1 precisa ter rodado").toBeTruthy();
    const { builtinEnvironments } = await import("vitest/environments");
    const env = await builtinEnvironments.jsdom.setup(globalThis, { jsdom: { url: "http://localhost:3000/notas-fiscais/emitidas" } } as never);
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const chamadas: string[] = [];
    // Linhas V1 sintéticas (SEM a chave `numeracao`, como sai de config não elegível à V2):
    // a lista deve seguir a regra antiga (flag NEXT_PUBLIC + reaproveitavel do cStat).
    const linhaV1 = (id: string, nome: string, numero: number, reaproveitavel: boolean) => {
      const { numeracao: _semNumeracao, ...resto } = corpoLista.notas[0];
      return { ...resto, id, numero, status: "REJECTED", destinatarioNome: nome, reaproveitavel };
    };
    const corpoTela = { ...corpoLista, notas: [...corpoLista.notas, linhaV1("v1-reap", "CLIENTE V1 REAP", 50, true), linhaV1("v1-sem", "CLIENTE V1 SEM", 51, false)] };
    const fetchOriginal = globalThis.fetch;
    globalThis.fetch = (async (input: any) => {
      const u = String(input);
      chamadas.push(u);
      const corpo = u.includes("/fiscal/nfe/stats")
        ? { stats: { total: 2, autorizadas: 0, rejeitadas: 2, canceladas: 0, valorTotal: 0 } }
        : u.startsWith("http://api.test/fiscal/nfe?")
          ? corpoTela
          : {};
      return { ok: true, status: 200, json: async () => corpo, text: async () => JSON.stringify(corpo) } as never;
    }) as never;
    try {
      const React = await import("react");
      // O esbuild do vitest compila o JSX no runtime clássico (React.createElement);
      // o Next usa o automático. Só expõe o React global para o componente montar.
      (globalThis as any).React = React;
      const { createRoot } = await import("react-dom/client");
      // O módulo lê NEXT_PUBLIC_NFE_REEMISSAO_REJEITADA_ENABLED no import: já está "true".
      const { NfeList } = await import("../../../../app/notas-fiscais/components/nfe-list");
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      await React.act(async () => { root.render(React.createElement(NfeList)); });
      await React.act(async () => { await new Promise((r) => setTimeout(r, 400)); });

      expect(chamadas.some((u) => u.startsWith("http://api.test/fiscal/nfe?"))).toBe(true);
      const linhas = [...container.querySelectorAll("tbody tr")];
      const temRetry = (tr: Element) => !!tr.querySelector("svg.lucide-rotate-ccw") || /Tentar novamente/.test(tr.textContent ?? "");
      // CONTROLE (passa): a nº 2 (rejeição SEFAZ com cStat) tem o botão — prova que
      // a flag está ligada no módulo e que a detecção do botão funciona.
      const linhaControle = linhas.find((tr) => tr.textContent?.includes("Nº 2: mantido para nova tentativa"));
      expect(linhaControle, `linhas: ${linhas.map((l) => l.textContent).join(" || ")}`).toBeTruthy();
      expect(temRetry(linhaControle!), `linha de controle: "${linhaControle!.textContent}"`).toBe(true);

      const linha = linhas.find((tr) => tr.textContent?.includes("Nº 1: mantido para nova tentativa"));
      // A lista MOSTRA que o nº 1 foi mantido (NumeracaoActions lê numeracao.reutilizavel)...
      expect(linha, `linhas: ${linhas.map((l) => l.textContent).join(" || ")}`).toBeTruthy();

      // ...e a ação para reabrir a nota (design §4.20: REJECTED + RESERVADO ⇒
      // "Tentar novamente — mantém o nº N") precisa existir nessa linha.
      expect(temRetry(linha!), `linha da nota rejeitada: "${linha!.textContent}"`).toBe(true);
      // O tooltip (stub inline) promete MANTER o nº que o servidor informou, não o "reaproveita" da V1.
      expect(linha!.querySelector("[data-tooltip]")?.textContent).toBe("Tentar novamente — mantém o nº 1");
      expect(linhaControle!.querySelector("[data-tooltip]")?.textContent).toBe("Tentar novamente — mantém o nº 2");

      // V1 intacta: reaproveitavel ⇒ botão com o texto antigo; sem reaproveitavel ⇒ nenhum botão.
      const v1Reap = linhas.find((tr) => tr.textContent?.includes("CLIENTE V1 REAP"));
      const v1Sem = linhas.find((tr) => tr.textContent?.includes("CLIENTE V1 SEM"));
      expect(v1Reap && v1Sem, `linhas: ${linhas.map((l) => l.textContent).join(" || ")}`).toBeTruthy();
      expect(v1Reap!.querySelector("[data-tooltip]")?.textContent).toBe("Tentar novamente — reaproveita o nº 1/50");
      expect(temRetry(v1Sem!)).toBe(false);
      expect(v1Reap!.textContent).not.toContain("mantido para nova tentativa");

      await React.act(async () => { root.unmount(); });
    } finally {
      globalThis.fetch = fetchOriginal;
      env.teardown(globalThis);
    }
  }, 60000);
});
