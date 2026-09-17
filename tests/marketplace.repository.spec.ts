import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountStatus, Platform } from "@prisma/client";

vi.mock("../app/lib/prisma", () => ({
  default: {
    marketplaceAccount: {
      findFirst: vi.fn(),
      update: vi.fn(),
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

describe("MarketplaceRepository.updateTokensFromEnvironmentOAuth", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("grava tokens e limpa as duas credenciais especificas no mesmo update", async () => {
    const expiresAt = new Date("2026-09-17T23:00:00.000Z");
    const update = vi
      .spyOn((prisma as any).marketplaceAccount, "update")
      .mockResolvedValue({ id: "account-1" });

    await MarketplaceRepository.updateTokensFromEnvironmentOAuth("account-1", {
      accessToken: "access-new",
      refreshToken: "refresh-new",
      expiresAt,
    });

    expect(update).toHaveBeenCalledWith({
      where: { id: "account-1" },
      data: {
        accessToken: "access-new",
        refreshToken: "refresh-new",
        expiresAt,
        appClientId: null,
        appClientSecret: null,
      },
    });
  });
});
