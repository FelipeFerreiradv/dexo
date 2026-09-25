import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

// Permissão de página "fiscal" (Notas fiscais) cobrada NA API.
//
// Antes: toda rota sob /fiscal tinha só o authMiddleware. Desligar "Notas
// fiscais" de um colaborador escondia o menu, e ele seguia listando, criando
// rascunho, cancelando e emitindo devolução por chamada direta.
//
// Exceções (o PDV usa, e em produção há colaboradores com fiscal desligado e PDV
// ligado): GET /fiscal/companies (seletor de CNPJ, pdv-view.tsx) aceita "fiscal
// OU pdv"; GET /fiscal/nfe/:id/danfe (reimpressão, pdv-fiscal-docs.ts) aceita
// "fiscal, pdv OU clientes", porque o mesmo menu de reimpressão (PdvSaleActions)
// está na ficha do cliente (customer-purchases-sheet.tsx).
//
// Zero regressão: admin/superadmin e colaborador sem pagePermissions (ou sem a
// chave "fiscal") passam exatamente como antes.

const TENANT = "tenant-dls";
const h = vi.hoisted(() => ({ usuario: {} as Record<string, unknown> }));
const db = vi.hoisted(() => ({ nfeEmitida: { findFirst: vi.fn() } }));

vi.mock("../../app/lib/prisma", () => ({ default: db }));
vi.mock("@/app/lib/prisma", () => ({ default: db }));
vi.mock("../../app/middlewares/auth.middleware", () => ({
  authMiddleware: async (request: any) => {
    request.user = { ...h.usuario, dataOwnerId: TENANT };
  },
}));

import Fastify, { type FastifyInstance } from "fastify";
import { fiscalRoutes } from "../../app/routes/fiscal.routes";
import { fiscalDevolucaoRoutes } from "../../app/routes/fiscal-devolucao.routes";
import { fiscalRespTecRoutes } from "../../app/routes/fiscal-resp-tec.routes";
import { authMiddleware } from "../../app/middlewares/auth.middleware";
import {
  exigeAcessoFiscal,
  exigeAcessoFiscalOuPdv,
  exigeAcessoFiscalPdvOuClientes,
} from "../../app/middlewares/require-page-access.middleware";
import { CompanyFiscalUseCase } from "../../app/usecases/company-fiscal.usecase";
import { NfeDraftUseCase } from "../../app/usecases/nfe-draft.usecase";
import { NfeListingUseCase } from "../../app/usecases/nfe-listing.usecase";
import { NfeDevolucaoUseCase } from "../../app/usecases/nfe-devolucao.usecase";
import { NfeCancelamentoUseCase } from "../../app/usecases/nfe-cancelamento.usecase";
import { CompanyFiscalRespTecUseCase } from "../../app/usecases/company-fiscal-resp-tec.usecase";

type RotaVista = { metodo: string; url: string; preHandler: unknown[] };
const rotas: RotaVista[] = [];

