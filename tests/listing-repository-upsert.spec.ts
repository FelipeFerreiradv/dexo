import { describe, it, expect, vi, afterEach } from "vitest";

import { ListingRepository } from "@/app/marketplaces/repositories/listing.repository";
import prisma from "@/app/lib/prisma";

/**
 * upsertListing é a base da paridade de status da Magalu: uma falha grava
 * "error"+lastError e um retry bem-sucedido reaproveita a MESMA linha (chave
 * conta+externalListingId) virando "active", sem P2002 nem linha duplicada.
 */
describe("ListingRepository.upsertListing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("falha: upsert pela chave (conta, externalListingId) com status error + lastError", async () => {
    const spy: any = vi.spyOn(prisma.productListing, "upsert");
    spy.mockResolvedValue({ id: "L1" });

    await ListingRepository.upsertListing({
      productId: "p1",
      marketplaceAccountId: "acc1",
      externalListingId: "33597",
      externalSku: "33597",
      status: "error",
      lastError: "boom",
      retryEnabled: true,
    });

    const arg = spy.mock.calls[0][0] as any;
    expect(arg.where).toEqual({
      marketplaceAccountId_externalListingId: {
        marketplaceAccountId: "acc1",
        externalListingId: "33597",
      },
    });
    expect(arg.create.productId).toBe("p1");
    expect(arg.create.status).toBe("error");
    expect(arg.create.lastError).toBe("boom");
    // update (linha já existe) também alinha status + erro
    expect(arg.update.status).toBe("error");
    expect(arg.update.lastError).toBe("boom");
  });

  it("sucesso: status active + lastError null LIMPA o erro anterior (mesma linha)", async () => {
    const spy: any = vi.spyOn(prisma.productListing, "upsert");
    spy.mockResolvedValue({ id: "L1" });

    await ListingRepository.upsertListing({
      productId: "p1",
      marketplaceAccountId: "acc1",
      externalListingId: "33597",
      status: "active",
      permalink: null,
      lastError: null,
      retryEnabled: false,
    });

    const arg = spy.mock.calls[0][0] as any;
    expect(arg.update.status).toBe("active");
    expect(arg.update.lastError).toBeNull();
    expect(arg.create.status).toBe("active");
  });
});
