/**
 * Renovação bem-sucedida devolve ACTIVE à conta Shopee que estava em ERROR.
 *
 * É o espelho da auto-desativação (shopee-oauth-auto-deactivate.spec.ts). Sem
 * ele, ERROR era porta de mão única: em 16/09/2026 8 contas marcadas ERROR
 * durante a pane da partner key seguiram renovando token normalmente por 11 h
 * e mesmo assim ficaram fora do laço de pedidos — venda nenhuma entrava.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.hoisted(() => {
  process.env.SHOPEE_PARTNER_ID = "2000001";
  process.env.SHOPEE_PARTNER_KEY = "a".repeat(64);
});

import axios from "axios";
import { ShopeeOAuthService } from "@/app/marketplaces/services/shopee-oauth.service";
import prisma from "@/app/lib/prisma";

vi.mock("axios");
const mockedAxios = axios as unknown as {
  post: ReturnType<typeof vi.fn>;
  isAxiosError: (e: unknown) => boolean;
};

const TOKEN_OK = {
  data: {
    access_token: "novo",
    refresh_token: "novo-rt",
    expire_in: 14400,
    shop_id: 777,
  },
};

let updateMany: ReturnType<typeof vi.fn>;

beforeEach(() => {
  delete process.env.SHOPEE_AUTO_REACTIVATE_DISABLED;
  (mockedAxios as any).post = vi.fn();
  (mockedAxios as any).isAxiosError = (e: any) => !!e && e.isAxiosError === true;
  updateMany = vi.fn().mockResolvedValue({ count: 1 });
  vi.spyOn(prisma.marketplaceAccount, "updateMany").mockImplementation(
    updateMany as never,
  );
  vi.spyOn(console, "warn").mockImplementation(() => {});
  (ShopeeOAuthService as any).refreshesInFlight?.clear?.();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.SHOPEE_AUTO_REACTIVATE_DISABLED;
});

describe("reativa quando a renovação prova que a autorização está viva", () => {
  it("token novo → devolve ACTIVE só a conta em ERROR daquela loja", async () => {
    (mockedAxios as any).post.mockResolvedValue(TOKEN_OK);

    const r = await ShopeeOAuthService.refreshAccessToken("rt", 777);

    expect(r.access_token).toBe("novo");
    // O filtro é o que torna isto seguro: ACTIVE e INACTIVE nunca são tocadas.
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledWith({
      where: { shopId: 777, platform: "SHOPEE", status: "ERROR" },
      data: { status: "ACTIVE" },
    });
  });

  it("registra o evento quando alguma conta voltou", async () => {
    (mockedAxios as any).post.mockResolvedValue(TOKEN_OK);

    await ShopeeOAuthService.refreshAccessToken("rt", 778);

    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("shopee.oauth.account.reactivated"),
    );
  });
});

describe("NÃO reativa", () => {
  it("200 sem access_token (erro no corpo) não prova autorização viva", async () => {
    (mockedAxios as any).post.mockResolvedValue({
      data: { error: "error_auth", message: "invalid" },
    });

    await ShopeeOAuthService.refreshAccessToken("rt", 779);

    expect(updateMany).not.toHaveBeenCalled();
  });

  it("renovação que falha não reativa", async () => {
    (mockedAxios as any).post.mockRejectedValue({
      isAxiosError: true,
      message: "Request failed with status code 403",
      response: { status: 403, data: { error: "error_sign", message: "wrong sign" } },
    });

    await expect(
      ShopeeOAuthService.refreshAccessToken("rt", 780),
    ).rejects.toThrow(/renovar token/);

    expect(updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "ACTIVE" } }),
    );
  });

  it("kill-switch ligado → não toca no status", async () => {
    process.env.SHOPEE_AUTO_REACTIVATE_DISABLED = "1";
    (mockedAxios as any).post.mockResolvedValue(TOKEN_OK);

    await ShopeeOAuthService.refreshAccessToken("rt", 781);

    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe("reativar é best-effort", () => {
  it("falha no banco não derruba a renovação", async () => {
    updateMany.mockRejectedValue(new Error("banco fora"));
    (mockedAxios as any).post.mockResolvedValue(TOKEN_OK);

    const r = await ShopeeOAuthService.refreshAccessToken("rt", 782);

    expect(r.access_token).toBe("novo");
  });
});
