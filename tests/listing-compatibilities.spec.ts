import { describe, it, expect, vi } from "vitest";

// Mocks para repos/servicos que tocam Prisma/HTTP (so precisamos do builder interno)
vi.mock("../app/marketplaces/repositories/marketplace.repository", () => ({
  MarketplaceRepository: {
    findByIdAndUser: vi.fn(),
    findFirstActiveByUserAndPlatform: vi.fn(),
    findAllByUserIdAndPlatform: vi.fn(),
  },
}));
vi.mock("../app/marketplaces/repositories/listing.repository", () => ({
  ListingRepository: {
    findByProductAndAccount: vi.fn(),
    createListing: vi.fn(),
    updateListing: vi.fn(),
  },
}));
vi.mock("../app/services/system-log.service", () => ({
  SystemLogService: {
    logError: vi.fn(),
    logWarning: vi.fn(),
    logInfo: vi.fn(),
    log: vi.fn(),
  },
}));

import { ListingUseCase } from "../app/marketplaces/usecases/listing.usercase";

const formatLines = (ListingUseCase as any).formatCompatibilityLines.bind(
  ListingUseCase,
) as (p: { compatibilities?: any }) => string[];

const buildMLDescription = (ListingUseCase as any).buildMLDescription.bind(
  ListingUseCase,
) as (
  product: any,
  source?: "product" | "user_default" | "fallback",
) => { text: string; source: string };

const buildShopeeDescription = (ListingUseCase as any).buildShopeeDescription.bind(
  ListingUseCase,
) as (product: any) => string;

describe("ListingUseCase.formatCompatibilityLines", () => {
  it("retorna vazio quando nao ha compatibilidades", () => {
    expect(formatLines({})).toEqual([]);
    expect(formatLines({ compatibilities: [] })).toEqual([]);
    expect(formatLines({ compatibilities: null as any })).toEqual([]);
  });

  it("formata brand + model + range de anos", () => {
    const lines = formatLines({
      compatibilities: [
        { brand: "fiat", model: "Uno", yearFrom: 2010, yearTo: 2014 },
        { brand: "VW", model: "Gol", yearFrom: 2015, yearTo: 2015 },
      ],
    });
    expect(lines).toEqual(["FIAT Uno 2010-2014", "VW Gol 2015"]);
  });

  it("trata ano so-inicio e so-fim", () => {
    const lines = formatLines({
      compatibilities: [
        { brand: "Ford", model: "Ka", yearFrom: 2018 },
        { brand: "Ford", model: "Fiesta", yearTo: 2010 },
      ],
    });
    expect(lines).toEqual(["FORD Ka 2018+", "FORD Fiesta até 2010"]);
  });

  it("inclui version quando presente", () => {
    const lines = formatLines({
      compatibilities: [
        {
          brand: "Honda",
          model: "Civic",
          yearFrom: 2016,
          yearTo: 2020,
          version: "EXL",
        },
      ],
    });
    expect(lines).toEqual(["HONDA Civic 2016-2020 EXL"]);
  });

  it("dedupe case-insensitive preservando primeira ocorrencia", () => {
    const lines = formatLines({
      compatibilities: [
        { brand: "Fiat", model: "Palio", yearFrom: 2012, yearTo: 2016 },
        { brand: "FIAT", model: "Palio", yearFrom: 2012, yearTo: 2016 },
        { brand: "fiat", model: "palio", yearFrom: 2012, yearTo: 2016 },
      ],
    });
    expect(lines).toEqual(["FIAT Palio 2012-2016"]);
  });

  it("ignora entradas sem brand ou sem model", () => {
    const lines = formatLines({
      compatibilities: [
        { brand: "", model: "X" },
        { brand: "Toyota", model: "" },
        { brand: "  ", model: "  " },
        { brand: "Chevrolet", model: "Onix" },
      ],
    });
    expect(lines).toEqual(["CHEVROLET Onix"]);
  });

  it("ignora anos invalidos (0 ou negativos)", () => {
    const lines = formatLines({
      compatibilities: [
        { brand: "Renault", model: "Sandero", yearFrom: 0, yearTo: 0 },
      ],
    });
    expect(lines).toEqual(["RENAULT Sandero"]);
  });
});

describe("ListingUseCase.buildMLDescription with compatibilities", () => {
  const baseProduct = {
    id: "p-1",
    sku: "SKU-1",
    name: "Farol Dianteiro",
    brand: "Original",
    compatibilities: [
      { brand: "Fiat", model: "Uno", yearFrom: 2010, yearTo: 2014 },
      { brand: "VW", model: "Gol", yearFrom: 2012, yearTo: 2016 },
    ],
  };

  it("injeta bloco de compatibilidades quando descricao do produto esta ausente", () => {
    const { text } = buildMLDescription(baseProduct);
    expect(text).toContain("Compatível com:");
    expect(text).toContain("FIAT Uno 2010-2014");
    expect(text).toContain("VW Gol 2012-2016");
  });

  it("apendamos compatibilidades na descricao original do produto", () => {
    const { text } = buildMLDescription({
      ...baseProduct,
      description: "Peça nova, lacrada, garantia de 30 dias.",
    });
    expect(text).toContain("Peça nova, lacrada, garantia de 30 dias.");
    expect(text).toContain("Compatível com:");
    expect(text).toContain("FIAT Uno 2010-2014");
  });

  it("nao duplica se a descricao ja mencionar 'Compatível com'", () => {
    const { text } = buildMLDescription({
      ...baseProduct,
      description: "Compatível com vários modelos listados abaixo...",
    });
    const matches = text.match(/compat[ií]vel com/gi) || [];
    expect(matches.length).toBe(1);
  });

  it("nao quebra produtos sem compatibilidades", () => {
    const { text } = buildMLDescription({
      id: "p-2",
      sku: "SKU-2",
      name: "Amortecedor",
      brand: "Cofap",
    });
    expect(text).toBeTruthy();
    expect(text).not.toContain("Compatível com:");
  });
});

describe("ListingUseCase.buildShopeeDescription with compatibilities", () => {
  const baseProduct = {
    id: "p-1",
    sku: "SKU-1",
    name: "Lanterna Traseira",
    brand: "OEM",
    model: "Focus",
    compatibilities: [
      { brand: "Ford", model: "Focus", yearFrom: 2014, yearTo: 2019 },
    ],
  };

  it("adiciona bloco de compatibilidades na descricao", () => {
    const desc = buildShopeeDescription(baseProduct);
    expect(desc).toContain("Compatível com:");
    expect(desc).toContain("FORD Focus 2014-2019");
  });

  it("preserva descricao original e adiciona compatibilidades", () => {
    const desc = buildShopeeDescription({
      ...baseProduct,
      description: "Item de reposição com garantia.",
    });
    expect(desc).toContain("Item de reposição com garantia.");
    expect(desc).toContain("Compatível com:");
    expect(desc).toContain("FORD Focus 2014-2019");
  });

  it("nao duplica bloco se descricao original ja menciona compatibilidade", () => {
    const desc = buildShopeeDescription({
      ...baseProduct,
      description: "Compatível com Ford Focus 2014 em diante.",
    });
    const matches = desc.match(/compat[ií]vel com/gi) || [];
    expect(matches.length).toBe(1);
  });

  it("funciona sem compatibilidades (sem regressao)", () => {
    const desc = buildShopeeDescription({
      id: "p-2",
      sku: "SKU-2",
      name: "Pastilha de Freio",
      brand: "Fras-le",
    });
    expect(desc).toContain("SKU: SKU-2");
    expect(desc).not.toContain("Compatível com:");
  });
});
