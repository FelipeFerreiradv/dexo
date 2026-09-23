import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fastify from "fastify";

/**
 * POST /listings/:id/retry-ml — botão "Tentar publicar novamente".
 *
 * A revisão de 23/09/2026 achou que o botão podia rodar o create ao mesmo
 * tempo que o cron (ou que um segundo clique) e publicar DUAS vezes no ML, e
 * que recriava sem conferir quando a linha não tinha `[VERIFICAR]`. Estes
 * testes travam: dono, 409 com retry agendado, reserva atômica, conferência
 * SEMPRE antes de criar, ambíguo/sem conferência não cria, reserva liberada.
 */

vi.mock("../app/marketplaces/usecases/listing.usercase", () => ({
  ListingUseCase: { createMLListing: vi.fn() },
}));

vi.mock("../app/marketplaces/services/listing-dispatcher.service", () => ({
  ListingDispatcher: { dispatch: vi.fn() },
}));

vi.mock(
  "../app/marketplaces/repositories/bulk-listing-job.repository",
  () => ({ BulkListingJobRepository: {} }),
);

vi.mock("../app/marketplaces/repositories/marketplace.repository", () => ({
  MarketplaceRepository: { findByIdAndUser: vi.fn(), updateTokens: vi.fn() },
}));

vi.mock("../app/marketplaces/repositories/listing.repository", () => ({
  ListingRepository: {
    claimInteractiveRetry: vi.fn(),
    releaseInteractiveRetry: vi.fn(async () => undefined),
    findBusyMlPlaceholderInPair: vi.fn(async () => null),
    updateListing: vi.fn(),
  },
}));

vi.mock("../app/marketplaces/services/listing-retry.service", () => ({
  ListingRetryService: { reconcileBeforeRecreate: vi.fn() },
}));

vi.mock("../app/marketplaces/services/ml-oauth.service", () => ({
  MLOAuthService: { refreshAccessTokenForAccount: vi.fn() },
}));

vi.mock("../app/services/system-log.service", () => ({
  SystemLogService: {
    logError: vi.fn(),
    logWarning: vi.fn(),
    logInfo: vi.fn(),
    log: vi.fn(),
  },
}));

