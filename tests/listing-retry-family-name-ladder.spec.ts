import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";
import { ListingRetryService } from "../app/marketplaces/services/listing-retry.service";
import { ListingRepository } from "../app/marketplaces/repositories/listing.repository";
import { MLApiService } from "../app/marketplaces/services/ml-api.service";
import { CategoryResolutionService } from "../app/marketplaces/services/category-resolution.service";

/**
 * Escada de retry do cron × escada do createMLListing.
 *
 * O cron tinha uma cópia ANTIGA da escada e repetia um erro que o fluxo
 * principal já havia resolvido:
 *
 *  1. Ao receber `body.required_fields [family_name]`, retentava com
 *     family_name MAS MANTINHA o title. Categorias que exigem family_name são
 *     fluxo User Product e rejeitam os dois juntos → `invalid_fields [title]`.
 *  2. `isTitleInvalid` era calculado só do erro ORIGINAL (family_name) e nunca
 *     atualizado, então os fallbacks de title eram pulados e a escada desistia
 *     sem usar as variantes que tem.
 *
 * Medido em produção (lote piloto de 25 reabilitados): 12 falharam por
 * family_name e 13 por title inválido — os dois sintomas do mesmo defeito.
 */

vi.mock("../app/marketplaces/repositories/listing.repository", () => ({
  ListingRepository: {
    findPendingRetries: vi.fn(),
    incrementRetryAttempts: vi.fn(),
    updateListing: vi.fn(),
  },
}));

vi.mock("../app/marketplaces/services/ml-api.service", () => ({
  MLApiService: {
    getSellerItemIds: vi.fn(),
    createItem: vi.fn(),
    updateItem: vi.fn(),
    getItemDetails: vi.fn(),
    uploadPicture: vi.fn(),
    uploadPictureFromUrl: vi.fn(),
    normalizeListingType: vi.fn((t?: string) => t || "bronze"),
  },
}));

vi.mock("../app/marketplaces/services/ml-oauth.service", () => ({
  MLOAuthService: { refreshAccessTokenForAccount: vi.fn() },
}));

vi.mock("../app/marketplaces/repositories/marketplace.repository", () => ({
  MarketplaceRepository: { updateTokens: vi.fn(), updateStatus: vi.fn() },
}));

vi.mock("../app/services/system-log.service", () => ({
  SystemLogService: { logError: vi.fn(), log: vi.fn() },
}));

vi.mock("../app/repositories/user.repository", () => ({
  UserRepositoryPrisma: vi.fn(() => ({ findById: vi.fn(async () => null) })),
}));

vi.mock("../app/marketplaces/services/category-resolution.service", () => ({
  CategoryResolutionService: {
    resolveMLCategory: vi.fn(),
    ensureLeafLocalOnly: vi.fn(),
    assertWithinVehicleRoot: vi.fn(),
    assertConditionCoherent: vi.fn(),
  },
}));

vi.mock("../app/repositories/product.repository", () => ({
  ProductRepositoryPrisma: vi.fn(() => ({})),
}));

vi.mock("../app/marketplaces/services/image-resize.service", () => ({
  ensureMLMinImageSize: vi.fn(),
}));

vi.mock("../app/marketplaces/services/listing-preflight.service", () => ({
  ListingPreflightService: {
    checkML: vi.fn(async (input: any) => ({
      ok: true,
      issues: [],
      enrichedAttributes: input.currentAttributes || [],
      missingRequired: [],
    })),
    formatBlockMessage: vi.fn(() => "block"),
  },
}));

const candidate = () =>
  ({
    id: "pl-ladder",
    externalListingId: "PENDING_1",
    status: "error",
    retryAttempts: 0,
    retryEnabled: true,
    nextRetryAt: new Date(Date.now() - 1000),
    requestedCategoryId: "MLB1744",
    productId: "prod-1",
    product: {
      id: "prod-1",
      sku: "SKU-1",
      name: "Farol Dianteiro Gol",
      description: "Farol",
      price: new Prisma.Decimal("629.00"),
      stock: 1,
      heightCm: 20,
      widthCm: 20,
      lengthCm: 30,
      weightKg: 2,
      imageUrl: null,
      imageUrls: [],
    },
    marketplaceAccount: {
      id: "acct-1",
      accountName: "LOJA",
      accessToken: "tok",
      refreshToken: "ref",
      expiresAt: new Date(Date.now() + 3600_000),
      platform: "MERCADO_LIVRE",
      userId: "user-1",
      externalUserId: "123",
    },
  }) as any;

