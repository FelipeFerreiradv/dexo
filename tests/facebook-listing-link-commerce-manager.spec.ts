import { describe, expect, it } from "vitest";

import {
  buildFacebookCommerceManagerUrl,
  pickPreferredListingsByPlatform,
  resolveMarketplaceListingLinkState,
  type MarketplaceListingLinkInput,
} from "../app/lib/marketplace-listing-links";

/**
 * "Ver anúncio" do Facebook.
 *
 * Duas coisas distintas, e é por confundir as duas que o botão mentia:
 *
 *  1. O `permalink` gravado no vínculo NÃO é a peça. A Meta exige um campo
 *     `link` em todo item do catálogo, e o que a integração manda é a página
 *     fixa do vendedor (FB_PRODUCT_URL_BASE). Em produção o operador clicava e
 *     caía na conta da loja. O Facebook precisa ser resolvido ANTES do bloco
 *     genérico de permalink — o teste do permalink abaixo é o que impede a
 *     regressão de alguém "simplificar" e devolver o ramo para lá.
 *
 *  2. NÃO existe URL por item no Commerce Manager. Medido contra o roteador da
 *     Meta com controle negativo: `/commerce/catalogs/{id}/products/` é rota
 *     reconhecida (redireciona para `permissions_needed?...&target_tab=products`),
 *     enquanto `/products/{itemId}/`, `/product/{id}/`, `/items/` e
 *     `/products/edit/{id}/` caem no mesmo login genérico que um caminho
 *     inventado. O destino honesto é a lista de itens DO catálogo da conta.
 */
const CATALOG = "1395647917674862";
const CM_URL = `https://business.facebook.com/commerce/catalogs/${CATALOG}/products/`;

