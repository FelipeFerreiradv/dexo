import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { Platform } from "@prisma/client";

import { ProductUseCase } from "@/app/usecases/product.usercase";
import { ListingUseCase } from "@/app/marketplaces/usecases/listing.usercase";

const makeListing = (id: string, externalId: string, platform: Platform) => ({
  id,
  externalListingId: externalId,
  marketplaceAccountId: `acc-${id}`,
  marketplaceAccount: { platform, id: `acc-${id}`, userId: "user-1" },
});

describe("ProductUseCase.pauseListings", () => {
  let useCase: ProductUseCase;

  beforeEach(() => {
    useCase = new ProductUseCase();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("retorna 'Produto nao encontrado' sem buscar listings se ownership/existencia falham", async () => {
    vi.spyOn((useCase as any).productRepository, "findById").mockResolvedValue(
      null,
    );
    const spyGetListings = vi.spyOn(useCase as any, "getProductListings");
    const spyUpdate = vi.spyOn(ListingUseCase, "updateListingStatus");

    const result = await useCase.pauseListings("prod-X", "user-1", "paused");

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/não encontrado/);
    expect(result.listingResults).toEqual([]);
    expect(spyGetListings).not.toHaveBeenCalled();
    expect(spyUpdate).not.toHaveBeenCalled();
  });

  it("filtra listings PENDING_ e sem externalListingId antes de iterar", async () => {
    vi.spyOn((useCase as any).productRepository, "findById").mockResolvedValue({
      id: "prod-1",
    });
    vi.spyOn(useCase as any, "getProductListings").mockResolvedValue([
      makeListing("l1", "MLB1", Platform.MERCADO_LIVRE),
      makeListing("l2", "PENDING_xyz", Platform.MERCADO_LIVRE),
      makeListing("l3", "", Platform.SHOPEE),
    ]);
    const spyUpdate = vi
      .spyOn(ListingUseCase, "updateListingStatus")
      .mockResolvedValue({ success: true });

    const result = await useCase.pauseListings("prod-1", "user-1", "paused");

    expect(spyUpdate).toHaveBeenCalledTimes(1);
    expect(spyUpdate).toHaveBeenCalledWith("l1", "user-1", "paused");
    expect(result.listingResults).toHaveLength(1);
    expect(result.success).toBe(true);
  });

  it("agrega resultados quando todos os listings passam (changed)", async () => {
    vi.spyOn((useCase as any).productRepository, "findById").mockResolvedValue({
      id: "prod-1",
    });
    vi.spyOn(useCase as any, "getProductListings").mockResolvedValue([
      makeListing("l1", "MLB1", Platform.MERCADO_LIVRE),
      makeListing("l2", "555", Platform.SHOPEE),
    ]);
    vi.spyOn(ListingUseCase, "updateListingStatus").mockResolvedValue({
      success: true,
    });

    const result = await useCase.pauseListings("prod-1", "user-1", "paused");

    expect(result.success).toBe(true);
    expect(result.message).toMatch(/2 anúncio\(s\) pausado\(s\)/);
    expect(result.listingResults).toHaveLength(2);
    expect(result.listingResults.every((r) => r.paused && !r.alreadyInState)).toBe(true);
  });

  it("conta alreadyInState separado de changed na mensagem", async () => {
    vi.spyOn((useCase as any).productRepository, "findById").mockResolvedValue({
      id: "prod-1",
    });
    vi.spyOn(useCase as any, "getProductListings").mockResolvedValue([
      makeListing("l1", "MLB1", Platform.MERCADO_LIVRE),
      makeListing("l2", "555", Platform.SHOPEE),
    ]);
    vi.spyOn(ListingUseCase, "updateListingStatus").mockImplementation(
      async (id: string) =>
        id === "l1" ? { success: true } : { success: true, alreadyInState: true },
    );

    const result = await useCase.pauseListings("prod-1", "user-1", "paused");

    expect(result.success).toBe(true);
    expect(result.message).toMatch(/1.*pausado.*1 já estava/);
    expect(result.listingResults.filter((r) => r.alreadyInState)).toHaveLength(1);
  });

  it("retorna success=false apenas quando TODOS os listings falham", async () => {
    vi.spyOn((useCase as any).productRepository, "findById").mockResolvedValue({
      id: "prod-1",
    });
    vi.spyOn(useCase as any, "getProductListings").mockResolvedValue([
      makeListing("l1", "MLB1", Platform.MERCADO_LIVRE),
      makeListing("l2", "555", Platform.SHOPEE),
    ]);
    vi.spyOn(ListingUseCase, "updateListingStatus").mockResolvedValue({
      success: false,
      error: "boom",
    });

    const result = await useCase.pauseListings("prod-1", "user-1", "paused");

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/Nenhum anúncio foi alterado/);
    expect(result.listingResults.every((r) => !r.paused)).toBe(true);
  });

  it("success=true em falha parcial (1 OK + 1 falha)", async () => {
    vi.spyOn((useCase as any).productRepository, "findById").mockResolvedValue({
      id: "prod-1",
    });
    vi.spyOn(useCase as any, "getProductListings").mockResolvedValue([
      makeListing("l1", "MLB1", Platform.MERCADO_LIVRE),
      makeListing("l2", "555", Platform.SHOPEE),
    ]);
    vi.spyOn(ListingUseCase, "updateListingStatus").mockImplementation(
      async (id: string) =>
        id === "l1" ? { success: true } : { success: false, error: "shopee err" },
    );

    const result = await useCase.pauseListings("prod-1", "user-1", "paused");

    expect(result.success).toBe(true);
    expect(result.message).toMatch(/1 alterado.*1 falha/);
    const failed = result.listingResults.find((r) => !r.paused);
    expect(failed?.error).toBe("shopee err");
  });

  it("retorna mensagem 'Nenhum anúncio publicado' quando lista vazia apos filtro", async () => {
    vi.spyOn((useCase as any).productRepository, "findById").mockResolvedValue({
      id: "prod-1",
    });
    vi.spyOn(useCase as any, "getProductListings").mockResolvedValue([
      makeListing("l1", "PENDING_a", Platform.MERCADO_LIVRE),
    ]);
    const spyUpdate = vi.spyOn(ListingUseCase, "updateListingStatus");

    const result = await useCase.pauseListings("prod-1", "user-1", "paused");

    expect(result.success).toBe(true);
    expect(result.message).toMatch(/Nenhum anúncio publicado/);
    expect(result.listingResults).toEqual([]);
    expect(spyUpdate).not.toHaveBeenCalled();
  });

  // ── O fan-out por canal ────────────────────────────────────────────
  //
  // `pauseListings` toca TODOS os anúncios do produto, em todas as
  // plataformas. Isso é requisito, não acaso: se a peça saiu do pátio (ou não
  // voltou a ele), ela não pode continuar comprável em canal nenhum. Deixar a
  // Shopee vendendo porque "lá o anúncio nunca saiu do ar" reproduz o próprio
  // problema que a preferência de reabertura existe para resolver.
  it("pausa o produto nos CINCO canais em que ele está publicado", async () => {
    vi.spyOn((useCase as any).productRepository, "findById").mockResolvedValue({
      id: "prod-1",
    });
    vi.spyOn(useCase as any, "getProductListings").mockResolvedValue([
      makeListing("l-ml", "MLB1", Platform.MERCADO_LIVRE),
      makeListing("l-shopee", "999", Platform.SHOPEE),
      makeListing("l-magalu", "SKU-1", Platform.MAGALU),
      makeListing("l-olx", "SKU-1", Platform.OLX),
      makeListing("l-fb", "SKU-1", Platform.FACEBOOK),
    ]);
    const spy = vi
      .spyOn(ListingUseCase, "updateListingStatus")
      .mockResolvedValue({ success: true });

    await useCase.pauseListings("prod-1", "user-1", "paused", {
      forceRemote: true,
    });

    expect(spy.mock.calls.map((c) => c[0]).sort()).toEqual([
      "l-fb",
      "l-magalu",
      "l-ml",
      "l-olx",
      "l-shopee",
    ]);
  });
});
