import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import axios from "axios";
import { MagaluApiService } from "../magalu-api.service";

vi.mock("axios");
const mockedAxios = axios as unknown as {
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  request: ReturnType<typeof vi.fn>;
  isAxiosError: (e: unknown) => boolean;
};

beforeEach(() => {
  (mockedAxios as any).get = vi.fn().mockResolvedValue({ data: {} });
  (mockedAxios as any).post = vi.fn().mockResolvedValue({ data: {} });
  (mockedAxios as any).put = vi.fn().mockResolvedValue({ data: {} });
  (mockedAxios as any).request = vi.fn().mockResolvedValue({ data: {} });
  (mockedAxios as any).isAxiosError = (e: any) => !!e && e.isAxiosError === true;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MagaluApiService (cliente Bearer)", () => {
  it("setStock → PATCH /portfolios/stocks/{sku} com channel + type AVAILABLE", async () => {
    await MagaluApiService.setStock("tok", "SKU-1", 5, "chan-1");
    const cfg = (mockedAxios as any).request.mock.calls[0][0];
    expect(cfg.method).toBe("patch");
    expect(cfg.url).toContain("/seller/v1/portfolios/stocks/SKU-1");
    expect(cfg.data).toEqual({
      channel: { id: "chan-1" },
      quantity: 5,
      type: "AVAILABLE",
    });
    expect(cfg.headers.Authorization).toBe("Bearer tok");
  });

  it("setStock create:true → POST e inclui branch quando fornecido", async () => {
    await MagaluApiService.setStock("tok", "SKU-1", 2, "chan-1", {
      create: true,
      branchId: "br-1",
    });
    const cfg = (mockedAxios as any).request.mock.calls[0][0];
    expect(cfg.method).toBe("post");
    expect(cfg.data.branch).toEqual({ id: "br-1" });
  });

  it("setPrice → PATCH /prices/{sku}, BRL, preço em CENTAVOS (normalizer 100)", async () => {
    await MagaluApiService.setPrice("tok", "SKU-1", 99.8, "chan-1");
    const cfg = (mockedAxios as any).request.mock.calls[0][0];
    expect(cfg.method).toBe("patch");
    expect(cfg.url).toContain("/seller/v1/portfolios/prices/SKU-1");
    expect(cfg.data).toEqual({
      channel: { id: "chan-1" },
      currency: "BRL",
      list_price: 9980,
      price: 9980,
      normalizer: 100,
    });
  });

  it("listSkus → GET com Bearer e normaliza results/data", async () => {
    (mockedAxios as any).get.mockResolvedValue({
      data: { results: [{ sku: "A" }, { sku: "B" }] },
    });
    const skus = await MagaluApiService.listSkus("tok");
    expect(skus.map((s) => s.sku)).toEqual(["A", "B"]);
    const [url, config] = (mockedAxios as any).get.mock.calls[0];
    expect(url).toContain("/seller/v1/portfolios/skus");
    expect(config.headers.Authorization).toBe("Bearer tok");
  });

  it("createSku → POST /portfolios/skus com Bearer", async () => {
    (mockedAxios as any).post.mockResolvedValue({ data: { id: "new-1" } });
    const created = await MagaluApiService.createSku("tok", { sku: "X" });
    expect(created.id).toBe("new-1");
    const [url, , config] = (mockedAxios as any).post.mock.calls[0];
    expect(url).toContain("/seller/v1/portfolios/skus");
    expect(config.headers.Authorization).toBe("Bearer tok");
  });

  it("getRecentOrders → GET /orders normalizando results", async () => {
    (mockedAxios as any).get.mockResolvedValue({
      data: { results: [{ id: "o1" }] },
    });
    const orders = await MagaluApiService.getRecentOrders("tok", 7);
    expect(orders.map((o) => o.id)).toEqual(["o1"]);
    const [url] = (mockedAxios as any).get.mock.calls[0];
    expect(url).toContain("/seller/v1/orders");
  });

  it("propaga erro de auth (401) com .status para o refresh detectar", async () => {
    (mockedAxios as any).request.mockRejectedValue({
      isAxiosError: true,
      response: { status: 401, data: { error: "unauthorized" } },
    });
    await expect(
      MagaluApiService.setStock("tok", "SKU-1", 1, "chan-1"),
    ).rejects.toMatchObject({ status: 401 });
  });
});
