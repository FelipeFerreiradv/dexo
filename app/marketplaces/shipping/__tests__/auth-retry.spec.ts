import { describe, it, expect, vi, afterEach } from "vitest";
import { ShippingAuthRetry, isMarketplaceAuthError } from "../auth-retry";
import { MLOAuthService } from "../../services/ml-oauth.service";
import { ShopeeOAuthService } from "../../services/shopee-oauth.service";
import { MarketplaceRepository } from "../../repositories/marketplace.repository";
import type { ShippingAccount } from "../shipping-label.types";

afterEach(() => {
  vi.restoreAllMocks();
});

function mlAccount(): ShippingAccount {
  return {
    id: "a1",
    platform: "MERCADO_LIVRE",
    accessToken: "t1",
    refreshToken: "r1",
    externalUserId: "seller1",
    shopId: null,
  };
}

function shopeeAccount(): ShippingAccount {
  return {
    id: "a2",
    platform: "SHOPEE",
    accessToken: "t1",
    refreshToken: "r1",
    externalUserId: null,
    shopId: 123,
  };
}

describe("isMarketplaceAuthError", () => {
  it("detecta por status 401/403 e por mensagem", () => {
    expect(isMarketplaceAuthError({ status: 401 })).toBe(true);
    expect(isMarketplaceAuthError({ status: 403 })).toBe(true);
    expect(isMarketplaceAuthError(new Error("invalid access token"))).toBe(true);
    expect(isMarketplaceAuthError(new Error("erro qualquer"))).toBe(false);
  });
});

describe("ShippingAuthRetry.ml", () => {
  it("sucesso: não refresca", async () => {
    const acc = mlAccount();
    const ref = vi.spyOn(MLOAuthService, "refreshAccessTokenForAccount");
    const res = await ShippingAuthRetry.ml(acc, async (token) => {
      expect(token).toBe("t1");
      return "ok";
    });
    expect(res).toBe("ok");
    expect(ref).not.toHaveBeenCalled();
  });

  it("401: refresca, persiste e retenta com o novo token", async () => {
    const acc = mlAccount();
    vi.spyOn(MLOAuthService, "refreshAccessTokenForAccount").mockResolvedValue({
      accessToken: "t2",
      refreshToken: "r2",
      expiresIn: 3600,
    });
    const upd = vi
      .spyOn(MarketplaceRepository, "updateTokens")
      .mockResolvedValue({} as never);

    let calls = 0;
    const res = await ShippingAuthRetry.ml(acc, async (token) => {
      calls++;
      if (calls === 1) {
        const e = new Error("unauthorized");
        (e as { status?: number }).status = 401;
        throw e;
      }
      expect(token).toBe("t2");
      return "ok2";
    });

    expect(res).toBe("ok2");
    expect(upd).toHaveBeenCalledWith(
      "a1",
      expect.objectContaining({ accessToken: "t2", refreshToken: "r2" }),
    );
    expect(acc.accessToken).toBe("t2");
  });

  it("erro não-auth: propaga sem refrescar", async () => {
    const acc = mlAccount();
    const ref = vi.spyOn(MLOAuthService, "refreshAccessTokenForAccount");
    await expect(
      ShippingAuthRetry.ml(acc, async () => {
        throw new Error("500 boom");
      }),
    ).rejects.toThrow("boom");
    expect(ref).not.toHaveBeenCalled();
  });
});

describe("ShippingAuthRetry.shopee", () => {
  it("401: refresca, persiste e retenta", async () => {
    const acc = shopeeAccount();
    vi.spyOn(ShopeeOAuthService, "refreshAccessToken").mockResolvedValue({
      access_token: "t2",
      refresh_token: "r2",
      expire_in: 3600,
      shop_id: 123,
      partner_id: 1,
      merchant_id: 1,
      request_id: "x",
    });
    vi.spyOn(ShopeeOAuthService, "calculateExpiryDate").mockReturnValue(
      new Date(),
    );
    const upd = vi
      .spyOn(MarketplaceRepository, "updateTokens")
      .mockResolvedValue({} as never);

    let calls = 0;
    const res = await ShippingAuthRetry.shopee(acc, async (token, shopId) => {
      calls++;
      expect(shopId).toBe(123);
      if (calls === 1) {
        const e = new Error("forbidden");
        (e as { status?: number }).status = 403;
        throw e;
      }
      expect(token).toBe("t2");
      return "ok2";
    });

    expect(res).toBe("ok2");
    expect(upd).toHaveBeenCalled();
    expect(acc.accessToken).toBe("t2");
  });

  it("conta sem shopId lança erro", async () => {
    const acc = { ...shopeeAccount(), shopId: null };
    await expect(
      ShippingAuthRetry.shopee(acc, async () => "x"),
    ).rejects.toThrow();
  });
});
