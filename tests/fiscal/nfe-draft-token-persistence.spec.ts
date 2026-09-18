import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  updateTokensMock,
  mlRefreshMock,
  shopeeRefreshMock,
  magaluRefreshMock,
  mlBillingMock,
  shopeeBillingMock,
  magaluOrderMock,
} = vi.hoisted(() => ({
  updateTokensMock: vi.fn(),
  mlRefreshMock: vi.fn(),
  shopeeRefreshMock: vi.fn(),
  magaluRefreshMock: vi.fn(),
  mlBillingMock: vi.fn(),
  shopeeBillingMock: vi.fn(),
  magaluOrderMock: vi.fn(),
}));

vi.mock("../../app/marketplaces/repositories/marketplace.repository", () => ({
  MarketplaceRepository: { updateTokens: updateTokensMock },
}));
vi.mock("@/app/marketplaces/repositories/marketplace.repository", () => ({
  MarketplaceRepository: { updateTokens: updateTokensMock },
}));

vi.mock("../../app/marketplaces/services/ml-oauth.service", () => ({
  MLOAuthService: { refreshAccessTokenForAccount: mlRefreshMock },
}));
vi.mock("@/app/marketplaces/services/ml-oauth.service", () => ({
  MLOAuthService: { refreshAccessTokenForAccount: mlRefreshMock },
}));
vi.mock("../../app/marketplaces/services/shopee-oauth.service", () => ({
  ShopeeOAuthService: {
    refreshAccessToken: shopeeRefreshMock,
    calculateExpiryDate: (expiresIn: number) =>
      new Date(Date.now() + expiresIn * 1_000),
  },
}));
vi.mock("@/app/marketplaces/services/shopee-oauth.service", () => ({
  ShopeeOAuthService: {
    refreshAccessToken: shopeeRefreshMock,
    calculateExpiryDate: (expiresIn: number) =>
      new Date(Date.now() + expiresIn * 1_000),
  },
}));
vi.mock("../../app/marketplaces/services/magalu-oauth.service", () => ({
  MagaluOAuthService: { refreshAccessTokenForAccount: magaluRefreshMock },
}));
vi.mock("@/app/marketplaces/services/magalu-oauth.service", () => ({
  MagaluOAuthService: { refreshAccessTokenForAccount: magaluRefreshMock },
}));

vi.mock("../../app/marketplaces/services/ml-api.service", () => ({
  MLApiService: { getOrderBillingInfo: mlBillingMock },
}));
vi.mock("@/app/marketplaces/services/ml-api.service", () => ({
  MLApiService: { getOrderBillingInfo: mlBillingMock },
}));
vi.mock("../../app/marketplaces/services/shopee-api.service", () => ({
  ShopeeApiService: { getOrderFiscalInfo: shopeeBillingMock },
}));
vi.mock("@/app/marketplaces/services/shopee-api.service", () => ({
  ShopeeApiService: { getOrderFiscalInfo: shopeeBillingMock },
}));
vi.mock("../../app/marketplaces/services/magalu-api.service", () => ({
  MagaluApiService: { getOrder: magaluOrderMock },
}));
vi.mock("@/app/marketplaces/services/magalu-api.service", () => ({
  MagaluApiService: { getOrder: magaluOrderMock },
}));

vi.mock("../../app/repositories/nfe.repository", () => ({
  NfeRepository: class {},
}));
vi.mock("@/app/repositories/nfe.repository", () => ({
  NfeRepository: class {},
}));
vi.mock("../../app/repositories/company-fiscal.repository", () => ({
  CompanyFiscalRepository: class {},
}));
vi.mock("@/app/repositories/company-fiscal.repository", () => ({
  CompanyFiscalRepository: class {},
}));
vi.mock("../../app/repositories/customer.repository", () => ({
  CustomerRepository: class {},
}));
vi.mock("@/app/repositories/customer.repository", () => ({
  CustomerRepository: class {},
}));
vi.mock("../../app/repositories/order.repository", () => ({
  orderRepository: {},
}));
vi.mock("@/app/repositories/order.repository", () => ({
  orderRepository: {},
}));

