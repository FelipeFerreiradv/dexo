import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ──────────────────────────────────────────────────────────
// Bloco A — integração do mapper no createShopeeListing.
//
// Arquivo SEPARADO de tests/shopee-listing-attrs.spec.ts de propósito: aquele
// congela o comportamento legado (flag desligada) e não pode ser contaminado
// pelo estado da env. Aqui a flag SHOPEE_ATTR_MAPPER_ENABLED fica ligada.
//
// O teste mais importante é o de PARIDADE: com a flag desligada, o payload
// enviado à Shopee tem de ser exatamente o mesmo de hoje. É o que torna o
// kill-switch confiável.
// ──────────────────────────────────────────────────────────

vi.mock("@/app/lib/prisma", () => ({
  default: {
    shopeeCategoryAttribute: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({}),
    },
    productListing: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
    },
  },
}));
vi.mock("../app/lib/prisma", () => ({
  default: {
    shopeeCategoryAttribute: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({}),
    },
    productListing: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
    },
  },
}));

vi.mock("../app/marketplaces/repositories/marketplace.repository", () => ({
  MarketplaceRepository: {
    findByIdAndUser: vi.fn(),
    findFirstActiveByUserAndPlatform: vi.fn(),
    findAllByUserIdAndPlatform: vi.fn(),
    updateTokens: vi.fn(),
    updateStatus: vi.fn(),
  },
}));

vi.mock("../app/marketplaces/repositories/listing.repository", () => ({
  ListingRepository: {
    findByProductAndAccount: vi.fn(),
    findLiveByProductAndAccount: vi.fn(async () => null),
    createListing: vi.fn(),
    updateListing: vi.fn(),
  },
}));

