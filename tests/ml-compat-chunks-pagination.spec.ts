import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import axios from "axios";
import {
  MLApiService,
  __resetCompatCacheForTests,
} from "../app/marketplaces/services/ml-api.service";

/**
 * Paginação do POST /catalog_compatibilities/products_search/chunks.
 *
 * Contrato MEDIDO contra a API real em 22/09/2026 (sonda somente leitura):
 *  - `offset` no CORPO é ignorado — offset 0 e 1500 devolvem os mesmos 50;
 *  - `?offset=&limit=` na QUERY STRING pagina de verdade;
 *  - o total vem em `total` na RAIZ, não em `paging.total`;
 *  - `limit` tem teto de 50.
 *
 * O código mandava o offset só no corpo e lia `paging.total` (sempre ausente):
 * relia os mesmos 50 veículos 30 vezes ("1500 total fetched") e qualquer ano
 * fora deles sumia. Ford Fiesta tem 209 no catálogo; o 2002 nunca era achado.
 * Em 30 dias: ~2.160 anúncios de 11 clientes com compatibilidade faltando.
 */

vi.mock("axios");
const mockedAxios = axios as any;

type Prod = { id: string; attributes: any[] };

function produto(
  id: string,
  model: { id: string; name: string },
  year: string,
): Prod {
  return {
    id,
    attributes: [
      { id: "BRAND", value_id: "66432", value_name: "Ford" },
      { id: "MODEL", value_id: model.id, value_name: model.name },
      { id: "VEHICLE_YEAR", value_name: year },
    ],
  };
}

const FIESTA = { id: "66659", name: "Fiesta" };

/** 209 Fiestas; os 9 de 2002 só aparecem a partir do offset 200. */
const CATALOGO_FIESTA: Prod[] = Array.from({ length: 209 }, (_, i) =>
  produto(`MLB_FIESTA_${i}`, FIESTA, i >= 200 ? "2002" : String(2005 + (i % 15))),
);

/**
 * Simulador fiel do endpoint real: pagina SÓ pela query string e ignora o
 * `offset` do corpo; responde `{results, total}` sem `paging`.
 */
function simuladorML(catalogo: Prod[]) {
  return (url: string, _body: any, config: any) => {
    if (!url.includes("products_search/chunks")) {
      return Promise.resolve({ data: {} });
    }
    const offset = Number(config?.params?.offset ?? 0);
    const limit = Math.min(Number(config?.params?.limit ?? 50), 50);
    return Promise.resolve({
      data: {
        results: catalogo.slice(offset, offset + limit),
        total: catalogo.length,
      },
    });
  };
}

function dominioFord() {
  return {
    data: {
      attributes: [
        { id: "BRAND", values: [{ id: "66432", name: "Ford" }] },
      ],
    },
  };
}

const chamadasChunks = () =>
  (mockedAxios.post.mock.calls as any[]).filter(
    ([url]) => typeof url === "string" && url.includes("products_search/chunks"),
  );

