import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";
import { ListingRetryService } from "../app/marketplaces/services/listing-retry.service";
import { ListingRepository } from "../app/marketplaces/repositories/listing.repository";
import { MLApiService } from "../app/marketplaces/services/ml-api.service";
import { MLOAuthService } from "../app/marketplaces/services/ml-oauth.service";
import { MarketplaceRepository } from "../app/marketplaces/repositories/marketplace.repository";
import { CategoryResolutionService } from "../app/marketplaces/services/category-resolution.service";

/**
 * Token do ML expirado no cron de retry.
 *
 * O fluxo interativo (createMLListing) renova o token antes de falar com o ML;
 * o cron usava `account.accessToken` cru. Como o token dura ~6h e o retry roda
 * logo após a falha (que acabou de renovar), isso raramente aparecia — mas
 * morde quando a fila fica parada ou é reabilitada em lote: aí o candidato é
 * desligado por token vencido, não por problema no anúncio.
 */

vi.mock("../app/marketplaces/repositories/listing.repository", () => ({
  ListingRepository: {
    findPendingRetries: vi.fn(),
    incrementRetryAttempts: vi.fn(),
    updateListing: vi.fn(),
  },
}));

vi.mock("../app/marketplaces/services/ml-api.service", () => ({
  MLApiService: { getSellerItemIds: vi.fn(), createItem: vi.fn() },
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
  },
}));

vi.mock("../app/repositories/product.repository", () => ({
  ProductRepositoryPrisma: vi.fn(() => ({})),
}));

vi.mock("../app/marketplaces/services/image-resize.service", () => ({
  ensureMLMinImageSize: vi.fn(),
}));

const HOUR = 3600_000;

const makeCandidate = (expiresAt: Date) =>
  ({
    id: "pl-token",
    externalListingId: "PENDING_X",
    status: "paused",
    retryAttempts: 0,
    retryEnabled: true,
    nextRetryAt: new Date(Date.now() - 1000),
    requestedCategoryId: "MLB999",
    productId: "prod-1",
    product: {
      id: "prod-1",
      sku: "SKU-1",
      name: "Farol Dianteiro",
      price: new Prisma.Decimal("629.00"),
      stock: 1,
    },
    marketplaceAccount: {
      id: "acct-1",
      accountName: "MINHA-LOJA",
      accessToken: "tok-velho",
      refreshToken: "refresh-1",
      expiresAt,
      platform: "MERCADO_LIVRE",
      userId: "user-1",
      externalUserId: "123",
    },
  }) as any;

describe("ListingRetryService — refresh de token do ML", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (MLApiService.getSellerItemIds as any).mockResolvedValue([]);
    // Encerra o candidato logo depois do capability check.
    (CategoryResolutionService.resolveMLCategory as any).mockRejectedValue(
      new Error("stop-after-token"),
    );
  });

  it("renova o token vencido e usa o NOVO nas chamadas ao ML", async () => {
    (ListingRepository.findPendingRetries as any).mockResolvedValue([
      makeCandidate(new Date(Date.now() - HOUR)), // vencido há 1h
    ]);
    (MLOAuthService.refreshAccessTokenForAccount as any).mockResolvedValue({
      accessToken: "tok-novo",
      refreshToken: "refresh-2",
      expiresIn: 21600,
    });

    await ListingRetryService.runOnce();

    expect(MLOAuthService.refreshAccessTokenForAccount).toHaveBeenCalledWith(
      "acct-1",
      "refresh-1",
    );
    // Persistiu para os próximos ciclos e outros fluxos.
    expect(MarketplaceRepository.updateTokens).toHaveBeenCalledWith(
      "acct-1",
      expect.objectContaining({
        accessToken: "tok-novo",
        refreshToken: "refresh-2",
      }),
    );
    // O ponto do fix: a chamada ao ML usa o token NOVO, não o velho.
    expect(MLApiService.getSellerItemIds).toHaveBeenCalledWith(
      "tok-novo",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("NÃO renova quando o token ainda é válido", async () => {
    (ListingRepository.findPendingRetries as any).mockResolvedValue([
      makeCandidate(new Date(Date.now() + 3 * HOUR)),
    ]);

    await ListingRetryService.runOnce();

    expect(MLOAuthService.refreshAccessTokenForAccount).not.toHaveBeenCalled();
    expect(MarketplaceRepository.updateTokens).not.toHaveBeenCalled();
    expect(MLApiService.getSellerItemIds).toHaveBeenCalledWith(
      "tok-velho",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("reagenda com mensagem acionável quando o refresh falha", async () => {
    (ListingRepository.findPendingRetries as any).mockResolvedValue([
      makeCandidate(new Date(Date.now() - HOUR)),
    ]);
    (MLOAuthService.refreshAccessTokenForAccount as any).mockRejectedValue(
      new Error("invalid_grant"),
    );

    await ListingRetryService.runOnce();

    // Não gasta chamada ao ML com token que sabidamente não serve.
    expect(MLApiService.getSellerItemIds).not.toHaveBeenCalled();

    const call = (ListingRepository.incrementRetryAttempts as any).mock
      .calls[0];
    expect(call[0]).toBe("pl-token");
    expect(call[1].lastError).toContain("reconecte a conta");
    expect(call[1].lastError).toContain("MINHA-LOJA");
    // Primeira tentativa: ainda reagenda (não é terminal de cara).
    expect(call[1].retryEnabled).toBe(true);
  });

  it("para de retentar após MAX_ATTEMPTS quando o refresh segue falhando", async () => {
    const cand = makeCandidate(new Date(Date.now() - HOUR));
    cand.retryAttempts = 4; // a próxima é a 5ª (MAX_ATTEMPTS)
    (ListingRepository.findPendingRetries as any).mockResolvedValue([cand]);
    (MLOAuthService.refreshAccessTokenForAccount as any).mockRejectedValue(
      new Error("invalid_grant"),
    );

    await ListingRetryService.runOnce();

    const call = (ListingRepository.incrementRetryAttempts as any).mock
      .calls[0];
    expect(call[1]).toMatchObject({ retryEnabled: false, nextRetryAt: null });
  });

  it("NÃO marca a conta como ERROR (um erro de rede no cron derrubaria a conta inteira)", async () => {
    (ListingRepository.findPendingRetries as any).mockResolvedValue([
      makeCandidate(new Date(Date.now() - HOUR)),
    ]);
    (MLOAuthService.refreshAccessTokenForAccount as any).mockRejectedValue(
      new Error("ECONNRESET"),
    );

    await ListingRetryService.runOnce();

    expect(MarketplaceRepository.updateStatus).not.toHaveBeenCalled();
  });
});
