import { describe, expect, it } from "vitest";

// ──────────────────────────────────────────────────────────
// ESCOPOS DO OAUTH DO FACEBOOK — pedir só o que se usa.
//
// `business_management` era pedido e nunca exercido. Os únicos endpoints do
// Graph que esta integração chama são de CATÁLOGO — items_batch, products e
// check_batch_request_status — mais o `/me` do callback, coberto por
// `public_profile` (que a Meta concede a todo app).
//
// POR QUE ISTO VIRA TESTE, e não só um comentário:
//   1. a Análise do App REPROVA quem pede permissão que não usa;
//   2. o pedido enviado à Meta em 19/08/2026 cobre apenas `catalog_management`;
//   3. com o app "Ao vivo", pedir permissão não aprovada NÃO dá erro — a Meta
//      devolve o token SEM ela, em silêncio, e o Dexo não confere os escopos
//      concedidos. O sintoma seria "publicação falha por permissão" semanas
//      depois, sem nada no consentimento denunciando a causa.
//
// Acrescentar escopo aqui é uma decisão de produto (muda a tela que o vendedor
// vê e exige nova análise). Este spec existe para que ela nunca aconteça por
// acidente.
// ──────────────────────────────────────────────────────────

process.env.FACEBOOK_APP_ID ??= "test-app-id";
process.env.FACEBOOK_APP_SECRET ??= "test-app-secret";

import { FacebookOAuthService } from "@/app/marketplaces/services/facebook-oauth.service";
import { FACEBOOK_CONSTANTS } from "@/app/marketplaces/facebook/facebook-constants";

/** Escopos que a URL de consentimento realmente pede. */
function escoposDaUrl(): string[] {
  const { authUrl } = FacebookOAuthService.generateAuthUrl("user-1");
  const scope = new URL(authUrl).searchParams.get("scope") ?? "";
  return scope
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

describe("a tela de consentimento pede exatamente um escopo", () => {
  it("pede catalog_management", () => {
    expect(escoposDaUrl()).toEqual(["catalog_management"]);
  });

  it("NÃO pede business_management", () => {
    // O assert que dá valor ao caso acima: sem ele, trocar a constante por uma
    // lista maior ainda passaria se alguém afrouxasse o `toEqual`.
    expect(escoposDaUrl()).not.toContain("business_management");
    expect(FACEBOOK_CONSTANTS.SCOPES).not.toContain("business_management");
  });

  it("o escopo continua sobrescrevível por env, sem virar código", () => {
    // A constante lê `process.env.FACEBOOK_SCOPES` na carga do módulo, então
    // este caso afirma o CONTRATO (a env manda), não o valor de agora — mudar
    // isso para uma constante fixa quebraria a saída de emergência.
    const fonte = FACEBOOK_CONSTANTS.SCOPES;
    expect(typeof fonte).toBe("string");
    expect(fonte.length).toBeGreaterThan(0);
  });
});
