import { describe, it, expect, vi, afterEach } from "vitest";

import prisma from "@/app/lib/prisma";
import { WebhookUseCase } from "@/app/marketplaces/usecases/webhook.usercase";
import { MarketplaceRepository } from "@/app/marketplaces/repositories/marketplace.repository";
import { MLApiService } from "@/app/marketplaces/services/ml-api.service";
import { ListingAutodetectUseCase } from "@/app/marketplaces/usecases/listing-autodetect.usercase";

const payload = (over: Record<string, any> = {}) => ({
  resource: "/items/MLB123",
  user_id: 555,
  topic: "items",
  application_id: 1,
  attempts: 1,
  sent: "2026-06-18T10:00:00Z",
  received: "2026-06-18T10:00:01Z",
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
  title: "Roda Liga Leve",
  status: "active",
  price: 100,
  available_quantity: 5,
  permalink: "http://ml/MLB123",
  thumbnail: "http://img/t.jpg",
  pictures: [],
  attributes: [],
  seller_custom_field: "SKU-1",
  date_created: "2026-06-18T09:00:00Z", // >= baseline
  last_updated: "2026-06-18T09:30:00Z",
  ...over,
});

// claim "novo" (create resolve) | "duplicado" (P2002)
function mockClaim(duplicate = false) {
  const create = vi.spyOn(prisma.webhookEventLog as any, "create");
  if (duplicate) create.mockRejectedValue({ code: "P2002" });
  else create.mockResolvedValue({} as any);
  return create;
}

describe("WebhookUseCase.validateItemWebhookPayload", () => {
  it("aceita payload de items válido", () => {
    expect(WebhookUseCase.validateItemWebhookPayload(payload())).toBe(true);
  });

  it("rejeita topic diferente de items", () => {
    expect(
      WebhookUseCase.validateItemWebhookPayload(
        payload({ topic: "orders_v2" }),
      ),
    ).toBe(false);
  });

  it("rejeita resource fora do formato /items/{id}", () => {
    expect(
      WebhookUseCase.validateItemWebhookPayload(
        payload({ resource: "/orders/123" }),
      ),
    ).toBe(false);
  });

  it("rejeita payload sem campos obrigatórios", () => {
    expect(
      WebhookUseCase.validateItemWebhookPayload(
        payload({ application_id: undefined }),
      ),
    ).toBe(false);
    expect(
      WebhookUseCase.validateItemWebhookPayload(payload({ attempts: "1" })),
    ).toBe(false);
  });
});

describe("WebhookUseCase.processItemWebhook", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("dedup: reentrega do mesmo evento (P2002) → duplicate_ignored, não resolve conta", async () => {
    mockClaim(true);
    const findAll = vi.spyOn(MarketplaceRepository, "findAllByExternalUserId");

    const res = await WebhookUseCase.processItemWebhook(payload() as any);

    expect(res.action).toBe("duplicate_ignored");
    expect(findAll).not.toHaveBeenCalled();
  });

  it("conta não encontrada → erro", async () => {
    mockClaim();
    vi.spyOn(
      MarketplaceRepository,
      "findAllByExternalUserId",
    ).mockResolvedValue([] as any);

    const res = await WebhookUseCase.processItemWebhook(payload() as any);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/não encontrada/i);
  });

  it("múltiplas contas ativas → erro (ambíguo)", async () => {
    mockClaim();
    vi.spyOn(
      MarketplaceRepository,
      "findAllByExternalUserId",
    ).mockResolvedValue([account(), account({ id: "acc2" })] as any);

    const res = await WebhookUseCase.processItemWebhook(payload() as any);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Múltiplas contas/i);
  });

  it("conta inativa → erro", async () => {
    mockClaim();
    vi.spyOn(
      MarketplaceRepository,
      "findAllByExternalUserId",
    ).mockResolvedValue([account({ status: "INACTIVE" })] as any);

    const res = await WebhookUseCase.processItemWebhook(payload() as any);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/não está ativa/i);
  });

  it("sem baseline (autoImportListingsSince null) → no_baseline_skipped (fail-safe)", async () => {
    mockClaim();
    vi.spyOn(
      MarketplaceRepository,
      "findAllByExternalUserId",
    ).mockResolvedValue([account({ autoImportListingsSince: null })] as any);
    const getItem = vi.spyOn(MLApiService, "getItemDetails");

    const res = await WebhookUseCase.processItemWebhook(payload() as any);
    expect(res.action).toBe("no_baseline_skipped");
    expect(getItem).not.toHaveBeenCalled();
  });

  it("anúncio antigo (date_created < baseline) → not_new_ignored, não cria produto", async () => {
    mockClaim();
    vi.spyOn(
      MarketplaceRepository,
      "findAllByExternalUserId",
    ).mockResolvedValue([account()] as any);
    vi.spyOn(MLApiService, "getItemDetails").mockResolvedValue(
      mlItem({ date_created: "2026-05-01T00:00:00Z" }) as any, // < baseline
    );
    const upsert = vi.spyOn(
      ListingAutodetectUseCase,
      "upsertProductFromMarketplaceItem",
    );

    const res = await WebhookUseCase.processItemWebhook(payload() as any);
    expect(res.action).toBe("not_new_ignored");
    expect(upsert).not.toHaveBeenCalled();
  });

  it("anúncio não ativo → inactive_ignored", async () => {
    mockClaim();
    vi.spyOn(
      MarketplaceRepository,
      "findAllByExternalUserId",
    ).mockResolvedValue([account()] as any);
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

  it("anúncio novo ativo → cria produto via núcleo e devolve a ação", async () => {
    mockClaim();
    vi.spyOn(
      MarketplaceRepository,
      "findAllByExternalUserId",
    ).mockResolvedValue([account()] as any);
    vi.spyOn(MLApiService, "getItemDetails").mockResolvedValue(mlItem() as any);
    const upsert = vi
      .spyOn(ListingAutodetectUseCase, "upsertProductFromMarketplaceItem")
      .mockResolvedValue({ action: "created_product", productId: "p-new" });

    const res = await WebhookUseCase.processItemWebhook(payload() as any);

    expect(res.success).toBe(true);
    expect(res.action).toBe("created_product");
    expect(res.productId).toBe("p-new");
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: "MERCADO_LIVRE",
        account: { id: "acc1", userId: "u1" },
        externalListingId: "MLB123",
        rawSku: "SKU-1",
      }),
    );
  });
});
