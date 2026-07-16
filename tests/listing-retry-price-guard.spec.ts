import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";
import { ListingRetryService } from "../app/marketplaces/services/listing-retry.service";
import { ListingRepository } from "../app/marketplaces/repositories/listing.repository";
import { MLApiService } from "../app/marketplaces/services/ml-api.service";
import { CategoryResolutionService } from "../app/marketplaces/services/category-resolution.service";

/**
 * Regressão: o guard terminal de preço reprovava TODO produto.
 *
 * `findPendingRetries` usa `include: { product: true }`, então `product.price`
 * é um `Prisma.Decimal` (typeof === "object") e não um number. O guard
 * comparava `typeof product.price === "number"`, reprovava sempre, e marcava
 * o anúncio como `[TERMINAL] Produto sem preço (price=0)` com
 * retryEnabled=false — sobrescrevendo o lastError real (ex.: family_name).
 * Em produção isso desligou 1.374 anúncios de produtos com preço válido.
 *
 * Estes testes usam `Prisma.Decimal` de propósito: é o que o banco devolve.
 * Mockar `price: 10` (number literal) afirma um contrato que a produção viola
 * e deixa a regressão passar.
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
  },
}));

vi.mock("../app/services/system-log.service", () => ({
  SystemLogService: { logError: vi.fn(), log: vi.fn() },
}));

// Deps que tocam banco/rede depois do guard. O fluxo pós-guard não é o objeto
// deste teste — só precisamos que ele pare de forma controlada.
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

vi.mock("../app/marketplaces/repositories/marketplace.repository", () => ({
  MarketplaceRepository: { findByIdAndUser: vi.fn(), updateStatus: vi.fn() },
}));

vi.mock("../app/marketplaces/services/image-resize.service", () => ({
  ensureMLMinImageSize: vi.fn(),
}));

const makeCandidate = (price: Prisma.Decimal | number, stock = 1) =>
  ({
    id: "pl-price-guard",
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
      price,
      stock,
    },
    marketplaceAccount: {
      id: "acct-1",
      accessToken: "tok",
      platform: "MERCADO_LIVRE",
      userId: "user-1",
      externalUserId: "123",
    },
  }) as any;

const errorsMatching = (needle: string) =>
  (ListingRepository.incrementRetryAttempts as any).mock.calls.filter(
    (call: any[]) => String(call[1]?.lastError || "").includes(needle),
  );

describe("ListingRetryService — guard de preço com Decimal do Prisma", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // O capability check roda ANTES do guard: precisa passar para o guard ser
    // exercitado de verdade.
    (MLApiService.getSellerItemIds as any).mockResolvedValue([]);
    // Primeiro efeito depois do guard. Falhar aqui encerra o candidato de
    // forma controlada, sem tocar banco nem ML.
    (CategoryResolutionService.resolveMLCategory as any).mockRejectedValue(
      new Error("stop-after-guard"),
    );
  });

  it("NÃO marca como terminal um produto com preço válido em Decimal", async () => {
    (ListingRepository.findPendingRetries as any).mockResolvedValue([
      makeCandidate(new Prisma.Decimal("629.00")),
    ]);

    await ListingRetryService.runOnce();

    expect(errorsMatching("sem preço")).toHaveLength(0);
  });

  it("passa do guard e segue o fluxo quando o preço é um Decimal válido", async () => {
    (ListingRepository.findPendingRetries as any).mockResolvedValue([
      makeCandidate(new Prisma.Decimal("1350.00")),
    ]);

    await ListingRetryService.runOnce();

    // O guard dava `continue` antes de resolver categoria. Chegar aqui prova
    // que o candidato passou pelo guard.
    expect(CategoryResolutionService.resolveMLCategory).toHaveBeenCalled();
  });

  it("continua marcando como terminal quando o preço é realmente zero", async () => {
    (ListingRepository.findPendingRetries as any).mockResolvedValue([
      makeCandidate(new Prisma.Decimal("0")),
    ]);

    await ListingRetryService.runOnce();

    const calls = errorsMatching("sem preço");
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toMatchObject({
      retryEnabled: false,
      nextRetryAt: null,
    });
    // Preço inválido nunca é aceito pelo ML: não gasta a criação.
    expect(CategoryResolutionService.resolveMLCategory).not.toHaveBeenCalled();
  });

  it("continua marcando como terminal quando não há estoque", async () => {
    (ListingRepository.findPendingRetries as any).mockResolvedValue([
      makeCandidate(new Prisma.Decimal("629.00"), 0),
    ]);

    await ListingRetryService.runOnce();

    expect(errorsMatching("sem estoque (stock=0)")).toHaveLength(1);
  });
});

describe("ListingRetryService — trava de reentrância", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ignora um disparo enquanto a passada anterior está em voo", async () => {
    let releaseFirstPass: () => void = () => {};
    const firstPassBlocked = new Promise<void>((resolve) => {
      releaseFirstPass = resolve;
    });

    (ListingRepository.findPendingRetries as any).mockImplementation(
      async () => {
        await firstPassBlocked;
        return [];
      },
    );

    const inFlight = ListingRetryService.runOnce();
    // Segundo disparo (cron ou POST /ml/retry-pending) com a passada em voo:
    // sem a trava, leria o mesmo lote e criaria anúncios duplicados no ML.
    await ListingRetryService.runOnce();

    expect(ListingRepository.findPendingRetries).toHaveBeenCalledTimes(1);

    releaseFirstPass();
    await inFlight;

    // Terminada a passada, a trava libera o próximo disparo.
    await ListingRetryService.runOnce();
    expect(ListingRepository.findPendingRetries).toHaveBeenCalledTimes(2);
  });
});
