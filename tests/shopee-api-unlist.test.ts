import { describe, it, expect, vi, afterEach } from "vitest";

import { ShopeeApiService } from "@/app/marketplaces/services/shopee-api.service";

describe("ShopeeApiService.unlistItem", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("envia item_list mapeado e retorna failure_list vazio em sucesso total", async () => {
    const spy = vi
      .spyOn(ShopeeApiService as any, "makeAuthenticatedRequest")
      .mockResolvedValue({
        error: null,
        message: null,
        warning: null,
        request_id: "req-1",
        response: { failure_list: [] },
      });

    const result = await ShopeeApiService.unlistItem("token", 999, [
      { itemId: 111, unlist: true },
      { itemId: 222, unlist: true },
    ]);

    expect(result).toEqual({ failure_list: [] });
    expect(spy).toHaveBeenCalledWith(
      "POST",
      "/api/v2/product/unlist_item",
      "token",
      999,
      {
        item_list: [
          { item_id: 111, unlist: true },
          { item_id: 222, unlist: true },
        ],
      },
    );
  });

  it("retorna failure_list quando alguns itens falham (parcial)", async () => {
    vi.spyOn(ShopeeApiService as any, "makeAuthenticatedRequest").mockResolvedValue({
      error: null,
      message: null,
      warning: null,
      request_id: "req-2",
      response: {
        failure_list: [
          { item_id: 222, failed_reason: "item not found" },
        ],
      },
    });

    const result = await ShopeeApiService.unlistItem("token", 999, [
      { itemId: 111, unlist: true },
      { itemId: 222, unlist: true },
    ]);

    expect(result.failure_list).toEqual([
      { item_id: 222, failed_reason: "item not found" },
    ]);
  });

  it("lanca erro global quando response.error vem preenchido", async () => {
    vi.spyOn(ShopeeApiService as any, "makeAuthenticatedRequest").mockResolvedValue({
      error: "error_auth",
      message: "Invalid access_token",
      warning: null,
      request_id: "req-3",
    });

    await expect(
      ShopeeApiService.unlistItem("bad-token", 999, [
        { itemId: 111, unlist: true },
      ]),
    ).rejects.toThrow(/Invalid access_token/);
  });

  it("retorna failure_list vazio sem chamar API quando items eh vazio", async () => {
    const spy = vi.spyOn(ShopeeApiService as any, "makeAuthenticatedRequest");

    const result = await ShopeeApiService.unlistItem("token", 999, []);

    expect(result).toEqual({ failure_list: [] });
    expect(spy).not.toHaveBeenCalled();
  });

  it("preserva flag unlist=false (despausar) no payload enviado", async () => {
    const spy = vi
      .spyOn(ShopeeApiService as any, "makeAuthenticatedRequest")
      .mockResolvedValue({
        error: null,
        message: null,
        warning: null,
        request_id: "req-4",
        response: { failure_list: [] },
      });

    await ShopeeApiService.unlistItem("token", 999, [
      { itemId: 111, unlist: false },
    ]);

    expect(spy).toHaveBeenCalledWith(
      "POST",
      "/api/v2/product/unlist_item",
      "token",
      999,
      { item_list: [{ item_id: 111, unlist: false }] },
    );
  });
});