describe("searchCatalogCompatibilityChunks — contrato real da paginação", () => {
  beforeEach(() => {
    mockedAxios.post = vi.fn();
    mockedAxios.get = vi.fn();
    mockedAxios.isAxiosError = () => false;
    __resetCompatCacheForTests();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("manda offset/limit na query string (e mantém no corpo, inofensivo)", async () => {
    mockedAxios.post.mockResolvedValue({ data: { results: [], total: 0 } });
    await MLApiService.searchCatalogCompatibilityChunks("tok", {
      knownAttributes: [{ id: "BRAND", value_id: "66432" }],
      limit: 50,
      offset: 150,
    });
    const [url, body, config] = mockedAxios.post.mock.calls[0];
    expect(url).toMatch(/products_search\/chunks$/);
    expect(config.params).toEqual({ limit: 50, offset: 150 });
    expect(body.offset).toBe(150);
    expect(body.site_id).toBe("MLB");
  });

  it("normaliza o `total` da raiz para `paging.total`", async () => {
    mockedAxios.post.mockResolvedValue({ data: { results: [], total: 209 } });
    const r = await MLApiService.searchCatalogCompatibilityChunks("tok", {});
    expect(r.paging?.total).toBe(209);
    expect(r.total).toBe(209);
  });

  it("não sobrescreve um `paging.total` que o ML venha a mandar", async () => {
    mockedAxios.post.mockResolvedValue({
      data: { results: [], paging: { total: 7 } },
    });
    const r = await MLApiService.searchCatalogCompatibilityChunks("tok", {});
    expect(r.paging?.total).toBe(7);
  });
});

describe("resolveCompatibilityCatalogProducts — ano fora dos 50 primeiros", () => {
  beforeEach(() => {
    mockedAxios.post = vi.fn();
    mockedAxios.get = vi.fn().mockResolvedValue(dominioFord());
    mockedAxios.isAxiosError = () => false;
    __resetCompatCacheForTests();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    __resetCompatCacheForTests();
  });

  it("Ford Fiesta 2002 (só existe depois do offset 200) é resolvido", async () => {
    mockedAxios.post.mockImplementation(simuladorML(CATALOGO_FIESTA));
    const r = await MLApiService.resolveCompatibilityCatalogProducts("tok", [
      { brand: "Ford", model: "Fiesta", yearFrom: 2002, yearTo: 2002 },
    ]);
    const de2002 = r.catalogProductIds.filter((id) =>
      ["200", "201", "202", "203", "204", "205", "206", "207", "208"].some(
        (n) => id === `MLB_FIESTA_${n}`,
      ),
    );
    expect(de2002).toHaveLength(9);
    expect(r.unresolved).toEqual([]);
    expect(r.truncated ?? []).toEqual([]);
  });

  it("para no total informado: 209 produtos ⇒ 5 páginas, não 30", async () => {
    mockedAxios.post.mockImplementation(simuladorML(CATALOGO_FIESTA));
    await MLApiService.resolveCompatibilityCatalogProducts("tok", [
      { brand: "Ford", model: "Fiesta", yearFrom: 2010, yearTo: 2010 },
    ]);
    // listCompatibilityModels (5 páginas) + busca do par (5 páginas)
    expect(chamadasChunks().length).toBeLessThanOrEqual(10);
  });

  it("ano que o catálogo do ML não tem continua não resolvido (sem inventar)", async () => {
    mockedAxios.post.mockImplementation(simuladorML(CATALOGO_FIESTA));
    const r = await MLApiService.resolveCompatibilityCatalogProducts("tok", [
      { brand: "Ford", model: "Fiesta", yearFrom: 1990, yearTo: 1990 },
    ]);
    expect(r.catalogProductIds).toEqual([]);
    expect(r.unresolved).toHaveLength(1);
    expect(r.unresolved[0].reason).toMatch(/no catalog products for 1990/);
    expect(r.truncated ?? []).toEqual([]);
  });

  it("se o ML ignorar TODO offset (página repetida), para cedo e marca truncado", async () => {
    // Pior caso: o ML devolve sempre a mesma página. O código antigo fazia 30
    // chamadas idênticas; agora a 2ª página sem id novo encerra a busca.
    mockedAxios.post.mockImplementation((url: string) => {
      if (!url.includes("products_search/chunks")) {
        return Promise.resolve({ data: {} });
      }
      return Promise.resolve({
        data: { results: CATALOGO_FIESTA.slice(0, 50), total: 209 },
      });
    });
    const r = await MLApiService.resolveCompatibilityCatalogProducts("tok", [
      { brand: "Ford", model: "Fiesta", yearFrom: 2002, yearTo: 2002 },
    ]);
    expect(chamadasChunks().length).toBeLessThanOrEqual(4);
    expect(r.truncated).toEqual([
      { brand: "Ford", model: "Fiesta", fetched: 50, total: 209 },
    ]);
    expect(r.unresolved).toHaveLength(1);
  });

  it("vários anos no mesmo par: uma busca só, todos os anos cobertos", async () => {
    mockedAxios.post.mockImplementation(simuladorML(CATALOGO_FIESTA));
    const r = await MLApiService.resolveCompatibilityCatalogProducts("tok", [
      { brand: "Ford", model: "Fiesta", yearFrom: 2002, yearTo: 2006 },
    ]);
    // 2002 (9) + 2005 e 2006 existem; 2003 e 2004 não existem no catálogo
    expect(r.catalogProductIds.length).toBeGreaterThan(9);
    const anosNaoResolvidos = r.unresolved.map((u) => u.year).sort();
    expect(anosNaoResolvidos).toEqual([2003, 2004]);
  });
});

describe("listCompatibilityModels — modelos além da 1ª página", () => {
  beforeEach(() => {
    mockedAxios.post = vi.fn();
    mockedAxios.get = vi.fn();
    mockedAxios.isAxiosError = () => false;
    __resetCompatCacheForTests();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    __resetCompatCacheForTests();
  });

  it("lista EcoSport, que só aparece a partir da 4ª página", async () => {
    const catalogo: Prod[] = [
      ...Array.from({ length: 100 }, (_, i) =>
        produto(`MLB_F_${i}`, FIESTA, "2010"),
      ),
      ...Array.from({ length: 50 }, (_, i) =>
        produto(`MLB_K_${i}`, { id: "KA", name: "Ka" }, "2012"),
      ),
      ...Array.from({ length: 20 }, (_, i) =>
        produto(`MLB_E_${i}`, { id: "ECO", name: "EcoSport" }, "2015"),
      ),
    ];
    mockedAxios.post.mockImplementation(simuladorML(catalogo));
    const models = await MLApiService.listCompatibilityModels("tok", {
      valueId: "66432",
      name: "Ford",
    });
    expect(models.map((m) => m.name).sort()).toEqual([
      "EcoSport",
      "Fiesta",
      "Ka",
    ]);
  });
});
