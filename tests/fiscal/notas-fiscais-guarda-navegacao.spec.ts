import React from "react";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Guarda de NAVEGAÇÃO da página "Notas fiscais" (assertPageAccess("fiscal")).
//
// Todas as páginas do menu chamam assertPageAccess(<página>) — Clientes,
// Pedidos, PDV... —, menos as de app/notas-fiscais. Um colaborador com "Notas
// fiscais" desligado abria /notas-fiscais/... pela URL e, com a API já
// protegida (403), via a tela quebrada. Agora ele é mandado para a primeira
// página liberada, como em qualquer outra área.
//
// Este spec EXECUTA a guarda de TODA page.tsx sob app/notas-fiscais, descoberta
// no disco (página nova entra sozinha na varredura): os layout.tsx da pasta até
// a página e a própria página quando ela é server component — o que o Next roda
// no servidor para aquela URL. Redirect para dentro de /notas-fiscais é seguido,
// como o navegador faria (o índice só redireciona para /notas-fiscais/nfe).
//
// Ordem travada (page-access.ts): a flag NEXT_PUBLIC_FISCAL_MODULE_ENABLED vem
// ANTES da permissão. Com o módulo desligado nada consulta o banco e o destino é
// o de sempre.

(globalThis as any).React = React;

class RedirectError extends Error {
  constructor(public destino: string) {
    super(`REDIRECT:${destino}`);
  }
}

const h = vi.hoisted(() => ({ sessao: null as unknown }));

vi.mock("next/navigation", () => ({
  // O redirect real do Next lança para interromper o render; o dublê também.
  redirect: (destino: string) => {
    throw new RedirectError(destino);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => h.sessao) }));
vi.mock("@/app/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/app/lib/prisma", () => ({ default: { user: { findUnique: vi.fn() } } }));
// Conteúdo das páginas: irrelevante para a guarda (e pesado de importar em node).
vi.mock("@/components/page-header", () => ({ PageHeader: () => null }));
vi.mock("@/app/notas-fiscais/components/nfe-wizard", () => ({ NfeWizard: () => null }));
vi.mock("@/app/notas-fiscais/components/nfe-list", () => ({ NfeList: () => null }));
vi.mock("@/app/notas-fiscais/components/fiscal-companies-manager", () => ({ FiscalCompaniesManager: () => null }));

import prisma from "@/app/lib/prisma";

const RAIZ = path.resolve(__dirname, "../../app/notas-fiscais");
const URL_RAIZ = "/notas-fiscais";

/** Toda page.tsx sob app/notas-fiscais, como caminho relativo com "/". */
function paginas(dir = RAIZ): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...paginas(abs));
    else if (e.name === "page.tsx") out.push(path.relative(RAIZ, abs).split(path.sep).join("/"));
  }
  return out.sort();
}

const urlDe = (pagina: string) => {
  const pasta = path.posix.dirname(pagina);
  return pasta === "." ? URL_RAIZ : `${URL_RAIZ}/${pasta}`;
};

