import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fastify from "fastify";

import {
  OLX_CATEGORY_LABEL,
  OLX_DEFAULT_CATEGORY_ID,
} from "../app/marketplaces/olx/olx-category-map";
import {
  FACEBOOK_CATEGORY_LABEL,
  FACEBOOK_DEFAULT_CATEGORY,
} from "../app/marketplaces/facebook/facebook-category-map";

/**
 * A LISTA PRECISA OFERECER TUDO QUE A RESOLUÇÃO PRODUZ.
 *
 * O spec vizinho (olx-facebook-category-labels) provou a metade fácil da
 * invariante: todo código que a resolução devolve tem rótulo. Faltava a outra
 * metade, e era nela que estava o defeito — a LISTA que alimenta o combobox era
 * montada a partir do de-para de BUSCA (`OLX_CATEGORY_MAP` /
 * `FACEBOOK_CATEGORY_MAP`), e o DEFAULT de cada canal não tem palavra-chave lá,
 * justamente por ser o default.
 *
 * Consequência em produção: "Carros, vans e utilitários" (OLX 2101) e "Peças de
 * carros, vans e utilitários" (Meta) — a categoria da esmagadora maioria das
 * peças de um desmanche — nunca apareciam. O operador não conseguia escolhê-las
 * em nenhuma das seis telas (cadastro, edição e revisão em massa × dois canais),
 * e ao reabrir uma peça já salva com a default o campo vinha em branco, porque
 * nenhuma opção casava com o valor salvo.
 *
 * O teste é sobre a ROTA, não sobre uma cópia da regra: é a rota que a tela
 * chama.
 */

vi.mock("../app/lib/prisma", () => ({ default: {} }));
vi.mock("@/app/lib/prisma", () => ({ default: {} }));

vi.mock("../app/middlewares/auth.middleware", () => ({
  authMiddleware: async (request: any) => {
    request.user = { id: "user-1", dataOwnerId: "user-1" };
  },
}));

describe("as categorias de OLX e Facebook chegam INTEIRAS ao combobox", () => {
  let app: ReturnType<typeof fastify>;

  beforeEach(async () => {
    const { marketplaceRoutes } = await import(
      "../app/routes/marketplace.routes"
    );
    app = fastify();
    await app.register(marketplaceRoutes, { prefix: "/marketplace" });
  });

  afterEach(async () => {
    await app.close();
  });

  const buscar = async (url: string) => {
    const res = await app.inject({
      method: "GET",
      url,
      headers: { email: "t@e.com" },
    });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.payload).categories as Array<{
      id: string;
      value: string;
    }>;
  };

  it("OLX: a lista oferece as CINCO categorias, sem faltar nenhuma", async () => {
    const categories = await buscar("/marketplace/olx/categories");
    const ids = categories.map((c) => c.id).sort();

    expect(ids).toEqual(Object.keys(OLX_CATEGORY_LABEL).sort());
    expect(categories).toHaveLength(5);
  });

  it("OLX: a DEFAULT está na lista — era ela que faltava", async () => {
    const categories = await buscar("/marketplace/olx/categories");
    const padrao = categories.find(
      (c) => c.id === String(OLX_DEFAULT_CATEGORY_ID),
    );

    expect(padrao, "a categoria padrão da OLX sumiu da lista").toBeDefined();
    expect(padrao!.value).toBe("Carros, vans e utilitários");
  });

  it("Facebook: a lista oferece as TRÊS categorias, incluindo a DEFAULT", async () => {
    const categories = await buscar("/marketplace/facebook/categories");
    const ids = categories.map((c) => c.id).sort();

    expect(ids).toEqual(Object.keys(FACEBOOK_CATEGORY_LABEL).sort());
    const padrao = categories.find((c) => c.id === FACEBOOK_DEFAULT_CATEGORY);
    expect(padrao, "a categoria padrão da Meta sumiu da lista").toBeDefined();
    expect(padrao!.value).toBe("Peças de carros, vans e utilitários");
  });

  it("o operador acha a categoria de carro digitando o que ele fala", async () => {
    // Sem a default na lista, todas estas buscas voltavam vazias.
    for (const termo of ["carro", "carros", "van", "utilitario", "utilitário"]) {
      const olx = await buscar(
        `/marketplace/olx/categories?search=${encodeURIComponent(termo)}`,
      );
      expect(
        olx.map((c) => c.id),
        `OLX buscando "${termo}"`,
      ).toContain(String(OLX_DEFAULT_CATEGORY_ID));

      const fb = await buscar(
        `/marketplace/facebook/categories?search=${encodeURIComponent(termo)}`,
      );
      expect(
        fb.map((c) => c.id),
        `Facebook buscando "${termo}"`,
      ).toContain(FACEBOOK_DEFAULT_CATEGORY);
    }
  });

  it("a busca por sinônimo continua funcionando (singular/plural e acento)", async () => {
    const casos: Array<[string, string]> = [
      ["caminhão", "2102"],
      ["caminhao", "2102"],
      ["caminhões", "2102"],
      ["moto", "2103"],
      ["ônibus", "2105"],
      ["onibus", "2105"],
      ["barco", "2104"],
      ["lancha", "2104"],
    ];

    for (const [termo, esperado] of casos) {
      const categories = await buscar(
        `/marketplace/olx/categories?search=${encodeURIComponent(termo)}`,
      );
      expect(
        categories.map((c) => c.id),
        `buscando "${termo}"`,
      ).toContain(esperado);
    }
  });

  it("nenhum rótulo é número cru nem caminho em inglês", async () => {
    for (const url of [
      "/marketplace/olx/categories",
      "/marketplace/facebook/categories",
    ]) {
      for (const c of await buscar(url)) {
        expect(c.value, `${url} → ${c.id}`).not.toMatch(/^\d+$/);
        expect(c.value).not.toContain("_");
        expect(c.value).not.toContain(">");
        expect(c.value.toLowerCase()).not.toContain("vehicle");
        expect(c.value.trim().length).toBeGreaterThan(2);
      }
    }
  });

  it("busca que não casa nada devolve lista vazia, não a lista inteira", async () => {
    // Controle negativo do filtro: se o `filter` for frouxo, os casos acima
    // passariam por acidente.
    for (const url of [
      "/marketplace/olx/categories",
      "/marketplace/facebook/categories",
    ]) {
      expect(await buscar(`${url}?search=zzzznaoexiste`)).toEqual([]);
    }
  });
});
