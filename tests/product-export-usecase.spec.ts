import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  productFindManyMock,
  productCountMock,
  locationFindManyMock,
  queryRawMock,
  maskMock,
} = vi.hoisted(() => ({
  productFindManyMock: vi.fn(),
  productCountMock: vi.fn(),
  locationFindManyMock: vi.fn(),
  queryRawMock: vi.fn(),
  maskMock: vi.fn(async (p: unknown) => p),
}));

vi.mock("../app/lib/prisma", () => ({
  default: {
    product: { findMany: productFindManyMock, count: productCountMock },
    location: { findMany: locationFindManyMock },
    $queryRaw: queryRawMock,
  },
}));

vi.mock("../app/marketplaces/services/category-resolution.service", () => ({
  maskCorruptVehicleCategoriesInProducts: maskMock,
}));

import {
  EXPORT_PAGE_DEFAULT,
  EXPORT_PAGE_MAX,
  ExportParamError,
  attributeDisplayValue,
  exportProductsPage,
  getMlAttributeNames,
  parseExportCursor,
  parseExportLimit,
  resetMlAttributeNamesCache,
  splitAttributes,
  toExportProduct,
  type ExportSourceRow,
} from "../app/usecases/product-export.usecase";

/** Imita o Decimal do Prisma: objeto cujo toString é o número. */
const decimal = (v: string) => ({ toString: () => v, toJSON: () => v });

function linha(over: Partial<ExportSourceRow> = {}): ExportSourceRow {
  return {
    id: "p1",
    sku: "100",
    name: "Lanterna traseira",
    description: null,
    price: decimal("199.90"),
    costPrice: null,
    markup: null,
    stock: 1,
    reservedStock: 0,
    weightKg: decimal("1.25"),
    imageUrls: [],
    location: null,
    locationId: null,
    productLocation: null,
    attributes: null,
    listings: [],
    compatibilities: [],
    createdAt: new Date("2026-09-25T12:00:00.000Z"),
    updatedAt: new Date("2026-09-25T13:00:00.000Z"),
    ...over,
  };
}

const semNomes = new Map<string, string>();

describe("toExportProduct — localização (mesma precedência da tela)", () => {
  it("caminho completo quando há localização vinculada", () => {
    const p = toExportProduct(
      linha({
        locationId: "l1",
        productLocation: { code: "CX-3", description: "fundo" },
        location: "CX-3",
      }),
      () => "BARRACÃO 1 > R1 > CX-3",
      semNomes,
    );
    expect(p.location).toEqual({
      path: "BARRACÃO 1 > R1 > CX-3",
      description: "fundo",
      typedText: null,
    });
  });

  it("sem caminho cai no código; sem vínculo cai no texto livre", () => {
    const soCodigo = toExportProduct(
      linha({ locationId: "l1", productLocation: { code: "CX-3" } }),
      () => "",
      semNomes,
    );
    expect(soCodigo.location.path).toBe("CX-3");
    const soTexto = toExportProduct(linha({ location: "  Prateleira A  " }), () => "", semNomes);
    expect(soTexto.location).toEqual({ path: "Prateleira A", description: null, typedText: null });
    const nada = toExportProduct(linha(), () => "", semNomes);
    expect(nada.location.path).toBeNull();
  });

  it("texto digitado só aparece quando difere de verdade (não por espaço/caixa)", () => {
    const soEspaco = toExportProduct(
      linha({ locationId: "l1", productLocation: { code: "1P2CX4" }, location: "1p2 cx4" }),
      () => "GALPÃO > 1P2CX4",
      semNomes,
    );
    expect(soEspaco.location.typedText).toBeNull();
    const diferente = toExportProduct(
      linha({ locationId: "l1", productLocation: { code: "CX-9" }, location: "Prateleira velha" }),
      () => "GALPÃO > CX-9",
      semNomes,
    );
    expect(diferente.location.typedText).toBe("Prateleira velha");
  });

  it("texto gravado pelo montador antigo (trechos repetidos) é o mesmo lugar", () => {
    const p = toExportProduct(
      linha({
        locationId: "cb",
        productLocation: { code: "BARR. > CORR.-B" },
        location: "BARR. > BARR. > CORR.-B",
      }),
      () => "BARR. > CORR.-B",
      semNomes,
      () => "BARR. > BARR. > CORR.-B",
    );
    expect(p.location.path).toBe("BARR. > CORR.-B");
    expect(p.location.typedText).toBeNull();
  });
});

