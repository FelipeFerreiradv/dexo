import { describe, expect, it } from "vitest";
import {
  contarPublicadosPorCanal,
  isPending,
} from "../app/produtos/components/product-listings-list";
import type { ApiListing } from "../app/produtos/lib/listings-status-cache";

/**
 * A regra do que conta como anúncio NO AR.
 *
 * Ela decide duas coisas em telas diferentes: se o botão "Editar anúncio"
 * aparece habilitado na lista, e se a categoria do produto entra travada no
 * cadastro. Se as duas divergirem, uma delas mente para o operador — por isso a
 * regra é uma função só, e por isso ela é testada aqui.
 *
 * O caso que importa é o `PENDING_`: o anúncio existe no Dexo mas ainda não do
 * lado do marketplace. Contá-lo travaria a categoria de um produto que ainda
 * não tem nada publicado — justamente o produto em que trocar a categoria é
 * legítimo e não confunde ninguém.
 */

function anuncio(over: Partial<ApiListing> = {}): ApiListing {
  return {
    id: "l1",
    platform: "MERCADO_LIVRE",
    accountId: "acc-1",
    accountName: "JOTABE-AUTOPECAS",
    status: "active",
    externalListingId: "MLB123",
    permalink: null,
    lastError: null,
    updatedAt: null,
    ...over,
  };
}

describe("isPending", () => {
  it("PENDING_ é anúncio que ainda não existe no marketplace", () => {
    expect(isPending(anuncio({ externalListingId: "PENDING_abc" }))).toBe(true);
  });

  it("id real não é pendente", () => {
    expect(isPending(anuncio({ externalListingId: "MLB123" }))).toBe(false);
  });

  it("sem id não é 'pendente', é ausência — quem filtra isso é o contador", () => {
    expect(isPending(anuncio({ externalListingId: null }))).toBe(false);
  });
});

describe("contarPublicadosPorCanal", () => {
  it("conta por canal só o que está no ar", () => {
    expect(
      contarPublicadosPorCanal([
        anuncio({ id: "a", platform: "MERCADO_LIVRE" }),
        anuncio({ id: "b", platform: "MERCADO_LIVRE", externalListingId: "MLB9" }),
        anuncio({ id: "c", platform: "SHOPEE", externalListingId: "998877" }),
      ]),
    ).toEqual({ MERCADO_LIVRE: 2, SHOPEE: 1 });
  });

  it("PENDING_ NÃO conta — o produto ainda não está anunciado naquele canal", () => {
    expect(
      contarPublicadosPorCanal([
        anuncio({ platform: "MERCADO_LIVRE", externalListingId: "PENDING_x" }),
      ]),
    ).toEqual({});
  });

  it("linha sem id externo não conta", () => {
    expect(
      contarPublicadosPorCanal([
        anuncio({ externalListingId: null }),
        anuncio({ externalListingId: "" }),
      ]),
    ).toEqual({});
  });

  it("linha sem plataforma não conta (e não quebra)", () => {
    expect(
      contarPublicadosPorCanal([anuncio({ platform: null })]),
    ).toEqual({});
  });

  it("lista vazia devolve mapa vazio — canal ausente vira 0 na tela", () => {
    const r = contarPublicadosPorCanal([]);
    expect(r).toEqual({});
    expect(r.MERCADO_LIVRE ?? 0).toBe(0);
  });

  it("mistura real: publicados, pendentes e canais que não travam categoria", () => {
    expect(
      contarPublicadosPorCanal([
        anuncio({ id: "1", platform: "MERCADO_LIVRE", externalListingId: "MLB1" }),
        anuncio({ id: "2", platform: "MERCADO_LIVRE", externalListingId: "PENDING_2" }),
        anuncio({ id: "3", platform: "SHOPEE", externalListingId: "33" }),
        anuncio({ id: "4", platform: "OLX", externalListingId: "SKU-4" }),
        anuncio({ id: "5", platform: "FACEBOOK", externalListingId: "SKU-5" }),
        anuncio({ id: "6", platform: "MAGALU", externalListingId: "SKU-6" }),
      ]),
    ).toEqual({
      MERCADO_LIVRE: 1,
      SHOPEE: 1,
      OLX: 1,
      FACEBOOK: 1,
      MAGALU: 1,
    });
  });
});
