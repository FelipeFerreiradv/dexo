import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Paridade: o endpoint de checagem e o script de prova usam o MESMO motor do
 * createMLListing (resolveEffectiveMLCategory + buildMLCreateAttributes), então
 * o que eles avaliam é exatamente o que o create envia. Harness igual ao de
 * tests/ml-required-attrs-create.spec.ts.
 */

vi.mock("../app/marketplaces/repositories/listing.repository", () => ({
  ListingRepository: {
    findLiveByProductAndAccount: vi.fn(),
    findByProductAndAccount: vi.fn(),
    updateListing: vi.fn(),
    createListing: vi.fn(),
    createReservedPlaceholderIfAbsent: vi.fn(),
    findRetryStateById: vi.fn(),
    updateCompatDiagnostics: vi.fn(),
  },
}));

vi.mock("../app/marketplaces/repositories/marketplace.repository", () => ({
  MarketplaceRepository: {
    findByIdAndUser: vi.fn(),
    findFirstActiveByUserAndPlatform: vi.fn(),
    findAllByUserIdAndPlatform: vi.fn(),
    updateStatus: vi.fn(),
    updateTokens: vi.fn(),
  },
}));

vi.mock("../app/marketplaces/services/ml-oauth.service", () => ({
  MLOAuthService: {
    getUserInfo: vi.fn(async () => ({ id: 123456 })),
    refreshAccessTokenForAccount: vi.fn(),
  },
}));

vi.mock("../app/marketplaces/services/ml-api.service", () => ({
  MLApiService: {
    getSellerItemIds: vi.fn(async () => []),
    createItem: vi.fn(),
    normalizeListingType: vi.fn((t?: string) => t || "bronze"),
    suggestCategoryId: vi.fn(async () => null),
    uploadPicture: vi.fn(),
    uploadPictureFromUrl: vi.fn(),
    getCategoryAttributes: vi.fn(async () => {
      throw new Error("rede proibida no teste");
    }),
  },
}));

vi.mock("../app/repositories/product.repository", () => {
  const findById = vi.fn();
  return {
    ProductRepositoryPrisma: vi.fn(() => ({ findById })),
    __findById: findById,
  };
});

vi.mock("../app/services/system-log.service", () => ({
  SystemLogService: { logError: vi.fn(), log: vi.fn() },
}));

vi.mock("../app/marketplaces/services/category-resolution.service", () => ({
  CategoryResolutionService: {
    resolveMLCategory: vi.fn(),
    ensureLeafLocalOnly: vi.fn(async () => null),
    assertWithinVehicleRoot: vi.fn(async () => ({ ok: true, reason: "ok" })),
    assertConditionCoherent: vi.fn(async () => ({
      ok: true,
      reason: "unknown",
    })),
  },
  getVehicleRootSet: vi.fn(),
}));

vi.mock("../app/marketplaces/services/ml-attribute-catalog.service", async () => {
  const actual: any = await vi.importActual(
    "../app/marketplaces/services/ml-attribute-catalog.service",
  );
  const getAll = vi.fn();
  return {
    ...actual,
    MLAttributeCatalogService: {
      getAll,
      getRequired: vi.fn(async (id: string) =>
        ((await getAll(id)) || []).filter((a: any) => a.required),
      ),
      _clearMemory: vi.fn(),
    },
  };
});

import { ListingUseCase } from "../app/marketplaces/usecases/listing.usercase";
import { ListingRepository } from "../app/marketplaces/repositories/listing.repository";
import { MarketplaceRepository } from "../app/marketplaces/repositories/marketplace.repository";
import { MLApiService } from "../app/marketplaces/services/ml-api.service";
import { CategoryResolutionService } from "../app/marketplaces/services/category-resolution.service";
import {
  MLAttributeCatalogService,
  normalizeMLCategoryAttribute,
} from "../app/marketplaces/services/ml-attribute-catalog.service";

const M1 =
  "Esta categoria do Mercado Livre exige o preenchimento do Part Number. Preencha esse campo antes de continuar.";

const FIXTURES = path.resolve(__dirname, "fixtures", "ml-category-attributes");
const catalogo = (id: string) =>
  (
    JSON.parse(fs.readFileSync(path.join(FIXTURES, `${id}.raw.json`), "utf8"))
      .attributes as any[]
  ).map((a) => normalizeMLCategoryAttribute(a));

/** Cache antigo: sem os booleanos novos. */
const semTags = (attrs: any[]) =>
  attrs.map(
    ({ requiredTag, catalogRequiredTag, conditionalRequiredTag, fixedTag, ...r }) => {
      void requiredTag;
      void catalogRequiredTag;
      void conditionalRequiredTag;
      void fixedTag;
      return r;
    },
  );

