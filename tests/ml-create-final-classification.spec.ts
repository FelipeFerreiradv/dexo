import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * createMLListing — o que acontece quando a escada esgota (PR-2, 22/09/2026).
 *
 * Antes: a mensagem era o JSON da 1ª tentativa (em conta "User Products",
 * sempre `family_name`), todo erro reagendava 5x o mesmo corpo, e um timeout
 * podia ter criado o item no ML sem ninguém conferir.
 *
 * Harness copiado de tests/ml-required-attrs-create.spec.ts.
 */

vi.mock("../app/marketplaces/repositories/listing.repository", () => ({
  ListingRepository: {
    findLiveByProductAndAccount: vi.fn(),
    findByProductAndAccount: vi.fn(),
    updateListing: vi.fn(),
    createListing: vi.fn(),
    findRetryStateById: vi.fn(),
    updateCompatDiagnostics: vi.fn(),
    claimInteractiveRetry: vi.fn(),
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
import { CategoryResolutionService } from "../app/marketplaces/services/category-resolution.service";
import { SystemLogService } from "../app/services/system-log.service";
import {
  MLAttributeCatalogService,
  normalizeMLCategoryAttribute,
} from "../app/marketplaces/services/ml-attribute-catalog.service";

const FIXTURES = path.resolve(__dirname, "fixtures", "ml-category-attributes");
const catalogo = (id: string) =>
  (
    JSON.parse(fs.readFileSync(path.join(FIXTURES, `${id}.raw.json`), "utf8"))
      .attributes as any[]
  ).map((a) => normalizeMLCategoryAttribute(a));

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

const erroMl = (message: string, cause: any[], status = 400) => {
  const e: any = new Error(`Erro ao criar item: ${JSON.stringify({ message, cause, status })}`);
  e.mlError = { status, message, error: "validation_error", cause };
  e.mlHttpStatus = status;
  return e;
};

const FAMILY_369 = {
  department: "items",
  cause_id: 369,
  type: "error",
  code: "body.required_fields",
  message:
    "The body does not contains some or none of the following properties [family_name]",
};
const INMETRO_3702 = {
  department: "structured-data",
  cause_id: 3702,
  type: "error",
  code: "item.attribute.invalid_sanitary_registry_value",
  message:
    'O valor que você inseriu em "Número de registro/certificação INMETRO" está incorreto.',
};
const QR_422 = {
  cause_id: 422,
  type: "error",
  message:
    "Attribute REGULATORY_INFORMATION_QR_CODE of type picture has an invalid picture ID (1)",
};
const VEHICLE_TYPE_3510 = {
  cause_id: 3510,
  type: "error",
  code: "invalid.item.attribute.values",
  message:
    "Attribute [VEHICLE_TYPE] is not valid, item values [(11377043:Carro/Caminhonete)]",
};

/**
 * Conta "User Products": sem family_name ⇒ 369. Com family_name ⇒ `comFamily`.
 * Categoria sugerida (MLB999) ⇒ `naSugerida` quando definido.
 */
function mlResponde(comFamily: () => never, naSugerida?: () => never) {
  (MLApiService.createItem as any).mockImplementation(async (_t: string, p: any) => {
    if (naSugerida && p.category_id === "MLB999") naSugerida();
    if (!p.family_name) throw erroMl("body.required_fields", [FAMILY_369]);
    comFamily();
  });
}

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

/** Última gravação de erro na linha. */
const gravacaoFinal = () => {
  const calls = (ListingRepository.updateListing as any).mock.calls.filter(
    (c: any[]) => c[1]?.status === "error",
  );
  return calls[calls.length - 1]?.[1];
};

let produto: any;

beforeEach(async () => {
  vi.clearAllMocks();
  delete process.env.ML_REQUIRED_ATTRS_BLOCK;
  delete process.env.LISTING_PREFLIGHT;
  delete process.env.ML_CATALOG_LISTING_ENABLED;
  for (const m of ["log", "warn", "error", "debug", "info"] as const) {
    vi.spyOn(console, m).mockImplementation(() => {});
  }
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
  (MLAttributeCatalogService.getAll as any).mockImplementation(async (id: string) =>
    id === "MLB46723" ? catalogo("MLB46723") : [],
  );
  (MLApiService.suggestCategoryId as any).mockResolvedValue(null);
  produto = {
    id: "prod-1",
    sku: "SKU-1",
    name: "Sensor Medidor Fluxo Ar Tiida",
    brand: "Nissan",
    price: 199,
    stock: 1,
    imageUrl: "/uploads/x.jpg",
    imageUrls: [],
    heightCm: 20,
    widthCm: 20,
    lengthCm: 40,
    weightKg: 1,
    mlCategoryId: "cat-interna-1",
  };
  const repo: any = await import("../app/repositories/product.repository");
  repo.__findById.mockImplementation(async () => ({ ...produto }));
  vi.spyOn(ListingUseCase as any, "collectProductImageUrls").mockReturnValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("family_name mascarando a causa real (caso da cliente, 22/09)", () => {
  it("retentativa com family_name recusada por INMETRO ⇒ mensagem do INMETRO, terminal corrigível", async () => {
    mlResponde(() => {
      throw erroMl("Validation error", [INMETRO_3702]);
    });
    const r = await criar();
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/INMETRO/);
    expect(r.error).not.toMatch(/family_name|\{/);
    expect(r.errorKind).toBe("VALIDATION");
    expect(r.lastErrorMarker).toBe("[TERMINAL][CORRIGIVEL]");
    const g = gravacaoFinal();
    expect(g.lastError.startsWith("[TERMINAL][CORRIGIVEL] ")).toBe(true);
    expect(g.lastError).toMatch(/INMETRO/);
    expect(g.retryEnabled).toBe(false);
    expect(g.nextRetryAt).toBeNull();
  });

  it("causa da categoria SUGERIDA não mascara a da pedida (QR code × VEHICLE_TYPE)", async () => {
    (MLApiService.suggestCategoryId as any).mockResolvedValue("MLB999");
    mlResponde(
      () => {
        throw erroMl("Validation error", [QR_422]);
      },
      () => {
        throw erroMl("Validation error", [VEHICLE_TYPE_3510]);
      },
    );
    const r = await criar();
    expect(r.error).toMatch(/REGULATORY_INFORMATION_QR_CODE/);
    expect(r.error).not.toMatch(/VEHICLE_TYPE/);
  });

  it("nenhuma causa reconhecida ⇒ frase humana com a mensagem do ML, nunca JSON", async () => {
    mlResponde(() => {
      throw erroMl("Validation error", [
        { cause_id: 9999, type: "error", message: "Something odd" },
      ]);
    });
    const r = await criar();
    expect(r.error).toMatch(/Something odd \(código 9999\)/);
    expect(r.error).not.toMatch(/[{}]/);
  });
});

describe("falhas que NÃO são de dado", () => {
  it("timeout na retentativa ⇒ [VERIFICAR], retry agendado (pode ter criado no ML)", async () => {
    mlResponde(() => {
      throw new Error("Timeout (ML createItem family_name) after 15000ms");
    });
    const r = await criar();
    expect(r.errorKind).toBe("UNKNOWN");
    expect(r.lastErrorMarker).toBe("[VERIFICAR]");
    expect(r.error).toMatch(/confere se o anúncio chegou a ser criado/);
    const g = gravacaoFinal();
    expect(g.lastError.startsWith("[VERIFICAR] ")).toBe(true);
    expect(g.retryEnabled).toBe(true);
    expect(g.nextRetryAt).toBeInstanceOf(Date);
  });

  it("5xx ⇒ [VERIFICAR], retry agendado", async () => {
    mlResponde(() => {
      throw erroMl("Internal error", [], 503);
    });
    const r = await criar();
    expect(r.errorKind).toBe("TRANSIENT");
    expect(r.lastErrorMarker).toBe("[VERIFICAR]");
    expect(gravacaoFinal().retryEnabled).toBe(true);
  });

  it("429 ⇒ sem marcador, retry agendado", async () => {
    mlResponde(() => {
      throw erroMl("too many requests", [], 429);
    });
    const r = await criar();
    expect(r.errorKind).toBe("RATE_LIMIT");
    expect(r.lastErrorMarker).toBeUndefined();
    const g = gravacaoFinal();
    expect(g.lastError).toMatch(/limitou/);
    expect(g.lastError.startsWith("[")).toBe(false);
    expect(g.retryEnabled).toBe(true);
  });

  // Mudança intencional (revisão de 23/09/2026): 401 de token vencido no meio
  // da publicação volta a REAGENDAR (o retry renova o token e publica), como
  // antes do erro estruturado. Só a recusa de PERMISSÃO (403/PolicyAgent)
  // pede reconexão e para o retry.
  it("401 (token vencido) ⇒ sem marcador, retry agendado", async () => {
    mlResponde(() => {
      throw erroMl("invalid access token", [], 401);
    });
    const r = await criar();
    expect(r.errorKind).toBe("AUTH");
    expect(r.lastErrorMarker).toBeUndefined();
    expect(r.error).toMatch(/"LOJA".*expirou/);
    const g = gravacaoFinal();
    expect(g.lastError.startsWith("[")).toBe(false);
    expect(g.retryEnabled).toBe(true);
  });

  it("403 PolicyAgent ⇒ [TERMINAL][RECONECTAR], sem retry", async () => {
    mlResponde(() => {
      throw erroMl("PolicyAgent: PA_UNAUTHORIZED_RESULT_FROM_POLICIES", [], 403);
    });
    const r = await criar();
    expect(r.errorKind).toBe("AUTH");
    expect(r.error).toMatch(/"LOJA".*reconectada/);
    const g = gravacaoFinal();
    expect(g.lastError.startsWith("[TERMINAL][RECONECTAR] ")).toBe(true);
    expect(g.retryEnabled).toBe(false);
  });

  it("conexão caída (ECONNRESET) numa tentativa e recusa por dado na última ⇒ [VERIFICAR] (pode ter criado)", async () => {
    let n = 0;
    (MLApiService.createItem as any).mockImplementation(async () => {
      n += 1;
      if (n === 1) {
        const e: any = new Error("socket hang up");
        e.code = "ECONNRESET";
        throw e;
      }
      throw erroMl("Validation error", [INMETRO_3702]);
    });
    const r = await criar();
    expect(r.lastErrorMarker).toBe("[VERIFICAR]");
    const g = gravacaoFinal();
    expect(g.lastError.startsWith("[VERIFICAR] ")).toBe(true);
    expect(g.retryEnabled).toBe(true);
  });

  it("ML_ERROR_DETAIL_DISABLED=1 sem causa reconhecida ⇒ texto cru do ML, como em main", async () => {
    process.env.ML_ERROR_DETAIL_DISABLED = "1";
    try {
      mlResponde(() => {
        throw erroMl("Validation error", [
          { cause_id: 9999, type: "error", message: "Something odd" },
        ]);
      });
      const r = await criar();
      expect(r.error).toMatch(/^Erro ao criar item: /);
    } finally {
      delete process.env.ML_ERROR_DETAIL_DISABLED;
    }
  });

  it("ML_ERROR_CLASSIFICATION_DISABLED=1 ⇒ recusa por dado volta a reagendar (comportamento anterior)", async () => {
    process.env.ML_ERROR_CLASSIFICATION_DISABLED = "1";
    try {
      mlResponde(() => {
        throw erroMl("Validation error", [INMETRO_3702]);
      });
      const r = await criar();
      expect(r.lastErrorMarker).toBeUndefined();
      const g = gravacaoFinal();
      expect(g.lastError.startsWith("[")).toBe(false);
      expect(g.retryEnabled).toBe(true);
    } finally {
      delete process.env.ML_ERROR_CLASSIFICATION_DISABLED;
    }
  });
});

describe("salvaguardas", () => {
  it("catálogo de atributos indisponível ⇒ recusa por dado NÃO é terminal (corpo incompleto por nossa causa)", async () => {
    (MLAttributeCatalogService.getAll as any).mockResolvedValue([]);
    mlResponde(() => {
      throw erroMl("Validation error", [INMETRO_3702]);
    });
    const r = await criar();
    expect(r.lastErrorMarker).toBeUndefined();
    const g = gravacaoFinal();
    expect(g.retryEnabled).toBe(true);
    expect(g.lastError.startsWith("[TERMINAL]")).toBe(false);
  });

  it("republicação (PENDING_REPUBLISH_) ⇒ sem marcador na linha (o sync reverte para o anúncio vivo)", async () => {
    (ListingRepository.findByProductAndAccount as any).mockResolvedValue({
      id: "l-rep",
      externalListingId: "PENDING_REPUBLISH_MLB1_1",
    });
    mlResponde(() => {
      throw erroMl("Validation error", [INMETRO_3702]);
    });
    const r = await criar();
    expect(r.lastErrorMarker).toBeUndefined();
    const g = gravacaoFinal();
    expect(g.lastError.startsWith("[")).toBe(false);
    expect(g.retryEnabled).toBe(true);
  });

  it("linha REAPROVEITADA com id real (anúncio encerrado) ⇒ sem marcador, reagenda como antes", async () => {
    (ListingRepository.findByProductAndAccount as any).mockResolvedValue({
      id: "l-velha",
      externalListingId: "MLB_ENCERRADO",
      status: "closed",
    });
    mlResponde(() => {
      throw erroMl("Validation error", [INMETRO_3702]);
    });
    const r = await criar();
    expect(r.lastErrorMarker).toBeUndefined();
    const g = gravacaoFinal();
    expect(g.lastError.startsWith("[")).toBe(false);
    expect(g.retryEnabled).toBe(true);
  });

  it("registra o resultado estruturado no SystemLog (sem token)", async () => {
    mlResponde(() => {
      throw erroMl("Validation error", [INMETRO_3702]);
    });
    await criar();
    const call = (SystemLogService.logError as any).mock.calls.find(
      (c: any[]) => c[2]?.details?.event === "ml.publish.failed",
    );
    expect(call).toBeTruthy();
    expect(call[0]).toBe("CREATE_LISTING");
    expect(call[2].details).toMatchObject({
      provider: "mercadolivre",
      operation: "create_item",
      kind: "VALIDATION",
      requestedCategoryId: "MLB46723",
      causeIds: [3702],
    });
    expect(JSON.stringify(call[2])).not.toMatch(/tok\b|Bearer|refresh/);
  });

  it("log falhando (serviço lança) não derruba a gravação do erro", async () => {
    (SystemLogService.logError as any).mockImplementation(() => {
      throw new Error("banco de logs fora");
    });
    mlResponde(() => {
      throw erroMl("Validation error", [INMETRO_3702]);
    });
    const r = await criar();
    expect(r.error).toMatch(/INMETRO/);
    expect(gravacaoFinal().retryEnabled).toBe(false);
  });
});

describe("pendente reaproveitado com retry desligado: reserva antes de publicar (revisão 23/09, rodada 2)", () => {
  const RESERVA = new Date("2026-09-23T12:10:00.000Z");
  const pendente = (over: Record<string, unknown> = {}) => ({
    id: "l-pend",
    externalListingId: "PENDING_1",
    status: "error",
    retryEnabled: false,
    nextRetryAt: null,
    ...over,
  });
  const recusa = () =>
    mlResponde(() => {
      throw erroMl("Validation error", [INMETRO_3702]);
    });

  it("reserva a linha ANTES do POST e segue publicando", async () => {
    (ListingRepository.findByProductAndAccount as any).mockResolvedValue(pendente());
    (ListingRepository.claimInteractiveRetry as any).mockResolvedValue(RESERVA);
    recusa();
    await criar();
    expect(ListingRepository.claimInteractiveRetry).toHaveBeenCalledWith(
      "l-pend",
      10 * 60 * 1000,
    );
    const ordem = [
      (ListingRepository.claimInteractiveRetry as any).mock.invocationCallOrder[0],
      (MLApiService.createItem as any).mock.invocationCallOrder[0],
    ];
    expect(ordem[0]).toBeLessThan(ordem[1]);
  });

  it("linha reservada por OUTRO (botão, outro Anunciar, outro lote) ⇒ não manda POST; 'em andamento'", async () => {
    (ListingRepository.findByProductAndAccount as any).mockResolvedValue(
      pendente({ nextRetryAt: new Date(Date.now() + 5 * 60_000) }),
    );
    (ListingRepository.claimInteractiveRetry as any).mockResolvedValue(null);
    const r = await criar();
    expect(MLApiService.createItem).not.toHaveBeenCalled();
    expect(r.success).toBe(false);
    expect(r.skipped).toBe(true);
    expect(r.error).toMatch(/em andamento/);
    expect(ListingRepository.updateListing).not.toHaveBeenCalled();
  });

  it("a reserva é de QUEM CHAMOU (botão passa a dele) ⇒ não reserva de novo e publica", async () => {
    (ListingRepository.findByProductAndAccount as any).mockResolvedValue(
      pendente({ nextRetryAt: RESERVA }),
    );
    recusa();
    await ListingUseCase.createMLListing(
      "user-1",
      "prod-1",
      "MLB46723",
      "acct-1",
      undefined,
      undefined,
      "actor-1",
      undefined,
      { reservation: { listingId: "l-pend", at: new Date(RESERVA.getTime()) } },
    );
    expect(ListingRepository.claimInteractiveRetry).not.toHaveBeenCalled();
    expect(MLApiService.createItem).toHaveBeenCalled();
  });

  it("reserva de outra linha (ou de outro horário) não vale como passe", async () => {
    (ListingRepository.findByProductAndAccount as any).mockResolvedValue(
      pendente({ nextRetryAt: RESERVA }),
    );
    (ListingRepository.claimInteractiveRetry as any).mockResolvedValue(null);
    const r = await ListingUseCase.createMLListing(
      "user-1",
      "prod-1",
      "MLB46723",
      "acct-1",
      undefined,
      undefined,
      "actor-1",
      undefined,
      { reservation: { listingId: "OUTRA", at: RESERVA } },
    );
    expect(ListingRepository.claimInteractiveRetry).toHaveBeenCalled();
    expect(MLApiService.createItem).not.toHaveBeenCalled();
    expect(r.skipped).toBe(true);
  });

  it("linha do CRON (retry ligado) SEM a reserva dele ⇒ 'agendada', nada é enviado (Anunciar não corre junto com o cron)", async () => {
    (ListingRepository.findByProductAndAccount as any).mockResolvedValue(
      pendente({ retryEnabled: true, nextRetryAt: new Date(Date.now() + 60_000) }),
    );
    const r = await criar();
    expect(MLApiService.createItem).not.toHaveBeenCalled();
    expect(ListingRepository.claimInteractiveRetry).not.toHaveBeenCalled();
    expect(r.skipped).toBe(true);
    expect((r as any).code).toBe("PUBLICATION_IN_PROGRESS");
    expect(r.error).toMatch(/agendada/);
    expect(ListingRepository.updateListing).not.toHaveBeenCalled();
  });

  it("linha do CRON com a reserva DELE ⇒ publica (sem reservar de novo)", async () => {
    (ListingRepository.findByProductAndAccount as any).mockResolvedValue(
      pendente({ retryEnabled: true, nextRetryAt: RESERVA }),
    );
    recusa();
    await ListingUseCase.createMLListing(
      "user-1",
      "prod-1",
      "MLB46723",
      "acct-1",
      undefined,
      undefined,
      undefined,
      undefined,
      { reservation: { listingId: "l-pend", at: new Date(RESERVA.getTime()) } },
    );
    expect(ListingRepository.claimInteractiveRetry).not.toHaveBeenCalled();
    expect(MLApiService.createItem).toHaveBeenCalled();
  });

  it("republicação (PENDING_REPUBLISH_) ⇒ sem reserva (o sync tem a própria trava)", async () => {
    (ListingRepository.findByProductAndAccount as any).mockResolvedValue(
      pendente({ externalListingId: "PENDING_REPUBLISH_MLB1_1" }),
    );
    recusa();
    await criar();
    expect(ListingRepository.claimInteractiveRetry).not.toHaveBeenCalled();
    expect(MLApiService.createItem).toHaveBeenCalled();
  });

  it("1ª publicação: a linha NASCE reservada (segundo 'Anunciar' a vê em andamento)", async () => {
    recusa();
    const antes = Date.now();
    await criar();
    const criada = (ListingRepository.createListing as any).mock.calls[0][0];
    expect(criada.retryEnabled).toBe(false);
    expect(criada.nextRetryAt).toBeInstanceOf(Date);
    expect(criada.nextRetryAt.getTime()).toBeGreaterThanOrEqual(antes + 9 * 60_000);
  });

  it("1ª publicação com erro inesperado ⇒ a reserva da linha nova é desfeita", async () => {
    // Erro fora dos ramos tratados, logo depois de criar a linha.
    vi.spyOn(ListingUseCase as any, "sanitizePackageDimensions").mockImplementation(() => {
      throw new Error("inesperado");
    });
    const r = await criar();
    expect(r.success).toBe(false);
    const criada = (ListingRepository.createListing as any).mock.calls[0][0];
    expect(ListingRepository.releaseInteractiveRetry).toHaveBeenCalledWith(
      "l-novo",
      criada.nextRetryAt,
    );
  });

  it("a linha escolhida já é anúncio VIVO (outra criação terminou no meio desta) ⇒ recusa, sem POST", async () => {
    (ListingRepository.findByProductAndAccount as any).mockResolvedValue({
      id: "l-viva",
      externalListingId: "MLB777",
      status: "active",
    });
    const r = await criar();
    expect(MLApiService.createItem).not.toHaveBeenCalled();
    expect(r.skipped).toBe(true);
    expect(r.error).toMatch(/já tem anúncio/);
    expect(ListingRepository.updateListing).not.toHaveBeenCalled();
  });

  it("linha com id real ENCERRADA continua podendo ser republicada", async () => {
    (ListingRepository.findByProductAndAccount as any).mockResolvedValue({
      id: "l-velha",
      externalListingId: "MLB_ENCERRADO",
      status: "closed",
    });
    recusa();
    await criar();
    expect(MLApiService.createItem).toHaveBeenCalled();
  });

  it("erro inesperado depois de reservar ⇒ a reserva é desfeita (não fica 'Publicando agora')", async () => {
    (ListingRepository.findByProductAndAccount as any).mockResolvedValue(pendente());
    (ListingRepository.claimInteractiveRetry as any).mockResolvedValue(RESERVA);
    (ListingRepository.updateListing as any).mockRejectedValue(new Error("pool esgotado"));
    const r = await criar();
    expect(r.success).toBe(false);
    expect(ListingRepository.releaseInteractiveRetry).toHaveBeenCalledWith("l-pend", RESERVA);
  });

  it("fim normal (recusa do ML) grava o próprio agendamento por cima da reserva", async () => {
    (ListingRepository.findByProductAndAccount as any).mockResolvedValue(pendente());
    (ListingRepository.claimInteractiveRetry as any).mockResolvedValue(RESERVA);
    recusa();
    await criar();
    const g = gravacaoFinal();
    expect(g).toBeDefined();
    expect("nextRetryAt" in g).toBe(true);
    expect(g.nextRetryAt === null || g.nextRetryAt instanceof Date).toBe(true);
    expect(g.nextRetryAt).not.toEqual(RESERVA);
  });
});