vi.mock("../app/lib/prisma", () => ({
  default: {
    productListing: { findFirst: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));

import { listingRoutes } from "../app/routes/listing.routes";
import { UserRepositoryPrisma } from "../app/repositories/user.repository";
import { ListingUseCase } from "../app/marketplaces/usecases/listing.usercase";
import { ListingRepository } from "../app/marketplaces/repositories/listing.repository";
import { ListingRetryService } from "../app/marketplaces/services/listing-retry.service";
import { MLOAuthService } from "../app/marketplaces/services/ml-oauth.service";
import { MarketplaceRepository } from "../app/marketplaces/repositories/marketplace.repository";
import prisma from "../app/lib/prisma";

const fakeUser = {
  id: "user-1",
  email: "test@example.com",
  name: "Test User",
  dataOwnerId: "user-1",
} as any;

// Reserva VIGENTE: relativa ao relógio. A data fixa que estava aqui
// (2026-09-23T12:10Z) venceu no próprio dia e o teste passou a falhar.
const RESERVA = new Date(Date.now() + 10 * 60_000);

const linha = (over: Record<string, unknown> = {}) => ({
  id: "pl-1",
  productId: "prod-1",
  marketplaceAccountId: "acct-1",
  externalListingId: "PENDING_1",
  status: "error",
  retryEnabled: false,
  nextRetryAt: null,
  lastError: "[TERMINAL][CORRIGIVEL] GTIN inválido",
  requestedCategoryId: "MLB192571",
  createdAt: new Date("2026-09-22T19:34:12.000Z"),
  listingType: "gold_premium",
  freeShipping: true,
  attributesOverride: null,
  product: { sku: "3398", name: "Sensor MAF" },
  marketplaceAccount: {
    id: "acct-1",
    platform: "MERCADO_LIVRE",
    accessToken: "tok",
    refreshToken: "ref",
    expiresAt: new Date(Date.now() + 3600_000),
    externalUserId: "seller-1",
  },
  ...over,
});

describe("POST /listings/:id/retry-ml", () => {
  let app: ReturnType<typeof fastify>;

  beforeEach(async () => {
    vi.clearAllMocks();
    delete process.env.ML_REQUIRED_ATTRS_BLOCK;
    vi.spyOn(console, "error").mockImplementation(() => {});
    app = fastify();
    await app.register(listingRoutes, { prefix: "/listings" });
    vi.spyOn(UserRepositoryPrisma.prototype, "findByEmail").mockResolvedValue(fakeUser);
    vi.spyOn(UserRepositoryPrisma.prototype, "findById").mockResolvedValue(fakeUser);
    (prisma.productListing.findFirst as any).mockResolvedValue(linha());
    (ListingRepository.claimInteractiveRetry as any).mockResolvedValue(RESERVA);
    (ListingRetryService.reconcileBeforeRecreate as any).mockResolvedValue("not_found");
    (ListingRepository.findBusyMlPlaceholderInPair as any).mockResolvedValue(null);
    (ListingUseCase.createMLListing as any).mockResolvedValue({
      success: true,
      externalListingId: "MLB9",
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  const tentar = () =>
    app.inject({
      method: "POST",
      url: "/listings/pl-1/retry-ml",
      headers: { email: "test@example.com" },
    });

  it("busca a linha pelo DONO do produto (tenant)", async () => {
    await tentar();
    expect((prisma.productListing.findFirst as any).mock.calls[0][0].where).toEqual({
      id: "pl-1",
      product: { userId: "user-1" },
    });
  });

  it("linha de outro dono / inexistente ⇒ 404, nada é criado", async () => {
    (prisma.productListing.findFirst as any).mockResolvedValue(null);
    const res = await tentar();
    expect(res.statusCode).toBe(404);
    expect(ListingUseCase.createMLListing).not.toHaveBeenCalled();
  });

  it("retry automático ligado (agendado ou em execução pelo cron) ⇒ 409, sem reserva nem create", async () => {
    (prisma.productListing.findFirst as any).mockResolvedValue(
      linha({ retryEnabled: true, nextRetryAt: new Date(Date.now() + 60_000) }),
    );
    const res = await tentar();
    expect(res.statusCode).toBe(409);
    expect(ListingRepository.claimInteractiveRetry).not.toHaveBeenCalled();
    expect(ListingUseCase.createMLListing).not.toHaveBeenCalled();
  });

  it("reserva negada (outro clique em andamento) ⇒ 409, sem create", async () => {
    (ListingRepository.claimInteractiveRetry as any).mockResolvedValue(null);
    const res = await tentar();
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/em andamento/);
    expect(ListingUseCase.createMLListing).not.toHaveBeenCalled();
  });

  it("SEMPRE confere no ML antes de criar — mesmo sem [VERIFICAR]", async () => {
    const res = await tentar();
    expect(res.statusCode).toBe(200);
    expect(ListingRetryService.reconcileBeforeRecreate).toHaveBeenCalledTimes(1);
    const ordem = [
      (ListingRetryService.reconcileBeforeRecreate as any).mock.invocationCallOrder[0],
      (ListingUseCase.createMLListing as any).mock.invocationCallOrder[0],
    ];
    expect(ordem[0]).toBeLessThan(ordem[1]);
  });

  it("achou o item no ML ⇒ adota, NÃO cria", async () => {
    (ListingRetryService.reconcileBeforeRecreate as any).mockResolvedValue("adopted");
    const res = await tentar();
    expect(res.statusCode).toBe(200);
    expect(res.json().reconciled).toBe(true);
    expect(ListingUseCase.createMLListing).not.toHaveBeenCalled();
  });

  it("item com o mesmo SKU e outro título ⇒ 409 (a pessoa confere), NÃO cria", async () => {
    (ListingRetryService.reconcileBeforeRecreate as any).mockResolvedValue("ambiguous");
    const res = await tentar();
    expect(res.statusCode).toBe(409);
    expect(ListingUseCase.createMLListing).not.toHaveBeenCalled();
  });

  it("não deu para conferir ⇒ 503, NÃO cria; a conferência é a INTERATIVA (não grava tentativa nem marcador)", async () => {
    (ListingRetryService.reconcileBeforeRecreate as any).mockResolvedValue("search_failed");
    const res = await tentar();
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatch(/Nada foi publicado/);
    expect(res.json().error).not.toMatch(/sozinha/);
    expect(ListingUseCase.createMLListing).not.toHaveBeenCalled();
    expect((ListingRetryService.reconcileBeforeRecreate as any).mock.calls[0][2]).toEqual({
      interactive: true,
    });
  });

  it("outro pendente do MESMO par agendado ou em andamento ⇒ 409, sem reserva nem create", async () => {
    (ListingRepository.findBusyMlPlaceholderInPair as any).mockResolvedValue({ id: "pl-2" });
    const res = await tentar();
    expect(res.statusCode).toBe(409);
    expect(ListingRepository.findBusyMlPlaceholderInPair).toHaveBeenCalledWith(
      "prod-1",
      "acct-1",
      "pl-1",
    );
    expect(ListingRepository.claimInteractiveRetry).not.toHaveBeenCalled();
    expect(ListingUseCase.createMLListing).not.toHaveBeenCalled();
  });

  it("cria com as configurações do PRÓPRIO pendente e libera a reserva no fim", async () => {
    await tentar();
    const args = (ListingUseCase.createMLListing as any).mock.calls[0];
    expect(args.slice(0, 4)).toEqual(["user-1", "prod-1", "MLB192571", "acct-1"]);
    expect(args[4]).toMatchObject({ listingType: "gold_premium", freeShipping: true });
    expect(args[7]).toBeUndefined();
    // A reserva vai junto: só quem a tem pode reaproveitar a linha reservada.
    expect(args[8]).toEqual({ reservation: { listingId: "pl-1", at: RESERVA } });
    expect(ListingRepository.releaseInteractiveRetry).toHaveBeenCalledWith("pl-1", RESERVA);
  });

  it("recusa do ML ⇒ 422 com a mensagem humana; a reserva também é liberada", async () => {
    (ListingUseCase.createMLListing as any).mockResolvedValue({
      success: false,
      error: "O campo GTIN está inválido.",
      errorKind: "VALIDATION",
    });
    const res = await tentar();
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("O campo GTIN está inválido.");
    expect(ListingRepository.releaseInteractiveRetry).toHaveBeenCalledWith("pl-1", RESERVA);
  });

  it("publicação demorada ⇒ 202 'ainda publicando'; a reserva só é liberada quando ela termina", async () => {
    process.env.ML_RETRY_BUTTON_WAIT_MS = "30";
    let terminar: (v: unknown) => void = () => {};
    (ListingUseCase.createMLListing as any).mockReturnValue(
      new Promise((resolve) => {
        terminar = resolve;
      }),
    );
    try {
      const res = await tentar();
      expect(res.statusCode).toBe(202);
      expect(res.json().pending).toBe(true);
      expect(ListingRepository.releaseInteractiveRetry).not.toHaveBeenCalled();
      terminar({ success: true, externalListingId: "MLB9" });
      await new Promise((r) => setTimeout(r, 10));
      expect(ListingRepository.releaseInteractiveRetry).toHaveBeenCalledWith(
        "pl-1",
        RESERVA,
      );
    } finally {
      delete process.env.ML_RETRY_BUTTON_WAIT_MS;
    }
  });

  it("com ML_REQUIRED_ATTRS_BLOCK=1 repassa a ficha guardada no pendente (igual ao cron)", async () => {
    process.env.ML_REQUIRED_ATTRS_BLOCK = "1";
    const ficha = { SIDE: { value_id: "1", value_name: "Direito" } };
    (prisma.productListing.findFirst as any).mockResolvedValue(
      linha({ attributesOverride: ficha }),
    );
    await tentar();
    const args = (ListingUseCase.createMLListing as any).mock.calls[0];
    expect(args[7]).toEqual(ficha);
    delete process.env.ML_REQUIRED_ATTRS_BLOCK;
  });

  it("token vencendo ⇒ renova antes de conferir no ML", async () => {
    (prisma.productListing.findFirst as any).mockResolvedValue(
      linha({
        marketplaceAccount: {
          id: "acct-1",
          platform: "MERCADO_LIVRE",
          accessToken: "velho",
          refreshToken: "ref",
          expiresAt: new Date(Date.now() - 1000),
          externalUserId: "seller-1",
        },
      }),
    );
    (MLOAuthService.refreshAccessTokenForAccount as any).mockResolvedValue({
      accessToken: "novo",
      refreshToken: "ref2",
      expiresIn: 21600,
    });
    await tentar();
    expect(MarketplaceRepository.updateTokens).toHaveBeenCalled();
    const conta = (ListingRetryService.reconcileBeforeRecreate as any).mock.calls[0][1];
    expect(conta.accessToken).toBe("novo");
  });

  it("republicação (PENDING_REPUBLISH_) e anúncio real ⇒ 409", async () => {
    for (const ext of ["PENDING_REPUBLISH_MLB1_1", "MLB123"]) {
      (prisma.productListing.findFirst as any).mockResolvedValue(
        linha({ externalListingId: ext }),
      );
      const res = await tentar();
      expect(res.statusCode).toBe(409);
    }
    expect(ListingUseCase.createMLListing).not.toHaveBeenCalled();
  });
});
