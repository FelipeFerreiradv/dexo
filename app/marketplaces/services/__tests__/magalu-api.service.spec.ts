import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import axios from "axios";
import { MagaluApiService } from "../magalu-api.service";

vi.mock("axios");
const mockedAxios = axios as unknown as {
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  isAxiosError: (e: unknown) => boolean;
};

beforeEach(() => {
  (mockedAxios as any).get = vi.fn().mockResolvedValue({ data: {} });
  (mockedAxios as any).post = vi.fn().mockResolvedValue({ data: {} });
  (mockedAxios as any).put = vi.fn().mockResolvedValue({ data: {} });
  (mockedAxios as any).isAxiosError = (e: any) => !!e && e.isAxiosError === true;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MagaluApiService (cliente Bearer)", () => {
  it("updateStock → PUT no endpoint de estoque com Bearer e corpo {sku, quantity}", async () => {
    await MagaluApiService.updateStock("tok", "SKU-1", 5);
    const [url, body, config] = (mockedAxios as any).put.mock.calls[0];
    expect(url).toContain("/seller/v1/portfolios/stocks");
    expect(body).toEqual({ sku: "SKU-1", quantity: 5 });
    expect(config.headers.Authorization).toBe("Bearer tok");
  });

  it("updatePrice → PUT no endpoint de preço com corpo {sku, price}", async () => {
    await MagaluApiService.updatePrice("tok", "SKU-1", 99.5);
    const [url, body] = (mockedAxios as any).put.mock.calls[0];
    expect(url).toContain("/seller/v1/portfolios/prices");
    expect(body).toEqual({ sku: "SKU-1", price: 99.5 });
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
    (mockedAxios as any).put.mockRejectedValue({
      isAxiosError: true,
      response: { status: 401, data: { error: "unauthorized" } },
    });
    await expect(
      MagaluApiService.updateStock("tok", "SKU-1", 1),
    ).rejects.toMatchObject({ status: 401 });
  });
});
