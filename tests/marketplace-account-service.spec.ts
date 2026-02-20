import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

import { MarketplaceAccountService } from "../app/marketplaces/services/marketplace-account.service";
import { MarketplaceRepository } from "../app/marketplaces/repositories/marketplace.repository";
import { SystemLogService } from "../app/services/system-log.service";
import { AccountStatus } from "@prisma/client";

describe("MarketplaceAccountService", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it("marks account ERROR on auth failures and logs", async () => {
    const updateSpy = vi
      .spyOn(MarketplaceRepository, "updateStatus")
      .mockResolvedValue({} as any);
    const logSpy = vi
      .spyOn(SystemLogService, "logError")
      .mockResolvedValue(undefined as any);

    const res = await MarketplaceAccountService.handleAuthFailure(
      "acct-1",
      new Error("invalid access token"),
      { userId: "user-1", context: "TEST_AUTH" },
    );

    expect(res.setToError).toBe(true);
    expect(updateSpy).toHaveBeenCalledWith("acct-1", AccountStatus.ERROR);
    expect(logSpy).toHaveBeenCalled();
  });

  it("does not mark ERROR for non-auth errors but logs them", async () => {
    const updateSpy = vi.spyOn(MarketplaceRepository, "updateStatus");
    const logSpy = vi
      .spyOn(SystemLogService, "logError")
      .mockResolvedValue(undefined as any);

    const res = await MarketplaceAccountService.handleAuthFailure(
      "acct-2",
      new Error("seller.unable_to_list"),
      { userId: "user-2", context: "TEST_NON_AUTH" },
    );

    expect(res.setToError).toBe(false);
    expect(updateSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalled();
  });

  it("setInactiveForVacation sets INACTIVE and logs", async () => {
    const updateSpy = vi
      .spyOn(MarketplaceRepository, "updateStatus")
      .mockResolvedValue({} as any);
    const logSpy = vi
      .spyOn(SystemLogService, "logError")
      .mockResolvedValue(undefined as any);

    await MarketplaceAccountService.setInactiveForVacation("acct-3", {
      userId: "user-3",
      message: "vacation detected",
    });

    expect(updateSpy).toHaveBeenCalledWith("acct-3", AccountStatus.INACTIVE);
    expect(logSpy).toHaveBeenCalled();
  });
});
