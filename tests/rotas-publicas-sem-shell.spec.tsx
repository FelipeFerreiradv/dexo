// @vitest-environment jsdom
//
// As rotas públicas não podem passar pelo MainLayout.
//
// Por que este spec existe: em 10/09/2026 a Meta abriu uma violação do Termo da
// Plataforma 4.a contra o app da Dexo por "site sem política de privacidade
// acessível ao público" e RESTRINGIU o acesso à API. A política foi publicada
// em /privacidade e o Depurador de Compartilhamento devolveu 200 — parecia
// resolvido.
//
// Não estava. Num navegador anônimo a página carregava e em seguida ia para
// /login. O motivo: `AppSidebar` e `AppHeader` fazem `router.push("/login")`
// quando a sessão é nula, e o `MainLayout` os renderiza em TODA rota que não
// seja /login. Ou seja, o rastreador da Meta (que não executa JavaScript) via a
// política e aprovava, enquanto um revisor humano via a tela de login e
// concluía o oposto — o pior tipo de defeito, o que passa no teste automático e
// falha na avaliação real.
//
// O que se afirma aqui é comportamento, não a existência da linha: o
// componente é montado de verdade, com sessão NULA, e o que se verifica é se o
// MainLayout entrou ou não na árvore.

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Caminho controlado por teste — é a única entrada da decisão.
let pathnameAtual = "/";
vi.mock("next/navigation", () => ({
  usePathname: () => pathnameAtual,
}));

// Stub do MainLayout: só precisa ser DETECTÁVEL na árvore. Não montamos o real
// porque o que está em jogo é se ele é aplicado, não como ele desenha.
vi.mock("@/components/main-layout", () => ({
  MainLayout: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="main-layout">{children}</div>
  ),
}));

import { MainLayoutClient } from "../components/main-layout-client";

let container: HTMLDivElement;
let root: Root;

function montar(pathname: string) {
  pathnameAtual = pathname;
  act(() => {
    root.render(
      <MainLayoutClient session={null}>
        <p data-testid="conteudo">conteúdo público</p>
      </MainLayoutClient>,
    );
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("rotas públicas não recebem o MainLayout", () => {
  // Estas duas são exigidas pela Meta e estão cadastradas no painel do app.
  // Se voltarem a passar pelo MainLayout, o visitante anônimo é expulso e a
  // violação reabre.
  for (const rota of ["/privacidade", "/termos"]) {
    it(`${rota} renderiza sem o MainLayout`, () => {
      montar(rota);
      expect(container.querySelector('[data-testid="main-layout"]')).toBeNull();
      expect(
        container.querySelector('[data-testid="conteudo"]'),
      ).not.toBeNull();
    });
  }

  it("/login continua sem o MainLayout (comportamento que já existia)", () => {
    montar("/login");
    expect(container.querySelector('[data-testid="main-layout"]')).toBeNull();
  });

  // ---- controles negativos ----
  //
  // Sem estes, um `return <>{children}</>` incondicional passaria nos testes
  // acima e desmontaria o sistema inteiro.

  it("a home continua COM o MainLayout", () => {
    montar("/");
    expect(
      container.querySelector('[data-testid="main-layout"]'),
    ).not.toBeNull();
  });

  it("uma tela do sistema continua COM o MainLayout", () => {
    montar("/produtos");
    expect(
      container.querySelector('[data-testid="main-layout"]'),
    ).not.toBeNull();
  });

  // A checagem é por rota inteira, não por prefixo solto: uma rota que apenas
  // COMEÇA com o mesmo texto é do sistema e precisa do shell.
  it("/privacidade-interna NÃO é confundida com a rota pública", () => {
    montar("/privacidade-interna");
    expect(
      container.querySelector('[data-testid="main-layout"]'),
    ).not.toBeNull();
  });
});