let app: FastifyInstance;
beforeAll(async () => {
  app = Fastify();
  // Captura o preHandler de TODA rota registrada pelos 3 plugins (mesma ordem e
  // mesmo prefixo de app/api/api.ts).
  app.addHook("onRoute", (opts) => {
    const metodos = Array.isArray(opts.method) ? opts.method : [opts.method];
    const ph = opts.preHandler == null ? [] : Array.isArray(opts.preHandler) ? opts.preHandler : [opts.preHandler];
    for (const metodo of metodos) rotas.push({ metodo: String(metodo), url: opts.url, preHandler: ph as unknown[] });
  });
  await app.register(fiscalRespTecRoutes, { prefix: "/fiscal" });
  await app.register(fiscalDevolucaoRoutes, { prefix: "/fiscal" });
  await app.register(fiscalRoutes, { prefix: "/fiscal" });
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

let casos: Record<string, MockInstance>;
beforeEach(() => {
  db.nfeEmitida.findFirst.mockReset();
  db.nfeEmitida.findFirst.mockResolvedValue(null);
  casos = {
    listar: vi.spyOn(NfeListingUseCase.prototype, "list").mockResolvedValue({ data: [], total: 0 } as never),
    rascunho: vi.spyOn(NfeDraftUseCase.prototype, "create").mockResolvedValue({ id: "draft-1" } as never),
    descartarBloqueado: vi.spyOn(NfeDraftUseCase.prototype, "descartarNumeroBloqueado").mockResolvedValue({ numero: 501, serie: 1 }),
    empresas: vi.spyOn(CompanyFiscalUseCase.prototype, "listByUserId").mockResolvedValue([] as never),
    disponibilidade: vi.spyOn(NfeDevolucaoUseCase.prototype, "disponibilidade").mockResolvedValue({ companyFiscalConfigId: "cfg-1" } as never),
    devolucao: vi.spyOn(NfeDevolucaoUseCase.prototype, "criar").mockResolvedValue({ reutilizado: false, draftId: "dev-1" } as never),
    cancelar: vi.spyOn(NfeCancelamentoUseCase.prototype, "cancel").mockResolvedValue({ success: true } as never),
    respTec: vi.spyOn(CompanyFiscalRespTecUseCase.prototype, "get").mockResolvedValue(null as never),
  };
});
afterEach(() => {
  vi.restoreAllMocks();
});

const colaborador = (pagePermissions: Record<string, boolean> | null) => {
  h.usuario = { id: "colab-1", parentUserId: TENANT, pagePermissions };
};
const admin = (pagePermissions: Record<string, boolean> | null = null) => {
  h.usuario = { id: TENANT, parentUserId: null, pagePermissions };
};

const PROIBIDO = {
  message: "Seu acesso a esta área foi removido pelo administrador da conta.",
  code: "PAGE_FORBIDDEN",
  pageId: "fiscal",
};

// Rotas representativas dos 3 plugins, cada uma com o caso de uso que ela chama.
const SO_FISCAL = [
  { nome: "listagem de NF-e", req: { method: "GET", url: "/fiscal/nfe" }, caso: "listar" },
  { nome: "rascunho a partir do pedido", req: { method: "POST", url: "/fiscal/nfe/draft", payload: { orderId: "pedido-1" } }, caso: "rascunho" },
  { nome: "cancelamento", req: { method: "POST", url: "/fiscal/nfe/nfe-1/cancel", payload: { justificativa: "x".repeat(20) } }, caso: "cancelar" },
  { nome: "descartar nº retido (BLOQUEADO)", req: { method: "POST", url: "/fiscal/nfe/nfe-1/numeracao/descartar-bloqueado", payload: { confirmar: true } }, caso: "descartarBloqueado" },
  { nome: "devolução: disponibilidade", req: { method: "GET", url: "/fiscal/nfe/devolucao/disponibilidade" }, caso: "disponibilidade" },
  { nome: "devolução: criar", req: { method: "POST", url: "/fiscal/nfe/nfe-1/devolucao", payload: {} }, caso: "devolucao" },
  { nome: "responsável técnico", req: { method: "GET", url: "/fiscal/config/resp-tec" }, caso: "respTec" },
] as const;

describe("colaborador com 'Notas fiscais' desligado: 403 nas rotas fiscais", () => {
  for (const pdv of [true, false]) {
    for (const r of SO_FISCAL) {
      it(`${r.nome} (PDV ${pdv ? "ligado" : "desligado"}) → 403 PAGE_FORBIDDEN, sem chegar ao caso de uso`, async () => {
        colaborador({ fiscal: false, pdv });
        const res = await app.inject(r.req as never);
        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual(PROIBIDO);
        expect(casos[r.caso]).not.toHaveBeenCalled();
      });
    }
  }

  it("download de XML e reenvio por e-mail também barram (não tocam no banco)", async () => {
    colaborador({ fiscal: false, pdv: true });
    for (const req of [
      { method: "GET", url: "/fiscal/nfe/nfe-1/xml" },
      { method: "POST", url: "/fiscal/nfe/nfe-1/resend-email", payload: { email: "a@b.com" } },
    ]) {
      const res = await app.inject(req as never);
      expect(res.statusCode, req.url).toBe(403);
    }
    expect(db.nfeEmitida.findFirst).not.toHaveBeenCalled();
  });
});

describe("exceções do PDV: fiscal desligado + PDV ligado passa", () => {
  it("GET /fiscal/companies?view=summary (seletor de CNPJ do PDV) → 200", async () => {
    colaborador({ fiscal: false, pdv: true });
    const res = await app.inject({ method: "GET", url: "/fiscal/companies?view=summary" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ companies: [] });
    expect(casos.empresas).toHaveBeenCalledWith(TENANT);
  });

  it("GET /fiscal/nfe/:id/danfe (reimpressão do PDV) chega ao handler, no escopo do tenant", async () => {
    // Clientes desligado de propósito: quem abre aqui tem de ser o PDV (chave
    // ausente contaria como liberada e o caso passaria por Clientes).
    colaborador({ fiscal: false, pdv: true, clientes: false });
    const res = await app.inject({ method: "GET", url: "/fiscal/nfe/nfe-1/danfe" });
    // Nota inexistente no banco dublê: o 404 é do HANDLER, não do guard.
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "NF-e nao encontrada" });
    expect(db.nfeEmitida.findFirst.mock.calls[0][0].where).toEqual({ id: "nfe-1", userId: TENANT });
  });

  it("PDV sem a chave gravada conta como ligado (semântica da casa)", async () => {
    colaborador({ fiscal: false });
    expect((await app.inject({ method: "GET", url: "/fiscal/companies" })).statusCode).toBe(200);
  });
});

