import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Prisma } from "@prisma/client";
import { ListingRetryService } from "../app/marketplaces/services/listing-retry.service";
import { ListingRepository } from "../app/marketplaces/repositories/listing.repository";
import { MLApiService } from "../app/marketplaces/services/ml-api.service";
import { ListingUseCase } from "../app/marketplaces/usecases/listing.usercase";

/**
 * Claim atômico por candidato — a trava ENTRE PROCESSOS do cron de retry.
 *
 * A trava `passInFlight` é por processo. Em produção (16/07) rodaram DOIS
 * crons em paralelo: o pm2 gerencia um wrapper `npm exec` e, num restart de
 * deploy, o node neto do deploy anterior sobreviveu como órfão por minutos —
 * processando os mesmos candidatos com código antigo (escritas de duas
 * versões na mesma janela, flagradas no piloto de reabilitação). Dois
 * processos criando o mesmo anúncio = item duplicado no ML.
 *
 * O claim é um UPDATE condicional atômico: só um processo vence a corrida por
 * candidato; quem perde, pula. Sem estado de sessão — advisory lock foi
 * descartado porque, com o pool do Prisma, o unlock pode cair em outra
 * conexão e o lock ficaria preso para sempre.
 */

vi.mock("../app/marketplaces/repositories/listing.repository", () => ({
  ListingRepository: {
    findPendingRetries: vi.fn(),
    incrementRetryAttempts: vi.fn(),
    updateListing: vi.fn(),
    findRetryStateById: vi.fn(),
    claimRetryCandidate: vi.fn(),
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

describe("ListingRetryService — claim atômico por candidato", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (MLApiService.getSellerItemIds as any).mockResolvedValue([]);
    (ListingRepository.findRetryStateById as any).mockResolvedValue({
      id: "pl-1",
      retryEnabled: true,
    });
  });

  it("candidato NÃO clamado (outro processo venceu) é pulado sem NENHUM efeito", async () => {
    (ListingRepository.findPendingRetries as any).mockResolvedValue([
      makeCandidate(),
    ]);
    (ListingRepository.claimRetryCandidate as any).mockResolvedValue(false);

    await ListingRetryService.runOnce();

    // Nada acontece: sem delegação, sem chamadas ao ML, sem escrita.
    expect(ListingUseCase.createMLListing).not.toHaveBeenCalled();
    expect(MLApiService.getSellerItemIds).not.toHaveBeenCalled();
    expect(ListingRepository.incrementRetryAttempts).not.toHaveBeenCalled();
    expect(ListingRepository.updateListing).not.toHaveBeenCalled();
  });

  it("o claim acontece ANTES do desvio Shopee (protege as duas plataformas)", async () => {
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
    (ListingRepository.claimRetryCandidate as any).mockResolvedValue(false);

    await ListingRetryService.runOnce();

    expect(ListingRepository.claimRetryCandidate).toHaveBeenCalledWith(
      "pl-1",
      expect.any(Number),
    );
    expect(ListingUseCase.createShopeeListing).not.toHaveBeenCalled();
  });

  it("candidato clamado segue o fluxo normal (delegação ML)", async () => {
    (ListingRepository.findPendingRetries as any).mockResolvedValue([
      makeCandidate(),
    ]);
    (ListingRepository.claimRetryCandidate as any).mockResolvedValue(true);
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

  it("claim de um candidato não afeta os demais do lote", async () => {
    (ListingRepository.findPendingRetries as any).mockResolvedValue([
      makeCandidate({ id: "pl-a" }),
      makeCandidate({ id: "pl-b" }),
    ]);
    // pl-a perdido para outro processo; pl-b clamado.
    (ListingRepository.claimRetryCandidate as any).mockImplementation(
      async (id: string) => id === "pl-b",
    );
    (ListingUseCase.createMLListing as any).mockResolvedValue({
      success: true,
      externalListingId: "MLB999",
    });

    await ListingRetryService.runOnce();

    expect(ListingUseCase.createMLListing).toHaveBeenCalledTimes(1);
  });
});

describe("ListingRepository.claimRetryCandidate — contrato do UPDATE condicional", () => {
  // Este describe usa o módulo REAL do repo com o prisma mockado por spy.
  // vi.doMock não ajuda aqui (o módulo já foi mockado acima), então validamos
  // o contrato via um import isolado.
  it("contrato: where exige elegibilidade e o data empurra o lease", async () => {
    const { ListingRepository: RealRepo } = await vi.importActual<
      typeof import("../app/marketplaces/repositories/listing.repository")
    >("../app/marketplaces/repositories/listing.repository");
    const prisma = (
      await vi.importActual<typeof import("../app/lib/prisma")>(
        "../app/lib/prisma",
      )
    ).default;

    const spy = vi
      .spyOn(prisma.productListing, "updateMany")
      .mockResolvedValue({ count: 1 } as any);

    const before = Date.now();
    const ok = await RealRepo.claimRetryCandidate("l1", 600_000);

    expect(ok).toBe(true);
    const arg = spy.mock.calls[0][0] as any;
    // Elegibilidade: mesmo predicado da fila — retry ligado e lease vencido.
    expect(arg.where).toMatchObject({ id: "l1", retryEnabled: true });
    expect(arg.where.OR).toHaveLength(2);
    // O lease empurra o candidato para fora da janela dos concorrentes.
    const lease = arg.data.nextRetryAt as Date;
    expect(lease.getTime()).toBeGreaterThanOrEqual(before + 600_000 - 1000);

    spy.mockRestore();
  });

  it("contrato: count 0 = perdeu a corrida", async () => {
    const { ListingRepository: RealRepo } = await vi.importActual<
      typeof import("../app/marketplaces/repositories/listing.repository")
    >("../app/marketplaces/repositories/listing.repository");
    const prisma = (
      await vi.importActual<typeof import("../app/lib/prisma")>(
        "../app/lib/prisma",
      )
    ).default;

    const spy = vi
      .spyOn(prisma.productListing, "updateMany")
      .mockResolvedValue({ count: 0 } as any);

    expect(await RealRepo.claimRetryCandidate("l1", 600_000)).toBe(false);
    spy.mockRestore();
  });
});
