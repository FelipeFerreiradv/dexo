import { afterEach, describe, expect, it, vi } from "vitest";

// O service usa import dinâmico de "@/app/lib/prisma" para per-account creds.
// Mockamos pra não bater no banco.
vi.mock("@/app/lib/prisma", () => ({
  default: {
    marketplaceAccount: {
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
    },
  },
}));

import { MLOAuthService } from "../app/marketplaces/services/ml-oauth.service";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MLOAuthService.refreshAccessTokenForAccount mutex", () => {
  it("serializes concurrent refreshes for the same accountId (single underlying call)", async () => {
    const refreshSpy = vi
      .spyOn(MLOAuthService, "refreshAccessToken")
      .mockResolvedValue({
        accessToken: "new-access",
        refreshToken: "new-refresh",
        expiresIn: 21600,
      });

    const [a, b, c] = await Promise.all([
      MLOAuthService.refreshAccessTokenForAccount("acc-1", "rt-1"),
      MLOAuthService.refreshAccessTokenForAccount("acc-1", "rt-1"),
      MLOAuthService.refreshAccessTokenForAccount("acc-1", "rt-1"),
    ]);

    // All callers receive the same resolved value
    expect(a.accessToken).toBe("new-access");
    expect(b.accessToken).toBe("new-access");
    expect(c.accessToken).toBe("new-access");
    // But the underlying refresh hits ML only once
    expect(refreshSpy).toHaveBeenCalledTimes(1);
  });

  it("does NOT share in-flight promise between different accountIds", async () => {
    const refreshSpy = vi
      .spyOn(MLOAuthService, "refreshAccessToken")
      .mockResolvedValue({
        accessToken: "x",
        refreshToken: "y",
        expiresIn: 21600,
      });

    await Promise.all([
      MLOAuthService.refreshAccessTokenForAccount("acc-A", "rt-A"),
      MLOAuthService.refreshAccessTokenForAccount("acc-B", "rt-B"),
    ]);

    expect(refreshSpy).toHaveBeenCalledTimes(2);
  });

  it("releases the in-flight slot after rejection (next caller can retry)", async () => {
    let calls = 0;
    const refreshSpy = vi
      .spyOn(MLOAuthService, "refreshAccessToken")
      .mockImplementation(async () => {
        calls += 1;
        if (calls === 1) {
          const err: any = new Error("transient");
          err.errorCode = "unknown";
          throw err;
        }
        return {
          accessToken: "ok",
          refreshToken: "rt",
          expiresIn: 21600,
        };
      });

    await expect(
      MLOAuthService.refreshAccessTokenForAccount("acc-2", "rt-2"),
    ).rejects.toThrow();

    const result = await MLOAuthService.refreshAccessTokenForAccount(
      "acc-2",
      "rt-2",
    );
    expect(result.accessToken).toBe("ok");
    expect(refreshSpy).toHaveBeenCalledTimes(2);
  });
});
