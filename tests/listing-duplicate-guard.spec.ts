import { describe, it, expect, vi, beforeEach } from "vitest";
import { ListingUseCase } from "../app/marketplaces/usecases/listing.usercase";
import { ListingRepository } from "../app/marketplaces/repositories/listing.repository";
import { MarketplaceRepository } from "../app/marketplaces/repositories/marketplace.repository";
import { MLApiService } from "../app/marketplaces/services/ml-api.service";
import { ProductRepositoryPrisma } from "../app/repositories/product.repository";

/**
 * Guard anti-duplicata do createMLListing.
 *
 * Um par (produto, conta) pode ter várias linhas de listing, e criar um
 * anúncio novo enquanto um VIVO existe naquela conta:
 *   - publica anúncio DUPLICADO no ML (que penaliza duplicatas);
 *   - no sucesso, sobrescreve o externalListingId de uma linha cujo item
 *     continua vivo lá — o anúncio antigo vira órfão (publicado no ML, sem
 *     linha no banco, invisível ao sync/estoque).
 *
 * Flagrado no piloto de reabilitação do retry: o createMLListing reusou a
 * linha de um anúncio ativo (sku 2924/ASAFE) e marcou retryEnabled=true nela.
 *
 * Regra: anúncio active/paused com id real naquela conta ⇒ recusa com
 * mensagem acionável. `closed` NÃO bloqueia (recriar anúncio encerrado é a
 * republicação legítima — e o republishUpListing troca a própria linha por
 * placeholder ANTES de chamar, então não se auto-bloqueia).
 */

vi.mock("../app/marketplaces/repositories/listing.repository", () => ({
  ListingRepository: {
    findLiveByProductAndAccount: vi.fn(),
    findByProductAndAccount: vi.fn(),
    updateListing: vi.fn(),
    createListing: vi.fn(),
    findRetryStateById: vi.fn(),
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
  id: "acct-1",
  userId: "user-1",
  accountName: "ASAFE",
  accessToken: "tok",
  refreshToken: "ref",
  expiresAt: new Date(Date.now() + 3600_000),
  status: "ACTIVE",
  externalUserId: "123456",
} as any;

describe("createMLListing — guard anti-duplicata", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (MarketplaceRepository.findByIdAndUser as any).mockResolvedValue(ACCOUNT);
    (ListingRepository.findByProductAndAccount as any).mockResolvedValue(null);
  });

  it("recusa quando o produto já tem anúncio ATIVO nesta conta", async () => {
    (ListingRepository.findLiveByProductAndAccount as any).mockResolvedValue({
      id: "l-vivo",
      externalListingId: "MLB4897260131",
      status: "active",
    });

    const result = await ListingUseCase.createMLListing(
      "user-1",
      "prod-1",
      "MLB1744",
      "acct-1",
    );

    expect(result.success).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.error).toContain("MLB4897260131");
    expect(result.error).toContain("anúncio ativo");
    // Recusa ANTES de qualquer efeito: nada criado no ML, nenhum placeholder.
    expect(MLApiService.createItem).not.toHaveBeenCalled();
    expect(ListingRepository.createListing).not.toHaveBeenCalled();
  });

  it("recusa também quando o anúncio existente está PAUSADO (vivo no ML)", async () => {
    (ListingRepository.findLiveByProductAndAccount as any).mockResolvedValue({
      id: "l-pausado",
      externalListingId: "MLB111",
      status: "paused",
    });

    const result = await ListingUseCase.createMLListing(
      "user-1",
      "prod-1",
      "MLB1744",
      "acct-1",
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("pausado");
  });

  it("marca o placeholder de retry como TERMINAL na recusa (cron para de gastar tentativas)", async () => {
    (ListingRepository.findLiveByProductAndAccount as any).mockResolvedValue({
      id: "l-vivo",
      externalListingId: "MLB4897260131",
      status: "active",
    });
    // O par tem também um placeholder pendente (caso do piloto: 242 pares assim).
    (ListingRepository.findByProductAndAccount as any).mockResolvedValue({
      id: "l-placeholder",
      externalListingId: "PENDING_123",
      retryEnabled: true,
    });

    await ListingUseCase.createMLListing(
      "user-1",
      "prod-1",
      "MLB1744",
      "acct-1",
    );

    expect(ListingRepository.updateListing).toHaveBeenCalledWith(
      "l-placeholder",
      expect.objectContaining({
        retryEnabled: false,
        nextRetryAt: null,
        lastError: expect.stringContaining("[TERMINAL]"),
      }),
    );
  });

  it("NÃO recusa quando não há anúncio vivo (closed não bloqueia a republicação)", async () => {
    (ListingRepository.findLiveByProductAndAccount as any).mockResolvedValue(
      null,
    );
    // Passa do guard e morre no próximo passo, de forma controlada: produto
    // não encontrado. Isso prova que o fluxo seguiu.
    const repoModule: any = await import("../app/repositories/product.repository");
    repoModule.__findById.mockResolvedValue(null);

    const result = await ListingUseCase.createMLListing(
      "user-1",
      "prod-1",
      "MLB1744",
      "acct-1",
    );

    expect(result.success).toBe(false);
    // "Produto não encontrado" — sem depender do acento: o fonte tem trechos
    // com encoding corrompido pré-existente (mojibake em literais).
    expect(result.error).toContain("Produto");
    expect(result.error).toContain("encontrado");
    // O guard não interferiu — a recusa por duplicata não aconteceu.
    expect(result.error).not.toContain("anúncio");
  });
});
