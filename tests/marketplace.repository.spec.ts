import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountStatus, Platform } from "@prisma/client";

vi.mock("../app/lib/prisma", () => ({
  default: {
    marketplaceAccount: {
      findFirst: vi.fn(),
    },
  },
}));

import prisma from "../app/lib/prisma";
import { MarketplaceRepository } from "../app/marketplaces/repositories/marketplace.repository";

describe("MarketplaceRepository.findByShopId", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prefere a conta Shopee ativa mais recentemente atualizada", async () => {
    const findFirstSpy = vi
      .spyOn((prisma as any).marketplaceAccount, "findFirst")
      .mockResolvedValue({ id: "acc-1" });

    await MarketplaceRepository.findByShopId(1679461742);

    expect(findFirstSpy).toHaveBeenCalledWith({
      where: {
        shopId: 1679461742,
        platform: Platform.SHOPEE,
        status: AccountStatus.ACTIVE,
      },
      orderBy: [
        { updatedAt: "desc" },
        { expiresAt: "desc" },
        { createdAt: "desc" },
      ],
    });
  });
});