const importar = (abs: string) => import(/* @vite-ignore */ abs.split(path.sep).join("/"));
const ehClient = (abs: string) => /^\s*["']use client["']/.test(fs.readFileSync(abs, "utf8"));
const MIOLO = Symbol("miolo-da-pagina");

/**
 * "Abre" a URL como o servidor do Next: layouts da pasta raiz até a da página,
 * depois a página (se for server component; a client só roda no navegador).
 * Devolve o destino do redirect ou null quando a tela é entregue.
 */
async function abrir(url: string): Promise<string | null> {
  const rel = url === URL_RAIZ ? "" : url.slice(URL_RAIZ.length + 1);
  const pastas = [RAIZ];
  for (const parte of rel ? rel.split("/") : []) pastas.push(path.join(pastas[pastas.length - 1], parte));
  const pagina = path.join(pastas[pastas.length - 1], "page.tsx");
  if (!fs.existsSync(pagina)) throw new Error(`sem page.tsx para ${url}`);
  try {
    for (const pasta of pastas) {
      const layout = path.join(pasta, "layout.tsx");
      if (!fs.existsSync(layout)) continue;
      const { default: Layout } = await importar(layout);
      // O layout entrega a página intacta (não embrulha nem troca o miolo).
      expect(await Layout({ children: MIOLO }), `${url}: ${path.relative(RAIZ, layout)}`).toBe(MIOLO);
    }
    if (!ehClient(pagina)) {
      const { default: Pagina } = await importar(pagina);
      await Pagina({ params: Promise.resolve({}), searchParams: Promise.resolve({}) });
    }
    return null;
  } catch (e) {
    if (e instanceof RedirectError) return e.destino;
    throw e;
  }
}

/** Segue redirects para dentro de /notas-fiscais, como o navegador faria. */
async function destinoFinal(url: string): Promise<string | null> {
  let atual: string | null = url;
  for (let salto = 0; salto < 4; salto++) {
    const destino = await abrir(atual!);
    if (destino === null || !destino.startsWith(URL_RAIZ)) return destino;
    atual = destino.split("?")[0];
  }
  throw new Error(`laço de redirect a partir de ${url}`);
}

const findUnique = vi.mocked(prisma.user.findUnique);
const colaborador = (pagePermissions: Record<string, boolean> | null) => {
  h.sessao = { user: { id: "colab-1", parentUserId: "admin-1", role: "USER" } };
  findUnique.mockResolvedValue({ parentUserId: "admin-1", role: "USER", pagePermissions } as never);
};

// Fiscal E Dashboard desligados: a primeira página liberada vira /produtos. Só a
// guarda de permissão manda para lá — o redirect da flag vai para "/" e o da
// sessão para "/login" —, então o destino prova QUEM redirecionou.
const SEM_FISCAL = { fiscal: false, dashboard: false };

const TODAS = paginas();

beforeEach(() => {
  findUnique.mockReset();
  h.sessao = null;
  vi.stubEnv("NEXT_PUBLIC_FISCAL_MODULE_ENABLED", "true");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("varredura: a guarda enxerga as páginas de Notas fiscais", () => {
  it("achou as 6 páginas de hoje (guarda contra teste vazio)", () => {
    expect(TODAS).toEqual(
      expect.arrayContaining([
        "page.tsx",
        "configuracao/page.tsx",
        "emitidas/page.tsx",
        "enviar-xml/page.tsx",
        "inutilizar-numero/page.tsx",
        "nfe/page.tsx",
      ]),
    );
  });
});

describe("colaborador com 'Notas fiscais' desligado não entra em NENHUMA página do módulo", () => {
  for (const pagina of TODAS) {
    it(`${urlDe(pagina)} → primeira página liberada (/produtos), lendo a permissão do banco`, async () => {
      colaborador(SEM_FISCAL);
      expect(await destinoFinal(urlDe(pagina))).toBe("/produtos");
      expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "colab-1" } }));
    });
  }

  it("sem nenhuma outra página liberada cai em /sem-acesso (nunca volta para o fiscal)", async () => {
    colaborador({ dashboard: false, produtos: false, sucatas: false, localizacoes: false, "scan-receber": false, pedidos: false, clientes: false, financeiro: false, pdv: false, mensagens: false, "mercado-livre": false, shopee: false, magalu: false, olx: false, facebook: false, logs: false, fiscal: false });
    for (const pagina of TODAS) expect(await destinoFinal(urlDe(pagina)), pagina).toBe("/sem-acesso");
  });
});

describe("zero regressão: quem entrava continua entrando", () => {
  const cenarios: Array<[string, () => void]> = [
    ["colaborador com fiscal ligado", () => colaborador({ fiscal: true, dashboard: false })],
    ["colaborador sem pagePermissions", () => colaborador(null)],
    ["colaborador com mapa legado sem a chave fiscal", () => colaborador({ financeiro: false })],
  ];
  for (const [nome, preparar] of cenarios) {
    it(`${nome}: todas as páginas entregam a tela`, async () => {
      preparar();
      for (const pagina of TODAS) expect(await destinoFinal(urlDe(pagina)), pagina).toBeNull();
    });
  }

  it("admin (sem parentUserId): entra em todas sem nenhuma consulta ao banco", async () => {
    h.sessao = { user: { id: "admin-1", parentUserId: null, role: "ADMIN" } };
    for (const pagina of TODAS) expect(await destinoFinal(urlDe(pagina)), pagina).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });
});

describe("ordem: flag e sessão ANTES da permissão", () => {
  // As páginas server já redirecionavam sem sessão (/login) e com o módulo
  // desligado ("/"); as client (enviar-xml, inutilizar-numero) fazem isso no
  // navegador. Nada disso pode mudar, e nenhum desses caminhos lê permissão.
  const CLIENT = new Set(TODAS.filter((p) => ehClient(path.join(RAIZ, p))));

  it("as páginas client de hoje são enviar-xml e inutilizar-numero", () => {
    expect([...CLIENT].sort()).toEqual(["enviar-xml/page.tsx", "inutilizar-numero/page.tsx"]);
  });

  it("módulo desligado: destino de sempre, sem consultar a permissão (redirecionar para página com a flag desligada daria laço)", async () => {
    vi.stubEnv("NEXT_PUBLIC_FISCAL_MODULE_ENABLED", "false");
    colaborador(SEM_FISCAL);
    for (const pagina of TODAS) {
      // Server: redirect("/") de sempre. Client: a tela vai ao navegador, que faz o router.push("/") de sempre.
      expect(await destinoFinal(urlDe(pagina)), pagina).toBe(CLIENT.has(pagina) ? null : "/");
    }
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("sem sessão: destino de sempre, sem consultar a permissão", async () => {
    h.sessao = null;
    for (const pagina of TODAS) {
      expect(await destinoFinal(urlDe(pagina)), pagina).toBe(CLIENT.has(pagina) ? null : "/login");
    }
    expect(findUnique).not.toHaveBeenCalled();
  });
});