describe("toExportProduct — demais campos", () => {
  it("Decimal do Prisma vira número; lixo vira null", () => {
    const p = toExportProduct(
      linha({ costPrice: decimal("80.00"), markup: decimal("abc") }),
      () => "",
      semNomes,
    );
    expect(p.price).toBe(199.9);
    expect(p.costPrice).toBe(80);
    expect(p.weightKg).toBe(1.25);
    expect(p.markup).toBeNull();
    expect(p.createdAt).toBe("2026-09-25T12:00:00.000Z");
  });

  it("id provisório (PENDING_…) não é anúncio; anúncios ordenados por plataforma e conta", () => {
    const p = toExportProduct(
      linha({
        listings: [
          { externalListingId: "999", status: "active", permalink: null, marketplaceAccount: { platform: "SHOPEE", accountName: "Loja" } },
          { externalListingId: "PENDING_REPUBLISH_abc", status: "error", permalink: null, marketplaceAccount: { platform: "MERCADO_LIVRE", accountName: "B" } },
          { externalListingId: "MLB1", status: "active", permalink: "https://x", marketplaceAccount: { platform: "MERCADO_LIVRE", accountName: "A" } },
        ],
      }),
      () => "",
      semNomes,
    );
    expect(p.listings.map((l) => [l.platform, l.accountName, l.externalListingId])).toEqual([
      ["MERCADO_LIVRE", "A", "MLB1"],
      ["MERCADO_LIVRE", "B", null],
      ["SHOPEE", "Loja", "999"],
    ]);
  });

  it("sucata, autor, posições e compatibilidades", () => {
    const p = toExportProduct(
      linha({
        scrap: { nickname: "Gol azul", brand: "VW", model: "Gol", year: "2012" },
        createdBy: { name: " Fulana " },
        compatibilityPositions: ["Dianteira", 3, "", "Esquerda"],
        compatibilities: [{ brand: "VW", model: "Gol", version: " ", yearFrom: 2010, yearTo: null }],
      }),
      () => "",
      semNomes,
    );
    expect(p.scrap).toBe("Gol azul (VW Gol 2012)");
    expect(p.createdByName).toBe("Fulana");
    expect(p.compatibilityPositions).toEqual(["Dianteira", "Esquerda"]);
    expect(p.compatibilities).toEqual([
      { brand: "VW", model: "Gol", version: null, yearFrom: 2010, yearTo: null },
    ]);
    expect(toExportProduct(linha({ scrap: { brand: "Fiat", model: "Uno" } }), () => "", semNomes).scrap).toBe("Fiat Uno");
  });
});

describe("ficha técnica × dados de outro sistema", () => {
  it("separa chaves do ML das internas e usa o nome do campo", () => {
    const nomes = new Map([["COLOR", "Cor"], ["OEM", "Código OEM"]]);
    const { ficha, extraData } = splitAttributes(
      {
        COLOR: { value_id: "52049", value_name: "Preto" },
        OEM: { value_name: "261a39875r" },
        SIDE: { value_id: "42758041" },
        FITS: { values: [{ name: "Gol" }, { name: "Voyage" }] },
        EMPTY: { value_name: "  " },
        NULLED: null,
        etiquetaOrigem: "E-1234",
        legacyQty: 3,
        active: true,
        migration: { from: "vaapt", at: "2026-05-01" },
        mlbs: ["MLB1"],
        vazio: "",
      },
      nomes,
    );
    expect(ficha).toEqual([
      { id: "COLOR", name: "Cor", value: "Preto" },
      { id: "OEM", name: "Código OEM", value: "261a39875r" },
      { id: "SIDE", name: null, value: "42758041" },
      { id: "FITS", name: null, value: "Gol, Voyage" },
    ]);
    expect(extraData).toEqual([
      { key: "etiquetaOrigem", value: "E-1234" },
      { key: "legacyQty", value: "3" },
      { key: "active", value: "Sim" },
    ]);
  });

  it("ficha ausente, nula ou em formato inesperado não quebra", () => {
    expect(splitAttributes(null, semNomes)).toEqual({ ficha: [], extraData: [] });
    expect(splitAttributes([1, 2], semNomes)).toEqual({ ficha: [], extraData: [] });
    expect(splitAttributes("texto", semNomes)).toEqual({ ficha: [], extraData: [] });
    expect(attributeDisplayValue(12.5)).toBe("12.5");
    expect(attributeDisplayValue(undefined)).toBeNull();
  });
});

