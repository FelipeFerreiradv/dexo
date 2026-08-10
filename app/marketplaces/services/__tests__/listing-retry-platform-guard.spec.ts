import { afterEach, describe, expect, it, vi } from "vitest";
import { Platform } from "@prisma/client";

import { ListingRetryService } from "../listing-retry.service";
import { ListingRepository } from "../../repositories/listing.repository";
import { MLApiService } from "../ml-api.service";
import { SystemLogService } from "../../../services/system-log.service";

/**
 * Garante que listings de plataformas OLX e FACEBOOK com retryEnabled=true
 * NÃO chegam ao caminho ML do ListingRetryService — ou seja, nenhuma chamada
 * a MLApiService.getSellerItemIds é feita com tokens de outra plataforma.
 *
 * Contexto: o cron selecionava candidatos por `retryEnabled: true`
 * sem filtrar plataforma, e o ramo default chamava getSellerItemIds enviando
 * token OLX/Meta para api.mercadolibre.com (vazamento + falha garantida).
 */

const makeAccount = (platform: Platform) => ({
  id: "acc-1",
  platform,
  accessToken: "tok-abc",
  refreshToken: "ref-abc",
  expiresAt: new Date(Date.now() + 3_600_000),
  userId: "user-1",
  externalUserId: "ext-1",
  accountName: "Conta Teste",
});

const makeListing = (platform: Platform) => ({
  id: "listing-1",
  externalListingId: "EXT-001",
  retryEnabled: true,
  retryAttempts: 0,
  nextRetryAt: null,
  requestedCategoryId: null,
  productId: "prod-1",
  product: {
    id: "prod-1",
    stock: 5,
    price: 100,
  },
  marketplaceAccount: makeAccount(platform),
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ListingRetryService — guard de plataforma", () => {
  it("não chama MLApiService e DESABILITA o retry de listing OLX com retryEnabled=true", async () => {
    vi.spyOn(ListingRepository, "findPendingRetries").mockResolvedValue([
      makeListing(Platform.OLX),
    ] as any);
    vi.spyOn(ListingRepository, "claimRetryCandidate").mockResolvedValue(
      true as any,
    );

    const mlSpy = vi
      .spyOn(MLApiService, "getSellerItemIds")
      .mockResolvedValue([] as any);
    const incSpy = vi
      .spyOn(ListingRepository, "incrementRetryAttempts")
      .mockResolvedValue(undefined as any);

    await ListingRetryService.runOnce();

    expect(mlSpy).not.toHaveBeenCalled();
    expect(incSpy).toHaveBeenCalledWith(
      "listing-1",
      expect.objectContaining({ retryEnabled: false, nextRetryAt: null }),
    );
  });

  it("não chama MLApiService e DESABILITA o retry de listing FACEBOOK com retryEnabled=true", async () => {
    vi.spyOn(ListingRepository, "findPendingRetries").mockResolvedValue([
      makeListing(Platform.FACEBOOK),
    ] as any);
    vi.spyOn(ListingRepository, "claimRetryCandidate").mockResolvedValue(
      true as any,
    );

    const mlSpy = vi
      .spyOn(MLApiService, "getSellerItemIds")
      .mockResolvedValue([] as any);
    const incSpy = vi
      .spyOn(ListingRepository, "incrementRetryAttempts")
      .mockResolvedValue(undefined as any);

    await ListingRetryService.runOnce();

    expect(mlSpy).not.toHaveBeenCalled();
    expect(incSpy).toHaveBeenCalledWith(
      "listing-1",
      expect.objectContaining({ retryEnabled: false, nextRetryAt: null }),
    );
  });

  it("DESABILITA o retry de listing MAGALU (regressão: reivindicava a cada ciclo p/ sempre)", async () => {
    vi.spyOn(ListingRepository, "findPendingRetries").mockResolvedValue([
      makeListing(Platform.MAGALU),
    ] as any);
    vi.spyOn(ListingRepository, "claimRetryCandidate").mockResolvedValue(
      true as any,
    );

    const mlSpy = vi
      .spyOn(MLApiService, "getSellerItemIds")
      .mockResolvedValue([] as any);
    const incSpy = vi
      .spyOn(ListingRepository, "incrementRetryAttempts")
      .mockResolvedValue(undefined as any);

    await ListingRetryService.runOnce();

    expect(mlSpy).not.toHaveBeenCalled();
    expect(incSpy).toHaveBeenCalledWith(
      "listing-1",
      expect.objectContaining({ retryEnabled: false, nextRetryAt: null }),
    );
  });

  it("chama MLApiService para listing MERCADO_LIVRE (caminho normal não é bloqueado)", async () => {
    vi.spyOn(ListingRepository, "findPendingRetries").mockResolvedValue([
      makeListing(Platform.MERCADO_LIVRE),
    ] as any);
    vi.spyOn(ListingRepository, "claimRetryCandidate").mockResolvedValue(
      true as any,
    );

    const mlSpy = vi
      .spyOn(MLApiService, "getSellerItemIds")
      .mockRejectedValue(new Error("capability check simulado"));

    vi.spyOn(ListingRepository, "incrementRetryAttempts").mockResolvedValue(
      undefined as any,
    );
    vi.spyOn(SystemLogService, "logError").mockResolvedValue(undefined as any);

    await ListingRetryService.runOnce();

    expect(mlSpy).toHaveBeenCalledOnce();
    expect(mlSpy).toHaveBeenCalledWith(
      "tok-abc",
      expect.any(String),
      "active",
      1,
    );
  });
});
