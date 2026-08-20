import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * O QUE ESTE SPEC PROVA — E O QUE NÃO PROVA.
 *
 * Ele lê o fonte do modal e afirma AUSÊNCIA: que não existe mais nenhum
 * caminho de criação de anúncio ali. Ler fonte é péssimo para provar que algo
 * FUNCIONA (a linha existir não diz que ela calcula certo), mas é exatamente a
 * ferramenta certa para provar que algo NÃO EXISTE — que é o caso aqui.
 *
 * O comportamento positivo do save está travado em
 * `tests/edit-modal-listing-payload.spec.ts` (função pura) e em
 * `tests/listing-edit-no-republish.spec.ts` (backend).
 *
 * Se alguém reintroduzir a criação pelo modal de edição, este spec quebra e
 * obriga a decisão a ser explícita em vez de acidental.
 */

const ROOT = join(__dirname, "..");
const MODAL = join(
  ROOT,
  "app",
  "produtos",
  "components",
  "edit-product-dialog.tsx",
);

const fonte = readFileSync(MODAL, "utf8");

describe("modal de edição não cria anúncio", () => {
  it("não chama POST /listings/dispatch", () => {
    expect(fonte).not.toContain("listings/dispatch");
    expect(fonte).not.toContain("dispatchRequests");
  });

  it("não tem toggle de criação em nenhuma plataforma", () => {
    for (const flag of [
      "createMlListing",
      "createShopeeListing",
      "createMagaluListing",
      "createOlxListing",
      "createFacebookListing",
    ]) {
      expect(fonte).not.toContain(flag);
    }
    // Os ids dos switches — o texto "Criar anúncio ..." ainda aparece num
    // comentário que explica de onde a categoria veio, e isso é história, não
    // funcionalidade.
    expect(fonte).not.toContain(`id="edit-create-`);
  });

  it("não tem seletor de contas para publicar", () => {
    for (const estado of [
      "selectedMlAccounts",
      "selectedShopeeAccounts",
      "selectedMagaluAccounts",
      "selectedOlxAccounts",
      "selectedFacebookAccounts",
    ]) {
      expect(fonte).not.toContain(estado);
    }
    for (const rota of [
      "/marketplace/ml/accounts",
      "/marketplace/shopee/accounts",
      "/marketplace/magalu/accounts",
      "/marketplace/olx/accounts",
      "/marketplace/facebook/accounts",
    ]) {
      expect(fonte).not.toContain(rota);
    }
  });

  it("não tem o aumento percentual entre contas (é da criação)", () => {
    expect(fonte).not.toContain("crossAccountIncrease");
    expect(fonte).not.toContain("crossAccountPercent");
    expect(fonte).not.toContain("crossAccountPriceIncreasePercent");
  });

  it("continua salvando o produto por PUT /products/:id", () => {
    expect(fonte).toContain("/products/${product.id}`");
    expect(fonte).toContain('method: "PUT"');
  });

  it("continua salvando o anúncio por PUT /listings/:id", () => {
    expect(fonte).toContain("/listings/${listingContext.listingId}");
    expect(fonte).toContain("buildListingOverridesPayload");
  });

  it("aponta o caminho oficial de publicação", () => {
    expect(fonte).toContain("Anunciar em massa");
  });
});

describe("o modal órfão de edição de anúncio foi absorvido", () => {
  it("edit-listing-dialog.tsx não existe mais", () => {
    const antigo = join(
      ROOT,
      "app",
      "produtos",
      "components",
      "edit-listing-dialog.tsx",
    );
    expect(() => readFileSync(antigo, "utf8")).toThrow();
  });

  it("as três capacidades que só ele tinha vivem agora no modal principal", () => {
    // categoria OLX/Facebook (os dois canais em que a troca chega no anúncio)
    expect(fonte).toContain("olxCategoryOverride");
    expect(fonte).toContain("fbCategoryOverride");
    // pausar/reativar
    expect(fonte).toContain("/status`");
    expect(fonte).toContain('method: "PATCH"');
  });
});
