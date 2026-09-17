import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Falha PASSAGEIRA de renovação de token não pode marcar a conta como ERROR.
 *
 * Produção, 16/09/2026: a partner key da Shopee falhou por ~3 h. O status-check
 * da Shopee marcava ERROR em QUALQUER falha de renovação, e 8 contas saudáveis
 * de 6 lojistas saíram do laço de pedidos, do webhook e da vigília por ~11 h —
 * os tokens delas seguiam renovando, mas nenhuma venda entrava e nenhuma baixa
 * acontecia. Os fluxos de criar anúncio (ML, Magalu, Shopee) tinham o mesmo
 * `updateStatus(ERROR)` incondicional.
 *
 * Regra: credencial morta vira ERROR (classificador central, o mesmo do
 * getAccountStatus do ML); falha passageira só é registrada. A mensagem para o
 * usuário não muda.
 */

vi.mock("../app/marketplaces/repositories/marketplace.repository", () => ({
  MarketplaceRepository: {
    findByIdAndUser: vi.fn(),
    findFirstActiveByUserAndPlatform: vi.fn(),
    findAllByUserIdAndPlatform: vi.fn(),
    updateStatus: vi.fn(),
    updateTokens: vi.fn(),
  },
}));

vi.mock("../app/marketplaces/services/shopee-oauth.service", () => ({
  ShopeeOAuthService: {
    refreshAccessToken: vi.fn(),
    calculateExpiryDate: vi.fn(),
  },
}));

vi.mock("../app/marketplaces/services/ml-oauth.service", () => ({
  MLOAuthService: {
    refreshAccessTokenForAccount: vi.fn(),
    clearAccountCircuitBreaker: vi.fn(),
  },
}));

vi.mock("../app/marketplaces/services/magalu-oauth.service", () => ({
  MagaluOAuthService: {
    refreshAccessTokenForAccount: vi.fn(),
    clearAccountCircuitBreaker: vi.fn(),
  },
}));

vi.mock("../app/services/system-log.service", () => ({
  SystemLogService: {
    logError: vi.fn(),
    logWarning: vi.fn(),
    logInfo: vi.fn(),
    log: vi.fn(),
  },
}));

import { AccountStatus } from "@prisma/client";
import { MarketplaceUseCase } from "../app/marketplaces/usecases/marketplace.usercase";
import { ListingUseCase } from "../app/marketplaces/usecases/listing.usercase";
import { MarketplaceRepository } from "../app/marketplaces/repositories/marketplace.repository";
import { ShopeeOAuthService } from "../app/marketplaces/services/shopee-oauth.service";
import { MLOAuthService } from "../app/marketplaces/services/ml-oauth.service";
import { MagaluOAuthService } from "../app/marketplaces/services/magalu-oauth.service";
import { SystemLogService } from "../app/services/system-log.service";

const VENCIDO = () => new Date(Date.now() - 60_000);

function conta(extra: Record<string, unknown>) {
  return {
    id: "acc-1",
    userId: "user-1",
    accountName: "Loja",
    accessToken: "tok",
    refreshToken: "rt",
    expiresAt: VENCIDO(),
    status: "ACTIVE",
    ...extra,
  } as any;
}

const marcouErro = () =>
  (MarketplaceRepository.updateStatus as any).mock.calls.some(
    (c: unknown[]) => c[1] === AccountStatus.ERROR,
  );

beforeEach(() => {
  vi.clearAllMocks();
});

describe("status-check da Shopee (GET /marketplace/shopee/status)", () => {
  beforeEach(() => {
    (MarketplaceRepository.findByIdAndUser as any).mockResolvedValue(
      conta({ shopId: 1386089464, platform: "SHOPEE" }),
    );
  });

  it.each([
    ["pane da partner key (o incidente de 16/09)", "Erro ao renovar token: partner key has expired"],
    ["assinatura recusada", "Erro ao renovar token: Wrong sign"],
    ["rede", "Erro ao renovar token: socket hang up"],
  ])("%s → NÃO marca ERROR", async (_rotulo, mensagem) => {
    (ShopeeOAuthService.refreshAccessToken as any).mockRejectedValue(
      new Error(mensagem),
    );

    const r = await MarketplaceUseCase.getShopeeAccountStatus("user-1", "acc-1");

    expect(r.connected).toBe(false);
    // Texto de sempre (o arquivo de origem o guarda com acentuação quebrada).
    expect(r.message).toMatch(/^Token expirado e n/);
    expect(marcouErro()).toBe(false);
    // Não é silencioso: vira SystemLog do lojista.
    expect(SystemLogService.logError).toHaveBeenCalledWith(
      "AUTH_REFRESH",
      expect.stringContaining(mensagem),
      expect.objectContaining({ userId: "user-1", resourceId: "acc-1" }),
    );
  });

  it("refresh_token expirado (credencial morta) → marca ERROR", async () => {
    (ShopeeOAuthService.refreshAccessToken as any).mockRejectedValue(
      new Error("Erro ao renovar token: Your refresh_token expired."),
    );

    await MarketplaceUseCase.getShopeeAccountStatus("user-1", "acc-1");

    expect(MarketplaceRepository.updateStatus).toHaveBeenCalledWith(
      "acc-1",
      AccountStatus.ERROR,
    );
  });
});