import { NfeDraftUseCase } from "../../app/usecases/nfe-draft.usecase";

type Platform = "MERCADO_LIVRE" | "SHOPEE" | "MAGALU";

function account(platform: Platform, expiresAt = new Date(Date.now() - 1_000)) {
  return {
    id: `${platform.toLowerCase()}-account`,
    platform,
    shopId: platform === "SHOPEE" ? 123456 : null,
    accessToken: "old-access-token",
    refreshToken: "old-refresh-token",
    expiresAt,
  };
}

const refreshCases = [
  {
    platform: "MERCADO_LIVRE" as const,
    seconds: 3_600,
    configure: () => {
      mlRefreshMock.mockResolvedValue({
        accessToken: "ml-access-new",
        refreshToken: "ml-refresh-new",
        expiresIn: 3_600,
      });
      mlBillingMock.mockResolvedValue({
        buyer: { billing_info: { name: "Comprador ML" } },
      });
    },
    invoke: (uc: NfeDraftUseCase, acc: ReturnType<typeof account>) =>
      (uc as any).mlBillingSnapshot(acc, "ml-order"),
    accessToken: "ml-access-new",
    refreshToken: "ml-refresh-new",
    apiMock: mlBillingMock,
  },
  {
    platform: "SHOPEE" as const,
    seconds: 7_200,
    configure: () => {
      shopeeRefreshMock.mockResolvedValue({
        access_token: "shopee-access-new",
        refresh_token: "shopee-refresh-new",
        expire_in: 7_200,
      });
      shopeeBillingMock.mockResolvedValue({
        recipient_address: { name: "Comprador Shopee" },
      });
    },
    invoke: (uc: NfeDraftUseCase, acc: ReturnType<typeof account>) =>
      (uc as any).shopeeBillingSnapshot(acc, "shopee-order"),
    accessToken: "shopee-access-new",
    refreshToken: "shopee-refresh-new",
    apiMock: shopeeBillingMock,
  },
  {
    platform: "MAGALU" as const,
    seconds: 1_800,
    configure: () => {
      magaluRefreshMock.mockResolvedValue({
        accessToken: "magalu-access-new",
        refreshToken: "magalu-refresh-new",
        expiresIn: 1_800,
      });
      magaluOrderMock.mockResolvedValue({
        customer: { name: "Comprador Magalu", phones: [] },
        deliveries: [],
      });
    },
    invoke: (uc: NfeDraftUseCase, acc: ReturnType<typeof account>) =>
      (uc as any).magaluBillingSnapshot(acc, "magalu-order"),
    accessToken: "magalu-access-new",
    refreshToken: "magalu-refresh-new",
    apiMock: magaluOrderMock,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  updateTokensMock.mockResolvedValue({});
});