describe("parâmetros da rota", () => {
  it("cursor", () => {
    expect(parseExportCursor(undefined)).toBeUndefined();
    expect(parseExportCursor("")).toBeUndefined();
    expect(parseExportCursor("cmshlz9u80ub41855v7kx1qng")).toBe("cmshlz9u80ub41855v7kx1qng");
    expect(() => parseExportCursor("x' OR 1=1")).toThrow(ExportParamError);
    expect(() => parseExportCursor("a".repeat(65))).toThrow(ExportParamError);
  });

  it("limite: padrão, teto e inválido", () => {
    expect(parseExportLimit(undefined)).toBe(EXPORT_PAGE_DEFAULT);
    expect(parseExportLimit("200")).toBe(200);
    expect(parseExportLimit("50000")).toBe(EXPORT_PAGE_MAX);
    for (const ruim of ["0", "-1", "abc", "1.5"]) {
      expect(() => parseExportLimit(ruim)).toThrow(ExportParamError);
    }
  });
});

describe("exportProductsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMlAttributeNamesCache();
    queryRawMock.mockResolvedValue([{ id: "COLOR", name: "Cor" }]);
    productCountMock.mockResolvedValue(3);
    locationFindManyMock.mockResolvedValue([]);
  });

  it("primeira página: escopo do cliente, ordem por id, total e próximo cursor", async () => {
    productFindManyMock.mockResolvedValue([linha({ id: "a" }), linha({ id: "b" })]);
    const page = await exportProductsPage({ userId: "owner-1", limit: 2 });

    const args = productFindManyMock.mock.calls[0][0];
    expect(args.where).toEqual({ userId: "owner-1" });
    expect(args.orderBy).toEqual({ id: "asc" });
    expect(args.take).toBe(2);
    expect(productCountMock).toHaveBeenCalledWith({ where: { userId: "owner-1" } });
    expect(page.total).toBe(3);
    expect(page.nextCursor).toBe("b");
    expect(page.products.map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("página seguinte usa o cursor, não recalcula o total e termina com null", async () => {
    productFindManyMock.mockResolvedValue([linha({ id: "c" })]);
    const page = await exportProductsPage({ userId: "owner-1", cursor: "b", limit: 2 });
    expect(productFindManyMock.mock.calls[0][0].where).toEqual({
      userId: "owner-1",
      id: { gt: "b" },
    });
    expect(productCountMock).not.toHaveBeenCalled();
    expect(page.total).toBeUndefined();
    expect("total" in page).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it("seleção é allowlist: da conta do marketplace só plataforma e nome", async () => {
    productFindManyMock.mockResolvedValue([]);
    await exportProductsPage({ userId: "owner-1", limit: 10 });
    const select = productFindManyMock.mock.calls[0][0].select;
    expect(select.listings.select.marketplaceAccount).toEqual({
      select: { platform: true, accountName: true },
    });
    expect(Object.keys(select.createdBy.select)).toEqual(["name"]);
    const texto = JSON.stringify(select).toLowerCase();
    for (const proibido of ["token", "secret", "password", "senha", "email"]) {
      expect(texto).not.toContain(proibido);
    }
  });

  it("carrega só as localizações da página e seus ancestrais, do próprio cliente", async () => {
    productFindManyMock.mockResolvedValue([
      linha({ id: "a", locationId: "cx", productLocation: { code: "BARR. > CORR.-B > CX 1" } }),
      linha({ id: "b", locationId: "cx", productLocation: { code: "BARR. > CORR.-B > CX 1" } }),
    ]);
    locationFindManyMock
      .mockResolvedValueOnce([{ id: "cx", code: "BARR. > CORR.-B > CX 1", parentId: "corr" }])
      .mockResolvedValueOnce([{ id: "corr", code: "BARR. > CORR.-B", parentId: "barr" }])
      .mockResolvedValueOnce([{ id: "barr", code: "BARR.", parentId: null }]);

    const page = await exportProductsPage({ userId: "owner-1", limit: 10 });

    expect(locationFindManyMock).toHaveBeenCalledTimes(3);
    expect(locationFindManyMock.mock.calls.map((c) => c[0].where)).toEqual([
      { userId: "owner-1", id: { in: ["cx"] } },
      { userId: "owner-1", id: { in: ["corr"] } },
      { userId: "owner-1", id: { in: ["barr"] } },
    ]);
    expect(page.products[0].location.path).toBe("BARR. > CORR.-B > CX 1");
  });

  it("página sem localização não consulta Location", async () => {
    productFindManyMock.mockResolvedValue([linha({ id: "a" })]);
    await exportProductsPage({ userId: "owner-1", limit: 10 });
    expect(locationFindManyMock).not.toHaveBeenCalled();
  });

  it("aplica a mesma máscara de categoria da listagem (coluna Categoria igual à de antes)", async () => {
    productFindManyMock.mockResolvedValue([
      linha({
        id: "a",
        brand: "VW",
        model: "Gol",
        year: "2010",
        category: "Farol",
        mlCategory: { externalId: "MLB999", fullPath: "Casa > Luminárias" },
      }),
      linha({ id: "b", category: "Suspensão", mlCategory: { externalId: "MLB1", fullPath: "Peças" } }),
    ]);
    let recebido: unknown = null;
    maskMock.mockImplementationOnce(async (arg: unknown) => {
      const views = arg as Array<Record<string, unknown>>;
      recebido = structuredClone(views);
      // Simula a listagem: esconde as categorias do produto "a".
      views[0].category = null;
      views[0].mlCategory = null;
      return views;
    });

    const page = await exportProductsPage({ userId: "owner-1", limit: 10 });

    expect(maskMock).toHaveBeenCalledTimes(1);
    expect(recebido).toEqual([
      { brand: "VW", model: "Gol", year: "2010", category: "Farol", mlCategory: "MLB999" },
      { brand: null, model: null, year: null, category: "Suspensão", mlCategory: "MLB1" },
    ]);
    expect(page.products[0].category).toBeNull();
    expect(page.products[0].mlCategory).toEqual({ code: null, path: null });
    expect(page.products[1].category).toBe("Suspensão");
    expect(page.products[1].mlCategory).toEqual({ code: "MLB1", path: "Peças" });
  });

  it("localização gravada do jeito antigo não aparece como texto digitado", async () => {
    productFindManyMock.mockResolvedValue([
      linha({
        id: "a",
        locationId: "cb",
        productLocation: { code: "BARR. > CORR.-B" },
        location: "BARR. > BARR. > CORR.-B",
      }),
    ]);
    locationFindManyMock
      .mockResolvedValueOnce([{ id: "cb", code: "BARR. > CORR.-B", parentId: "b" }])
      .mockResolvedValueOnce([{ id: "b", code: "BARR.", parentId: null }]);
    const page = await exportProductsPage({ userId: "owner-1", limit: 10 });
    expect(page.products[0].location).toEqual({
      path: "BARR. > CORR.-B",
      description: null,
      typedText: null,
    });
  });

  it("nomes da ficha entram no produto", async () => {
    productFindManyMock.mockResolvedValue([
      linha({ id: "a", attributes: { COLOR: { value_name: "Azul" } } }),
    ]);
    const page = await exportProductsPage({ userId: "owner-1", limit: 10 });
    expect(page.products[0].ficha).toEqual([{ id: "COLOR", name: "Cor", value: "Azul" }]);
  });
});

describe("getMlAttributeNames", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMlAttributeNamesCache();
  });

  it("consulta uma vez e guarda em memória", async () => {
    queryRawMock.mockResolvedValue([{ id: "COLOR", name: "Cor" }]);
    const t0 = 1_000_000;
    const a = await getMlAttributeNames(t0);
    const b = await getMlAttributeNames(t0 + 60_000);
    expect(queryRawMock).toHaveBeenCalledTimes(1);
    expect(a.get("COLOR")).toBe("Cor");
    expect(b).toBe(a);
  });

  it("chamadas simultâneas compartilham a mesma consulta", async () => {
    queryRawMock.mockResolvedValue([{ id: "SIDE", name: "Lado" }]);
    const [a, b] = await Promise.all([getMlAttributeNames(1), getMlAttributeNames(1)]);
    expect(queryRawMock).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it("renova depois de 6 h", async () => {
    queryRawMock.mockResolvedValue([]);
    await getMlAttributeNames(0);
    await getMlAttributeNames(6 * 60 * 60 * 1000 + 1);
    expect(queryRawMock).toHaveBeenCalledTimes(2);
  });

  it("falha no banco devolve mapa vazio (planilha sai com o id) e não derruba a exportação", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    queryRawMock.mockRejectedValue(new Error("timeout"));
    const map = await getMlAttributeNames(0);
    expect(map.size).toBe(0);
    warn.mockRestore();
  });
});
