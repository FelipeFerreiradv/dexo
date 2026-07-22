import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import prisma from "@/app/lib/prisma";
import { ListingRepository } from "@/app/marketplaces/repositories/listing.repository";
import { StockReconciliationService } from "@/app/marketplaces/services/stock-reconciliation.service";
import { computeProductPauseState } from "@/app/produtos/lib/product-listing-badges";

// Interações do espelhamento de status com os read-sites críticos: o mirror
// grava under_review→reviewing/unlist/inactive em anúncios que AINDA existem
// no marketplace — o guard anti-duplicata e a reconciliação de drift precisam
// continuar enxergando essas linhas como vivas.

describe("findLiveByProductAndAccount × espelhamento", () => {
  afterEach(() => {
    process.env.LISTING_STATUS_SYNC_DISABLED = "1"; // default da suíte
    vi.restoreAllMocks();
  });

  it("espelhamento LIGADO → conjunto vivo inclui reviewing/under_review/unlist/inactive", async () => {
    process.env.LISTING_STATUS_SYNC_DISABLED = "0";
    const findFirst = vi
      .spyOn(prisma.productListing, "findFirst")
      .mockResolvedValue(null as any);

    await ListingRepository.findLiveByProductAndAccount("p1", "acc1");

    const statuses = (findFirst.mock.calls[0][0]?.where as any).status.in;
    expect(statuses).toEqual(
      expect.arrayContaining([
        "active",
        "paused",
        "under_review",
        "reviewing",
        "unlist",
        "inactive",
      ]),
    );
    expect(statuses).not.toContain("closed"); // republicar closed é legítimo
  });

  it("kill-switch → conjunto base [active, paused] idêntico ao anterior", async () => {
    process.env.LISTING_STATUS_SYNC_DISABLED = "1";
    const findFirst = vi
      .spyOn(prisma.productListing, "findFirst")
      .mockResolvedValue(null as any);

    await ListingRepository.findLiveByProductAndAccount("p1", "acc1");

    expect((findFirst.mock.calls[0][0]?.where as any).status.in).toEqual([
      "active",
      "paused",
    ]);
  });
});

describe("StockReconciliationService × espelhamento", () => {
  beforeEach(() => {
    vi.spyOn(prisma.stockLog, "findMany").mockResolvedValue([
      { productId: "p1" },
    ] as any);
  });

  afterEach(() => {
    process.env.LISTING_STATUS_SYNC_DISABLED = "1";
    vi.restoreAllMocks();
  });

  it("espelhamento LIGADO → drift scan cobre os status espelhados vivos", async () => {
    process.env.LISTING_STATUS_SYNC_DISABLED = "0";
    const findMany = vi
      .spyOn(prisma.productListing, "findMany")
      .mockResolvedValue([] as any);

    await StockReconciliationService.runOnce();

    expect((findMany.mock.calls[0][0]?.where as any).status.in).toEqual(
      expect.arrayContaining([
        "active",
        "paused",
        "under_review",
        "reviewing",
        "unlist",
        "inactive",
      ]),
    );
  });

  it("kill-switch → filtro base idêntico ao anterior", async () => {
    process.env.LISTING_STATUS_SYNC_DISABLED = "1";
    const findMany = vi
      .spyOn(prisma.productListing, "findMany")
      .mockResolvedValue([] as any);

    await StockReconciliationService.runOnce();

    expect((findMany.mock.calls[0][0]?.where as any).status.in).toEqual([
      "ACTIVE",
      "active",
      "paused",
      "PAUSED",
    ]);
  });
});

describe("computeProductPauseState × status terminais espelhados", () => {
  const l = (status: string, ext = "MLB1") =>
    ({ status, externalListingId: ext }) as any;

  it("ativo + closed → all-active (closed é neutro; botão de pausa permanece)", () => {
    expect(
      computeProductPauseState([l("active"), l("closed", "MLB2")] as any),
    ).toBe("all-active");
  });

  it("pausado + seller_deleted → all-paused", () => {
    expect(
      computeProductPauseState([
        l("paused"),
        l("seller_deleted", "222"),
      ] as any),
    ).toBe("all-paused");
  });

  it("só terminais → no-actionable (nada pausável)", () => {
    expect(
      computeProductPauseState([l("closed"), l("deleted", "333")] as any),
    ).toBe("no-actionable");
  });

  it("comportamento pré-existente preservado: ativo + pausado → mixed; reviewing → no-actionable", () => {
    expect(
      computeProductPauseState([l("active"), l("paused", "MLB2")] as any),
    ).toBe("mixed");
    expect(
      computeProductPauseState([l("active"), l("reviewing", "MLB2")] as any),
    ).toBe("no-actionable");
  });
});
