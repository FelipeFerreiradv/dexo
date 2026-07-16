import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";
import { ListingRetryService } from "../app/marketplaces/services/listing-retry.service";
import { ListingRepository } from "../app/marketplaces/repositories/listing.repository";
import { MLApiService } from "../app/marketplaces/services/ml-api.service";
import { ListingUseCase } from "../app/marketplaces/usecases/listing.usercase";

/**
 * O cron delega a criação ML ao createMLListing (padrão que ele já usava no
 * Shopee), em vez de reimplementar payload + escada de retry.
 *
 * A cópia divergiu do original e acumulou defeitos que o fluxo principal já
 * tinha resolvido — 5 variantes de createItem contra 12, sem retry por
 * categoria sugerida, mandando family_name junto com title. Dois lotes piloto
 * de 25 anúncios reabilitados publicaram 0 nas duas vezes.
 *
 * O que estes testes protegem: a delegação acontece, o backoff/MAX_ATTEMPTS
 * continua sendo aplicado AQUI (o createMLListing reagenda com
 * `retryEnabled: true` fixo, sem limite = loop infinito), e os terminais que
 * ele marca são respeitados.
 */

vi.mock("../app/marketplaces/repositories/listing.repository", () => ({
  ListingRepository: {
    findPendingRetries: vi.fn(),
    incrementRetryAttempts: vi.fn(),
    updateListing: vi.fn(),
    findByProductAndAccount: vi.fn(),
  },
}));

vi.mock("../app/marketplaces/services/ml-api.service", () => ({
  MLApiService: { getSellerItemIds: vi.fn(), createItem: vi.fn() },
}));

vi.mock("../app/marketplaces/usecases/listing.usercase", () => ({
  ListingUseCase: { createMLListing: vi.fn(), createShopeeListing: vi.fn() },
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

const makeCandidate = (overrides: Record<string, unknown> = {}) =>
  ({
    id: "pl-1",
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
      name: "Farol",
      price: new Prisma.Decimal("629.00"),
      stock: 1,
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
    ...overrides,
  }) as any;

describe("ListingRetryService — delega a criação ML ao createMLListing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (MLApiService.getSellerItemIds as any).mockResolvedValue([]);
    (ListingRepository.findPendingRetries as any).mockResolvedValue([
      makeCandidate(),
    ]);
    (ListingRepository.findByProductAndAccount as any).mockResolvedValue({
      id: "pl-1",
      retryEnabled: true,
    });
  });

  it("chama createMLListing com dono, produto, categoria pedida e conta", async () => {
    (ListingUseCase.createMLListing as any).mockResolvedValue({
      success: true,
      externalListingId: "MLB999",
    });

    await ListingRetryService.runOnce();

    expect(ListingUseCase.createMLListing).toHaveBeenCalledWith(
      "user-1",
      "prod-1",
      "MLB1744",
      "acct-1",
    );
  });

  it("NÃO chama a API do ML direto — a criação é do createMLListing", async () => {
    (ListingUseCase.createMLListing as any).mockResolvedValue({
      success: true,
      externalListingId: "MLB999",
    });

    await ListingRetryService.runOnce();

    // O cron reimplementava o createItem; agora só o capability check fala
    // com o MLApiService.
    expect(MLApiService.createItem).not.toHaveBeenCalled();
  });

  it("no sucesso, não reagenda (o createMLListing já gravou o anúncio)", async () => {
    (ListingUseCase.createMLListing as any).mockResolvedValue({
      success: true,
      externalListingId: "MLB999",
    });

    await ListingRetryService.runOnce();

    expect(ListingRepository.incrementRetryAttempts).not.toHaveBeenCalled();
  });

  it("na falha, aplica o backoff daqui (o createMLListing reagenda sem limite)", async () => {
    (ListingUseCase.createMLListing as any).mockResolvedValue({
      success: false,
      error: "Erro ao criar item: family_name",
    });

    await ListingRetryService.runOnce();

    const call = (ListingRepository.incrementRetryAttempts as any).mock
      .calls[0];
    expect(call[0]).toBe("pl-1");
    expect(call[1].retryEnabled).toBe(true);
    expect(call[1].lastError).toContain("family_name");
    expect(call[1].nextRetryAt).toBeInstanceOf(Date);
  });

  it("para de retentar ao atingir MAX_ATTEMPTS (sem isto = loop infinito)", async () => {
    (ListingRepository.findPendingRetries as any).mockResolvedValue([
      makeCandidate({ retryAttempts: 4 }), // a próxima é a 5ª
    ]);
    (ListingUseCase.createMLListing as any).mockResolvedValue({
      success: false,
      error: "Erro ao criar item: family_name",
    });

    await ListingRetryService.runOnce();

    const call = (ListingRepository.incrementRetryAttempts as any).mock
      .calls[0];
    expect(call[1]).toMatchObject({ retryEnabled: false, nextRetryAt: null });
  });

  it("respeita o terminal do createMLListing e não ressuscita o candidato", async () => {
    // Ex.: PolicyAgent — o createMLListing desliga o retry e marca a conta.
    (ListingUseCase.createMLListing as any).mockResolvedValue({
      success: false,
      error: "Conta sem permissão para publicar (PolicyAgent)",
    });
    (ListingRepository.findByProductAndAccount as any).mockResolvedValue({
      id: "pl-1",
      retryEnabled: false,
    });

    await ListingRetryService.runOnce();

    expect(ListingRepository.incrementRetryAttempts).not.toHaveBeenCalled();
  });

  it("Shopee continua delegando para createShopeeListing", async () => {
    (ListingRepository.findPendingRetries as any).mockResolvedValue([
      makeCandidate({
        externalListingId: "PENDING_SHP_1",
        marketplaceAccount: {
          id: "acct-shp",
          accessToken: "tok",
          platform: "SHOPEE",
          userId: "user-1",
        },
      }),
    ]);
    (ListingUseCase.createShopeeListing as any).mockResolvedValue({
      success: true,
      externalListingId: "SHP1",
    });

    await ListingRetryService.runOnce();

    expect(ListingUseCase.createShopeeListing).toHaveBeenCalled();
    expect(ListingUseCase.createMLListing).not.toHaveBeenCalled();
  });
});
