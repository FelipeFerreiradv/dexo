import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import prisma from "@/app/lib/prisma";
import { WebhookUseCase } from "@/app/marketplaces/usecases/webhook.usercase";
import { MarketplaceRepository } from "@/app/marketplaces/repositories/marketplace.repository";
import { ListingRepository } from "@/app/marketplaces/repositories/listing.repository";
import { MLApiService } from "@/app/marketplaces/services/ml-api.service";
import { MLOAuthService } from "@/app/marketplaces/services/ml-oauth.service";
import { ListingAutodetectUseCase } from "@/app/marketplaces/usecases/listing-autodetect.usercase";

const payload = (over: Record<string, any> = {}) => ({
  resource: "/items/MLB123",
  user_id: 555,
  topic: "items",
  application_id: 1,
  attempts: 1,
  sent: "2026-07-22T10:00:00Z",
  received: "2026-07-22T10:00:01Z",
  ...over,
});

const account = (over: Record<string, any> = {}) => ({
  id: "acc1",
  userId: "u1",
  status: "ACTIVE",
  accessToken: "tok",
  refreshToken: "ref",
  expiresAt: new Date(Date.now() + 3_600_000), // longe de expirar → sem refresh
  autoImportListingsSince: new Date("2026-06-01T00:00:00Z"),
  ...over,
});

const mlItem = (over: Record<string, any> = {}) => ({
  id: "MLB123",
  title: "Capo dianteiro S10",
  status: "active",
  price: 800,
  available_quantity: 1,
  permalink: "http://ml/MLB123",
  thumbnail: "http://img/t.jpg",
  pictures: [],
  attributes: [],
  seller_custom_field: "34209",
  date_created: "2026-07-01T09:00:00Z", // >= baseline
  last_updated: "2026-07-22T09:52:00Z",
  ...over,
});

const listing = (over: Record<string, any> = {}) => ({
  id: "lst1",
  productId: "p1",
  marketplaceAccountId: "acc1",
  externalListingId: "MLB123",
  status: "active",
  product: { id: "p1", userId: "u1" },
  ...over,
});

function mockClaim(duplicate = false) {
  const create = vi.spyOn(prisma.webhookEventLog as any, "create");
  if (duplicate) create.mockRejectedValue({ code: "P2002" });
  else create.mockResolvedValue({} as any);
  return create;
}

