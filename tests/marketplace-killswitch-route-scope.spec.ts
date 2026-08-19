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
// Regra atual: bloqueia o que MEXE NOS ANÚNCIOS (`/sync`, `/import`) e libera a
// administração da conta — leitura, dados do vendedor e o OAuth de
// conectar/desconectar, que só troca token e escreve no NOSSO banco. Sem isso,
// uma reautorização em produção exigiria DESLIGAR o kill-switch.
//
// Este spec trava o predicado do hook — ele É a regra.
//
// ⚠️ Até 19/08/2026 este arquivo carregava uma CÓPIA transcrita à mão do
// predicado, e testava a cópia. Isso é um teste que mente por construção: no dia
// em que a regra de produção mudasse, a cópia continuaria verde provando a si
// mesma, e o spec anunciaria uma cobertura que não existe. O predicado passou a
// ser exportado por marketplace.routes.ts só para que ele possa ser IMPORTADO
// aqui — é a função real que responde aos casos abaixo.
// ──────────────────────────────────────────────────────────

import { mexeNosAnunciosDoCanal } from "../app/routes/marketplace.routes";

/** true = a requisição é barrada com 503 quando a flag está ligada. */
const bloqueada = (metodo: string, path: string) =>
  mexeNosAnunciosDoCanal(metodo, path);

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
    // Dá para preparar telefone/CEP e catálogo ANTES de ligar a integração.
    expect(bloqueada("PATCH", "/marketplace/olx/accounts/acc-1")).toBe(false);
    expect(bloqueada("PATCH", "/marketplace/facebook/accounts/acc-2")).toBe(
      false,
    );
  });

  it("CONECTAR e desconectar a conta — OAuth e vínculo, nunca anúncio", () => {
    // O caso que motivou esta correção: sem isto, reautorizar uma conta em
    // produção obrigaria a DESLIGAR o kill-switch antes.
    expect(bloqueada("POST", "/marketplace/olx/auth")).toBe(false);
    expect(bloqueada("GET", "/marketplace/olx/callback")).toBe(false);
    expect(bloqueada("POST", "/marketplace/facebook/auth")).toBe(false);
    expect(bloqueada("DELETE", "/marketplace/olx")).toBe(false);
  });
});

describe("kill-switch de rota — o que continua BLOQUEADO", () => {
  it("tudo que publica, sincroniza ou importa", () => {
    expect(bloqueada("POST", "/marketplace/olx/sync")).toBe(true);
    expect(bloqueada("POST", "/marketplace/olx/sync/prod-1")).toBe(true);
    expect(bloqueada("POST", "/marketplace/facebook/import")).toBe(true);
    expect(bloqueada("POST", "/marketplace/facebook/sync")).toBe(true);
  });

  it("GET de status de import é leitura local e PASSA", () => {
    expect(bloqueada("GET", "/marketplace/facebook/import/job-1")).toBe(false);
  });

  it("qualquer método sobre /sync e /import, não só POST", () => {
    // Guarda contra o predicado virar permissivo demais no futuro.
    expect(bloqueada("PATCH", "/marketplace/olx/sync")).toBe(true);
    expect(bloqueada("PUT", "/marketplace/facebook/import")).toBe(true);
  });
});