describe("NfeDraftUseCase — persistência de tokens do lookup fiscal", () => {
  it.each(refreshCases)(
    "$platform persiste access, refresh e expiry antes da consulta fiscal",
    async (testCase) => {
      testCase.configure();
      const apiImplementation = testCase.apiMock.getMockImplementation();
      testCase.apiMock.mockImplementation(async (...args: unknown[]) => {
        expect(updateTokensMock).toHaveBeenCalledTimes(1);
        return apiImplementation?.(...args);
      });
      const uc = new NfeDraftUseCase();
      const acc = account(testCase.platform);
      const before = Date.now();

      await testCase.invoke(uc, acc);

      expect(updateTokensMock).toHaveBeenCalledTimes(1);
      const [accountId, payload] = updateTokensMock.mock.calls[0];
      expect(accountId).toBe(acc.id);
      expect(payload.accessToken).toBe(testCase.accessToken);
      expect(payload.refreshToken).toBe(testCase.refreshToken);
      expect(payload.expiresAt.getTime()).toBeGreaterThanOrEqual(
        before + testCase.seconds * 1_000,
      );
      expect(payload.expiresAt.getTime()).toBeLessThanOrEqual(
        Date.now() + testCase.seconds * 1_000,
      );
    },
  );

  it.each(refreshCases)(
    "$platform não vaza tokens quando a persistência falha",
    async (testCase) => {
      testCase.configure();
      const secretAccess = `${testCase.platform}-access-secret`;
      const secretRefresh = `${testCase.platform}-refresh-secret`;
      if (testCase.platform === "MERCADO_LIVRE") {
        mlRefreshMock.mockResolvedValue({
          accessToken: secretAccess,
          refreshToken: secretRefresh,
          expiresIn: testCase.seconds,
        });
      } else if (testCase.platform === "SHOPEE") {
        shopeeRefreshMock.mockResolvedValue({
          access_token: secretAccess,
          refresh_token: secretRefresh,
          expire_in: testCase.seconds,
        });
      } else {
        magaluRefreshMock.mockResolvedValue({
          accessToken: secretAccess,
          refreshToken: secretRefresh,
          expiresIn: testCase.seconds,
        });
      }
      updateTokensMock.mockRejectedValue(
        new Error(`falha contendo ${secretAccess} ${secretRefresh}`),
      );
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      await testCase.invoke(new NfeDraftUseCase(), account(testCase.platform));

      const rendered = warn.mock.calls.flat().join(" ");
      expect(rendered).toContain(
        '"event":"nfe.billing.token_refresh_or_persist_failed"',
      );
      expect(rendered).not.toContain(secretAccess);
      expect(rendered).not.toContain(secretRefresh);
    },
  );

  it.each(refreshCases)(
    "$platform com token válido não grava novamente",
    async (testCase) => {
      testCase.configure();
      const uc = new NfeDraftUseCase();
      const acc = account(testCase.platform, new Date(Date.now() + 3_600_000));

      await testCase.invoke(uc, acc);

      expect(updateTokensMock).not.toHaveBeenCalled();
      expect(testCase.apiMock).toHaveBeenCalled();
    },
  );

  it.each(refreshCases)(
    "$platform mantém a persistência quando a consulta fiscal falha",
    async (testCase) => {
      testCase.configure();
      const secretAccess = `${testCase.platform}-access-secret`;
      const secretRefresh = `${testCase.platform}-refresh-secret`;
      if (testCase.platform === "MERCADO_LIVRE") {
        mlRefreshMock.mockResolvedValue({
          accessToken: secretAccess,
          refreshToken: secretRefresh,
          expiresIn: testCase.seconds,
        });
        mlBillingMock.mockRejectedValue(new Error(`${secretAccess} ${secretRefresh}`));
      } else if (testCase.platform === "SHOPEE") {
        shopeeRefreshMock.mockResolvedValue({
          access_token: secretAccess,
          refresh_token: secretRefresh,
          expire_in: testCase.seconds,
        });
        shopeeBillingMock.mockRejectedValue(new Error(`${secretAccess} ${secretRefresh}`));
      } else {
        magaluRefreshMock.mockResolvedValue({
          accessToken: secretAccess,
          refreshToken: secretRefresh,
          expiresIn: testCase.seconds,
        });
        magaluOrderMock.mockRejectedValue(new Error(`${secretAccess} ${secretRefresh}`));
      }

      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const result = await (new NfeDraftUseCase() as any).tryMarketplaceBilling({
          externalOrderId: `${testCase.platform}-order`,
          customerName: "Comprador",
          customerEmail: "comprador@example.com",
          marketplaceAccount: account(testCase.platform),
        });

        expect(result).toBeNull();
        expect(updateTokensMock).toHaveBeenCalledTimes(1);
        expect(errorSpy.mock.calls.flat().join(" ")).not.toContain(secretAccess);
        expect(errorSpy.mock.calls.flat().join(" ")).not.toContain(secretRefresh);
      } finally {
        errorSpy.mockRestore();
      }
    },
  );
});