const ACCOUNT = {
  id: "acct-1",
  userId: "user-1",
  accountName: "LOJA",
  accessToken: "tok",
  refreshToken: "ref",
  expiresAt: new Date(Date.now() + 3600_000),
  status: "ACTIVE",
  externalUserId: "123456",
} as any;

const baseProduct = () => ({
  id: "prod-1",
  sku: "SKU-1",
  name: "Sensor de rotação Gol",
  brand: "Volkswagen",
  price: 100,
  stock: 1,
  imageUrl: "/uploads/x.jpg",
  imageUrls: [],
  heightCm: 10,
  widthCm: 10,
  lengthCm: 10,
  weightKg: 1,
  mlCategoryId: "cat-interna-1",
});

const erroMl = (message: string, cause: any[], status = 400) => {
  const e: any = new Error(message);
  e.mlError = { status, message, error: "validation_error", cause };
  return e;
};

const causa147 = (categoria = "MLB46723", ids = "PART_NUMBER") => ({
  department: "items",
  cause_id: 147,
  code: "item.attributes.missing_required",
  message: `The attributes [${ids}] are required for category ${categoria} and channel marketplace`,
});

const erro147 = (categoria = "MLB46723") =>
  erroMl(`Validation error: missing_required ${categoria}`, [causa147(categoria)]);

let produto: any;
let imagens: any;
const ENV_KEYS = [
  "ML_REQUIRED_ATTRS_BLOCK",
  "LISTING_PREFLIGHT",
  "ML_CATALOG_LISTING_ENABLED",
] as const;
const envAntes: Record<string, string | undefined> = {};

const criar = (overrides?: Record<string, unknown> | null) =>
  ListingUseCase.createMLListing(
    "user-1",
    "prod-1",
    "MLB46723",
    "acct-1",
    undefined,
    undefined,
    "actor-1",
    overrides,
  );

const gravacoesTerminais = () => [
  ...(ListingRepository.updateListing as any).mock.calls.filter((c: any[]) =>
    String(c[1]?.lastError ?? "").startsWith("[TERMINAL]"),
  ),
  ...(ListingRepository.createListing as any).mock.calls.filter((c: any[]) =>
    String(c[0]?.lastError ?? "").startsWith("[TERMINAL]"),
  ),
];

beforeEach(async () => {
  vi.clearAllMocks();
  for (const k of ENV_KEYS) envAntes[k] = process.env[k];
  delete process.env.ML_REQUIRED_ATTRS_BLOCK;
  delete process.env.LISTING_PREFLIGHT;
  delete process.env.ML_CATALOG_LISTING_ENABLED;

  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "debug").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});

  (MarketplaceRepository.findByIdAndUser as any).mockResolvedValue(ACCOUNT);
  (ListingRepository.findLiveByProductAndAccount as any).mockResolvedValue(null);
  (ListingRepository.findByProductAndAccount as any).mockResolvedValue(null);
  // Criação exclusiva da 1ª linha do par (lock de transação): nos testes
  // unitários delega ao createListing mockado — as asserções de sempre valem.
  (ListingRepository.createReservedPlaceholderIfAbsent as any).mockImplementation(
    async (d: any) => ({ created: await (ListingRepository.createListing as any)(d) }),
  );
  (ListingRepository.createListing as any).mockImplementation(async (d: any) => ({
    id: "l-novo",
    ...d,
  }));
  (ListingRepository.updateListing as any).mockResolvedValue({});
  (CategoryResolutionService.resolveMLCategory as any).mockImplementation(
    async ({ explicitCategoryId }: any) => ({
      externalId: explicitCategoryId || "MLB46723",
      fullPath: "Acessórios > Peças",
      source: "explicit",
    }),
  );
  (CategoryResolutionService.ensureLeafLocalOnly as any).mockResolvedValue(null);
  (MLAttributeCatalogService.getAll as any).mockImplementation(async (id: string) =>
    id === "MLB46723" ? catalogo("MLB46723") : [],
  );
  (MLApiService.suggestCategoryId as any).mockResolvedValue(null);
  (MLApiService.createItem as any).mockRejectedValue(
    erroMl("Internal error", [], 500),
  );

  produto = baseProduct();
  const repo: any = await import("../app/repositories/product.repository");
  repo.__findById.mockImplementation(async () => ({ ...produto }));
  imagens = vi
    .spyOn(ListingUseCase as any, "collectProductImageUrls")
    .mockReturnValue([]);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (envAntes[k] === undefined) delete process.env[k];
    else process.env[k] = envAntes[k];
  }
  vi.restoreAllMocks();
});

