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
 *
 * MUDANÇA DE COMPORTAMENTO (item D-1 do plano de paridade): OLX e FACEBOOK
 * passaram a ter retry PRÓPRIO, delegando ao create da própria plataforma —
 * mesmo desenho do branch da Shopee. Antes o retry deles era desabilitado, e
 * uma falha transitória (5xx da OLX, rate limit da Meta) matava o anúncio na
 * primeira tentativa. O invariante de não vazar token para o ML permanece e
 * continua travado aqui; o MAGALU segue sem retry (não tem branch próprio).
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
  it("não chama MLApiService e DELEGA o retry de listing OLX ao create da OLX", async () => {
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
    const { ListingUseCase } = await import("../../usecases/listing.usercase");
    const createSpy = vi
      .spyOn(ListingUseCase, "createOlxListing")
      .mockResolvedValue({ success: true } as any);

    await ListingRetryService.runOnce();

    // Invariante que NÃO muda: token da OLX nunca vai para o ML.
    expect(mlSpy).not.toHaveBeenCalled();
    expect(createSpy).toHaveBeenCalledWith("user-1", "prod-1", undefined, "acc-1");
    // O create cuida do próprio estado — o retry não desabilita mais nada aqui.
    expect(incSpy).not.toHaveBeenCalled();
  });

  it("não chama MLApiService e DELEGA o retry de listing FACEBOOK ao create do Facebook", async () => {
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
    const { ListingUseCase } = await import("../../usecases/listing.usercase");
    const createSpy = vi
      .spyOn(ListingUseCase, "createFacebookListing")
      .mockResolvedValue({ success: true } as any);

    await ListingRetryService.runOnce();

    expect(mlSpy).not.toHaveBeenCalled();
    expect(createSpy).toHaveBeenCalledWith("user-1", "prod-1", undefined, "acc-1");
    expect(incSpy).not.toHaveBeenCalled();
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

describe("ListingRetryService — teto de tentativas e kill-switch (OLX/Facebook)", () => {
  it("recusa DEFINITIVA da OLX sai da fila na 1a tentativa, sem republicar para sempre", async () => {
    vi.spyOn(ListingRepository, "findPendingRetries").mockResolvedValue([
      makeListing(Platform.OLX),
    ] as any);
    vi.spyOn(ListingRepository, "claimRetryCandidate").mockResolvedValue(
      true as any,
    );
    const incSpy = vi
      .spyOn(ListingRepository, "incrementRetryAttempts")
      .mockResolvedValue(undefined as any);
    const { ListingUseCase } = await import("../../usecases/listing.usercase");
    vi.spyOn(ListingUseCase, "createOlxListing").mockResolvedValue({
      success: false,
      error: "OLX recusou o anúncio: REFUSED_SUSPECT_PRICE",
    } as any);

    await ListingRetryService.runOnce();

    // Sem isto o create regravaria retryEnabled:true a cada 60s, para sempre:
    // ~1.440 chamadas/dia à OLX por um anúncio que ela nunca vai aceitar.
    expect(incSpy).toHaveBeenCalledWith(
      "listing-1",
      expect.objectContaining({ retryEnabled: false, nextRetryAt: null }),
    );
    expect(
      (incSpy.mock.calls[0][1] as any).lastError.startsWith("[TERMINAL]"),
    ).toBe(true);
  });

  it("falha TRANSITORIA continua reagendando, com backoff", async () => {
    vi.spyOn(ListingRepository, "findPendingRetries").mockResolvedValue([
      makeListing(Platform.FACEBOOK),
    ] as any);
    vi.spyOn(ListingRepository, "claimRetryCandidate").mockResolvedValue(
      true as any,
    );
    const incSpy = vi
      .spyOn(ListingRepository, "incrementRetryAttempts")
      .mockResolvedValue(undefined as any);
    const { ListingUseCase } = await import("../../usecases/listing.usercase");
    vi.spyOn(ListingUseCase, "createFacebookListing").mockResolvedValue({
      success: false,
      error: "socket hang up",
    } as any);

    await ListingRetryService.runOnce();

    const arg = incSpy.mock.calls[0][1] as any;
    expect(arg.retryEnabled).toBe(true);
    expect(arg.nextRetryAt).toBeInstanceOf(Date);
  });

  it("kill-switch ligado ⇒ o cron NAO publica e NAO consome tentativa", async () => {
    const anterior = process.env.OLX_INTEGRATION_DISABLED;
    process.env.OLX_INTEGRATION_DISABLED = "1";
    try {
      vi.spyOn(ListingRepository, "findPendingRetries").mockResolvedValue([
        makeListing(Platform.OLX),
      ] as any);
      vi.spyOn(ListingRepository, "claimRetryCandidate").mockResolvedValue(
        true as any,
      );
      const incSpy = vi
        .spyOn(ListingRepository, "incrementRetryAttempts")
        .mockResolvedValue(undefined as any);
      const { ListingUseCase } = await import("../../usecases/listing.usercase");
      const createSpy = vi
        .spyOn(ListingUseCase, "createOlxListing")
        .mockResolvedValue({ success: true } as any);

      await ListingRetryService.runOnce();

      // O cron de retry era o unico caminho de publicacao que o kill-switch
      // nao cobria: com a integracao pausada, ele seguia publicando na OLX.
      expect(createSpy).not.toHaveBeenCalled();
      const arg = incSpy.mock.calls[0][1] as any;
      expect(arg.retryEnabled).toBeUndefined();
      expect(arg.nextRetryAt).toBeInstanceOf(Date);
    } finally {
      if (anterior === undefined) delete process.env.OLX_INTEGRATION_DISABLED;
      else process.env.OLX_INTEGRATION_DISABLED = anterior;
    }
  });
});
