import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../app/marketplaces/repositories/marketplace.repository", () => ({
  MarketplaceRepository: {
    updateStatus: vi.fn(),
  },
}));

vi.mock("../app/services/system-log.service", () => ({
  SystemLogService: {
    logError: vi.fn(),
  },
}));

import { AccountStatus } from "@prisma/client";
import { MarketplaceRepository } from "../app/marketplaces/repositories/marketplace.repository";
import { MarketplaceAccountService } from "../app/marketplaces/services/marketplace-account.service";
import { SystemLogService } from "../app/services/system-log.service";

describe("MarketplaceAccountService.handleAuthFailure", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("marca a conta como ERROR quando o refresh token veio de outro client_id", async () => {
    const updateStatusSpy = vi
      .spyOn(MarketplaceRepository, "updateStatus")
      .mockResolvedValue({} as any);
    const logSpy = vi
      .spyOn(SystemLogService, "logError")
      .mockResolvedValue(undefined as any);

    const result = await MarketplaceAccountService.handleAuthFailure(
      "acc-1",
      new Error("the client_id does not match the original"),
      { userId: "user-1", context: "AUTH_REFRESH" },
    );

    expect(result.setToError).toBe(true);
    expect(updateStatusSpy).toHaveBeenCalledWith("acc-1", AccountStatus.ERROR);
    expect(logSpy).toHaveBeenCalledWith(
      "AUTH_REFRESH",
      expect.stringContaining("client_id does not match the original"),
      expect.objectContaining({
        userId: "user-1",
        resourceId: "acc-1",
      }),
    );
  });
});
