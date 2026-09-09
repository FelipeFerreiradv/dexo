import { describe, expect, it } from "vitest";
import { determineActionType } from "../app/middlewares/logging.middleware";

/**
 * A exclusão em massa de produtos é um POST. Antes desta correção ela casava
 * com o ramo genérico `startsWith("/products") + POST` e era auditada como
 * CREATE_PRODUCT — quem varria o SystemLog atrás de exclusões não achava a
 * requisição, e com ela perdia o `details.body.ids`, que é a ÚNICA lista do
 * que foi apagado (o produto some do banco, não há como reconstruir depois).
 *
 * Caso real: Portal Eco Peças, 04/09/2026 — 96 produtos apagados em duas
 * chamadas de bulk-delete que a auditoria mostrava como criação de produto.
 */
describe("determineActionType — classificação de rota para a auditoria", () => {
  it("classifica POST /products/bulk-delete como DELETE_PRODUCT", () => {
    expect(determineActionType("POST", "/products/bulk-delete")).toEqual({
      action: "DELETE_PRODUCT",
      resource: "Product",
    });
  });

  it("ignora query string ao classificar o bulk-delete", () => {
    expect(
      determineActionType("POST", "/products/bulk-delete?origem=tela"),
    ).toEqual({ action: "DELETE_PRODUCT", resource: "Product" });
  });

  // Controle negativo: a exceção acima não pode vazar para a criação normal.
  it("mantém POST /products como CREATE_PRODUCT", () => {
    expect(determineActionType("POST", "/products")).toEqual({
      action: "CREATE_PRODUCT",
      resource: "Product",
    });
  });

  it("mantém DELETE /products/:id como DELETE_PRODUCT com resourceId", () => {
    expect(determineActionType("DELETE", "/products/abc123")).toEqual({
      action: "DELETE_PRODUCT",
      resource: "Product",
      resourceId: "abc123",
    });
  });

  it("mantém PUT /products/:id como UPDATE_PRODUCT", () => {
    expect(determineActionType("PUT", "/products/abc123")).toMatchObject({
      action: "UPDATE_PRODUCT",
      resource: "Product",
    });
  });

  // Outra rota que também termina em /bulk-delete não pode ser confundida:
  // a exceção é ancorada no caminho inteiro, não no sufixo.
  it("não afeta rotas de outros recursos", () => {
    expect(determineActionType("POST", "/listings")).toMatchObject({
      action: "CREATE_LISTING",
    });
  });
});
