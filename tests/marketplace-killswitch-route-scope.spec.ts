import { afterEach, describe, expect, it } from "vitest";

// ──────────────────────────────────────────────────────────
// Escopo do kill-switch de rota de OLX/Facebook.
//
// O hook de /marketplace bloqueava TODAS as rotas das duas plataformas quando a
// flag estava ligada — inclusive as que só leem o banco local. Consequência: com
// a integração pausada (que é a postura recomendada de rollout), a aba de
// Integrações não conseguia listar as contas e o operador não conseguia
// preencher telefone/CEP do vendedor. A integração pausada ficava
// indistinguível de quebrada.
//
// Regra atual: bloqueia o que FALA COM O CANAL (OAuth + métodos mutantes),
// libera leitura local e configuração por conta.
//
// Este spec reproduz a decisão do hook isoladamente — o predicado é a regra, e
// é ele que precisa ficar travado contra regressão.
// ──────────────────────────────────────────────────────────

/** Cópia fiel do predicado de marketplace.routes.ts (hook onRequest). */
function ehLeituraOuConfigLocal(metodo: string, path: string): boolean {
  if (path.endsWith("/auth") || path.endsWith("/callback")) return false;
  if (metodo === "GET") return true;
  if (metodo === "PATCH" && /\/accounts\/[^/]+$/.test(path)) return true;
  return false;
}

/** true = a requisição é barrada com 503 quando a flag está ligada. */
const bloqueada = (metodo: string, path: string) =>
  !ehLeituraOuConfigLocal(metodo, path);

afterEach(() => {});

describe("kill-switch de rota — o que continua PASSANDO com a integração pausada", () => {
  it("leitura local das contas e do status", () => {
    // É isto que faz a aba de Integrações renderizar em vez de mostrar erro.
    expect(bloqueada("GET", "/marketplace/olx/accounts")).toBe(false);
    expect(bloqueada("GET", "/marketplace/olx/status")).toBe(false);
    expect(bloqueada("GET", "/marketplace/olx/listings")).toBe(false);
    expect(bloqueada("GET", "/marketplace/facebook/accounts")).toBe(false);
    expect(bloqueada("GET", "/marketplace/facebook/listings")).toBe(false);
  });

  it("categoria resolvida offline (não faz I/O com o canal)", () => {
    expect(bloqueada("GET", "/marketplace/olx/categories")).toBe(false);
    expect(bloqueada("GET", "/marketplace/facebook/category-suggest")).toBe(
      false,
    );
  });

  it("configuração do vendedor por conta — escrita puramente local", () => {
    // O caso que motivou a correção: dá para preparar telefone/CEP e catálogo
    // ANTES de ligar a integração.
    expect(bloqueada("PATCH", "/marketplace/olx/accounts/acc-1")).toBe(false);
    expect(bloqueada("PATCH", "/marketplace/facebook/accounts/acc-2")).toBe(
      false,
    );
  });
});

describe("kill-switch de rota — o que continua BLOQUEADO", () => {
  it("OAuth, mesmo sendo GET, porque conversa com o canal", () => {
    expect(bloqueada("GET", "/marketplace/olx/auth")).toBe(true);
    expect(bloqueada("GET", "/marketplace/olx/callback")).toBe(true);
    expect(bloqueada("GET", "/marketplace/facebook/auth")).toBe(true);
    expect(bloqueada("GET", "/marketplace/facebook/callback")).toBe(true);
  });

  it("tudo que publica, sincroniza ou importa", () => {
    expect(bloqueada("POST", "/marketplace/olx/sync")).toBe(true);
    expect(bloqueada("POST", "/marketplace/olx/sync/prod-1")).toBe(true);
    expect(bloqueada("POST", "/marketplace/facebook/import")).toBe(true);
    expect(bloqueada("POST", "/marketplace/facebook/sync")).toBe(true);
  });

  it("desconectar conta", () => {
    expect(bloqueada("DELETE", "/marketplace/olx")).toBe(true);
    expect(bloqueada("DELETE", "/marketplace/facebook")).toBe(true);
  });

  it("PATCH fora de /accounts/:id não é considerado config local", () => {
    // Guarda contra o regex virar permissivo demais no futuro.
    expect(bloqueada("PATCH", "/marketplace/olx/sync")).toBe(true);
    expect(bloqueada("PATCH", "/marketplace/olx/accounts")).toBe(true);
  });
});
