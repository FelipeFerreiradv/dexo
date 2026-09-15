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

  /**
   * Mesma família de defeito, achada no chamado MK2 Autopeças (09/2026): mover
   * peças entre localizações é POST em /locations/move-products e caía no ramo
   * genérico, sendo auditada como CREATE_LOCATION — e ainda com o
   * `targetLocationId` do corpo virando "[REDACTED]", porque `isSensitiveKey`
   * casa "rg" por substring dentro de "ta-RG-etLocationId". Medido em produção:
   * 6 movimentações da MK2 entre 07 e 15/09, todas rotuladas CREATE_LOCATION e
   * todas com o destino redigido.
   *
   * Aqui devolve `null` (e não uma action nova) porque a rota grava registro
   * PRÓPRIO, com origem, destino e ids sem redação — evita log duplicado, igual
   * ao PATCH de /scraps.
   */
  it("não classifica POST /locations/move-products no ramo genérico", () => {
    expect(determineActionType("POST", "/locations/move-products")).toBeNull();
  });

  it("ignora query string ao classificar o move-products", () => {
    expect(
      determineActionType("POST", "/locations/move-products?origem=tela"),
    ).toBeNull();
  });

  // Controles negativos: a exceção é igualdade exata de caminho e não pode
  // vazar para nenhuma outra rota de localização.
  it("mantém POST /locations como CREATE_LOCATION", () => {
    expect(determineActionType("POST", "/locations")).toEqual({
      action: "CREATE_LOCATION",
      resource: "Location",
    });
  });

  it("mantém POST /locations/bulk como CREATE_LOCATION", () => {
    expect(determineActionType("POST", "/locations/bulk")).toEqual({
      action: "CREATE_LOCATION",
      resource: "Location",
    });
  });

  it("mantém POST /locations/:id/attach-products como CREATE_LOCATION", () => {
    expect(determineActionType("POST", "/locations/abc123/attach-products"))
      .toEqual({ action: "CREATE_LOCATION", resource: "Location" });
  });

  it("mantém DELETE /locations/:id como DELETE_LOCATION com resourceId", () => {
    expect(determineActionType("DELETE", "/locations/abc123")).toEqual({
      action: "DELETE_LOCATION",
      resource: "Location",
      resourceId: "abc123",
    });
  });
});