describe("paridade: checagem/script × create (mesmo motor)", () => {
  beforeEach(() => {
    process.env.ML_OEM_TAGS_DISABLED = "1";
    process.env.ML_REQUIRED_ATTRS_BLOCK = "1";
    (MLAttributeCatalogService.getAll as any).mockImplementation(async () =>
      catalogo("MLB431271"),
    );
    (MLApiService.createItem as any).mockRejectedValue(
      erroMl("Internal error", [], 500),
    );
  });
  afterEach(() => {
    delete process.env.ML_OEM_TAGS_DISABLED;
  });

  it("P1: os atributos avaliados são os mesmos que o createItem recebe", async () => {
    produto = {
      ...baseProduct(),
      name: "Farol dianteiro Gol 5U0807217",
      model: "Gol",
      year: "2014",
      attributes: { OEM: { value_name: "OEM-1" } },
    };
    const override = {
      SIDE: { value_id: "183554", value_name: "Dianteiro" },
      GTIN: { value_name: "789" },
    };
    const espiao = vi.spyOn(ListingUseCase as any, "buildMLCreateAttributes");

    const ev = await ListingUseCase.evaluateMLRequiredAttributesForProduct({
      product: { ...produto },
      categoryId: "MLB431271",
      attributeOverrides: override,
    });
    expect(ev.status).toBe("ok");
    const avaliados = (await (espiao.mock.results[0].value as Promise<any>))
      .attributes;

    await ListingUseCase.createMLListing(
      "user-1",
      "prod-1",
      "MLB431271",
      "acct-1",
      undefined,
      undefined,
      undefined,
      override,
    );
    expect(MLApiService.createItem).toHaveBeenCalled();
    const enviados = (MLApiService.createItem as any).mock.calls[0][1].attributes
      .filter((a: any) => !String(a.id).startsWith("SELLER_PACKAGE_"));
    expect(enviados).toEqual(
      avaliados.filter((a: any) => !String(a.id).startsWith("SELLER_PACKAGE_")),
    );
    expect(espiao).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      "categoria pai que desce para 'Outros'",
      { externalId: "MLB1747" },
      { externalId: "MLB191833" },
      "MLB191833",
    ],
    ["id com sufixo -01", { externalId: "MLB1747-01" }, null, "MLB1747"],
    [
      "id sintético do catálogo estático (já mapeado pela resolução)",
      { externalId: "MLB22693" },
      null,
      "MLB22693",
    ],
  ])("P2: %s → mesmo category_id do createItem", async (_, resolvido, folha, esperado) => {
    (CategoryResolutionService.resolveMLCategory as any).mockResolvedValue({
      ...resolvido,
      fullPath: "x",
      source: "explicit",
    });
    (CategoryResolutionService.ensureLeafLocalOnly as any).mockResolvedValue(folha);
    (MLAttributeCatalogService.getAll as any).mockResolvedValue([]);

    const cat = await ListingUseCase.resolveEffectiveMLCategory({
      product: { ...produto },
      categoryId: "SYN-QUALQUER",
    });
    expect(cat?.categoryIdForML).toBe(esperado);

    await ListingUseCase.createMLListing("user-1", "prod-1", "SYN-QUALQUER", "acct-1");
    const enviado = (MLApiService.createItem as any).mock.calls[0][1].category_id;
    expect(enviado).toBe(cat?.categoryIdForML);
  });

  it("P3: resolveMLCategory lançando → null (e evaluate devolve category_unresolved)", async () => {
    (CategoryResolutionService.resolveMLCategory as any).mockRejectedValue(
      new Error("Categoria fornecida (X) não está sincronizada"),
    );
    expect(
      await ListingUseCase.resolveEffectiveMLCategory({
        product: { ...produto },
        categoryId: "X",
      }),
    ).toBeNull();
    const ev = await ListingUseCase.evaluateMLRequiredAttributesForProduct({
      product: { ...produto },
      categoryId: "X",
    });
    expect(ev).toMatchObject({
      status: "unknown",
      unknownReason: "category_unresolved",
      categoryId: null,
      blocking: [],
    });
  });

  it("D4: sem categoria pedida nem persistida → usa a MESMA sugestão do create (domain_discovery), memorizada por nome", async () => {
    (MLApiService.suggestCategoryId as any).mockResolvedValue("MLB431271");
    const semCategoria = { ...produto, mlCategoryId: undefined };
    const cache = new Map();
    const a = await ListingUseCase.evaluateMLRequiredAttributesForProduct({
      product: semCategoria,
      categoryCache: cache,
    });
    const b = await ListingUseCase.evaluateMLRequiredAttributesForProduct({
      product: { ...semCategoria },
      categoryCache: cache,
    });
    expect(MLApiService.suggestCategoryId).toHaveBeenCalledTimes(1);
    expect(MLApiService.suggestCategoryId).toHaveBeenCalledWith("MLB", semCategoria.name);
    expect(a.categoryId).toBe("MLB431271");
    expect(b.categoryId).toBe("MLB431271");
    // Mesmo catálogo do create: sem SIDE → bloqueado com a mensagem de lado.
    expect(a.status).toBe("blocked");
    expect(a.blocking.map((i) => i.attributeId)).toContain("SIDE");
  });

  it("D4: sugestão falhando → unknown/category_unresolved (não bloqueia)", async () => {
    (MLApiService.suggestCategoryId as any).mockResolvedValue(null);
    const ev = await ListingUseCase.evaluateMLRequiredAttributesForProduct({
      product: { ...produto, mlCategoryId: undefined },
    });
    expect(ev.status).toBe("unknown");
    expect(ev.unknownReason).toBe("category_unresolved");
    expect(CategoryResolutionService.resolveMLCategory).not.toHaveBeenCalled();
  });

  it("categoryCache: itens da mesma categoria resolvem uma vez", async () => {
    const cache = new Map();
    await Promise.all([
      ListingUseCase.evaluateMLRequiredAttributesForProduct({
        product: { ...produto },
        categoryId: "MLB431271",
        categoryCache: cache,
      }),
      ListingUseCase.evaluateMLRequiredAttributesForProduct({
        product: { ...produto, id: "prod-2" },
        categoryId: "MLB431271",
        categoryCache: cache,
      }),
    ]);
    expect(CategoryResolutionService.resolveMLCategory).toHaveBeenCalledTimes(1);
  });

  it("categoryCache: sem categoria pedida, produtos com mlCategoryId DIFERENTES não compartilham a resolução", async () => {
    (CategoryResolutionService.resolveMLCategory as any).mockImplementation(
      async ({ explicitCategoryId, product }: any) => ({
        externalId: explicitCategoryId || product?.mlCategoryId,
        fullPath: "x",
        source: "persisted",
      }),
    );
    const cache = new Map();
    const a = await ListingUseCase.evaluateMLRequiredAttributesForProduct({
      product: { ...produto, mlCategoryId: "MLB431271" },
      categoryCache: cache,
    });
    const b = await ListingUseCase.evaluateMLRequiredAttributesForProduct({
      product: { ...produto, id: "prod-2", mlCategoryId: "MLB46723" },
      categoryCache: cache,
    });
    expect(CategoryResolutionService.resolveMLCategory).toHaveBeenCalledTimes(2);
    expect(a.categoryId).toBe("MLB431271");
    expect(b.categoryId).toBe("MLB46723");
    expect(MLApiService.suggestCategoryId).not.toHaveBeenCalled();
  });

  it("categoryCache: sem categoria nenhuma, NOMES diferentes pedem sugestões diferentes", async () => {
    (MLApiService.suggestCategoryId as any).mockImplementation(
      async (_site: string, nome: string) =>
        nome.startsWith("Farol") ? "MLB431271" : "MLB46723",
    );
    const cache = new Map();
    const a = await ListingUseCase.evaluateMLRequiredAttributesForProduct({
      product: { ...produto, mlCategoryId: undefined, name: "Farol dianteiro Gol" },
      categoryCache: cache,
    });
    const b = await ListingUseCase.evaluateMLRequiredAttributesForProduct({
      product: { ...produto, id: "prod-2", mlCategoryId: undefined, name: "Sensor de rotação Gol" },
      categoryCache: cache,
    });
    expect(MLApiService.suggestCategoryId).toHaveBeenCalledTimes(2);
    expect(a.categoryId).toBe("MLB431271");
    expect(b.categoryId).toBe("MLB46723");
  });

  it("a avaliação não grava nada nem chama createItem", async () => {
    await ListingUseCase.evaluateMLRequiredAttributesForProduct({
      product: { ...produto },
      categoryId: "MLB431271",
    });
    expect(MLApiService.createItem).not.toHaveBeenCalled();
    expect(ListingRepository.createListing).not.toHaveBeenCalled();
    expect(ListingRepository.updateListing).not.toHaveBeenCalled();
    expect(ListingRepository.findByProductAndAccount).not.toHaveBeenCalled();
  });
});
