import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mockar prisma ANTES de importar o service — o service consome prisma
// como singleton via import default.
const findUniqueMock = vi.hoisted(() => vi.fn());
const upsertMock = vi.hoisted(() => vi.fn());

vi.mock("@/app/lib/prisma", () => ({
  default: {
    shopeeCategoryAttribute: {
      findUnique: findUniqueMock,
      upsert: upsertMock,
    },
  },
}));
vi.mock("../app/lib/prisma", () => ({
  default: {
    shopeeCategoryAttribute: {
      findUnique: findUniqueMock,
      upsert: upsertMock,
    },
  },
}));

import { ShopeeAttributeCatalogService } from "../app/marketplaces/services/shopee-attribute-catalog.service";

const REGION = "BR";
const CATEGORY = 102291;
const LOCALE = "pt-BR";

const sampleAttrs = [
  {
    attribute_id: 4233,
    attribute_name: "Auto-Part Number",
    is_mandatory: true,
    attribute_value_list: [],
  },
  {
    attribute_id: 4001,
    attribute_name: "Marca",
    is_mandatory: true,
    attribute_value_list: [{ value_id: 10, value_name: "Fiat" }],
  },
];

describe("ShopeeAttributeCatalogService", () => {
  beforeEach(() => {
    ShopeeAttributeCatalogService._resetForTests();
    findUniqueMock.mockReset();
    upsertMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("retorna source=live quando memória e DB estão vazios e fetchLive resolve", async () => {
    findUniqueMock.mockResolvedValue(null);
    upsertMock.mockResolvedValue({});
    const fetchLive = vi
      .fn()
      .mockResolvedValue({ attribute_list: sampleAttrs });

    const res = await ShopeeAttributeCatalogService.getCategoryAttributes(
      REGION,
      CATEGORY,
      LOCALE,
      { fetchLive },
    );

    expect(res?.source).toBe("live");
    expect(res?.attribute_list).toHaveLength(2);
    expect(fetchLive).toHaveBeenCalledTimes(1);
    expect(upsertMock).toHaveBeenCalledTimes(1);
  });

  it("retorna source=memory na segunda chamada da mesma categoria (sem hit em DB nem live)", async () => {
    findUniqueMock.mockResolvedValue(null);
    upsertMock.mockResolvedValue({});
    const fetchLive = vi
      .fn()
      .mockResolvedValue({ attribute_list: sampleAttrs });

    await ShopeeAttributeCatalogService.getCategoryAttributes(
      REGION,
      CATEGORY,
      LOCALE,
      { fetchLive },
    );
    findUniqueMock.mockClear();
    const res2 = await ShopeeAttributeCatalogService.getCategoryAttributes(
      REGION,
      CATEGORY,
      LOCALE,
      { fetchLive },
    );

    expect(res2?.source).toBe("memory");
    expect(findUniqueMock).toHaveBeenCalledTimes(0);
    expect(fetchLive).toHaveBeenCalledTimes(1); // só a primeira
  });

  it("retorna source=db_fresh quando DB tem entrada fresh (não chama live)", async () => {
    const now = Date.now();
    findUniqueMock.mockResolvedValue({
      attributes: sampleAttrs,
      ttlExpiresAt: new Date(now + 60 * 60 * 1000), // ainda fresh
      fetchedAt: new Date(now - 1000),
    });
    const fetchLive = vi.fn();

    const res = await ShopeeAttributeCatalogService.getCategoryAttributes(
      REGION,
      CATEGORY,
      LOCALE,
      { fetchLive },
    );

    expect(res?.source).toBe("db_fresh");
    expect(res?.attribute_list).toHaveLength(2);
    expect(fetchLive).not.toHaveBeenCalled();
  });

  it("usa harvest quando live falha (403) e DB está vazio", async () => {
    findUniqueMock.mockResolvedValue(null);
    upsertMock.mockResolvedValue({});
    const fetchLive = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("403 Permission denied"), { status: 403 }));
    const harvest = vi.fn().mockResolvedValue(sampleAttrs);

    const res = await ShopeeAttributeCatalogService.getCategoryAttributes(
      REGION,
      CATEGORY,
      LOCALE,
      { fetchLive, harvest },
    );

    expect(res?.source).toBe("harvested");
    expect(res?.attribute_list).toHaveLength(2);
    expect(harvest).toHaveBeenCalledTimes(1);
    expect(upsertMock).toHaveBeenCalledTimes(1);
  });

  it("usa db_stale quando live falha e harvest também (cache stale como último recurso)", async () => {
    const now = Date.now();
    findUniqueMock.mockResolvedValue({
      attributes: sampleAttrs,
      ttlExpiresAt: new Date(now - 1000), // expirado
      fetchedAt: new Date(now - 2 * 24 * 60 * 60 * 1000), // 2 dias atrás (ainda <30d)
    });
    const fetchLive = vi
      .fn()
      .mockRejectedValue(new Error("Shopee API 403"));
    const harvest = vi.fn().mockResolvedValue(null);

    const res = await ShopeeAttributeCatalogService.getCategoryAttributes(
      REGION,
      CATEGORY,
      LOCALE,
      { fetchLive, harvest },
    );

    expect(res?.source).toBe("db_stale");
    expect(res?.attribute_list).toHaveLength(2);
  });

  it("retorna null quando NADA funciona (memory vazio, DB vazio, live falha, harvest sem nada)", async () => {
    findUniqueMock.mockResolvedValue(null);
    const fetchLive = vi.fn().mockRejectedValue(new Error("Shopee 403"));
    const harvest = vi.fn().mockResolvedValue(null);

    const res = await ShopeeAttributeCatalogService.getCategoryAttributes(
      REGION,
      CATEGORY,
      LOCALE,
      { fetchLive, harvest },
    );

    expect(res).toBeNull();
  });

  it("putCategoryAttributes rejeita lista vazia ou malformada", async () => {
    upsertMock.mockResolvedValue({});

    await ShopeeAttributeCatalogService.putCategoryAttributes(
      REGION,
      CATEGORY,
      LOCALE,
      [],
      "live",
    );
    expect(upsertMock).not.toHaveBeenCalled();

    await ShopeeAttributeCatalogService.putCategoryAttributes(
      REGION,
      CATEGORY,
      LOCALE,
      [{ no_attribute_id: true } as any],
      "live",
    );
    expect(upsertMock).not.toHaveBeenCalled();

    await ShopeeAttributeCatalogService.putCategoryAttributes(
      REGION,
      CATEGORY,
      LOCALE,
      sampleAttrs,
      "live",
    );
    expect(upsertMock).toHaveBeenCalledTimes(1);
  });

  it("propaga erro de DB sem quebrar o fluxo (try/catch interno)", async () => {
    findUniqueMock.mockRejectedValue(new Error("DB unreachable"));
    upsertMock.mockRejectedValue(new Error("DB unreachable"));
    const fetchLive = vi
      .fn()
      .mockResolvedValue({ attribute_list: sampleAttrs });

    const res = await ShopeeAttributeCatalogService.getCategoryAttributes(
      REGION,
      CATEGORY,
      LOCALE,
      { fetchLive },
    );

    // DB down, mas live funciona — devolve via memória
    expect(res?.source).toBe("live");
    expect(res?.attribute_list).toHaveLength(2);
  });
});
