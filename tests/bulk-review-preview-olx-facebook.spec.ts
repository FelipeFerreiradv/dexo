import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { buildPreviewViewModel } from "../app/produtos/components/listing-preview/preview-utils";

/**
 * A Prévia da "Revisão individual" não desenhava OLX nem Facebook.
 *
 * No modo Revisão individual o operador percorre peça a peça antes de publicar
 * centenas de anúncios — é a tela que existe para conferir. As abas de Mercado
 * Livre, Shopee e Magalu apareciam; as de OLX e Facebook, nunca. Com só esses
 * dois canais marcados, a área mostrava "Nada para pré-visualizar", e a
 * conclusão razoável do operador era que nada seria publicado neles.
 *
 * A causa foi estreita: `previewValues` carregava `olxListingPrice` e
 * `facebookListingPrice` (o preço foi plumbado) mas não os TOGGLES
 * `createOlxListing`/`createFacebookListing`, que são o que o motor da Prévia lê
 * para decidir se mostra a aba. `StepPreview` já aceitava as props dos dois
 * canais desde sempre — ninguém as passava.
 *
 * ⚠️ Este arquivo testa as DUAS pontas por meios diferentes, e é honesto sobre
 * o que cada um prova:
 *   1. O MOTOR (`buildPreviewViewModel`) — teste de comportamento de verdade.
 *   2. A LIGAÇÃO no componente — a suíte não tem jsdom nem @testing-library/react
 *      (decisão registrada em tests/product-draft-reads-on-open.spec.ts), então
 *      resta travar o texto-fonte. Isso prova que o campo é PASSADO, não que a
 *      tela pinta certo. Serve porque o defeito era exatamente ausência de campo.
 */

const OLX_CAT = "2103";
const FB_CAT =
  "Vehicles & Parts > Vehicle Parts & Accessories > Motorcycle Parts";

const base = {
  name: "Farol Dianteiro",
  price: 300,
  imageUrl: "https://x/1.jpg",
};

const formatCurrency = (v: number | null | undefined) =>
  v === null || v === undefined
    ? "—"
    : new Intl.NumberFormat("pt-BR", {
        style: "currency",
        currency: "BRL",
      }).format(v);

describe("motor da Prévia — OLX e Facebook aparecem quando marcados", () => {
  it("com os toggles ligados, as duas abas são exibidas", () => {
    const vm = buildPreviewViewModel({
      values: { ...base, createOlxListing: true, createFacebookListing: true },
      compatibilities: [],
      mlAccounts: [],
      shopeeAccounts: [],
      selectedMlAccountIds: [],
      selectedShopeeAccountIds: [],
      mlOptions: [],
      shopeeOptions: [],
      formatCurrency,
    } as any);

    expect(vm.showOlx).toBe(true);
    expect(vm.showFacebook).toBe(true);
  });

  it("sem os toggles, nada aparece — era este o estado que o operador via", () => {
    const vm = buildPreviewViewModel({
      values: { ...base },
      compatibilities: [],
      mlAccounts: [],
      shopeeAccounts: [],
      selectedMlAccountIds: [],
      selectedShopeeAccountIds: [],
      mlOptions: [],
      shopeeOptions: [],
      formatCurrency,
    } as any);

    expect(vm.showOlx).toBe(false);
    expect(vm.showFacebook).toBe(false);
  });

  it("a categoria aparece pelo NOME, vindo da opção sintética com o rótulo", () => {
    const vm = buildPreviewViewModel({
      values: {
        ...base,
        createOlxListing: true,
        createFacebookListing: true,
        olxCategory: OLX_CAT,
        facebookCategory: FB_CAT,
      },
      compatibilities: [],
      mlAccounts: [],
      shopeeAccounts: [],
      selectedMlAccountIds: [],
      selectedShopeeAccountIds: [],
      mlOptions: [],
      shopeeOptions: [],
      olxOptions: [{ id: OLX_CAT, value: "Motos" }],
      facebookOptions: [{ id: FB_CAT, value: "Peças de motos" }],
      formatCurrency,
    } as any);

    expect(vm.olxCategoryLabel).toBe("Motos");
    expect(vm.facebookCategoryLabel).toBe("Peças de motos");
    expect(vm.olxCategoryLabel).not.toBe(OLX_CAT);
    expect(vm.facebookCategoryLabel.toLowerCase()).not.toContain("vehicle");
  });

  it("o Valor do Anúncio manda na Prévia; sem ele, herda o preço do produto", () => {
    const comValor = buildPreviewViewModel({
      values: {
        ...base,
        createOlxListing: true,
        createFacebookListing: true,
        olxListingPrice: 450,
      },
      compatibilities: [],
      mlAccounts: [],
      shopeeAccounts: [],
      selectedMlAccountIds: [],
      selectedShopeeAccountIds: [],
      mlOptions: [],
      shopeeOptions: [],
      formatCurrency,
    } as any);

    expect(comValor.olxPriceFormatted).toContain("450");
    // Facebook sem valor próprio herda os R$ 300 do produto.
    expect(comValor.facebookPriceFormatted).toContain("300");
  });
});

describe("ligação no passo de Revisão individual", () => {
  const fonte = fs.readFileSync(
    path.resolve(
      __dirname,
      "..",
      "app",
      "produtos",
      "components",
      "bulk-review",
      "per-product-review-step.tsx",
    ),
    "utf8",
  );

  it("os toggles de OLX e Facebook são mapeados para o motor da Prévia", () => {
    // Era exatamente isto que faltava — o preço já estava lá, o toggle não.
    expect(fonte).toContain("createOlxListing: values.includeOlx");
    expect(fonte).toContain("createFacebookListing: values.includeFacebook");
  });

  it("a categoria escolhida por peça também viaja", () => {
    expect(fonte).toContain("olxCategory: values.olxCategoryOverride");
    expect(fonte).toContain("facebookCategory: values.fbCategoryOverride");
  });

  it("as contas e as opções dos dois canais chegam ao StepPreview", () => {
    for (const prop of [
      "olxAccounts={globalOlxAccounts}",
      "selectedOlxAccountIds={values.olxAccountIds ?? []}",
      "olxOptions={olxOptionsForPreview}",
      "facebookAccounts={globalFacebookAccounts}",
      "selectedFacebookAccountIds={values.facebookAccountIds ?? []}",
      "facebookOptions={facebookOptionsForPreview}",
    ]) {
      expect(fonte, prop).toContain(prop);
    }
  });

  it("os três canais antigos continuam ligados do mesmo jeito", () => {
    // Controle de regressão: a ligação nova não pode ter deslocado a antiga.
    expect(fonte).toContain("createMLListing: values.includeMl");
    expect(fonte).toContain("createShopeeListing: values.includeShopee");
    expect(fonte).toContain("createMagaluListing: values.includeMagalu");
    expect(fonte).toContain("magaluOptions={magaluOptionsForPreview}");
  });
});