describe("WebhookUseCase.processItemWebhook — espelho de status (mirror)", () => {
  beforeEach(() => {
    process.env.LISTING_STATUS_SYNC_DISABLED = "0";
  });

  afterEach(() => {
    process.env.LISTING_STATUS_SYNC_DISABLED = "1"; // default da suíte
    vi.restoreAllMocks();
  });

  it("listing existente + remoto paused → grava status e NÃO roda autodetect (mesmo SEM baseline)", async () => {
    mockClaim();
    vi.spyOn(
      MarketplaceRepository,
      "findAllByExternalUserId",
    ).mockResolvedValue([account({ autoImportListingsSince: null })] as any);
    vi.spyOn(ListingRepository, "findByExternalListingId").mockResolvedValue(
      listing() as any,
    );
    vi.spyOn(MLApiService, "getItemDetails").mockResolvedValue(
      mlItem({ status: "paused" }) as any,
    );
    const update = vi
      .spyOn(ListingRepository, "updateStatus")
      .mockResolvedValue(listing({ status: "paused" }) as any);
    const upsert = vi.spyOn(
      ListingAutodetectUseCase,
      "upsertProductFromMarketplaceItem",
    );

    const res = await WebhookUseCase.processItemWebhook(payload() as any);

    expect(res.success).toBe(true);
    expect(res.action).toBe("status_reconciled");
    expect(update).toHaveBeenCalledWith("lst1", "paused");
    expect(upsert).not.toHaveBeenCalled();
  });

  it("listing existente + status igual → status_unchanged, sem write", async () => {
    mockClaim();
    vi.spyOn(
      MarketplaceRepository,
      "findAllByExternalUserId",
    ).mockResolvedValue([account()] as any);
    vi.spyOn(ListingRepository, "findByExternalListingId").mockResolvedValue(
      listing({ status: "active" }) as any,
    );
    vi.spyOn(MLApiService, "getItemDetails").mockResolvedValue(
      mlItem({ status: "active" }) as any,
    );
    const update = vi.spyOn(ListingRepository, "updateStatus");

    const res = await WebhookUseCase.processItemWebhook(payload() as any);

    expect(res.action).toBe("status_unchanged");
    expect(update).not.toHaveBeenCalled();
  });

  it("listing existente + remoto closed → grava closed", async () => {
    mockClaim();
    vi.spyOn(
      MarketplaceRepository,
      "findAllByExternalUserId",
    ).mockResolvedValue([account()] as any);
    vi.spyOn(ListingRepository, "findByExternalListingId").mockResolvedValue(
      listing({ status: "paused" }) as any,
    );
    vi.spyOn(MLApiService, "getItemDetails").mockResolvedValue(
      mlItem({ status: "closed" }) as any,
    );
    const update = vi
      .spyOn(ListingRepository, "updateStatus")
      .mockResolvedValue(listing({ status: "closed" }) as any);

    const res = await WebhookUseCase.processItemWebhook(payload() as any);

    expect(res.action).toBe("status_reconciled");
    expect(update).toHaveBeenCalledWith("lst1", "closed");
  });

  it("listing INEXISTENTE + item paused → fluxo legado idêntico (inactive_ignored)", async () => {
    mockClaim();
    vi.spyOn(
      MarketplaceRepository,
      "findAllByExternalUserId",
    ).mockResolvedValue([account()] as any);
    vi.spyOn(ListingRepository, "findByExternalListingId").mockResolvedValue(
      null as any,
    );
    vi.spyOn(MLApiService, "getItemDetails").mockResolvedValue(
      mlItem({ status: "paused" }) as any,
    );
    const upsert = vi.spyOn(
      ListingAutodetectUseCase,
      "upsertProductFromMarketplaceItem",
    );

    const res = await WebhookUseCase.processItemWebhook(payload() as any);

    expect(res.action).toBe("inactive_ignored");
    expect(upsert).not.toHaveBeenCalled();
  });

  it("kill-switch ligado → nem consulta listing, fluxo legado puro", async () => {
    process.env.LISTING_STATUS_SYNC_DISABLED = "1";
    mockClaim();
    vi.spyOn(
      MarketplaceRepository,
      "findAllByExternalUserId",
    ).mockResolvedValue([account({ autoImportListingsSince: null })] as any);
    const find = vi.spyOn(ListingRepository, "findByExternalListingId");

    const res = await WebhookUseCase.processItemWebhook(payload() as any);

    expect(res.action).toBe("no_baseline_skipped");
    expect(find).not.toHaveBeenCalled();
  });

  it("erro no espelho (repo rejeita) → fall-through para o legado, sem exception", async () => {
    mockClaim();
    vi.spyOn(
      MarketplaceRepository,
      "findAllByExternalUserId",
    ).mockResolvedValue([account()] as any);
    vi.spyOn(ListingRepository, "findByExternalListingId").mockRejectedValue(
      new Error("db down"),
    );
    vi.spyOn(MLApiService, "getItemDetails").mockResolvedValue(
      mlItem() as any,
    );
    const upsert = vi
      .spyOn(ListingAutodetectUseCase, "upsertProductFromMarketplaceItem")
      .mockResolvedValue({ action: "created_product", productId: "p-new" });

    const res = await WebhookUseCase.processItemWebhook(payload() as any);

    expect(res.success).toBe(true);
    expect(res.action).toBe("created_product");
    expect(upsert).toHaveBeenCalled();
  });

  it("token perto de expirar + falha pós-refresh no mirror → refresh acontece UMA só vez (single-use preservado)", async () => {
    // Regressão crítica evitada: o refresh token do ML é single-use. Se o
    // mirror refresca e depois falha, o fall-through legado NÃO pode
    // refrescar de novo com o par antigo (invalid_grant → conta ERROR).
    mockClaim();
    const acc = account({ expiresAt: new Date(Date.now() + 1_000) }); // <60s
    vi.spyOn(
      MarketplaceRepository,
      "findAllByExternalUserId",
    ).mockResolvedValue([acc] as any);
    vi.spyOn(MarketplaceRepository, "updateTokens").mockResolvedValue(
      {} as any,
    );
    const refresh = vi
      .spyOn(MLOAuthService, "refreshAccessTokenForAccount")
      .mockResolvedValue({
        accessToken: "tok-novo",
        refreshToken: "ref-novo",
        expiresIn: 21_600,
      } as any);
    vi.spyOn(ListingRepository, "findByExternalListingId").mockResolvedValue(
      listing() as any,
    );
    const getItem = vi
      .spyOn(MLApiService, "getItemDetails")
      .mockRejectedValueOnce(new Error("timeout transitório do ML")) // mirror
      .mockResolvedValue(mlItem() as any); // fluxo legado
    vi.spyOn(
      ListingAutodetectUseCase,
      "upsertProductFromMarketplaceItem",
    ).mockResolvedValue({ action: "created_product", productId: "p-new" });

    const res = await WebhookUseCase.processItemWebhook(payload() as any);

    expect(res.success).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
    // O fluxo legado reutilizou o token NOVO (objeto account mutado).
    expect(getItem).toHaveBeenLastCalledWith("tok-novo", "MLB123");
  });

  it("dedupe P2002 vem antes do espelho → duplicate_ignored", async () => {
    mockClaim(true);
    const find = vi.spyOn(ListingRepository, "findByExternalListingId");

    const res = await WebhookUseCase.processItemWebhook(payload() as any);

    expect(res.action).toBe("duplicate_ignored");
    expect(find).not.toHaveBeenCalled();
  });
});
