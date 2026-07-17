import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mockar prisma porque o catalog service tenta findUnique/upsert em
// shopeeCategoryAttribute. Sem mock, o Prisma client (depois de prisma generate)
// tenta conectar em localhost:5432 do test env e da timeout. Antes do prisma
// generate o property era undefined e o try/catch interno engolia — agora
// precisamos do mock pra retornar null/no-op sincronicamente.
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
    // Guard anti-duplicata (espelho do ML): sem anúncio vivo por default.
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

describe("ListingUseCase.createShopeeListing — atributos obrigatórios de autopeça", () => {
  const mockAccount = {
    id: "shp-acct-attr",
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
    name: "Sonda Lambda Secundaria Fiat Argo 2018 A 2021",
    description: "Descrição",
    price: 99,
    stock: 1,
    imageUrl: "/uploads/sonda.jpg",
    imageUrls: ["/uploads/sonda.jpg"],
    heightCm: 10,
    widthCm: 10,
    lengthCm: 10,
    weightKg: 1,
    brand: "Fiat",
    model: "Argo",
    year: "2018",
    partNumber: "2142354345",
    quality: "USADO",
    shopeeCategoryId: "102340",
  } as any;

  beforeEach(async () => {
    // Cache de atributos Shopee tem memória process-level e seed lazy de
    // disco — limpa pra não pular o mock de getCategoryAttributes.
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
      id: "listing-shp-attr",
    } as any);
    vi.spyOn(ListingRepository, "updateListing").mockResolvedValue({} as any);

    vi.spyOn(ShopeeApiService, "assertLeafCategory").mockResolvedValue(
      undefined,
    );
    vi.spyOn(ShopeeApiService, "uploadImage").mockResolvedValue({
      image_info: { image_id: "shp-img-attr-1", image_url: "https://cdn/x" },
    } as any);
    vi.spyOn(ShopeeApiService, "getLogisticsChannelList").mockResolvedValue([
      {
        logistics_channel_id: 1,
        logistics_channel_name: "Xpress",
        enabled: true,
      },
    ] as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("preenche atributo Shopee 'Auto-Part Number' com product.partNumber (regressão: faltava no productAttrValues)", async () => {
    vi.spyOn(ShopeeApiService, "getCategoryAttributes").mockResolvedValue({
      attribute_list: [
        {
          attribute_id: 4233,
          attribute_name: "Auto-Part Number",
          is_mandatory: true,
          attribute_value_list: [], // texto livre — sem lista enumerada
        },
      ],
    } as any);

    const createSpy = vi
      .spyOn(ShopeeApiService, "createItem")
      .mockResolvedValue({ item_id: 12345 } as any);

    const res = await ListingUseCase.createShopeeListing(
      "user-autopart",
      "prod-autopart",
      "102340",
      "shp-acct-attr",
    );

    expect(res.success).toBe(true);
    expect(createSpy).toHaveBeenCalledTimes(1);

    const payload = createSpy.mock.calls[0]?.[2] as any;
    expect(payload).toBeDefined();
    expect(payload.attribute_list).toBeDefined();

    const autoPartAttr = payload.attribute_list.find(
      (a: any) => a.attribute_name === "Auto-Part Number",
    );
    expect(autoPartAttr).toBeDefined();
    expect(autoPartAttr.attribute_value_list).toHaveLength(1);
    // Antes da fix: caía no fallback "product.brand || product.name" e enviava
    // "Fiat" ou o nome todo — Shopee rejeitava. Agora deve ser o partNumber.
    expect(autoPartAttr.attribute_value_list[0].original_value_name).toBe(
      "2142354345",
    );
  });

  it("também cobre variantes pt-BR do nome do atributo (Número da Peça, Part Number (OEM))", async () => {
    vi.spyOn(ShopeeApiService, "getCategoryAttributes").mockResolvedValue({
      attribute_list: [
        {
          attribute_id: 5001,
          attribute_name: "Número da Peça",
          is_mandatory: true,
          attribute_value_list: [],
        },
        {
          attribute_id: 5002,
          attribute_name: "Part Number (OEM)",
          is_mandatory: true,
          attribute_value_list: [],
        },
      ],
    } as any);

    const createSpy = vi
      .spyOn(ShopeeApiService, "createItem")
      .mockResolvedValue({ item_id: 12346 } as any);

    const res = await ListingUseCase.createShopeeListing(
      "user-autopart",
      "prod-autopart",
      "102340",
      "shp-acct-attr",
    );

    expect(res.success).toBe(true);
    const payload = createSpy.mock.calls[0]?.[2] as any;
    const numPeca = payload.attribute_list.find(
      (a: any) => a.attribute_name === "Número da Peça",
    );
    const oem = payload.attribute_list.find(
      (a: any) => a.attribute_name === "Part Number (OEM)",
    );
    expect(numPeca?.attribute_value_list?.[0]?.original_value_name).toBe(
      "2142354345",
    );
    expect(oem?.attribute_value_list?.[0]?.original_value_name).toBe(
      "2142354345",
    );
  });

  it("regressão check: 'Marca' continua sendo mapeada (productAttrValues['marca']) — fix dos auto-part não pode quebrar atributos antigos", async () => {
    vi.spyOn(ShopeeApiService, "getCategoryAttributes").mockResolvedValue({
      attribute_list: [
        {
          attribute_id: 4001,
          attribute_name: "Marca",
          is_mandatory: true,
          attribute_value_list: [
            { value_id: 10, value_name: "Fiat" },
            { value_id: 11, value_name: "Volkswagen" },
          ],
        },
      ],
    } as any);

    const createSpy = vi
      .spyOn(ShopeeApiService, "createItem")
      .mockResolvedValue({ item_id: 12347 } as any);

    await ListingUseCase.createShopeeListing(
      "user-autopart",
      "prod-autopart",
      "102340",
      "shp-acct-attr",
    );

    const payload = createSpy.mock.calls[0]?.[2] as any;
    const marca = payload.attribute_list.find(
      (a: any) => a.attribute_name === "Marca",
    );
    expect(marca?.attribute_value_list?.[0]?.value_id).toBe(10);
  });

  it("produto sem partNumber continua caindo no fallback existente (sem regressão para produtos legados)", async () => {
    vi.spyOn(ProductRepositoryPrisma.prototype, "findById").mockResolvedValue({
      ...baseProduct,
      partNumber: null,
    });

    vi.spyOn(ShopeeApiService, "getCategoryAttributes").mockResolvedValue({
      attribute_list: [
        {
          attribute_id: 4233,
          attribute_name: "Auto-Part Number",
          is_mandatory: true,
          attribute_value_list: [],
        },
      ],
    } as any);

    const createSpy = vi
      .spyOn(ShopeeApiService, "createItem")
      .mockResolvedValue({ item_id: 12348 } as any);

    const res = await ListingUseCase.createShopeeListing(
      "user-autopart",
      "prod-autopart",
      "102340",
      "shp-acct-attr",
    );

    expect(res.success).toBe(true);
    const payload = createSpy.mock.calls[0]?.[2] as any;
    const autoPartAttr = payload.attribute_list.find(
      (a: any) => a.attribute_name === "Auto-Part Number",
    );
    // Sem partNumber, fallback usa product.brand (linha ~3210 do listing.usercase.ts)
    expect(autoPartAttr).toBeDefined();
    expect(autoPartAttr.attribute_value_list[0].original_value_name).toBeTruthy();
  });

  it("evita valor com filhos obrigatórios: escolhe 'Others' (sem filhos) em vez de 'Wireless' (regressão: Registration ID mandatory required)", async () => {
    // Reproduz a categoria 101251 (Ferragens/Fechaduras): "Connection Type"
    // mandatory com dois valores — Wireless dispara filhos obrigatorios
    // (Registration ID etc), Others nao. Antes do fix pegavamos [0]=Wireless
    // e a Shopee rejeitava por "Registration ID is mandatory required".
    vi.spyOn(ShopeeApiService, "getCategoryAttributes").mockResolvedValue({
      attribute_list: [
        {
          attribute_id: 100408,
          attribute_name: "Connection Type",
          is_mandatory: true,
          attribute_value_list: [
            { value_id: 2530, value_name: "Wireless", has_mandatory_children: true },
            { value_id: 16702, value_name: "Others", has_mandatory_children: false },
          ],
        },
      ],
    } as any);

    const createSpy = vi
      .spyOn(ShopeeApiService, "createItem")
      .mockResolvedValue({ item_id: 99001 } as any);

    const res = await ListingUseCase.createShopeeListing(
      "user-autopart",
      "prod-autopart",
      "101251",
      "shp-acct-attr",
    );

    expect(res.success).toBe(true);
    const payload = createSpy.mock.calls[0]?.[2] as any;
    const conn = payload.attribute_list.find(
      (a: any) => a.attribute_name === "Connection Type",
    );
    expect(conn).toBeDefined();
    // Deve ter escolhido "Others" (16702, sem filhos), NAO "Wireless" (2530)
    expect(conn.attribute_value_list[0].value_id).toBe(16702);
    expect(conn.attribute_value_list[0].original_value_name).toBe("Others");
  });

  it("prefere valor sem filhos mesmo sem sinônimo neutro nomeado", async () => {
    // Nenhum valor se chama "Outros"; só importa quem NAO tem filhos.
    vi.spyOn(ShopeeApiService, "getCategoryAttributes").mockResolvedValue({
      attribute_list: [
        {
          attribute_id: 5555,
          attribute_name: "Tipo X",
          is_mandatory: true,
          attribute_value_list: [
            { value_id: 1, value_name: "Alpha", has_mandatory_children: true },
            { value_id: 2, value_name: "Beta", has_mandatory_children: false },
          ],
        },
      ],
    } as any);

    const createSpy = vi
      .spyOn(ShopeeApiService, "createItem")
      .mockResolvedValue({ item_id: 99002 } as any);

    await ListingUseCase.createShopeeListing(
      "user-autopart",
      "prod-autopart",
      "102340",
      "shp-acct-attr",
    );

    const payload = createSpy.mock.calls[0]?.[2] as any;
    const attr = payload.attribute_list.find(
      (a: any) => a.attribute_name === "Tipo X",
    );
    expect(attr.attribute_value_list[0].value_id).toBe(2); // Beta, sem filhos
  });
});

describe("ListingUseCase.pickSafeMandatoryShopeeValue (unit)", () => {
  it("1) prefere sinônimo neutro SEM filhos", () => {
    const picked = ListingUseCase.pickSafeMandatoryShopeeValue([
      { value_id: 1, value_name: "Wireless", has_mandatory_children: true },
      { value_id: 2, value_name: "Others", has_mandatory_children: false },
      { value_id: 3, value_name: "Wired", has_mandatory_children: false },
    ]);
    expect(picked.value_id).toBe(2);
  });

  it("2) sem neutro, prefere qualquer valor SEM filhos", () => {
    const picked = ListingUseCase.pickSafeMandatoryShopeeValue([
      { value_id: 1, value_name: "Alpha", has_mandatory_children: true },
      { value_id: 2, value_name: "Beta", has_mandatory_children: false },
    ]);
    expect(picked.value_id).toBe(2);
  });

  it("3) todos com filhos: cai no sinônimo neutro mesmo com filhos", () => {
    const picked = ListingUseCase.pickSafeMandatoryShopeeValue([
      { value_id: 1, value_name: "Alpha", has_mandatory_children: true },
      { value_id: 2, value_name: "Outros", has_mandatory_children: true },
    ]);
    expect(picked.value_id).toBe(2);
  });

  it("4) sem flag (schema legado): degrada para sinônimo neutro, senão primeiro", () => {
    // has_mandatory_children undefined → tratado como 'sem filhos'
    const withSynonym = ListingUseCase.pickSafeMandatoryShopeeValue([
      { value_id: 1, value_name: "Fiat" },
      { value_id: 2, value_name: "Outros" },
    ]);
    expect(withSynonym.value_id).toBe(2);

    const noSynonym = ListingUseCase.pickSafeMandatoryShopeeValue([
      { value_id: 10, value_name: "Fiat" },
      { value_id: 11, value_name: "Volkswagen" },
    ]);
    expect(noSynonym.value_id).toBe(10); // primeiro, comportamento legado
  });
});
