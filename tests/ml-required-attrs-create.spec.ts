import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * createMLListing com ML_REQUIRED_ATTRS_BLOCK: o bloqueio ANTES do POST
 * (regra estrita sobre o payload enriquecido) e a detecção DEPOIS do POST
 * (causa 147 do ML), com a persistência terminal e as garantias de que a flag
 * desligada deixa tudo como hoje.
 *
 * Harness: mocks de tests/listing-duplicate-guard.spec.ts + resolução de
 * categoria, catálogo com fixture real e imagens desligadas.
 */

vi.mock("../app/marketplaces/repositories/listing.repository", () => ({
  ListingRepository: {
    findLiveByProductAndAccount: vi.fn(),
    findByProductAndAccount: vi.fn(),
    updateListing: vi.fn(),
    createListing: vi.fn(),
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

/**
 * Terminais DESTA funcionalidade (campo obrigatório, `[TERMINAL] <msg>`),
 * sem contar `[TERMINAL][CORRIGIVEL]` — o terminal por recusa de DADO que o
 * PR-2 (22/09/2026) introduziu para qualquer 400 na categoria pedida com o
 * catálogo disponível, e que a edição do produto re-arma.
 */
const gravacoesTerminaisDeObrigatorio = () =>
  gravacoesTerminais().filter(
    (c: any[]) =>
      !String((c[1] ?? c[0])?.lastError ?? "").startsWith(
        "[TERMINAL][CORRIGIVEL]",
      ),
  );

/** Gravação do terminal corrigível na linha (PR-2). */
const gravouCorrigivel = () =>
  (ListingRepository.updateListing as any).mock.calls.some(
    (c: any[]) =>
      String(c[1]?.lastError ?? "").startsWith("[TERMINAL][CORRIGIVEL]") &&
      c[1]?.retryEnabled === false,
  );

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

describe("bloqueio ANTES do POST /items", () => {
  it("C1: flag 1 + PART_NUMBER obrigatório ausente → terminal com M1, sem createItem e sem upload", async () => {
    process.env.ML_REQUIRED_ATTRS_BLOCK = "1";
    const r = await criar();
    expect(r).toMatchObject({
      success: false,
      terminal: true,
      code: "ML_REQUIRED_ATTRIBUTES_MISSING",
      error: M1,
      missingAttributes: [
        { id: "PART_NUMBER", name: expect.any(String), reason: "missing" },
      ],
    });
    expect(MLApiService.createItem).not.toHaveBeenCalled();
    expect(imagens).not.toHaveBeenCalled();
    expect(MLApiService.uploadPicture).not.toHaveBeenCalled();
  });

  it("C2: sem linha existente → cria placeholder já terminal", async () => {
    process.env.ML_REQUIRED_ATTRS_BLOCK = "1";
    const r = await criar();
    expect(ListingRepository.createListing).toHaveBeenCalledTimes(1);
    expect((ListingRepository.createListing as any).mock.calls[0][0]).toMatchObject({
      productId: "prod-1",
      marketplaceAccountId: "acct-1",
      externalListingId: expect.stringMatching(/^PENDING_/),
      status: "error",
      lastError: `[TERMINAL] ${M1}`,
      retryEnabled: false,
      nextRetryAt: null,
      requestedCategoryId: "MLB46723",
      createdByUserId: "actor-1",
    });
    expect(r.listingId).toBe("l-novo");
  });

  it("C3b: linha PENDING_ reservada por OUTRO (publicação em andamento) → bloqueio NÃO é gravado por cima da reserva", async () => {
    process.env.ML_REQUIRED_ATTRS_BLOCK = "1";
    (ListingRepository.findByProductAndAccount as any).mockResolvedValue({
      id: "l-pend",
      externalListingId: "PENDING_1",
      retryEnabled: false,
      nextRetryAt: new Date(Date.now() + 5 * 60_000),
    });
    const r = await criar();
    expect(r.success).toBe(false);
    expect(ListingRepository.updateListing).not.toHaveBeenCalled();
    expect(ListingRepository.createListing).not.toHaveBeenCalled();
  });

  it("C3: linha PENDING_ existente → updateListing nela com os mesmos campos", async () => {
    process.env.ML_REQUIRED_ATTRS_BLOCK = "1";
    (ListingRepository.findByProductAndAccount as any).mockResolvedValue({
      id: "l-pend",
      externalListingId: "PENDING_1",
    });
    const r = await criar();
    expect(ListingRepository.createListing).not.toHaveBeenCalled();
    expect(ListingRepository.updateListing).toHaveBeenCalledWith("l-pend", {
      status: "error",
      lastError: `[TERMINAL] ${M1}`,
      retryEnabled: false,
      nextRetryAt: null,
      requestedCategoryId: "MLB46723",
    });
    expect(r.listingId).toBe("l-pend");
  });

  it("C4: linha PENDING_REPUBLISH_ → nem updateListing nem createListing", async () => {
    process.env.ML_REQUIRED_ATTRS_BLOCK = "1";
    (ListingRepository.findByProductAndAccount as any).mockResolvedValue({
      id: "l-rep",
      externalListingId: "PENDING_REPUBLISH_1",
    });
    const r = await criar();
    expect(r.terminal).toBe(true);
    expect(ListingRepository.updateListing).not.toHaveBeenCalled();
    expect(ListingRepository.createListing).not.toHaveBeenCalled();
  });

  it.each([undefined, "0", "true"])(
    "C5: flag %s → createItem é chamado e nada terminal é gravado",
    async (valor) => {
      if (valor === undefined) delete process.env.ML_REQUIRED_ATTRS_BLOCK;
      else process.env.ML_REQUIRED_ATTRS_BLOCK = valor;
      const r = await criar();
      expect(MLApiService.createItem).toHaveBeenCalled();
      expect(gravacoesTerminais()).toEqual([]);
      expect(r.terminal).toBeUndefined();
      expect((r as any).code).toBeUndefined();
    },
  );

  it("C6: Part Number extraível do nome → não bloqueia (bloqueio fica DEPOIS do enriquecimento)", async () => {
    process.env.ML_REQUIRED_ATTRS_BLOCK = "1";
    produto = { ...baseProduct(), name: "Sensor de rotação Gol 5U0807217" };
    await criar();
    expect(MLApiService.createItem).toHaveBeenCalled();
    const payload = (MLApiService.createItem as any).mock.calls[0][1];
    expect(payload.attributes.find((a: any) => a.id === "PART_NUMBER")?.value_name).toBe(
      "5U0807217",
    );
  });

  it("C7: catálogo vazio → createItem chamado", async () => {
    process.env.ML_REQUIRED_ATTRS_BLOCK = "1";
    (MLAttributeCatalogService.getAll as any).mockResolvedValue([]);
    await criar();
    expect(MLApiService.createItem).toHaveBeenCalled();
  });

  it("C8: flag 1 + LISTING_PREFLIGHT=strict + falta só MOUNT_TYPE (catalog_required) → createItem chamado", async () => {
    process.env.ML_REQUIRED_ATTRS_BLOCK = "1";
    process.env.LISTING_PREFLIGHT = "strict";
    (MLAttributeCatalogService.getAll as any).mockResolvedValue(catalogo("MLB2221"));
    produto = { ...baseProduct(), partNumber: "PN-1" };
    await criar();
    expect(MLApiService.createItem).toHaveBeenCalled();
  });

  it("C8 (controle): sem a flag, o strict antigo continua barrando o MOUNT_TYPE", async () => {
    process.env.LISTING_PREFLIGHT = "strict";
    (MLAttributeCatalogService.getAll as any).mockResolvedValue(catalogo("MLB2221"));
    produto = { ...baseProduct(), partNumber: "PN-1" };
    const r = await criar();
    expect(MLApiService.createItem).not.toHaveBeenCalled();
    expect(r.success).toBe(false);
    expect(r.terminal).toBeUndefined();
  });

  it("D7: anúncio de catálogo ligado + produto vinculado → sem bloqueio antes do POST", async () => {
    process.env.ML_REQUIRED_ATTRS_BLOCK = "1";
    process.env.ML_CATALOG_LISTING_ENABLED = "true";
    produto = { ...baseProduct(), mlCatalogProductId: "MLB-CAT-1" };
    (MLApiService.createItem as any).mockResolvedValue({ id: "MLB1" });
    const r = await criar();
    expect(r.terminal).toBeUndefined();
    const primeiro = (MLApiService.createItem as any).mock.calls[0][1];
    expect(primeiro.catalog_listing).toBe(true);
  });
});

describe("detecção DEPOIS do POST (causa 147)", () => {
  beforeEach(() => {
    // Tags desconhecidas: o bloqueio antes do POST não age, quem decide é o ML.
    (MLAttributeCatalogService.getAll as any).mockResolvedValue(
      semTags(catalogo("MLB46723")),
    );
  });

  it("C9: 147 na categoria pedida → sem categoria sugerida, terminal com M1", async () => {
    process.env.ML_REQUIRED_ATTRS_BLOCK = "1";
    (MLApiService.createItem as any).mockRejectedValue(erro147());
    const r = await criar();
    expect(MLApiService.suggestCategoryId).not.toHaveBeenCalled();
    expect(ListingRepository.updateListing).toHaveBeenCalledWith("l-novo", {
      status: "error",
      lastError: `[TERMINAL] ${M1}`,
      retryEnabled: false,
      nextRetryAt: null,
      requestedCategoryId: "MLB46723",
    });
    expect(r).toMatchObject({
      success: false,
      listingId: "l-novo",
      terminal: true,
      code: "ML_REQUIRED_ATTRIBUTES_MISSING",
      error: M1,
    });
  });

  it("C10: family_name na 1ª tentativa e 147 na retentativa → terminal", async () => {
    process.env.ML_REQUIRED_ATTRS_BLOCK = "1";
    (MLApiService.createItem as any)
      .mockRejectedValueOnce(
        erroMl("body.required_fields [family_name]", [
          {
            cause_id: 369,
            code: "body.required_fields",
            message:
              "The body does not contains some or none of the following properties [family_name]",
          },
        ]),
      )
      .mockRejectedValue(erro147());
    const r = await criar();
    expect(r.terminal).toBe(true);
    expect(r.error).toBe(M1);
    expect(MLApiService.suggestCategoryId).not.toHaveBeenCalled();
  });

  it("C10b: título inválido + 147 na mesma categoria → terminal (ramo antes do de título)", async () => {
    process.env.ML_REQUIRED_ATTRS_BLOCK = "1";
    (MLApiService.createItem as any)
      .mockRejectedValueOnce(
        erroMl("body.invalid_fields [title]", [
          { code: "body.invalid_fields", message: "invalid_fields title" },
        ]),
      )
      .mockRejectedValue(erro147());
    const r = await criar();
    expect(r.terminal).toBe(true);
    expect(gravacoesTerminais()).toHaveLength(1);
  });

  it("C11: condition.invalid junto com 147 na 1ª tentativa → o desvio de categoria não roda", async () => {
    process.env.ML_REQUIRED_ATTRS_BLOCK = "1";
    (MLApiService.createItem as any).mockRejectedValue(
      erroMl("condition invalid", [
        { code: "item.condition.invalid", message: "condition" },
        causa147(),
      ]),
    );
    const r = await criar();
    expect(MLApiService.suggestCategoryId).not.toHaveBeenCalled();
    expect(MLApiService.createItem).toHaveBeenCalledTimes(1);
    expect(r.terminal).toBe(true);
  });

  it("C11 (controle): sem a flag, o desvio por condition.invalid roda como hoje", async () => {
    (MLApiService.createItem as any).mockRejectedValue(
      erroMl("condition invalid", [
        { code: "item.condition.invalid", message: "condition" },
        causa147(),
      ]),
    );
    await criar();
    expect(MLApiService.suggestCategoryId).toHaveBeenCalled();
  });

  const tituloRecusado = () =>
    erroMl("Validation error: body.invalid_fields [title]", [
      { code: "body.invalid_fields", message: "invalid_fields [title]" },
    ]);

  it("C12: erro de título sem 147 → escada e categoria sugerida iguais às de hoje", async () => {
    const rodar = async () => {
      vi.clearAllMocks();
      (MarketplaceRepository.findByIdAndUser as any).mockResolvedValue(ACCOUNT);
      (ListingRepository.findLiveByProductAndAccount as any).mockResolvedValue(null);
      (ListingRepository.findByProductAndAccount as any).mockResolvedValue(null);
      (ListingRepository.createListing as any).mockImplementation(async (d: any) => ({
        id: "l-novo",
        ...d,
      }));
      (MLApiService.suggestCategoryId as any).mockResolvedValue("MLB999");
      (MLApiService.createItem as any).mockRejectedValue(tituloRecusado());
      const r = await criar();
      return {
        r,
        creates: (MLApiService.createItem as any).mock.calls.length,
        sugestoes: (MLApiService.suggestCategoryId as any).mock.calls.length,
        updates: (ListingRepository.updateListing as any).mock.calls.map(
          (c: any[]) => c[1],
        ),
      };
    };
    delete process.env.ML_REQUIRED_ATTRS_BLOCK;
    const hoje = await rodar();
    process.env.ML_REQUIRED_ATTRS_BLOCK = "1";
    const comFlag = await rodar();
    expect(hoje.sugestoes).toBeGreaterThan(0);
    expect(comFlag.creates).toBe(hoje.creates);
    expect(comFlag.sugestoes).toBe(hoje.sugestoes);
    expect(comFlag.r.error).toBe(hoje.r.error);
    expect(comFlag.r.terminal).toBeUndefined();
    const retry = comFlag.updates.find((u: any) => u.retryEnabled === true);
    expect(retry).toBeTruthy();
  });

  it("C13: flag ausente + 147 → categoria sugerida é tentada (hoje)", async () => {
    (MLApiService.createItem as any).mockRejectedValue(erro147());
    const r = await criar();
    expect(MLApiService.suggestCategoryId).toHaveBeenCalled();
    expect(r.terminal).toBeUndefined();
    expect(gravacoesTerminaisDeObrigatorio()).toEqual([]);
    // Mudança intencional (PR-2, 22/09/2026): 147 na categoria PEDIDA, com o
    // catálogo disponível, é recusa de dado — não retenta às cegas; a edição
    // do produto re-arma. Antes reagendava 5x o mesmo corpo recusado.
    expect(gravouCorrigivel()).toBe(true);
  });

  it("C14: republicação (PENDING_REPUBLISH_) + 147 → sem gravação terminal, retorno success false", async () => {
    process.env.ML_REQUIRED_ATTRS_BLOCK = "1";
    (ListingRepository.findByProductAndAccount as any).mockResolvedValue({
      id: "l-rep",
      externalListingId: "PENDING_REPUBLISH_9",
    });
    (MLApiService.createItem as any).mockRejectedValue(erro147());
    const r = await criar();
    expect(r.success).toBe(false);
    expect(r.terminal).toBe(true);
    expect(gravacoesTerminais()).toEqual([]);
  });

  it("D1(a): 1ª tentativa sem 147 (timeout) e 147 SÓ na categoria sugerida → NÃO terminal, retry e mensagem de hoje", async () => {
    const rodar = async () => {
      vi.clearAllMocks();
      (MarketplaceRepository.findByIdAndUser as any).mockResolvedValue(ACCOUNT);
      (ListingRepository.findLiveByProductAndAccount as any).mockResolvedValue(null);
      (ListingRepository.findByProductAndAccount as any).mockResolvedValue(null);
      (ListingRepository.createListing as any).mockImplementation(async (d: any) => ({
        id: "l-novo",
        ...d,
      }));
      (MLApiService.suggestCategoryId as any).mockResolvedValue("MLB999");
      (MLApiService.createItem as any).mockImplementation(async (_t: string, p: any) => {
        if (p.category_id === "MLB999") throw erro147("MLB999");
        throw new Error("ML createItem timeout after 15000ms");
      });
      const r = await criar();
      return {
        r,
        updates: (ListingRepository.updateListing as any).mock.calls.map(
          (c: any[]) => c[1],
        ),
      };
    };
    delete process.env.ML_REQUIRED_ATTRS_BLOCK;
    const hoje = await rodar();
    process.env.ML_REQUIRED_ATTRS_BLOCK = "1";
    const comFlag = await rodar();

    expect(comFlag.r.terminal).toBeUndefined();
    expect(comFlag.r.error).toBe(hoje.r.error);
    expect(gravacoesTerminais()).toEqual([]);
    const generico = comFlag.updates.find((u: any) => u.status === "error");
    expect(generico).toMatchObject({ retryEnabled: true });
    expect(generico.requestedCategoryId).toBe("MLB46723");
  });

  it("D1(a'): 147 da sugerida SEM categoria citada também não conta (só tentativas da mesma categoria)", async () => {
    process.env.ML_REQUIRED_ATTRS_BLOCK = "1";
    (MLApiService.suggestCategoryId as any).mockResolvedValue("MLB999");
    (MLApiService.createItem as any).mockImplementation(async (_t: string, p: any) => {
      if (p.category_id === "MLB999") {
        throw erroMl("missing", [
          {
            cause_id: 147,
            code: "item.attributes.missing_required",
            message: "The attributes [PART_NUMBER] are required",
          },
        ]);
      }
      throw new Error("timeout");
    });
    const r = await criar();
    expect(r.terminal).toBeUndefined();
    expect(gravacoesTerminais()).toEqual([]);
  });

  it("D1(b): título inválido na categoria A + 147 só na categoria B → reagenda como hoje", async () => {
    process.env.ML_REQUIRED_ATTRS_BLOCK = "1";
    (MLApiService.suggestCategoryId as any).mockResolvedValue("MLB999");
    (MLApiService.createItem as any).mockImplementation(async (_t: string, p: any) => {
      if (p.category_id === "MLB999") throw erro147("MLB999");
      throw tituloRecusado();
    });
    const r = await criar();
    expect(r.terminal).toBeUndefined();
    expect(r.error).toBe(
      "Mercado Livre rejeitou o título informado. Ajuste o título e tente novamente.",
    );
    expect(ListingRepository.updateListing).toHaveBeenCalledWith(
      "l-novo",
      expect.objectContaining({ retryEnabled: true, requestedCategoryId: "MLB46723" }),
    );
    expect(gravacoesTerminais()).toEqual([]);
  });

  // ── D1: as quatro retentativas que MANTÊM a categoria pedida contam ──
  // (family_name e título seguro estão em C10/C10b; aqui sem título e o
  // fallback dinâmico sem título.)

  it("D1(c): categoria da allowlist sem título (MLB22693) — 1ª tentativa sem 147 e a retentativa SEM TÍTULO responde 147 → terminal", async () => {
    process.env.ML_REQUIRED_ATTRS_BLOCK = "1";
    (MLApiService.createItem as any)
      .mockRejectedValueOnce(erroMl("Internal error", [], 500))
      .mockRejectedValue(erro147("MLB22693"));
    const r = await ListingUseCase.createMLListing(
      "user-1",
      "prod-1",
      "MLB22693",
      "acct-1",
    );
    const chamadas = (MLApiService.createItem as any).mock.calls;
    expect(chamadas).toHaveLength(2);
    // A 2ª é a retentativa sem título, na MESMA categoria.
    expect(chamadas[1][1].category_id).toBe("MLB22693");
    expect(chamadas[1][1].title).toBeUndefined();
    expect(r).toMatchObject({ success: false, terminal: true, error: M1 });
    expect(MLApiService.suggestCategoryId).not.toHaveBeenCalled();
    expect(gravacoesTerminais()).toHaveLength(1);
  });

  it("D1(d): fora da allowlist com family_name explícito — título recusado duas vezes e o fallback DINÂMICO sem título responde 147 → terminal", async () => {
    process.env.ML_REQUIRED_ATTRS_BLOCK = "1";
    produto = { ...baseProduct(), attributes: { familyName: "Sensor de rotação" } };
    (MLApiService.createItem as any)
      .mockRejectedValueOnce(tituloRecusado())
      .mockRejectedValueOnce(tituloRecusado())
      .mockRejectedValue(erro147());
    const r = await criar();
    const chamadas = (MLApiService.createItem as any).mock.calls;
    expect(chamadas).toHaveLength(3);
    // 2ª = título seguro (com título); 3ª = dinâmico sem título, mesma categoria.
    expect(chamadas[1][1].title).toBeTruthy();
    expect(chamadas[2][1].title).toBeUndefined();
    expect(chamadas[2][1].category_id).toBe("MLB46723");
    expect(r).toMatchObject({ success: false, terminal: true, error: M1 });
    expect(MLApiService.suggestCategoryId).not.toHaveBeenCalled();
  });

  // ── D1: as tentativas em OUTRA categoria NÃO contam (147 sem categoria citada) ──

  const causa147SemCategoria = () =>
    erroMl("missing", [
      {
        cause_id: 147,
        code: "item.attributes.missing_required",
        message: "The attributes [PART_NUMBER] are required",
      },
    ]);

  it("D1(e): condition.invalid sem 147 e 147 só no DESVIO para a sugerida → não terminal, reagenda", async () => {
    process.env.ML_REQUIRED_ATTRS_BLOCK = "1";
    (MLApiService.suggestCategoryId as any).mockResolvedValue("MLB999");
    (MLApiService.createItem as any).mockImplementation(async (_t: string, p: any) => {
      if (p.category_id === "MLB999") throw causa147SemCategoria();
      throw erroMl("condition invalid", [
        { code: "item.condition.invalid", message: "condition" },
      ]);
    });
    const r = await criar();
    // O desvio por condition.invalid rodou (é ele que o teste exercita).
    expect(
      (MLApiService.createItem as any).mock.calls.some(
        (c: any[]) => c[1].category_id === "MLB999",
      ),
    ).toBe(true);
    expect(r.terminal).toBeUndefined();
    // O 147 da SUGERIDA continua não virando terminal de campo obrigatório.
    expect(gravacoesTerminaisDeObrigatorio()).toEqual([]);
    // Mudança intencional (PR-2, 22/09/2026): a categoria PEDIDA recusou a
    // condição (400) — recusa de dado, terminal corrigível (a edição re-arma),
    // em vez de reagendar o mesmo corpo.
    expect(gravouCorrigivel()).toBe(true);
  });

  it("D1(f): category_id.invalid e 147 só na FOLHA re-resolvida → não terminal, reagenda", async () => {
    process.env.ML_REQUIRED_ATTRS_BLOCK = "1";
    (CategoryResolutionService.resolveMLCategory as any).mockImplementation(
      async ({ explicitCategoryId, validateWithMLAPI }: any) => ({
        externalId: validateWithMLAPI ? "MLB888" : explicitCategoryId || "MLB46723",
        fullPath: "x",
        source: "explicit",
      }),
    );
    (MLApiService.createItem as any).mockImplementation(async (_t: string, p: any) => {
      if (p.category_id === "MLB888") throw causa147SemCategoria();
      throw erroMl("category invalid", [
        { code: "item.category_id.invalid", message: "category" },
      ]);
    });
    const r = await criar();
    expect(
      (MLApiService.createItem as any).mock.calls.some(
        (c: any[]) => c[1].category_id === "MLB888",
      ),
    ).toBe(true);
    expect(r.terminal).toBeUndefined();
    // O 147 da FOLHA re-resolvida continua não virando terminal de obrigatório.
    expect(gravacoesTerminaisDeObrigatorio()).toEqual([]);
    // Mudança intencional (PR-2, 22/09/2026): a categoria PEDIDA foi recusada
    // (category_id.invalid, 400) — recusa de dado, terminal corrigível.
    expect(gravouCorrigivel()).toBe(true);
  });

  it("D1(g): sugerida pede family_name e o 147 vem só da retentativa sugerida+family → não terminal, reagenda", async () => {
    process.env.ML_REQUIRED_ATTRS_BLOCK = "1";
    (MLApiService.suggestCategoryId as any).mockResolvedValue("MLB999");
    (MLApiService.createItem as any).mockImplementation(async (_t: string, p: any) => {
      if (p.category_id === "MLB999") {
        if (p.title) {
          throw erroMl("body.required_fields [family_name]", [
            {
              cause_id: 369,
              code: "body.required_fields",
              message:
                "The body does not contains some or none of the following properties [family_name]",
            },
          ]);
        }
        throw causa147SemCategoria();
      }
      throw new Error("ML createItem timeout after 15000ms");
    });
    const r = await criar();
    const naSugerida = (MLApiService.createItem as any).mock.calls.filter(
      (c: any[]) => c[1].category_id === "MLB999",
    );
    // innerErr (family_name) e innerErr2 (147): os dois passos rodaram.
    expect(naSugerida).toHaveLength(2);
    expect(naSugerida[1][1].title).toBeUndefined();
    expect(r.terminal).toBeUndefined();
    expect(gravacoesTerminais()).toEqual([]);
    expect(ListingRepository.updateListing).toHaveBeenCalledWith(
      "l-novo",
      expect.objectContaining({ retryEnabled: true }),
    );
  });

  it("decisão 3: com a flag LIGADA, condition.invalid sem 147 segue o desvio como hoje", async () => {
    const rodar = async () => {
      vi.clearAllMocks();
      (MarketplaceRepository.findByIdAndUser as any).mockResolvedValue(ACCOUNT);
      (ListingRepository.findLiveByProductAndAccount as any).mockResolvedValue(null);
      (ListingRepository.findByProductAndAccount as any).mockResolvedValue(null);
      (ListingRepository.createListing as any).mockImplementation(async (d: any) => ({
        id: "l-novo",
        ...d,
      }));
      (MLApiService.suggestCategoryId as any).mockResolvedValue("MLB999");
      (MLApiService.createItem as any).mockImplementation(async (_t: string, p: any) => {
        if (p.category_id === "MLB999") throw erroMl("Internal error", [], 500);
        throw erroMl("condition invalid", [
          { code: "item.condition.invalid", message: "condition" },
        ]);
      });
      const r = await criar();
      return {
        r,
        categorias: (MLApiService.createItem as any).mock.calls.map(
          (c: any[]) => c[1].category_id,
        ),
        sugestoes: (MLApiService.suggestCategoryId as any).mock.calls.length,
      };
    };
    delete process.env.ML_REQUIRED_ATTRS_BLOCK;
    const hoje = await rodar();
    process.env.ML_REQUIRED_ATTRS_BLOCK = "1";
    const comFlag = await rodar();
    // Hoje: 1ª tentativa, desvio por condition (sugerida) e fallback final (sugerida).
    expect(hoje.categorias).toEqual(["MLB46723", "MLB999", "MLB999"]);
    expect(comFlag.categorias).toEqual(hoje.categorias);
    expect(comFlag.sugestoes).toBe(hoje.sugestoes);
    expect(comFlag.r.error).toBe(hoje.r.error);
    expect(comFlag.r.terminal).toBeUndefined();
  });

  it("D1: 147 que cita OUTRA categoria na 1ª tentativa não conta", async () => {
    process.env.ML_REQUIRED_ATTRS_BLOCK = "1";
    (MLApiService.createItem as any).mockRejectedValue(erro147("MLB7777"));
    const r = await criar();
    expect(r.terminal).toBeUndefined();
    expect(MLApiService.suggestCategoryId).toHaveBeenCalled();
  });

  it("147 sem ids legíveis → mensagem genérica M10", async () => {
    process.env.ML_REQUIRED_ATTRS_BLOCK = "1";
    (MLApiService.createItem as any).mockRejectedValue(
      erroMl("missing required", [
        { cause_id: 147, code: "item.attributes.missing_required", message: "x" },
      ]),
    );
    const r = await criar();
    expect(r.terminal).toBe(true);
    expect(r.error).toBe(
      "Esta categoria do Mercado Livre exige campos obrigatórios que não foram preenchidos. Confira a ficha técnica do produto antes de publicar o anúncio.",
    );
  });
});

describe("ficha da Revisão individual (D2/D6)", () => {
  const SIDE_OVERRIDE = { value_id: "183554", value_name: "Dianteiro" };

  beforeEach(() => {
    (MLAttributeCatalogService.getAll as any).mockImplementation(async () =>
      catalogo("MLB431271"),
    );
    produto = { ...baseProduct(), partNumber: "PN-1" };
  });

  it("D2: SIDE só no override → entra no createItem, fica guardado no placeholder e a falha 5xx NÃO é terminal", async () => {
    process.env.ML_REQUIRED_ATTRS_BLOCK = "1";
    const r = await criar({ SIDE: SIDE_OVERRIDE, GTIN: { value_name: "789" } });
    expect(r.terminal).toBeUndefined();
    const placeholder = (ListingRepository.createListing as any).mock.calls[0][0];
    expect(placeholder.attributesOverride).toEqual({ SIDE: SIDE_OVERRIDE });
    const payload = (MLApiService.createItem as any).mock.calls[0][1];
    const ids = payload.attributes.map((a: any) => a.id);
    expect(ids).toContain("SIDE");
    // D6: GTIN (hidden) fica para o update pós-criação.
    expect(ids).not.toContain("GTIN");
    expect(ListingRepository.updateListing).toHaveBeenCalledWith(
      "l-novo",
      expect.objectContaining({ retryEnabled: true }),
    );
  });

  it("D2: retentativa do cron com a ficha guardada → linha PENDING_ reaproveitada funde a ficha e o SIDE chega ao POST", async () => {
    process.env.ML_REQUIRED_ATTRS_BLOCK = "1";
    (ListingRepository.findByProductAndAccount as any).mockResolvedValue({
      id: "l-pend",
      externalListingId: "PENDING_1",
      // Linha do CRON: retry ligado (o cron só pega essas; a criação não a reserva).
      retryEnabled: true,
      attributesOverride: { SIDE: SIDE_OVERRIDE, COLOR: { value_name: "Preto" } },
    });
    const r = await ListingUseCase.createMLListing(
      "user-1",
      "prod-1",
      "MLB46723",
      "acct-1",
      undefined,
      undefined,
      undefined,
      { SIDE: SIDE_OVERRIDE, COLOR: { value_name: "Preto" } },
    );
    expect(r.terminal).toBeUndefined();
    const payload = (MLApiService.createItem as any).mock.calls[0][1];
    expect(payload.attributes.find((a: any) => a.id === "SIDE")?.value_id).toBe("183554");
    const settings = (ListingRepository.updateListing as any).mock.calls.find(
      (c: any[]) => c[1]?.attributesOverride !== undefined,
    );
    expect(settings[1].attributesOverride).toEqual({
      SIDE: SIDE_OVERRIDE,
      COLOR: { value_name: "Preto" },
    });
  });

  it("D2: sem a SIDE no override, o mesmo produto é bloqueado com M2 antes do POST", async () => {
    process.env.ML_REQUIRED_ATTRS_BLOCK = "1";
    const r = await criar();
    expect(r.terminal).toBe(true);
    expect(r.error).toBe(
      "Esta categoria exige o lado da peça. Selecione Direito ou Esquerdo antes de publicar o anúncio.",
    );
  });

  it("D2 sem catálogo: 1ª tentativa com catálogo indisponível + 5xx guarda o SIDE no placeholder, e a retentativa com o catálogo de volta leva o SIDE ao POST", async () => {
    process.env.ML_REQUIRED_ATTRS_BLOCK = "1";
    (MLAttributeCatalogService.getAll as any).mockResolvedValue([]);
    const ficha = { SIDE: SIDE_OVERRIDE, BRANCO: { value_name: "  " } };
    const r1 = await criar(ficha);
    expect(r1.terminal).toBeUndefined();
    // Sem catálogo a criação segue só-OEM (O6): o SIDE não vai ao POST…
    const payload1 = (MLApiService.createItem as any).mock.calls[0][1];
    expect(payload1.attributes.map((a: any) => a.id)).not.toContain("SIDE");
    // …mas fica guardado para a retentativa (entradas em branco não).
    const placeholder = (ListingRepository.createListing as any).mock.calls[0][0];
    expect(placeholder.attributesOverride).toEqual({ SIDE: SIDE_OVERRIDE });

    // Cron: mesma linha, ficha guardada, catálogo de volta.
    vi.mocked(MLApiService.createItem).mockClear();
    (MLAttributeCatalogService.getAll as any).mockImplementation(async () =>
      catalogo("MLB431271"),
    );
    (ListingRepository.findByProductAndAccount as any).mockResolvedValue({
      id: "l-novo",
      externalListingId: "PENDING_1",
      // Linha do CRON: retry ligado (o cron só pega essas; a criação não a reserva).
      retryEnabled: true,
      attributesOverride: placeholder.attributesOverride,
    });
    const r2 = await ListingUseCase.createMLListing(
      "user-1",
      "prod-1",
      "MLB46723",
      "acct-1",
      undefined,
      undefined,
      undefined,
      placeholder.attributesOverride,
    );
    expect(r2.terminal).toBeUndefined();
    const payload2 = (MLApiService.createItem as any).mock.calls[0][1];
    expect(payload2.attributes.find((a: any) => a.id === "SIDE")?.value_id).toBe(
      "183554",
    );
  });

  it("D2 sem catálogo: ML cobra o SIDE (147) que o operador preencheu na revisão → NÃO terminal, reagenda sem trocar de categoria", async () => {
    process.env.ML_REQUIRED_ATTRS_BLOCK = "1";
    (MLAttributeCatalogService.getAll as any).mockResolvedValue([]);
    (MLApiService.suggestCategoryId as any).mockResolvedValue("MLB999");
    (MLApiService.createItem as any).mockRejectedValue(
      erroMl("missing SIDE", [causa147("MLB46723", "SIDE")]),
    );
    const r = await criar({ SIDE: SIDE_OVERRIDE });
    expect(r.terminal).toBeUndefined();
    expect(gravacoesTerminais()).toEqual([]);
    expect(MLApiService.suggestCategoryId).not.toHaveBeenCalled();
    expect(ListingRepository.updateListing).toHaveBeenCalledWith(
      "l-novo",
      expect.objectContaining({ retryEnabled: true }),
    );
  });

  it("D2 com catálogo (controle): o SIDE da ficha FOI ao POST e o ML ainda cobra → terminal (a exceção é só sem catálogo)", async () => {
    process.env.ML_REQUIRED_ATTRS_BLOCK = "1";
    (MLApiService.createItem as any).mockRejectedValue(
      erroMl("missing SIDE", [causa147("MLB46723", "SIDE")]),
    );
    const r = await criar({ SIDE: SIDE_OVERRIDE });
    const payload = (MLApiService.createItem as any).mock.calls[0][1];
    expect(payload.attributes.map((a: any) => a.id)).toContain("SIDE");
    expect(r.terminal).toBe(true);
    expect(MLApiService.suggestCategoryId).not.toHaveBeenCalled();
  });

  it("D2 sem catálogo (controle): 147 [SIDE] sem o lado na ficha → terminal com M2", async () => {
    process.env.ML_REQUIRED_ATTRS_BLOCK = "1";
    (MLAttributeCatalogService.getAll as any).mockResolvedValue([]);
    (MLApiService.createItem as any).mockRejectedValue(
      erroMl("missing SIDE", [causa147("MLB46723", "SIDE")]),
    );
    const r = await criar({ OUTRO: { value_name: "x" } });
    expect(r.terminal).toBe(true);
    expect(r.error).toBe(
      "Esta categoria exige o lado da peça. Selecione Direito ou Esquerdo antes de publicar o anúncio.",
    );
  });

  it("flag desligada: o placeholder NÃO ganha attributesOverride e o SIDE do override não vai ao POST", async () => {
    await criar({ SIDE: SIDE_OVERRIDE });
    const placeholder = (ListingRepository.createListing as any).mock.calls[0][0];
    expect(placeholder).not.toHaveProperty("attributesOverride");
    const payload = (MLApiService.createItem as any).mock.calls[0][1];
    expect(payload.attributes.map((a: any) => a.id)).not.toContain("SIDE");
  });
});
