import { describe, it, expect, vi, beforeEach } from "vitest";
import { ListingUseCase } from "../app/marketplaces/usecases/listing.usercase";
import { ListingRepository } from "../app/marketplaces/repositories/listing.repository";
import { MarketplaceRepository } from "../app/marketplaces/repositories/marketplace.repository";
import { ShopeeApiService } from "../app/marketplaces/services/shopee-api.service";

/**
 * Guard anti-duplicata do createShopeeListing (espelho do guard do ML, #144).
 *
 * Caso real de produção (duplo-submit do bulk em servidor lento): o job 1
 * criou os 2 anúncios com sucesso na Shopee; o job 2, redundante, tentou criar
 * de novo — a Shopee rejeitou com "This product duplicates another in your
 * shop" e o UPSERT do fracasso SOBRESCREVEU o status das linhas saudáveis
 * (ficaram status=error apontando para anúncios que estão no ar).
 *
 * Regra: anúncio active/paused com id real naquela conta ⇒ recusa
 * determinística ANTES de qualquer efeito (nada criado na Shopee, nenhuma
 * linha tocada). `closed` não bloqueia (republicação legítima); o placeholder
 * PENDING_ do retry não é "vivo" e também não bloqueia.
 */

vi.mock("../app/marketplaces/repositories/listing.repository", () => ({
  ListingRepository: {
    findLiveByProductAndAccount: vi.fn(),
    findByProductAndAccount: vi.fn(),
    updateListing: vi.fn(),
    createListing: vi.fn(),
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

vi.mock("../app/marketplaces/services/shopee-api.service", () => ({
  ShopeeApiService: {
    createItem: vi.fn(),
    uploadImage: vi.fn(),
    getCategoryAttributes: vi.fn(),
    getLogisticsChannelList: vi.fn(),
    assertLeafCategory: vi.fn(),
  },
}));

vi.mock("../app/marketplaces/services/shopee-oauth.service", () => ({
  ShopeeOAuthService: {
    refreshAccessToken: vi.fn(),
    calculateExpiryDate: vi.fn(),
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

const ACCOUNT = {
  id: "acct-shp-1",
  userId: "user-1",
  accountName: "Shopee Shop",
  accessToken: "tok",
  refreshToken: "ref",
  shopId: "1386089464",
  expiresAt: new Date(Date.now() + 3600_000),
  status: "ACTIVE",
} as any;

describe("createShopeeListing — guard anti-duplicata", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (MarketplaceRepository.findByIdAndUser as any).mockResolvedValue(ACCOUNT);
    (ListingRepository.findByProductAndAccount as any).mockResolvedValue(null);
  });

  it("recusa quando o produto já tem anúncio ATIVO nesta conta (o caso do duplo-submit)", async () => {
    (ListingRepository.findLiveByProductAndAccount as any).mockResolvedValue({
      id: "l-vivo",
      externalListingId: "58264481300",
      status: "active",
    });

    const result = await ListingUseCase.createShopeeListing(
      "user-1",
      "prod-1",
      "102294",
      "acct-shp-1",
    );

    expect(result.success).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.externalListingId).toBe("58264481300");
    expect(result.error).toContain("já tem anúncio ativo");
    // Recusa ANTES de qualquer efeito: nada criado na Shopee e — crucial —
    // NENHUMA linha tocada (o clobber do caso real veio do upsert do fracasso).
    expect(ShopeeApiService.createItem).not.toHaveBeenCalled();
    expect(ListingRepository.updateListing).not.toHaveBeenCalled();
    expect(ListingRepository.createListing).not.toHaveBeenCalled();
  });

  it("marca o placeholder PENDING_ do retry como terminal na recusa", async () => {
    (ListingRepository.findLiveByProductAndAccount as any).mockResolvedValue({
      id: "l-vivo",
      externalListingId: "58264481300",
      status: "active",
    });
    (ListingRepository.findByProductAndAccount as any).mockResolvedValue({
      id: "l-placeholder",
      externalListingId: "PENDING_SHP_abc",
      retryEnabled: true,
    });

    await ListingUseCase.createShopeeListing(
      "user-1",
      "prod-1",
      "102294",
      "acct-shp-1",
    );

    // O cron não pode gastar tentativas numa recusa determinística.
    expect(ListingRepository.updateListing).toHaveBeenCalledWith(
      "l-placeholder",
      expect.objectContaining({
        retryEnabled: false,
        nextRetryAt: null,
        status: "error",
        lastError: expect.stringContaining("[TERMINAL]"),
      }),
    );
  });

  it("recusa também quando o anúncio existente está PAUSADO", async () => {
    (ListingRepository.findLiveByProductAndAccount as any).mockResolvedValue({
      id: "l-pausado",
      externalListingId: "58200000001",
      status: "paused",
    });

    const result = await ListingUseCase.createShopeeListing(
      "user-1",
      "prod-1",
      "102294",
      "acct-shp-1",
    );

    expect(result.success).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.error).toContain("pausado");
    expect(ShopeeApiService.createItem).not.toHaveBeenCalled();
  });

  it("sem anúncio vivo, o fluxo segue (guard não bloqueia criação legítima)", async () => {
    (ListingRepository.findLiveByProductAndAccount as any).mockResolvedValue(
      null,
    );
    const { __findById } = (await import(
      "../app/repositories/product.repository"
    )) as any;
    __findById.mockResolvedValue(null);

    const result = await ListingUseCase.createShopeeListing(
      "user-1",
      "prod-1",
      "102294",
      "acct-shp-1",
    );

    // Passou do guard e parou no passo seguinte (produto não encontrado) —
    // prova que a recusa é exclusiva do caso duplicata.
    expect(result.skipped).toBeUndefined();
    expect(result.error).toContain("Produto");
    expect(result.error).toContain("encontrado");
  });
});
