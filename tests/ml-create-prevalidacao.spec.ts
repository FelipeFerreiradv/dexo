import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * createMLListing — PR-3 (22/09/2026):
 *   1. valores da ficha × catálogo da categoria ANTES do POST;
 *   2. family_name de primeira para vendedor "User Products";
 *   3. categoria sugerida pelo ML só por erro de categoria.
 *
 * Harness copiado de tests/ml-create-final-classification.spec.ts.
 */

vi.mock("../app/marketplaces/repositories/listing.repository", () => ({
  ListingRepository: {
    findLiveByProductAndAccount: vi.fn(),
    findByProductAndAccount: vi.fn(),
    updateListing: vi.fn(),
    createListing: vi.fn(),
    createReservedPlaceholderIfAbsent: vi.fn(),
    findRepublishingListingsInPair: vi.fn(async () => []),
    findRetryStateById: vi.fn(),
    updateCompatDiagnostics: vi.fn(),
    claimInteractiveRetry: vi.fn(async () => new Date(Date.now() + 600_000)),
    releaseInteractiveRetry: vi.fn(async () => undefined),
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
  SystemLogService: { logError: vi.fn(async () => undefined), log: vi.fn() },
}));

vi.mock("../app/marketplaces/services/category-resolution.service", () => ({
  CategoryResolutionService: {
    resolveMLCategory: vi.fn(),
    ensureLeafLocalOnly: vi.fn(async () => null),
    assertWithinVehicleRoot: vi.fn(async () => ({ ok: true, reason: "ok" })),
    assertConditionCoherent: vi.fn(async () => ({ ok: true, reason: "unknown" })),
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
import { MLOAuthService } from "../app/marketplaces/services/ml-oauth.service";
import { CategoryResolutionService } from "../app/marketplaces/services/category-resolution.service";
import { MLAttributeCatalogService } from "../app/marketplaces/services/ml-attribute-catalog.service";

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

/** Catálogo sintético da categoria pedida (formato normalizado do cache). */
const CATALOGO = [
  { id: "BRAND", name: "Marca", valueType: "string", required: false, variationRequired: false },
  {
    id: "GTIN",
    name: "Código universal de produto",
    valueType: "string",
    required: false,
    variationRequired: false,
  },
  {
    id: "REGULATORY_INFORMATION_QR_CODE",
    name: "QR code de informação regulatória",
    valueType: "picture_id",
    required: false,
    variationRequired: false,
  },
  {
    id: "VEHICLE_TYPE",
    name: "Tipo de veículo",
    valueType: "list",
    required: true,
    variationRequired: false,
    fixedTag: true,
    allowedValues: [{ id: "11377043", name: "Carro/Caminhonete" }],
  },
  {
    id: "MAXIMUM_OPENING_ANGLE",
    name: "Ângulo máximo de abertura",
    valueType: "number_unit",
    required: false,
    variationRequired: false,
    allowedUnits: ["°"],
    defaultUnit: "°",
  },
  {
    id: "INMETRO_CERTIFICATION_REGISTRATION_NUMBER",
    name: "Número de registro/certificação INMETRO",
    valueType: "string",
    required: false,
    variationRequired: false,
  },
  { id: "COLOR", name: "Cor", valueType: "string", required: false, variationRequired: false },
];

const erroMl = (message: string, cause: any[], status = 400) => {
  const e: any = new Error(`Erro ao criar item: ${JSON.stringify({ message, cause, status })}`);
  e.mlError = { status, message, error: "validation_error", cause };
  e.mlHttpStatus = status;
  return e;
};
const INMETRO_3702 = {
  cause_id: 3702,
  type: "error",
  code: "item.attribute.invalid_sanitary_registry_value",
  message: 'O valor que você inseriu em "Número de registro/certificação INMETRO" está incorreto.',
};
const CATEGORIA_INVALIDA = {
  cause_id: 1,
  type: "error",
  code: "item.category_id.invalid",
  message: "Category not allowed",
};
const PEDE_TITLE = {
  cause_id: 369,
  type: "error",
  code: "body.required_fields",
  message: "The body does not contains some or none of the following properties [title]",
};

const criar = () =>
  ListingUseCase.createMLListing(
    "user-1",
    "prod-1",
    "MLB46723",
    "acct-1",
    undefined,
    undefined,
    "actor-1",
  );

const chamadas = () => (MLApiService.createItem as any).mock.calls.map((c: any[]) => c[1]);
const attr = (payload: any, id: string) =>
  (payload.attributes || []).find((a: any) => a.id === id);

let produto: any;

beforeEach(async () => {
  vi.clearAllMocks();
  for (const k of [
    "ML_REQUIRED_ATTRS_BLOCK",
    "LISTING_PREFLIGHT",
    "ML_CATALOG_LISTING_ENABLED",
    "ML_VALUE_VALIDATION_DISABLED",
    "ML_UP_FAMILY_FIRST_DISABLED",
    "ML_SUGGESTED_CATEGORY_ANY_ERROR",
  ]) {
    delete process.env[k];
  }
  for (const m of ["log", "warn", "error", "debug", "info"] as const) {
    vi.spyOn(console, m).mockImplementation(() => {});
  }
  (MarketplaceRepository.findByIdAndUser as any).mockResolvedValue(ACCOUNT);
  (ListingRepository.findLiveByProductAndAccount as any).mockResolvedValue(null);
  (ListingRepository.findByProductAndAccount as any).mockResolvedValue(null);
  // Criação exclusiva da 1ª linha do par (lock de transação, #360): nos testes
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
  (MLAttributeCatalogService.getAll as any).mockImplementation(async (id: string) =>
    id === "MLB46723" ? CATALOGO : [],
  );
  (MLApiService.suggestCategoryId as any).mockResolvedValue(null);
  (MLOAuthService.getUserInfo as any).mockResolvedValue({ id: 123456 });
  produto = {
    id: "prod-1",
    sku: "SKU-1",
    name: "Dobradiça Capô Fiat Uno",
    brand: "Fiat",
    price: 199,
    stock: 1,
    imageUrl: "/uploads/x.jpg",
    imageUrls: [],
    heightCm: 20,
    widthCm: 20,
    lengthCm: 40,
    weightKg: 1,
    mlCategoryId: "cat-interna-1",
    attributes: {},
  };
  const repo: any = await import("../app/repositories/product.repository");
  repo.__findById.mockImplementation(async () => ({ ...produto }));
  vi.spyOn(ListingUseCase as any, "collectProductImageUrls").mockReturnValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("valores da ficha técnica antes do POST", () => {
  it("GTIN com número de peça ⇒ não chama o ML; linha [TERMINAL][CORRIGIVEL] sem retentativa", async () => {
    produto.attributes = { GTIN: { value_name: "2033029" } };
    const r = await criar();
    expect(MLApiService.createItem).not.toHaveBeenCalled();
    expect(r.success).toBe(false);
    expect(r.errorKind).toBe("VALIDATION");
    expect(r.lastErrorMarker).toBe("[TERMINAL][CORRIGIVEL]");
    expect(r.error).toMatch(/Código universal de produto.*"2033029"/);
    expect(r.terminal).toBeUndefined();
    expect(r.listingId).toBe("l-novo");
    const criada = (ListingRepository.createListing as any).mock.calls[0][0];
    expect(criada.lastError.startsWith("[TERMINAL][CORRIGIVEL] ")).toBe(true);
    expect(criada.retryEnabled).toBe(false);
    expect(criada.status).toBe("error");
  });

  it("linha já existente (placeholder) recebe o bloqueio pelo id", async () => {
    (ListingRepository.findByProductAndAccount as any).mockResolvedValue({
      id: "l-velha",
      externalListingId: "PENDING_1",
    });
    // (Antes o exemplo era o QR code com texto; desde 25/09 ele sai do envio
    // em vez de bloquear — a medida sem unidade segue bloqueando.)
    produto.attributes = { MAXIMUM_OPENING_ANGLE: { value_name: "1" } };
    await criar();
    expect(ListingRepository.updateListing).toHaveBeenCalledWith(
      "l-velha",
      expect.objectContaining({
        status: "error",
        retryEnabled: false,
        lastError: expect.stringMatching(
          /^\[TERMINAL\]\[CORRIGIVEL\] O campo "Ângulo máximo de abertura"/,
        ),
      }),
    );
  });

  it("linha reaproveitada com id REAL (anúncio encerrado) ⇒ o bloqueio vai para um placeholder PENDING_ novo; a encerrada não é tocada", async () => {
    // Sem isto o [TERMINAL][CORRIGIVEL] ficava numa linha que o re-arme e o
    // botão não enxergam (só PENDING_) — sem saída.
    (ListingRepository.findByProductAndAccount as any).mockResolvedValue({
      id: "l-encerrada",
      externalListingId: "MLB123",
      status: "closed",
    });
    produto.attributes = { GTIN: { value_name: "2033029" } };
    const r = await criar();
    expect(MLApiService.createItem).not.toHaveBeenCalled();
    expect(ListingRepository.updateListing).not.toHaveBeenCalledWith(
      "l-encerrada",
      expect.anything(),
    );
    const criada = (ListingRepository.createListing as any).mock.calls[0][0];
    expect(criada.externalListingId.startsWith("PENDING_")).toBe(true);
    expect(criada.lastError.startsWith("[TERMINAL][CORRIGIVEL] ")).toBe(true);
    expect(r.listingId).toBe("l-novo");
  });

  it("bloqueio lê a linha do par UMA vez (sem segunda leitura idêntica)", async () => {
    produto.attributes = { GTIN: { value_name: "2033029" } };
    await criar();
    expect(ListingRepository.findByProductAndAccount).toHaveBeenCalledTimes(1);
  });

  it("REPUBLICAÇÃO UP (opts.republish, linha PENDING_REPUBLISH_) ⇒ não bloqueia: o POST segue como antes e o ML decide", async () => {
    // A troca de título de anúncio vivo não tem onde mostrar o bloqueio (o
    // sync reverte a linha); o ML aceita parte destes valores com aviso.
    (ListingRepository.findByProductAndAccount as any).mockResolvedValue({
      id: "l-viva",
      externalListingId: "PENDING_REPUBLISH_MLB1_1",
    });
    produto.attributes = {
      MAXIMUM_OPENING_ANGLE: { value_name: "30" },
      VEHICLE_TYPE: { value_id: "13222040", value_name: "Linha Pesada" },
    };
    (MLApiService.createItem as any).mockRejectedValue(erroMl("Validation error", [INMETRO_3702]));
    await ListingUseCase.createMLListing(
      "user-1",
      "prod-1",
      "MLB46723",
      "acct-1",
      undefined,
      "Título novo",
      "actor-1",
      undefined,
      { republish: true },
    );
    expect(MLApiService.createItem).toHaveBeenCalled();
    const primeiro = chamadas()[0];
    expect(attr(primeiro, "MAXIMUM_OPENING_ANGLE")).toMatchObject({ value_name: "30" });
    // correção determinística continua valendo
    expect(attr(primeiro, "VEHICLE_TYPE").value_id).toBe("11377043");
    // nada de [TERMINAL][CORRIGIVEL] gravado na linha viva
    for (const c of (ListingRepository.updateListing as any).mock.calls) {
      expect(String(c[1]?.lastError ?? "")).not.toMatch(/CORRIGIVEL/);
    }
  });

  it("REPUBLICAÇÃO com um pendente ANTIGO mais novo no par ⇒ reconhecida pelo aviso de quem chama; não bloqueia", async () => {
    // findByProductAndAccount devolve o PENDING_ mais novo (um [TERMINAL]
    // velho), não a linha PENDING_REPUBLISH_ do anúncio vivo.
    (ListingRepository.findByProductAndAccount as any).mockResolvedValue({
      id: "l-velha",
      externalListingId: "PENDING_999",
      retryEnabled: false,
      nextRetryAt: null,
    });
    produto.attributes = { MAXIMUM_OPENING_ANGLE: { value_name: "30" } };
    // ML fora do ar: o que importa é que o POST SAIU (o bloqueio de valor
    // não o segurou) e que nada gravou o bloqueio de valor.
    (MLApiService.createItem as any).mockRejectedValue(
      erroMl("Service unavailable", [], 503),
    );
    await ListingUseCase.createMLListing(
      "user-1",
      "prod-1",
      "MLB46723",
      "acct-1",
      undefined,
      "Título novo",
      "actor-1",
      undefined,
      { republish: true },
    );
    expect(MLApiService.createItem).toHaveBeenCalled();
    for (const c of (ListingRepository.updateListing as any).mock.calls) {
      expect(String(c[1]?.lastError ?? "")).not.toMatch(/CORRIGIVEL/);
    }
  });

  it("PENDING_REPUBLISH_ ÓRFÃO no par não desliga a validação de uma criação normal", async () => {
    // Republicação que caiu no meio (restart) deixa a marca para sempre.
    (ListingRepository.findByProductAndAccount as any).mockResolvedValue({
      id: "l-orfa",
      externalListingId: "PENDING_REPUBLISH_MLB1_1",
    });
    produto.attributes = { MAXIMUM_OPENING_ANGLE: { value_name: "30" } };
    const r = await criar();
    expect(MLApiService.createItem).not.toHaveBeenCalled();
    expect(r.lastErrorMarker).toBe("[TERMINAL][CORRIGIVEL]");
  });

  it("número sem unidade em campo OPCIONAL ⇒ bloqueia (3708 recusa o anúncio)", async () => {
    produto.attributes = { MAXIMUM_OPENING_ANGLE: { value_name: "30" } };
    const r = await criar();
    expect(MLApiService.createItem).not.toHaveBeenCalled();
    expect(r.error).toMatch(/Ângulo máximo de abertura/);
  });

  it("valor fixo divergente é trocado pelo da categoria e o POST segue", async () => {
    produto.attributes = {
      VEHICLE_TYPE: { value_id: "13222040", value_name: "Linha Pesada" },
    };
    (MLApiService.createItem as any).mockRejectedValue(erroMl("Validation error", [INMETRO_3702]));
    await criar();
    const primeiro = chamadas()[0];
    expect(attr(primeiro, "VEHICLE_TYPE")).toEqual({
      id: "VEHICLE_TYPE",
      value_id: "11377043",
      value_name: "Carro/Caminhonete",
    });
  });

  it("ML_VALUE_VALIDATION_DISABLED=1 ⇒ payload de antes (valor vai ao ML)", async () => {
    process.env.ML_VALUE_VALIDATION_DISABLED = "1";
    produto.attributes = {
      GTIN: { value_name: "2033029" },
      VEHICLE_TYPE: { value_id: "13222040", value_name: "Linha Pesada" },
    };
    (MLApiService.createItem as any).mockRejectedValue(erroMl("Validation error", [INMETRO_3702]));
    await criar();
    const primeiro = chamadas()[0];
    expect(attr(primeiro, "GTIN")).toEqual({ id: "GTIN", value_name: "2033029" });
    expect(attr(primeiro, "VEHICLE_TYPE").value_id).toBe("13222040");
  });

  it("catálogo indisponível ⇒ nada é bloqueado nem trocado (fail-open)", async () => {
    (MLAttributeCatalogService.getAll as any).mockResolvedValue([]);
    produto.attributes = { GTIN: { value_name: "2033029" } };
    (MLApiService.createItem as any).mockRejectedValue(erroMl("Validation error", [INMETRO_3702]));
    await criar();
    expect(attr(chamadas()[0], "GTIN")).toEqual({ id: "GTIN", value_name: "2033029" });
  });

  it("anúncio de catálogo ligado ⇒ não bloqueia antes do POST (mesma exceção dos obrigatórios)", async () => {
    process.env.ML_CATALOG_LISTING_ENABLED = "true";
    produto.mlCatalogProductId = "MLB-CAT-1";
    produto.attributes = { GTIN: { value_name: "2033029" } };
    (MLApiService.createItem as any).mockResolvedValue({ id: "MLB1" });
    await criar();
    expect(MLApiService.createItem).toHaveBeenCalled();
  });

  it("ficha válida ⇒ atributos do POST idênticos aos de hoje", async () => {
    produto.attributes = {
      VEHICLE_TYPE: { value_id: "11377043", value_name: "Carro/Caminhonete" },
      MAXIMUM_OPENING_ANGLE: { value_name: "30 °" },
    };
    (MLApiService.createItem as any).mockRejectedValue(erroMl("Validation error", [INMETRO_3702]));
    await criar();
    const comValidacao = chamadas()[0].attributes;

    vi.clearAllMocks();
    process.env.ML_VALUE_VALIDATION_DISABLED = "1";
    (MLApiService.createItem as any).mockRejectedValue(erroMl("Validation error", [INMETRO_3702]));
    (MarketplaceRepository.findByIdAndUser as any).mockResolvedValue(ACCOUNT);
    (ListingRepository.createListing as any).mockImplementation(async (d: any) => ({
      id: "l-novo",
      ...d,
    }));
    await criar();
    expect(chamadas()[0].attributes).toEqual(comValidacao);
  });
});

describe("family_name de primeira (vendedor User Products)", () => {
  it("conta com user_product_seller ⇒ 1ª tentativa com family_name e sem title", async () => {
    (MLOAuthService.getUserInfo as any).mockResolvedValue({
      id: 123456,
      tags: ["normal", "user_product_seller"],
    });
    (MLApiService.createItem as any).mockRejectedValue(erroMl("Validation error", [INMETRO_3702]));
    await criar();
    const primeiro = chamadas()[0];
    expect(primeiro.family_name).toBe("Dobradiça Capô Fiat Uno");
    expect(primeiro.title).toBeUndefined();
    // O degrau family_name não reenvia o mesmo corpo.
    const corposIguais = chamadas().filter(
      (p: any) => JSON.stringify(p) === JSON.stringify(primeiro),
    );
    expect(corposIguais).toHaveLength(1);
  });

  it("conta sem a tag ⇒ 1ª tentativa com title e sem family_name (como sempre)", async () => {
    (MLOAuthService.getUserInfo as any).mockResolvedValue({ id: 123456, tags: ["normal"] });
    (MLApiService.createItem as any).mockRejectedValue(erroMl("Validation error", [INMETRO_3702]));
    await criar();
    const primeiro = chamadas()[0];
    expect(primeiro.title).toBe("Dobradiça Capô Fiat Uno");
    expect(primeiro.family_name).toBeUndefined();
  });

  it("ML_UP_FAMILY_FIRST_DISABLED=1 ⇒ fluxo anterior mesmo com a tag", async () => {
    process.env.ML_UP_FAMILY_FIRST_DISABLED = "1";
    (MLOAuthService.getUserInfo as any).mockResolvedValue({
      id: 123456,
      tags: ["user_product_seller"],
    });
    (MLApiService.createItem as any).mockRejectedValue(erroMl("Validation error", [INMETRO_3702]));
    await criar();
    expect(chamadas()[0].title).toBe("Dobradiça Capô Fiat Uno");
    expect(chamadas()[0].family_name).toBeUndefined();
  });

  it("/users/me falhou ⇒ fluxo anterior", async () => {
    (MLOAuthService.getUserInfo as any).mockRejectedValue(new Error("rede"));
    (MLApiService.createItem as any).mockRejectedValue(erroMl("Validation error", [INMETRO_3702]));
    await criar();
    expect(chamadas()[0].title).toBe("Dobradiça Capô Fiat Uno");
  });

  it("ML pediu title ⇒ degrau reverso manda o corpo de antes (com title, sem family_name)", async () => {
    (MLOAuthService.getUserInfo as any).mockResolvedValue({
      id: 123456,
      tags: ["user_product_seller"],
    });
    (MLApiService.createItem as any)
      .mockRejectedValueOnce(erroMl("body.required_fields", [PEDE_TITLE]))
      .mockRejectedValue(erroMl("Validation error", [INMETRO_3702]));
    await criar();
    const segundo = chamadas()[1];
    expect(segundo.title).toBe("Dobradiça Capô Fiat Uno");
    expect(segundo.family_name).toBeUndefined();
  });

  it("recusa por dado ⇒ sem degrau reverso", async () => {
    (MLOAuthService.getUserInfo as any).mockResolvedValue({
      id: 123456,
      tags: ["user_product_seller"],
    });
    (MLApiService.createItem as any).mockRejectedValue(erroMl("Validation error", [INMETRO_3702]));
    await criar();
    expect(chamadas().some((p: any) => p.title && !p.family_name)).toBe(false);
  });
});

describe("categoria sugerida pelo ML só por erro de categoria", () => {
  it("erro de DADO ⇒ não pede categoria ao ML nem publica fora da escolhida", async () => {
    (MLApiService.suggestCategoryId as any).mockResolvedValue("MLB999");
    (MLApiService.createItem as any).mockRejectedValue(erroMl("Validation error", [INMETRO_3702]));
    await criar();
    expect(MLApiService.suggestCategoryId).not.toHaveBeenCalled();
    expect(chamadas().every((p: any) => p.category_id === "MLB46723")).toBe(true);
  });

  it("título recusado ⇒ escada de título na MESMA categoria, sem categoria sugerida", async () => {
    (MLApiService.suggestCategoryId as any).mockResolvedValue("MLB999");
    (MLApiService.createItem as any).mockRejectedValue(
      erroMl("Validation error: body.invalid_fields [title]", [
        { code: "body.invalid_fields", message: "invalid_fields [title]" },
      ]),
    );
    await criar();
    expect(MLApiService.suggestCategoryId).not.toHaveBeenCalled();
    expect(chamadas().length).toBeGreaterThan(1);
    expect(chamadas().every((p: any) => p.category_id === "MLB46723")).toBe(true);
  });

  it("timeout na categoria pedida ⇒ não cria em OUTRA categoria (o item pode ter sido criado)", async () => {
    (MLApiService.suggestCategoryId as any).mockResolvedValue("MLB999");
    (MLApiService.createItem as any).mockRejectedValue(
      new Error("ML createItem timeout after 15000ms"),
    );
    const r = await criar();
    expect(MLApiService.suggestCategoryId).not.toHaveBeenCalled();
    expect(chamadas().every((p: any) => p.category_id === "MLB46723")).toBe(true);
    expect(r.lastErrorMarker).toBe("[VERIFICAR]");
  });

  it("erro de CATEGORIA ⇒ tenta a sugerida", async () => {
    (MLApiService.suggestCategoryId as any).mockResolvedValue("MLB999");
    (MLApiService.createItem as any).mockImplementation(async (_t: string, p: any) => {
      if (p.category_id === "MLB999") return { id: "MLB1" };
      throw erroMl("Validation error", [CATEGORIA_INVALIDA]);
    });
    await criar();
    expect(MLApiService.suggestCategoryId).toHaveBeenCalled();
    expect(chamadas().some((p: any) => p.category_id === "MLB999")).toBe(true);
  });

  it("ML_SUGGESTED_CATEGORY_ANY_ERROR=1 ⇒ comportamento anterior (qualquer erro)", async () => {
    process.env.ML_SUGGESTED_CATEGORY_ANY_ERROR = "1";
    (MLApiService.suggestCategoryId as any).mockResolvedValue("MLB999");
    (MLApiService.createItem as any).mockRejectedValue(erroMl("Validation error", [INMETRO_3702]));
    await criar();
    expect(MLApiService.suggestCategoryId).toHaveBeenCalled();
    expect(chamadas().some((p: any) => p.category_id === "MLB999")).toBe(true);
  });
});

describe("anúncio do par em REPUBLICAÇÃO (revisão de fechamento, 23/09 — defeito que já existia em main)", () => {
  // O id carrega o horário da troca: recente = republicação em curso.
  const REPUBLICANDO = {
    id: "l-rep",
    externalListingId: `PENDING_REPUBLISH_MLB111_${Date.now() - 60_000}`,
  };
  // Encalhada: bem fora da janela de uma criação (10 min).
  const ENCALHADA = {
    id: "l-encalhada",
    externalListingId: `PENDING_REPUBLISH_MLB111_${Date.now() - 3 * 24 * 3600_000}`,
    status: "error",
    retryEnabled: false,
    nextRetryAt: null,
    lastError:
      "[TERMINAL] Republicacao abortada: o anuncio MLB111 ja tem outra linha nesta conta — remova este pendente",
  };
  const criarComo = (opts?: Record<string, unknown>) =>
    ListingUseCase.createMLListing(
      "user-1",
      "prod-1",
      "MLB46723",
      "acct-1",
      undefined,
      undefined,
      "actor-1",
      undefined,
      opts as any,
    );

  it("'Anunciar' com a republicação em curso (ou interrompida) ⇒ recusa ANTES de montar o anúncio, apontando o anúncio antigo; sem POST", async () => {
    (ListingRepository.findRepublishingListingsInPair as any).mockResolvedValue([REPUBLICANDO]);
    const r = await criarComo();
    expect(MLApiService.createItem).not.toHaveBeenCalled();
    expect(r.success).toBe(false);
    expect(r.skipped).toBe(true);
    expect(r.listingId).toBe("l-rep");
    expect(r.externalListingId).toBe("MLB111");
    expect(r.error).toMatch(/MLB111/);
    // sem code: para o cron é falha comum (gasta tentativa), não "volta à fila" eterna
    expect((r as any).code).toBeUndefined();
    expect(ListingRepository.updateListing).not.toHaveBeenCalled();
    expect(ListingRepository.createReservedPlaceholderIfAbsent).not.toHaveBeenCalled();
  });

  it("a PRÓPRIA republicação (opts.republish) passa e publica", async () => {
    (ListingRepository.findRepublishingListingsInPair as any).mockResolvedValue([REPUBLICANDO]);
    (ListingRepository.findByProductAndAccount as any).mockResolvedValue({
      ...REPUBLICANDO,
      status: "pending",
      retryEnabled: false,
    });
    (MLApiService.createItem as any).mockRejectedValue(erroMl("Validation error", [INMETRO_3702]));
    await criarComo({ republish: true });
    expect(ListingRepository.findRepublishingListingsInPair).not.toHaveBeenCalled();
    expect(MLApiService.createItem).toHaveBeenCalled();
  });

  it("a leitura da marca FALHOU e o passo 3.1 escolheu a linha da republicação ⇒ recusa ali; sem POST e sem gravar na linha", async () => {
    (ListingRepository.findRepublishingListingsInPair as any).mockRejectedValue(new Error("pool"));
    (ListingRepository.findByProductAndAccount as any).mockResolvedValue({
      ...REPUBLICANDO,
      status: "pending",
      retryEnabled: false,
    });
    const r = await criarComo();
    expect(MLApiService.createItem).not.toHaveBeenCalled();
    expect(r.skipped).toBe(true);
    expect(r.error).toMatch(/MLB111/);
    expect(ListingRepository.updateListing).not.toHaveBeenCalled();
  });

  it("linha ENCALHADA (processo morreu / revert id_taken, dias atrás) ⇒ 'Anunciar' segue como antes, agora SOB RESERVA, e publica nela (releitura de 23/09)", async () => {
    (ListingRepository.findRepublishingListingsInPair as any).mockResolvedValue([ENCALHADA]);
    (ListingRepository.findByProductAndAccount as any).mockResolvedValue(ENCALHADA);
    (MLApiService.createItem as any).mockRejectedValue(erroMl("Validation error", [INMETRO_3702]));
    const r = await criarComo();
    expect(r.error ?? "").not.toMatch(/sendo republicado/);
    expect(ListingRepository.claimInteractiveRetry).toHaveBeenCalledWith(
      "l-encalhada",
      expect.any(Number),
      expect.any(Date),
      {},
    );
    expect(MLApiService.createItem).toHaveBeenCalled();
    expect((ListingRepository.updateListing as any).mock.calls[0][0]).toBe("l-encalhada");
  });

  it("encalhada E outra EM CURSO no mesmo par ⇒ recusa (a encalhada não esconde a em curso — releitura final de 23/09)", async () => {
    (ListingRepository.findRepublishingListingsInPair as any).mockResolvedValue([
      ENCALHADA,
      REPUBLICANDO,
    ]);
    const r = await criarComo();
    expect(MLApiService.createItem).not.toHaveBeenCalled();
    expect(r.error).toMatch(/sendo republicado/);
    expect(r.listingId).toBe("l-rep");
  });

  it("janela de 30 min: republicação trocada há 20 min ainda conta como EM CURSO (a subida de fotos não tem prazo)", async () => {
    (ListingRepository.findRepublishingListingsInPair as any).mockResolvedValue([
      { id: "l-lenta", externalListingId: `PENDING_REPUBLISH_MLB222_${Date.now() - 20 * 60_000}` },
    ]);
    const r = await criarComo();
    expect(MLApiService.createItem).not.toHaveBeenCalled();
    expect(r.error).toMatch(/MLB222/);
  });

  it("encalhada reservada por um 'Anunciar' comum vira pendente COMUM (id PENDING_ novo): o timeout ganha [VERIFICAR] como qualquer pendente", async () => {
    (ListingRepository.findRepublishingListingsInPair as any).mockResolvedValue([ENCALHADA]);
    (ListingRepository.findByProductAndAccount as any).mockResolvedValue(ENCALHADA);
    (MLApiService.createItem as any).mockRejectedValue(new Error("ML createItem timeout after 15000ms"));
    await criarComo();
    const [id, dados] = (ListingRepository.updateListing as any).mock.calls[0];
    expect(id).toBe("l-encalhada");
    expect(dados.externalListingId).toMatch(/^PENDING_\d+_[a-z0-9]+$/);
    const marcadores = (ListingRepository.updateListing as any).mock.calls
      .map((c: any[]) => String(c[1]?.lastError ?? ""))
      .filter((e: string) => e.startsWith("[VERIFICAR]"));
    expect(marcadores.length).toBeGreaterThan(0);
  });

  it("linha ENCALHADA já reservada por outro 'Anunciar' ⇒ recua (sem o segundo POST que main mandava)", async () => {
    (ListingRepository.findRepublishingListingsInPair as any).mockResolvedValue([ENCALHADA]);
    (ListingRepository.findByProductAndAccount as any).mockResolvedValue({
      ...ENCALHADA,
      nextRetryAt: new Date(Date.now() + 300_000),
    });
    const r = await criarComo();
    expect(MLApiService.createItem).not.toHaveBeenCalled();
    expect((r as any).code).toBe("PUBLICATION_IN_PROGRESS");
  });

  it("sem republicação no par ⇒ caminho de sempre (a consulta devolve nada)", async () => {
    (MLApiService.createItem as any).mockRejectedValue(erroMl("Validation error", [INMETRO_3702]));
    await criarComo();
    expect(ListingRepository.findRepublishingListingsInPair).toHaveBeenCalledWith("prod-1", "acct-1");
    expect(MLApiService.createItem).toHaveBeenCalled();
  });
});

describe("descrição com emoji no corpo do POST /items (23/09/2026 — SKU 7167)", () => {
  it("o emoji que o ML recusa sai do corpo; o resto do texto vai igual", async () => {
    produto.description = "⚠️ ATENÇÃO E OBSERVAÇÕES IMPORTANTES:\n🚗 Só direção hidráulica.";
    (MLApiService.createItem as any).mockRejectedValue(erroMl("Validation error", [INMETRO_3702]));
    await criar();
    const texto = chamadas()[0].description.plain_text as string;
    expect(texto).toContain("ATENÇÃO E OBSERVAÇÕES IMPORTANTES:");
    expect(texto).toContain("Só direção hidráulica.");
    expect(texto).not.toMatch(/[️‍]|[\u{10000}-\u{10FFFF}]/u);
  });

  it("descrição sem emoji vai IDÊNTICA à de antes", async () => {
    produto.description = "Peça original — usada.\n• 90 dias de garantia";
    (MLApiService.createItem as any).mockRejectedValue(erroMl("Validation error", [INMETRO_3702]));
    await criar();
    expect(chamadas()[0].description.plain_text).toContain(
      "Peça original — usada.\n• 90 dias de garantia",
    );
  });
});

describe("ficha da Revisão individual × ficha gravada no produto (Xaxim, 25/09/2026)", () => {
  // A revisão passou a abrir com a ficha do produto e a mandar só o que a
  // pessoa MUDOU (null = apagou). Antes o valor gravado sempre vencia: o "10
  // cm" digitado era descartado e o INMETRO de texto de busca voltava ao ML.
  const criarComFicha = (ficha: Record<string, unknown>) =>
    ListingUseCase.createMLListing(
      "user-1",
      "prod-1",
      "MLB46723",
      "acct-1",
      undefined,
      undefined,
      "actor-1",
      ficha as any,
    );

  beforeEach(() => {
    process.env.ML_REQUIRED_ATTRS_BLOCK = "1";
    (MLApiService.createItem as any).mockRejectedValue(erroMl("Validation error", [INMETRO_3702]));
  });

  it("medida gravada SEM unidade + corrigida na revisão ⇒ vai a da revisão (não bloqueia)", async () => {
    produto.attributes = { MAXIMUM_OPENING_ANGLE: { value_name: "1" } };
    await criarComFicha({ MAXIMUM_OPENING_ANGLE: { value_name: "90 °" } });
    expect(MLApiService.createItem).toHaveBeenCalled();
    expect(attr(chamadas()[0], "MAXIMUM_OPENING_ANGLE")).toMatchObject({ value_name: "90 °" });
  });

  it("correção que TAMBÉM é inválida ⇒ não substitui; segue o bloqueio pelo valor do produto", async () => {
    produto.attributes = { MAXIMUM_OPENING_ANGLE: { value_name: "1" } };
    await criarComFicha({ MAXIMUM_OPENING_ANGLE: { value_name: "10" } });
    expect(MLApiService.createItem).not.toHaveBeenCalled();
  });

  it("INMETRO gravado com texto de busca + apagado na revisão (null) ⇒ não vai ao ML", async () => {
    produto.attributes = {
      INMETRO_CERTIFICATION_REGISTRATION_NUMBER: { value_name: "sensor maf medidor fluxo ar nissan" },
    };
    await criarComFicha({ INMETRO_CERTIFICATION_REGISTRATION_NUMBER: null });
    expect(MLApiService.createItem).toHaveBeenCalled();
    expect(attr(chamadas()[0], "INMETRO_CERTIFICATION_REGISTRATION_NUMBER")).toBeUndefined();
  });

  it("INMETRO gravado com texto + número digitado na revisão ⇒ vai o número", async () => {
    produto.attributes = {
      INMETRO_CERTIFICATION_REGISTRATION_NUMBER: { value_name: "tbi corpo borboleta citroen c4" },
    };
    await criarComFicha({ INMETRO_CERTIFICATION_REGISTRATION_NUMBER: { value_name: "008512/2019" } });
    expect(attr(chamadas()[0], "INMETRO_CERTIFICATION_REGISTRATION_NUMBER")).toMatchObject({
      value_name: "008512/2019",
    });
  });

  it("QR code com texto gravado no produto ⇒ não bloqueia e não vai ao ML", async () => {
    produto.attributes = { REGULATORY_INFORMATION_QR_CODE: { value_name: "1" } };
    await criar();
    expect(MLApiService.createItem).toHaveBeenCalled();
    expect(attr(chamadas()[0], "REGULATORY_INFORMATION_QR_CODE")).toBeUndefined();
  });

  it("SEM REGRESSÃO: valor VÁLIDO do produto segue vencendo o da revisão na criação (opcional)", async () => {
    produto.attributes = { COLOR: { value_name: "Preto" } };
    await criarComFicha({ COLOR: { value_name: "Cinza" } });
    expect(attr(chamadas()[0], "COLOR")).toMatchObject({ value_name: "Preto" });
  });

  it("SEM REGRESSÃO: apagar campo que o produto NÃO tem não muda nada", async () => {
    produto.attributes = { COLOR: { value_name: "Preto" } };
    await criarComFicha({ INMETRO_CERTIFICATION_REGISTRATION_NUMBER: null });
    expect(attr(chamadas()[0], "COLOR")).toMatchObject({ value_name: "Preto" });
  });

  it("o placeholder guarda a correção para a retentativa, mas NUNCA o null do apagar", async () => {
    produto.attributes = {
      MAXIMUM_OPENING_ANGLE: { value_name: "1" },
      INMETRO_CERTIFICATION_REGISTRATION_NUMBER: { value_name: "texto de busca" },
    };
    await criarComFicha({
      MAXIMUM_OPENING_ANGLE: { value_name: "90 °" },
      INMETRO_CERTIFICATION_REGISTRATION_NUMBER: null,
    });
    const criada = (ListingRepository.createListing as any).mock.calls[0]?.[0];
    expect(criada.attributesOverride).toEqual({ MAXIMUM_OPENING_ANGLE: { value_name: "90 °" } });
    expect(JSON.stringify(criada.attributesOverride)).not.toContain("null");
  });
});