describe("exceções: fiscal, PDV e Clientes desligados → 403", () => {
  // Antes este caso desligava só fiscal e PDV. Com Clientes também abrindo o
  // DANFE, a chave "clientes" ausente conta como LIGADA (semântica da casa) —
  // o colaborador do caso precisa ter as três desligadas para levar o 403.
  it("companies e danfe barram, cada um com as páginas que o liberariam no corpo, sem tocar no banco", async () => {
    colaborador({ fiscal: false, pdv: false, clientes: false });
    for (const url of ["/fiscal/companies?view=summary", "/fiscal/companies"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(403);
      expect(res.json(), url).toEqual({ ...PROIBIDO, pageIds: ["fiscal", "pdv"] });
    }
    const danfe = await app.inject({ method: "GET", url: "/fiscal/nfe/nfe-1/danfe" });
    expect(danfe.statusCode).toBe(403);
    expect(danfe.json()).toEqual({ ...PROIBIDO, pageIds: ["fiscal", "pdv", "clientes"] });
    expect(casos.empresas).not.toHaveBeenCalled();
    expect(db.nfeEmitida.findFirst).not.toHaveBeenCalled();
  });
});

describe("Clientes ligado, fiscal e PDV desligados: só a reimpressão do DANFE passa", () => {
  // A ficha do cliente (customer-purchases-sheet.tsx) renderiza o PdvSaleActions,
  // que reimprime DANFE/DANFCE por GET /fiscal/nfe/:id/danfe. Esse colaborador
  // não pode levar 403 na reimpressão — e continua sem o resto do fiscal.
  beforeEach(() => {
    colaborador({ fiscal: false, pdv: false, clientes: true });
  });

  it("GET /fiscal/nfe/:id/danfe chega ao handler, no escopo do tenant", async () => {
    const res = await app.inject({ method: "GET", url: "/fiscal/nfe/nfe-1/danfe" });
    // Nota inexistente no banco dublê: o 404 é do HANDLER, não do guard.
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "NF-e nao encontrada" });
    expect(db.nfeEmitida.findFirst.mock.calls[0][0].where).toEqual({ id: "nfe-1", userId: TENANT });
  });

  it("GET /fiscal/companies (seletor de CNPJ do PDV) continua 403", async () => {
    const res = await app.inject({ method: "GET", url: "/fiscal/companies?view=summary" });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ ...PROIBIDO, pageIds: ["fiscal", "pdv"] });
    expect(casos.empresas).not.toHaveBeenCalled();
  });

  it("as rotas só-fiscal continuam 403, inclusive o XML da mesma nota", async () => {
    for (const r of SO_FISCAL) {
      const res = await app.inject(r.req as never);
      expect(res.statusCode, r.nome).toBe(403);
      expect(res.json(), r.nome).toEqual(PROIBIDO);
      expect(casos[r.caso], r.nome).not.toHaveBeenCalled();
    }
    expect((await app.inject({ method: "GET", url: "/fiscal/nfe/nfe-1/xml" })).statusCode).toBe(403);
  });
});