const mlError = (message: string) => {
  const err: any = new Error(`Erro ao criar item: ${message}`);
  err.mlError = { message };
  return err;
};

const FAMILY_NAME_ERR = mlError(
  '{"cause":[{"cause_id":369,"code":"body.required_fields","message":"The body does not contains ... [family_name]"}]}',
);
const TITLE_INVALID_ERR = mlError(
  '{"message":"body.invalid_fields","error":"The fields [title] are invalid for requested call."}',
);

/** Payloads de cada chamada a createItem, na ordem. */
const payloads = () =>
  (MLApiService.createItem as any).mock.calls.map((c: any[]) => c[1]);

describe("ListingRetryService — escada family_name/title (paridade com createMLListing)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (ListingRepository.findPendingRetries as any).mockResolvedValue([
      candidate(),
    ]);
    (MLApiService.getSellerItemIds as any).mockResolvedValue([]);
    (CategoryResolutionService.resolveMLCategory as any).mockResolvedValue({
      externalId: "MLB1744",
      fullPath: "Acessórios > Faróis",
      source: "explicit",
    });
    (CategoryResolutionService.ensureLeafLocalOnly as any).mockResolvedValue({
      externalId: "MLB1744",
    });
    (CategoryResolutionService.assertWithinVehicleRoot as any).mockResolvedValue(
      { ok: true },
    );
    (CategoryResolutionService.assertConditionCoherent as any).mockResolvedValue(
      { ok: true },
    );
  });

  it("retenta com family_name SEM title (UP flow rejeita os dois juntos)", async () => {
    (MLApiService.createItem as any)
      .mockRejectedValueOnce(FAMILY_NAME_ERR) // 1ª: sem family_name
      .mockResolvedValueOnce({ id: "MLB999", permalink: "https://ml/MLB999" });
    (MLApiService.getItemDetails as any).mockResolvedValue({
      id: "MLB999",
      status: "active",
    });

    await ListingRetryService.runOnce();

    const calls = payloads();
    expect(calls.length).toBeGreaterThanOrEqual(2);
    // A retentativa manda family_name...
    expect(calls[1].family_name).toBeTruthy();
    // ...e NÃO manda title. Este é o ponto do fix.
    expect(calls[1].title).toBeUndefined();
  });

  it("publica quando o ML aceita family_name sem title", async () => {
    (MLApiService.createItem as any)
      .mockRejectedValueOnce(FAMILY_NAME_ERR)
      .mockResolvedValueOnce({ id: "MLB999", permalink: "https://ml/MLB999" });
    (MLApiService.getItemDetails as any).mockResolvedValue({
      id: "MLB999",
      status: "active",
    });

    await ListingRetryService.runOnce();

    expect(ListingRepository.updateListing).toHaveBeenCalledWith(
      "pl-ladder",
      expect.objectContaining({
        externalListingId: "MLB999",
        retryEnabled: false,
      }),
    );
  });

  it("liga os fallbacks de title quando a retentativa com family_name falha por title", async () => {
    // Erro original = family_name (não title). Antes do fix, isTitleInvalid
    // ficava false para sempre e a escada parava na 2ª chamada.
    (MLApiService.createItem as any)
      .mockRejectedValueOnce(FAMILY_NAME_ERR)
      .mockRejectedValueOnce(TITLE_INVALID_ERR)
      .mockResolvedValueOnce({ id: "MLB777", permalink: "https://ml/MLB777" });
    (MLApiService.getItemDetails as any).mockResolvedValue({
      id: "MLB777",
      status: "active",
    });

    await ListingRetryService.runOnce();

    // A escada continuou além da 2ª tentativa em vez de desistir.
    expect(payloads().length).toBeGreaterThanOrEqual(3);
    expect(ListingRepository.updateListing).toHaveBeenCalledWith(
      "pl-ladder",
      expect.objectContaining({ externalListingId: "MLB777" }),
    );
  });

  it("preserva o caminho feliz: aceito de primeira, sem retentativa", async () => {
    (MLApiService.createItem as any).mockResolvedValueOnce({
      id: "MLB111",
      permalink: "https://ml/MLB111",
    });
    (MLApiService.getItemDetails as any).mockResolvedValue({
      id: "MLB111",
      status: "active",
    });

    await ListingRetryService.runOnce();

    expect(MLApiService.createItem).toHaveBeenCalledTimes(1);
    // A 1ª tentativa mantém o title e não manda family_name.
    expect(payloads()[0].title).toBeTruthy();
    expect(payloads()[0].family_name).toBeUndefined();
  });
});