describe("criar anúncio com token vencido e renovação que falha", () => {
  describe("Shopee", () => {
    beforeEach(() => {
      (MarketplaceRepository.findByIdAndUser as any).mockResolvedValue(
        conta({ shopId: "1386089464" }),
      );
    });

    it("falha passageira → NÃO marca ERROR e devolve a mesma mensagem ao usuário", async () => {
      (ShopeeOAuthService.refreshAccessToken as any).mockRejectedValue(
        new Error("Erro ao renovar token: partner key has expired"),
      );

      const r = await ListingUseCase.createShopeeListing(
        "user-1",
        "prod-1",
        "102294",
        "acc-1",
      );

      expect(r.success).toBe(false);
      expect(r.error).toBe(
        "Conta do Shopee expirou ou token inválido — reconecte a conta",
      );
      expect(marcouErro()).toBe(false);
    });

    it("credencial morta → marca ERROR", async () => {
      (ShopeeOAuthService.refreshAccessToken as any).mockRejectedValue(
        new Error("Erro ao renovar token: Your refresh_token expired."),
      );

      await ListingUseCase.createShopeeListing("user-1", "prod-1", "102294", "acc-1");

      expect(MarketplaceRepository.updateStatus).toHaveBeenCalledWith(
        "acc-1",
        AccountStatus.ERROR,
      );
    });
  });

  describe("Mercado Livre", () => {
    beforeEach(() => {
      (MarketplaceRepository.findByIdAndUser as any).mockResolvedValue(conta({}));
    });

    it("falha passageira → NÃO marca ERROR", async () => {
      (MLOAuthService.refreshAccessTokenForAccount as any).mockRejectedValue(
        new Error("Erro ao renovar token: timeout of 10000ms exceeded"),
      );

      const r = await ListingUseCase.createMLListing(
        "user-1",
        "prod-1",
        "MLB1",
        "acc-1",
      );

      expect(r.success).toBe(false);
      expect(marcouErro()).toBe(false);
    });

    it("invalid_grant → marca ERROR", async () => {
      (MLOAuthService.refreshAccessTokenForAccount as any).mockRejectedValue(
        new Error("Erro ao renovar token: invalid_grant"),
      );

      await ListingUseCase.createMLListing("user-1", "prod-1", "MLB1", "acc-1");

      expect(MarketplaceRepository.updateStatus).toHaveBeenCalledWith(
        "acc-1",
        AccountStatus.ERROR,
      );
    });
  });

  describe("Magalu", () => {
    beforeEach(() => {
      (MarketplaceRepository.findByIdAndUser as any).mockResolvedValue(conta({}));
    });

    it("falha passageira → NÃO marca ERROR", async () => {
      (MagaluOAuthService.refreshAccessTokenForAccount as any).mockRejectedValue(
        new Error("Erro ao renovar token (Magalu): Request failed with status code 503"),
      );

      const r = await ListingUseCase.createMagaluListing(
        "user-1",
        "prod-1",
        undefined,
        "acc-1",
      );

      expect(r.success).toBe(false);
      expect(r.error).toBe(
        "Conta da Magalu expirou ou token inválido — reconecte a conta",
      );
      expect(marcouErro()).toBe(false);
    });

    it("conta em estado terminal (invalid_grant) → marca ERROR", async () => {
      (MagaluOAuthService.refreshAccessTokenForAccount as any).mockRejectedValue(
        new Error(
          "Erro ao renovar token (Magalu): conta acc-1 em estado terminal (invalid_grant)",
        ),
      );

      await ListingUseCase.createMagaluListing("user-1", "prod-1", undefined, "acc-1");

      expect(MarketplaceRepository.updateStatus).toHaveBeenCalledWith(
        "acc-1",
        AccountStatus.ERROR,
      );
    });
  });
});