vi.mock("../app/marketplaces/repositories/category.repository", () => ({
  CategoryRepository: {
    findByExternalId: vi.fn(),
    findByFullPath: vi.fn(),
    findById: vi.fn(),
  },
  default: { findByExternalId: vi.fn() },
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
import { MarketplaceRepository } from "../app/marketplaces/repositories/marketplace.repository";
import { ListingRepository } from "../app/marketplaces/repositories/listing.repository";
import { ShopeeApiService } from "../app/marketplaces/services/shopee-api.service";
import { ProductRepositoryPrisma } from "../app/repositories/product.repository";
import { ShopeeAttributeCatalogService } from "../app/marketplaces/services/shopee-attribute-catalog.service";

const mockAccount = {
  id: "shp-acct-mapper",
  accessToken: "shp-token",
  refreshToken: "shp-refresh",
  shopId: 1547916297,
  accountName: "Loja Autopeça",
  status: "ACTIVE",
  expiresAt: new Date(Date.now() + 3600 * 1000),
} as any;

const baseProduct = {
  id: "prod-autopart",
  userId: "user-autopart",
  sku: "SKU-AUTOPART",
  name: "Farol Dianteiro Esquerdo Fiat Argo 2018",
  description: "Descrição",
  price: 99,
  stock: 1,
  imageUrl: "/uploads/farol.jpg",
  imageUrls: ["/uploads/farol.jpg"],
  heightCm: 15,
  widthCm: 20,
  lengthCm: 30,
  weightKg: 2.5,
  brand: "Fiat",
  model: "Argo",
  year: "2018",
  partNumber: "2142354345",
  quality: "SEMINOVO",
  shopeeCategoryId: "102298",
  attributes: null,
  compatibilities: [],
} as any;

/** Recorte fiel da categoria 102298 (1.161 anúncios em produção). */
const CAT_102298 = [
  { attribute_id: 102293, attribute_name: "Auto-Part Number", is_mandatory: true, input_type: "3", attribute_value_list: [] },
  { attribute_id: 100095, attribute_name: "Weight", is_mandatory: false, input_type: "2", attribute_unit: ["g", "kg"], attribute_value_list: [] },
  { attribute_id: 100773, attribute_name: "Lighting Type", is_mandatory: false, input_type: "2", attribute_value_list: [] },
  { attribute_id: 100942, attribute_name: "Dimension (L x W x H)", is_mandatory: false, input_type: "3", attribute_value_list: [] },
  { attribute_id: 101638, attribute_name: "Item condition", is_mandatory: false, input_type: "5", attribute_value_list: [{ value_id: 9, value_name: "Novo" }, { value_id: 8, value_name: "Usado" }] },
  { attribute_id: 101674, attribute_name: "Side", is_mandatory: false, input_type: "5", attribute_value_list: [{ value_id: 20, value_name: "Direito" }, { value_id: 21, value_name: "Esquerdo" }] },
  { attribute_id: 102200, attribute_name: "Car brand", is_mandatory: false, input_type: "5", attribute_value_list: [{ value_id: 10, value_name: "Fiat" }] },
];

function setupCommon() {
  ShopeeAttributeCatalogService._resetForTests();
  vi.spyOn(MarketplaceRepository, "findByIdAndUser").mockResolvedValue(
    mockAccount,
  );
  vi.spyOn(
    MarketplaceRepository,
    "findFirstActiveByUserAndPlatform",
  ).mockResolvedValue(mockAccount);
  vi.spyOn(
    MarketplaceRepository,
    "findAllByUserIdAndPlatform",
  ).mockResolvedValue([mockAccount]);
  vi.spyOn(ProductRepositoryPrisma.prototype, "findById").mockResolvedValue(
    baseProduct,
  );
  vi.spyOn(ListingRepository, "findByProductAndAccount").mockResolvedValue(
    null,
  );
  vi.spyOn(ListingRepository, "createListing").mockResolvedValue({
    id: "listing-shp-mapper",
  } as any);
  vi.spyOn(ListingRepository, "updateListing").mockResolvedValue({} as any);
  vi.spyOn(ShopeeApiService, "assertLeafCategory").mockResolvedValue(undefined);
  vi.spyOn(ShopeeApiService, "uploadImage").mockResolvedValue({
    image_info: { image_id: "img-1", image_url: "https://cdn/x" },
  } as any);
  vi.spyOn(ShopeeApiService, "getLogisticsChannelList").mockResolvedValue([
    { logistics_channel_id: 1, logistics_channel_name: "Xpress", enabled: true },
  ] as any);
  vi.spyOn(ShopeeApiService, "getCategoryAttributes").mockResolvedValue({
    attribute_list: CAT_102298,
  } as any);
  return vi
    .spyOn(ShopeeApiService, "createItem")
    .mockResolvedValue({ item_id: 777 } as any);
}

function attrsDoPayload(createSpy: any) {
  const payload = createSpy.mock.calls[0]?.[2];
  return (payload?.attribute_list ?? []) as Array<any>;
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.SHOPEE_ATTR_MAPPER_ENABLED;
  delete process.env.SHOPEE_ATTR_MAPPER_STRICT;
});

describe("createShopeeListing com SHOPEE_ATTR_MAPPER_ENABLED", () => {
  beforeEach(() => {
    process.env.SHOPEE_ATTR_MAPPER_ENABLED = "true";
  });

  it("cobertura sobe de 1 para vários atributos na categoria 102298", async () => {
    const createSpy = setupCommon();

    await ListingUseCase.createShopeeListing(
      "user-autopart",
      "prod-autopart",
      "102298",
      "shp-acct-mapper",
    );

    const attrs = attrsDoPayload(createSpy);
    const porId = new Map(attrs.map((a) => [a.attribute_id, a]));

    // Baseline de produção era APENAS o Auto-Part Number.
    expect(attrs.length).toBeGreaterThanOrEqual(5);
    expect(
      porId.get(102293)?.attribute_value_list[0].original_value_name,
    ).toBe("2142354345");
    // Lado inferido do nome do produto e casado no enum da categoria.
    expect(porId.get(101674)?.attribute_value_list[0]).toEqual({
      value_id: 21,
      original_value_name: "Esquerdo",
    });
    // Condição derivada de quality=SEMINOVO.
    expect(porId.get(101638)?.attribute_value_list[0].original_value_name).toBe(
      "Usado",
    );
    // Marca do veículo.
    expect(porId.get(102200)?.attribute_value_list[0].value_id).toBe(10);
    // Dimensões e peso, que antes nunca iam.
    expect(
      porId.get(100942)?.attribute_value_list[0].original_value_name,
    ).toBe("30 x 20 x 15 cm");
    expect(porId.get(100095)).toBeTruthy();
    // Nenhum valor vazio.
    for (const a of attrs) {
      expect(a.attribute_value_list[0].original_value_name).toBeTruthy();
    }
  });

  it("emite o log de cobertura com os números do relatório", async () => {
    const createSpy = setupCommon();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await ListingUseCase.createShopeeListing(
      "user-autopart",
      "prod-autopart",
      "102298",
      "shp-acct-mapper",
    );

    const linha = logSpy.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes("shopee.create_item.attributes"));
    expect(linha).toBeTruthy();
    const evento = JSON.parse(linha as string);
    expect(evento).toMatchObject({
      event: "shopee.create_item.attributes",
      categoryId: 102298,
      productId: "prod-autopart",
      total: 7,
    });
    expect(evento.filled).toBeGreaterThanOrEqual(5);
    expect(Array.isArray(evento.unmapped)).toBe(true);
    expect(createSpy).toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it("aplica os overrides do anúncio na ficha (partNumberOverride vence o produto)", async () => {
    const createSpy = setupCommon();
    vi.spyOn(ListingRepository, "findByProductAndAccount").mockResolvedValue({
      id: "l-existente",
      partNumberOverride: "OVERRIDE-123",
    } as any);

    await ListingUseCase.createShopeeListing(
      "user-autopart",
      "prod-autopart",
      "102298",
      "shp-acct-mapper",
    );

    const attrs = attrsDoPayload(createSpy);
    const partNumber = attrs.find((a) => a.attribute_id === 102293);
    expect(partNumber.attribute_value_list[0].original_value_name).toBe(
      "OVERRIDE-123",
    );
  });

  it("ficha técnica do operador vence a derivação", async () => {
    const createSpy = setupCommon();
    vi.spyOn(ProductRepositoryPrisma.prototype, "findById").mockResolvedValue({
      ...baseProduct,
      attributes: { "100773": { value_name: "LED" } },
    });

    await ListingUseCase.createShopeeListing(
      "user-autopart",
      "prod-autopart",
      "102298",
      "shp-acct-mapper",
    );

    const attrs = attrsDoPayload(createSpy);
    const lighting = attrs.find((a) => a.attribute_id === 100773);
    expect(lighting.attribute_value_list[0].original_value_name).toBe("LED");
  });

  it("não quebra quando o produto não tem dado nenhum além do obrigatório", async () => {
    const createSpy = setupCommon();
    vi.spyOn(ProductRepositoryPrisma.prototype, "findById").mockResolvedValue({
      ...baseProduct,
      partNumber: null,
      weightKg: null,
      heightCm: null,
      widthCm: null,
      lengthCm: null,
      quality: null,
      name: "Peca generica",
    });

    const r = await ListingUseCase.createShopeeListing(
      "user-autopart",
      "prod-autopart",
      "102298",
      "shp-acct-mapper",
    );

    expect(r.success).toBe(true);
    const attrs = attrsDoPayload(createSpy);
    // O obrigatório continua preenchido pelo fallback legado (paridade).
    const partNumber = attrs.find((a) => a.attribute_id === 102293);
    expect(partNumber.attribute_value_list[0].original_value_name).toBe("Fiat");
  });
});

describe("paridade com a flag DESLIGADA (o kill-switch é confiável)", () => {
  it("payload é byte-idêntico ao comportamento legado", async () => {
    // Com a flag ligada.
    process.env.SHOPEE_ATTR_MAPPER_ENABLED = "true";
    const spyLigado = setupCommon();
    await ListingUseCase.createShopeeListing(
      "user-autopart",
      "prod-autopart",
      "102298",
      "shp-acct-mapper",
    );
    const comMapper = attrsDoPayload(spyLigado);
    vi.restoreAllMocks();

    // Com a flag desligada.
    delete process.env.SHOPEE_ATTR_MAPPER_ENABLED;
    const spyDesligado = setupCommon();
    await ListingUseCase.createShopeeListing(
      "user-autopart",
      "prod-autopart",
      "102298",
      "shp-acct-mapper",
    );
    const semMapper = attrsDoPayload(spyDesligado);

    // O legado conhecia 4 campos: aqui só marca, modelo, ano e part number
    // teriam chance — e nesta categoria nenhum desses nomes existe além do
    // Auto-Part Number.
    expect(semMapper.map((a: any) => a.attribute_id)).toEqual([102293]);
    expect(comMapper.length).toBeGreaterThan(semMapper.length);
    // O atributo que ambos preenchem tem o MESMO valor.
    const legado = semMapper.find((a: any) => a.attribute_id === 102293);
    const novo = comMapper.find((a: any) => a.attribute_id === 102293);
    expect(novo.attribute_value_list[0].original_value_name).toBe(
      legado.attribute_value_list[0].original_value_name,
    );
  });
});