describe("Facebook — o link abre o catálogo da conta no Commerce Manager", () => {
  it("com catálogo configurado, o botão abre e aponta para o catálogo daquela conta", () => {
    const state = resolveMarketplaceListingLinkState({
      platform: "FACEBOOK",
      externalListingId: "SKU-35873",
      fbCatalogId: CATALOG,
      status: "active",
    });

    expect(state).toEqual({
      href: CM_URL,
      isOpenable: true,
      disabledReason: null,
    });
  });

  it("cada conta manda para o SEU catálogo, nunca para o da conta vizinha", () => {
    const a = resolveMarketplaceListingLinkState({
      platform: "FACEBOOK",
      externalListingId: "SKU-1",
      fbCatalogId: "111111111111111",
    });
    const b = resolveMarketplaceListingLinkState({
      platform: "FACEBOOK",
      externalListingId: "SKU-1",
      fbCatalogId: "222222222222222",
    });

    expect(a.href).toContain("/catalogs/111111111111111/");
    expect(b.href).toContain("/catalogs/222222222222222/");
    expect(a.href).not.toBe(b.href);
  });

  it("REGRESSÃO: o permalink do Facebook é a página da loja e nunca pode virar o link", () => {
    // Este é o defeito que o cliente viu em produção: clicava em "Ver anúncio"
    // e abria a conta da loja. Se alguém mover o ramo do Facebook para depois
    // do bloco de permalink, este caso cai.
    const paginaDaLoja = "https://facebook.com/jotabeautopecas";

    const semCatalogo = resolveMarketplaceListingLinkState({
      platform: "FACEBOOK",
      externalListingId: "SKU-35873",
      permalink: paginaDaLoja,
      status: "active",
    });
    expect(semCatalogo.href).toBeNull();
    expect(semCatalogo.isOpenable).toBe(false);

    const comCatalogo = resolveMarketplaceListingLinkState({
      platform: "FACEBOOK",
      externalListingId: "SKU-35873",
      permalink: paginaDaLoja,
      fbCatalogId: CATALOG,
      status: "active",
    });
    expect(comCatalogo.href).toBe(CM_URL);
    expect(comCatalogo.href).not.toBe(paginaDaLoja);
  });

  it("sem catálogo na conta, continua desabilitado — e o motivo diz o que fazer", () => {
    const state = resolveMarketplaceListingLinkState({
      platform: "FACEBOOK",
      externalListingId: "SKU-35873",
      status: "active",
    });

    expect(state.isOpenable).toBe(false);
    expect(state.href).toBeNull();
    expect(state.disabledReason).toBe(
      "Informe o ID do Catálogo na conta do Facebook para abrir a peça no Commerce Manager.",
    );
  });

  it("catálogo com lixo digitado não vira link torto — volta ao estado desabilitado", () => {
    // O campo é texto livre na aba de conexão. Colar a URL inteira, um caminho
    // relativo ou o nome do catálogo são erros de digitação plausíveis; nenhum
    // pode produzir um href.
    const lixo = [
      "",
      "   ",
      "catalogo da jotabe",
      "../../admin",
      "https://business.facebook.com/commerce/catalogs/123/products/",
      "123abc",
      "12 34",
      "-1",
    ];

    for (const fbCatalogId of lixo) {
      const state = resolveMarketplaceListingLinkState({
        platform: "FACEBOOK",
        externalListingId: "SKU-1",
        fbCatalogId,
      });
      expect(state.href, `catálogo ${JSON.stringify(fbCatalogId)}`).toBeNull();
      expect(state.isOpenable).toBe(false);
    }
  });

  it("o id do catálogo aceita espaço em volta (colado com sobra)", () => {
    expect(buildFacebookCommerceManagerUrl(`  ${CATALOG}  `)).toBe(CM_URL);
    expect(buildFacebookCommerceManagerUrl(null)).toBeNull();
    expect(buildFacebookCommerceManagerUrl(undefined)).toBeNull();
  });

  it("a URL é exatamente a rota que o Commerce Manager reconhece", () => {
    const href = buildFacebookCommerceManagerUrl(CATALOG)!;
    const url = new URL(href);

    expect(url.origin).toBe("https://business.facebook.com");
    expect(url.pathname).toBe(`/commerce/catalogs/${CATALOG}/products/`);
    expect(url.search).toBe("");
    // Sem id de item no caminho: essa rota não existe na Meta (ver o cabeçalho).
    expect(url.pathname.replace(CATALOG, "")).not.toMatch(/\d/);
  });

  it("vínculo ainda pendente segue pendente, mesmo com catálogo configurado", () => {
    const state = resolveMarketplaceListingLinkState({
      platform: "FACEBOOK",
      externalListingId: "PENDING_FB_1",
      fbCatalogId: CATALOG,
    });

    expect(state.isOpenable).toBe(false);
    expect(state.disabledReason).toBe(
      "Anuncio do Facebook ainda esta pendente de publicacao.",
    );
  });

  it("o campo novo não muda nada nos outros canais", () => {
    // Controle negativo do plumbing: se `fbCatalogId` vazar para outro
    // resolvedor, este caso pega.
    const outros: MarketplaceListingLinkInput[] = [
      {
        platform: "MERCADO_LIVRE",
        externalListingId: "MLB987654321",
        fbCatalogId: CATALOG,
      },
      {
        platform: "SHOPEE",
        externalListingId: "44556677:889900",
        shopId: 332211,
        fbCatalogId: CATALOG,
      },
      { platform: "MAGALU", externalListingId: "MG-1", fbCatalogId: CATALOG },
      { platform: "OLX", externalListingId: "SKU-1", fbCatalogId: CATALOG },
    ];

    for (const listing of outros) {
      const comCampo = resolveMarketplaceListingLinkState(listing);
      const { fbCatalogId: _drop, ...semCampo } = listing;
      expect(comCampo, listing.platform).toEqual(
        resolveMarketplaceListingLinkState(semCampo),
      );
      expect(comCampo.href ?? "").not.toContain("business.facebook.com");
    }
  });

  it("entre duas contas do Facebook, prefere a que realmente abre", () => {
    const preferred = pickPreferredListingsByPlatform(
      [
        {
          platform: "FACEBOOK" as const,
          marketplaceAccountId: "acc-sem-catalogo",
          externalListingId: "SKU-A",
          status: "active",
          updatedAt: "2026-08-19T10:00:00.000Z",
        },
        {
          platform: "FACEBOOK" as const,
          marketplaceAccountId: "acc-com-catalogo",
          externalListingId: "SKU-B",
          fbCatalogId: CATALOG,
          status: "active",
          updatedAt: "2026-08-18T10:00:00.000Z",
        },
      ],
      ["FACEBOOK"],
    );

    expect(preferred).toHaveLength(1);
    expect(preferred[0].listing.externalListingId).toBe("SKU-B");
    expect(preferred[0].linkState.href).toBe(CM_URL);
  });
});