describe("zero regressão: quem passava continua passando", () => {
  const cenarios: Array<[string, () => void]> = [
    ["admin (sem parentUserId), mesmo com um mapa gravado", () => admin({ fiscal: false, pdv: false })],
    ["admin sem mapa", () => admin()],
    ["colaborador sem pagePermissions", () => colaborador(null)],
    ["colaborador com mapa legado sem a chave fiscal", () => colaborador({ financeiro: false, pdv: false })],
    ["colaborador com fiscal ligado explicitamente", () => colaborador({ fiscal: true, pdv: false })],
  ];
  for (const [nome, preparar] of cenarios) {
    it(`${nome}: rotas fiscais e as do PDV chegam ao caso de uso`, async () => {
      preparar();
      for (const r of SO_FISCAL) {
        const res = await app.inject(r.req as never);
        expect(res.statusCode, r.nome).not.toBe(403);
        expect(casos[r.caso], r.nome).toHaveBeenCalledTimes(1);
      }
      expect((await app.inject({ method: "GET", url: "/fiscal/companies" })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/fiscal/nfe/nfe-1/danfe" })).statusCode).toBe(404);
    });
  }
});

describe("cobertura: TODA rota autenticada sob /fiscal tem exatamente um guard fiscal", () => {
  // HEAD é criado pelo Fastify a partir do GET, com as mesmas opções.
  const vistas = () => rotas.filter((r) => r.metodo !== "HEAD");
  const GUARDS = [exigeAcessoFiscal, exigeAcessoFiscalOuPdv, exigeAcessoFiscalPdvOuClientes] as unknown[];
  const guardsDe = (r: RotaVista) => r.preHandler.filter((f) => GUARDS.includes(f));
  const chave = (r: RotaVista) => `${r.metodo} ${r.url}`;
  // A regra, exata: DANFE = fiscal|pdv|clientes; GET companies = fiscal|pdv; TODAS as outras = fiscal.
  const NOME_GUARD = new Map<unknown, string>([
    [exigeAcessoFiscal, "fiscal"],
    [exigeAcessoFiscalOuPdv, "fiscal|pdv"],
    [exigeAcessoFiscalPdvOuClientes, "fiscal|pdv|clientes"],
  ]);
  const guardEsperado = (r: RotaVista) =>
    chave(r) === "GET /fiscal/nfe/:id/danfe"
      ? "fiscal|pdv|clientes"
      : chave(r) === "GET /fiscal/companies"
        ? "fiscal|pdv"
        : "fiscal";

  it("o onRoute enxergou as rotas dos 3 plugins (guarda contra teste vazio)", () => {
    const urls = vistas().map(chave);
    expect(urls.length).toBeGreaterThanOrEqual(48);
    expect(urls).toContain("GET /fiscal/nfe");
    expect(urls).toContain("POST /fiscal/nfe/devolucao/manual");
    expect(urls).toContain("PUT /fiscal/companies/:id/resp-tec");
    expect(urls).toContain("POST /fiscal/nfe/:id/numeracao/descartar-bloqueado");
  });

  it("toda rota com authMiddleware tem um e só um guard fiscal, DEPOIS do authMiddleware", () => {
    const erradas: string[] = [];
    for (const r of rotas) {
      const iAuth = r.preHandler.indexOf(authMiddleware);
      if (iAuth === -1) continue;
      const guards = guardsDe(r);
      if (guards.length !== 1 || r.preHandler.indexOf(guards[0]) < iAuth) erradas.push(chave(r));
    }
    expect(erradas).toEqual([]);
  });

  it("cada rota tem o guard da regra: DANFE = fiscal|pdv|clientes, GET companies = fiscal|pdv, o resto = fiscal", () => {
    const divergentes: string[] = [];
    for (const r of vistas()) {
      if (!r.preHandler.includes(authMiddleware)) continue;
      const nomes = guardsDe(r).map((g) => NOME_GUARD.get(g));
      const esperado = guardEsperado(r);
      if (nomes.length !== 1 || nomes[0] !== esperado) divergentes.push(`${chave(r)}: ${nomes.join(",") || "nenhum"} (esperado ${esperado})`);
    }
    expect(divergentes).toEqual([]);
  });

  it("as exceções são só estas duas rotas (lista fechada)", () => {
    const comGuard = (g: unknown) => vistas().filter((r) => r.preHandler.includes(g)).map(chave).sort();
    expect(comGuard(exigeAcessoFiscalOuPdv)).toEqual(["GET /fiscal/companies"]);
    expect(comGuard(exigeAcessoFiscalPdvOuClientes)).toEqual(["GET /fiscal/nfe/:id/danfe"]);
  });

  it("nenhuma rota fiscal é pública hoje (rota nova sem authMiddleware tem de ser decisão consciente)", () => {
    const publicas = rotas.filter((r) => !r.preHandler.includes(authMiddleware)).map(chave);
    expect(publicas).toEqual([]);
  });
});
