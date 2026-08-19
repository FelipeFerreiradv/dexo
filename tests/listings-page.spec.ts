import { describe, expect, it } from "vitest";

import {
  LISTINGS_PAGE_SIZE_MAX,
  LISTINGS_PAGE_SIZE_PADRAO,
  resolveListingsPage,
  totalDePaginas,
} from "../app/marketplaces/lib/listings-page";

/**
 * O cálculo de página das abas "Anúncios".
 *
 * Tudo que chega aqui é texto de URL. O modo de falhar que importa não é lançar
 * exceção — é devolver `skip: NaN`, que o Prisma aceita e responde com página
 * vazia. Para o operador isso aparece como "sumiram meus anúncios", sem erro em
 * lugar nenhum. Por isso os casos abaixo são quase todos de lixo.
 */
describe("resolveListingsPage — nunca produz skip inválido", () => {
  it("sem parâmetro nenhum, usa o padrão", () => {
    expect(resolveListingsPage({})).toEqual({
      page: 1,
      limit: LISTINGS_PAGE_SIZE_PADRAO,
      skip: 0,
    });
    expect(resolveListingsPage(undefined)).toEqual({
      page: 1,
      limit: LISTINGS_PAGE_SIZE_PADRAO,
      skip: 0,
    });
    expect(resolveListingsPage(null)).toEqual({
      page: 1,
      limit: LISTINGS_PAGE_SIZE_PADRAO,
      skip: 0,
    });
  });

  it("página e limite válidos viram skip correto", () => {
    expect(resolveListingsPage({ page: "3", limit: "50" })).toEqual({
      page: 3,
      limit: 50,
      skip: 100,
    });
    expect(resolveListingsPage({ page: 1, limit: 20 })).toEqual({
      page: 1,
      limit: 20,
      skip: 0,
    });
  });

  it("o teto duro não pode ser furado pela query", () => {
    // Era exatamente isto que a paginação veio impedir: uma resposta que cresce
    // com o tamanho da conta. Se `limit` fosse livre, `?limit=999999` recriaria
    // o problema inteiro.
    for (const limit of ["999999", 201, "1e9", 100000]) {
      expect(resolveListingsPage({ limit }).limit).toBe(LISTINGS_PAGE_SIZE_MAX);
    }
    expect(resolveListingsPage({ limit: 200 }).limit).toBe(200);
  });

  it("lixo cai no padrão em vez de virar NaN", () => {
    const lixo = [
      "",
      "  ",
      "abc",
      "0",
      "-5",
      "NaN",
      "Infinity",
      "-Infinity",
      {},
      [],
      true,
      null,
      undefined,
    ];

    for (const valor of lixo) {
      const r = resolveListingsPage({ page: valor, limit: valor });
      expect(Number.isInteger(r.page), `page com ${JSON.stringify(valor)}`).toBe(
        true,
      );
      expect(Number.isInteger(r.skip), `skip com ${JSON.stringify(valor)}`).toBe(
        true,
      );
      expect(r.page).toBeGreaterThanOrEqual(1);
      expect(r.limit).toBeGreaterThanOrEqual(1);
      expect(r.skip).toBeGreaterThanOrEqual(0);
    }
  });

  it("fracionário é truncado, não arredondado para cima", () => {
    // `page=2.9` virando 3 pularia uma página inteira sem o operador pedir.
    expect(resolveListingsPage({ page: "2.9" }).page).toBe(2);
    expect(resolveListingsPage({ limit: "10.9" }).limit).toBe(10);
  });

  it("parâmetro repetido na URL (array) usa o primeiro", () => {
    // `?page=1&page=2` chega como array no Fastify; `Number(["1","2"])` é NaN.
    expect(resolveListingsPage({ page: ["2", "7"] }).page).toBe(2);
    expect(resolveListingsPage({ page: [] }).page).toBe(1);
  });
});

describe("totalDePaginas", () => {
  it("conta as páginas certas", () => {
    expect(totalDePaginas(0, 50)).toBe(1);
    expect(totalDePaginas(1, 50)).toBe(1);
    expect(totalDePaginas(50, 50)).toBe(1);
    expect(totalDePaginas(51, 50)).toBe(2);
    expect(totalDePaginas(36185, 50)).toBe(724);
  });

  it("lista vazia tem UMA página, não zero", () => {
    // Zero páginas faria o rodapé mostrar "Página 1 de 0".
    expect(totalDePaginas(0, 50)).toBe(1);
    expect(totalDePaginas(-1, 50)).toBe(1);
    expect(totalDePaginas(Number.NaN, 50)).toBe(1);
  });
});
