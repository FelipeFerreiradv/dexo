import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mocks de repositórios/servicos que tocam Prisma/HTTP ──
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
  default: {
    findByExternalId: vi.fn(),
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
import { MarketplaceRepository } from "../app/marketplaces/repositories/marketplace.repository";
import { ListingRepository } from "../app/marketplaces/repositories/listing.repository";
import { ShopeeApiService } from "../app/marketplaces/services/shopee-api.service";
import { ProductRepositoryPrisma } from "../app/repositories/product.repository";

describe("ListingUseCase.collectProductImageUrls", () => {
  const helper = (ListingUseCase as any).collectProductImageUrls as (p: {
    imageUrls?: string[] | null;
    imageUrl?: string | null;
  }) => string[];

  it("retorna galeria completa quando imageUrls tem múltiplos itens", () => {
    const result = helper({
      imageUrl: "/uploads/a.jpg",
      imageUrls: ["/uploads/a.jpg", "/uploads/b.jpg", "/uploads/c.jpg"],
    });
    expect(result).toEqual([
      "/uploads/a.jpg",
      "/uploads/b.jpg",
      "/uploads/c.jpg",
    ]);
  });

  it("preserva ordem original das imageUrls", () => {
    const urls = [
      "/uploads/3.jpg",
      "/uploads/1.jpg",
      "/uploads/2.jpg",
    ];
    const result = helper({ imageUrls: urls, imageUrl: "/uploads/3.jpg" });
    expect(result).toEqual(urls);
  });

  it("remove duplicatas preservando a primeira ocorrência", () => {
    const result = helper({
      imageUrls: ["/uploads/a.jpg", "/uploads/b.jpg", "/uploads/a.jpg"],
      imageUrl: "/uploads/a.jpg",
    });
    expect(result).toEqual(["/uploads/a.jpg", "/uploads/b.jpg"]);
  });

  it("faz fallback para imageUrl quando imageUrls está vazio", () => {
    const result = helper({ imageUrls: [], imageUrl: "/uploads/solo.jpg" });
    expect(result).toEqual(["/uploads/solo.jpg"]);
  });

  it("faz fallback para imageUrl quando imageUrls é undefined", () => {
    const result = helper({ imageUrl: "/uploads/solo.jpg" });
    expect(result).toEqual(["/uploads/solo.jpg"]);
  });

  it("retorna array vazio quando nenhuma imagem está presente", () => {
    expect(helper({})).toEqual([]);
    expect(helper({ imageUrl: "", imageUrls: [] })).toEqual([]);
  });

  it("ignora strings em branco ou não-string", () => {
    const result = helper({
      imageUrls: [
        "/uploads/a.jpg",
        "",
        "   ",
        null as any,
        undefined as any,
        "/uploads/b.jpg",
      ],
    });
    expect(result).toEqual(["/uploads/a.jpg", "/uploads/b.jpg"]);
  });
});

describe("ListingUseCase.createShopeeListing multi-image", () => {
  const mockAccount = {
    id: "shp-acct-1",
    accessToken: "shp-token",
    refreshToken: "shp-refresh",
    shopId: 999,
    accountName: "Loja Teste",
    status: "ACTIVE",
    expiresAt: new Date(Date.now() + 3600 * 1000),
  } as any;

  const mockProduct = {
    id: "prod-multi",
    userId: "user-1",
    sku: "SKU-MULTI",
    name: "Produto Multi Imagem",
    description: "Descrição",
    price: 150,
    stock: 10,
    imageUrl: "/uploads/img-1.jpg",
    imageUrls: [
      "/uploads/img-1.jpg",
      "/uploads/img-2.jpg",
      "/uploads/img-3.jpg",
      "/uploads/img-4.jpg",
      "/uploads/img-5.jpg",
      "/uploads/img-6.jpg",
      "/uploads/img-7.jpg",
    ],
    heightCm: 20,
    widthCm: 20,
    lengthCm: 20,
    weightKg: 1,
    brand: "Marca X",
    quality: "NOVO",
    shopeeCategoryId: "12345",
  } as any;

  beforeEach(() => {
    vi.spyOn(
      MarketplaceRepository,
      "findByIdAndUser",
    ).mockResolvedValue(mockAccount);
    vi.spyOn(
      MarketplaceRepository,
      "findFirstActiveByUserAndPlatform",
    ).mockResolvedValue(mockAccount);
    vi.spyOn(
      MarketplaceRepository,
      "findAllByUserIdAndPlatform",
    ).mockResolvedValue([mockAccount]);

    vi.spyOn(
      ProductRepositoryPrisma.prototype,
      "findById",
    ).mockResolvedValue(mockProduct);

    vi.spyOn(ListingRepository, "findByProductAndAccount").mockResolvedValue(
      null,
    );
    vi.spyOn(ListingRepository, "createListing").mockResolvedValue({
      id: "listing-shp-1",
    } as any);
    vi.spyOn(ListingRepository, "updateListing").mockResolvedValue({} as any);

    vi.spyOn(ShopeeApiService, "assertLeafCategory").mockResolvedValue(
      undefined,
    );
    vi.spyOn(ShopeeApiService, "getCategoryAttributes").mockResolvedValue({
      attribute_list: [],
    } as any);
    vi.spyOn(ShopeeApiService, "getLogisticsChannelList").mockResolvedValue([
      { logistics_channel_id: 1, logistics_channel_name: "Xpress", enabled: true },
    ] as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("faz upload de todas as imagens e envia image_id_list completo no payload", async () => {
    // Cada chamada de uploadImage retorna um ID único baseado na ordem
    let uploadIndex = 0;
    const uploadSpy = vi
      .spyOn(ShopeeApiService, "uploadImage")
      .mockImplementation(async () => {
        const id = `shp-img-${++uploadIndex}`;
        return { image_info: { image_id: id, image_url: `https://cdn/${id}` } } as any;
      });

    const createSpy = vi
      .spyOn(ShopeeApiService, "createItem")
      .mockResolvedValue({ item_id: 7777 } as any);

    const res = await ListingUseCase.createShopeeListing(
      "user-1",
      "prod-multi",
      "12345",
      "shp-acct-1",
    );

    expect(res.success).toBe(true);

    // Shopee uploadImage deve ter sido chamado 7 vezes (uma para cada imagem)
    expect(uploadSpy).toHaveBeenCalledTimes(7);

    // createItem deve receber um payload com image_id_list contendo todos os IDs em ordem
    expect(createSpy).toHaveBeenCalledTimes(1);
    const payload = createSpy.mock.calls[0]?.[2] as any;
    expect(payload).toBeDefined();
    expect(payload.image).toBeDefined();
    expect(payload.image.image_id_list).toEqual([
      "shp-img-1",
      "shp-img-2",
      "shp-img-3",
      "shp-img-4",
      "shp-img-5",
      "shp-img-6",
      "shp-img-7",
    ]);
  });

  it("limita a 9 imagens mesmo quando o produto tem mais (limite Shopee)", async () => {
    const tenImageProduct = {
      ...mockProduct,
      imageUrls: Array.from({ length: 12 }, (_, i) => `/uploads/img-${i + 1}.jpg`),
    };
    vi.spyOn(
      ProductRepositoryPrisma.prototype,
      "findById",
    ).mockResolvedValue(tenImageProduct);

    let uploadIndex = 0;
    const uploadSpy = vi
      .spyOn(ShopeeApiService, "uploadImage")
      .mockImplementation(async () => ({
        image_info: { image_id: `id-${++uploadIndex}`, image_url: "https://cdn/x" },
      } as any));

    const createSpy = vi
      .spyOn(ShopeeApiService, "createItem")
      .mockResolvedValue({ item_id: 8888 } as any);

    const res = await ListingUseCase.createShopeeListing(
      "user-1",
      "prod-multi",
      "12345",
      "shp-acct-1",
    );

    expect(res.success).toBe(true);
    expect(uploadSpy).toHaveBeenCalledTimes(9);
    const payload = createSpy.mock.calls[0]?.[2] as any;
    expect(payload.image.image_id_list).toHaveLength(9);
  });

  it("tolera falha parcial de upload e publica com as imagens que deram certo", async () => {
    let call = 0;
    vi.spyOn(ShopeeApiService, "uploadImage").mockImplementation(async () => {
      call++;
      if (call === 3) {
        throw new Error("timeout ao fazer upload");
      }
      return {
        image_info: { image_id: `ok-${call}`, image_url: "https://cdn/x" },
      } as any;
    });

    const createSpy = vi
      .spyOn(ShopeeApiService, "createItem")
      .mockResolvedValue({ item_id: 9999 } as any);

    const res = await ListingUseCase.createShopeeListing(
      "user-1",
      "prod-multi",
      "12345",
      "shp-acct-1",
    );

    expect(res.success).toBe(true);
    const payload = createSpy.mock.calls[0]?.[2] as any;
    // 7 imagens no produto, 1 falhou → 6 devem ir no payload
    expect(payload.image.image_id_list).toEqual([
      "ok-1",
      "ok-2",
      "ok-4",
      "ok-5",
      "ok-6",
      "ok-7",
    ]);
  });

  it("falha o listing quando nenhuma imagem consegue ser enviada", async () => {
    vi.spyOn(ShopeeApiService, "uploadImage").mockRejectedValue(
      new Error("erro de rede"),
    );
    const createSpy = vi.spyOn(ShopeeApiService, "createItem");

    const res = await ListingUseCase.createShopeeListing(
      "user-1",
      "prod-multi",
      "12345",
      "shp-acct-1",
    );

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/upload/i);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("usa imageUrl como fallback quando imageUrls está vazio", async () => {
    vi.spyOn(
      ProductRepositoryPrisma.prototype,
      "findById",
    ).mockResolvedValue({
      ...mockProduct,
      imageUrls: [],
      imageUrl: "/uploads/single.jpg",
    });

    const uploadSpy = vi
      .spyOn(ShopeeApiService, "uploadImage")
      .mockResolvedValue({
        image_info: { image_id: "single-id", image_url: "https://cdn/x" },
      } as any);

    const createSpy = vi
      .spyOn(ShopeeApiService, "createItem")
      .mockResolvedValue({ item_id: 11111 } as any);

    const res = await ListingUseCase.createShopeeListing(
      "user-1",
      "prod-multi",
      "12345",
      "shp-acct-1",
    );

    expect(res.success).toBe(true);
    expect(uploadSpy).toHaveBeenCalledTimes(1);
    const payload = createSpy.mock.calls[0]?.[2] as any;
    expect(payload.image.image_id_list).toEqual(["single-id"]);
  });
});
