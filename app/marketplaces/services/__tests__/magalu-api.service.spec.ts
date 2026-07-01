import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import axios from "axios";
import { MagaluApiService } from "../magalu-api.service";

vi.mock("axios");
const mockedAxios = axios as unknown as {
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  patch: ReturnType<typeof vi.fn>;
  request: ReturnType<typeof vi.fn>;
  isAxiosError: (e: unknown) => boolean;
};

beforeEach(() => {
  (mockedAxios as any).get = vi.fn().mockResolvedValue({ data: {} });
  (mockedAxios as any).post = vi.fn().mockResolvedValue({ data: {} });
  (mockedAxios as any).put = vi.fn().mockResolvedValue({ data: {} });
  (mockedAxios as any).patch = vi.fn().mockResolvedValue({ data: {} });
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

  it("patchSku → PATCH /portfolios/skus/{sku} com Bearer e corpo parcial", async () => {
    (mockedAxios as any).patch.mockResolvedValue({
      data: { trace_id: "t-1" },
    });
    const res = await MagaluApiService.patchSku("tok", "SKU-1", {
      active: false,
    });
    expect(res.trace_id).toBe("t-1");
    const [url, body, config] = (mockedAxios as any).patch.mock.calls[0];
    expect(url).toContain("/seller/v1/portfolios/skus/SKU-1");
    expect(body).toEqual({ active: false });
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

  // Fallback DIRECIONAL do upsert (limpeza de egress) —————————————————————————
  it("UPDATE (create=false) que bate 409 NÃO faz POST de fallback e propaga o erro do PATCH", async () => {
    (mockedAxios as any).request = vi.fn().mockRejectedValue({
      isAxiosError: true,
      response: { status: 409, data: { message: "already exists" } },
    });
    await expect(
      MagaluApiService.setStock("tok", "SKU-1", 5, "chan-1"),
    ).rejects.toMatchObject({ status: 409 });
    // Só a chamada primária (PATCH); sem POST de fallback garantidamente-inútil.
    expect((mockedAxios as any).request).toHaveBeenCalledTimes(1);
    expect((mockedAxios as any).request.mock.calls[0][0].method).toBe("patch");
  });

  it("UPDATE (create=false) que bate 404 FAZ POST de fallback (entrada não existe → cria)", async () => {
    (mockedAxios as any).request = vi
      .fn()
      .mockRejectedValueOnce({
        isAxiosError: true,
        response: { status: 404, data: {} },
      })
      .mockResolvedValueOnce({ data: {} });
    await expect(
      MagaluApiService.setPrice("tok", "SKU-1", 15, "chan-1"),
    ).resolves.toBeUndefined();
    expect((mockedAxios as any).request).toHaveBeenCalledTimes(2);
    expect((mockedAxios as any).request.mock.calls[0][0].method).toBe("patch");
    expect((mockedAxios as any).request.mock.calls[1][0].method).toBe("post");
  });

  it("CREATE (create=true) que bate 409 (já existe) FAZ PATCH de fallback — inalterado", async () => {
    (mockedAxios as any).request = vi
      .fn()
      .mockRejectedValueOnce({
        isAxiosError: true,
        response: { status: 409, data: {} },
      })
      .mockResolvedValueOnce({ data: {} });
    await expect(
      MagaluApiService.setStock("tok", "SKU-1", 5, "chan-1", { create: true }),
    ).resolves.toBeUndefined();
    expect((mockedAxios as any).request).toHaveBeenCalledTimes(2);
    expect((mockedAxios as any).request.mock.calls[0][0].method).toBe("post");
    expect((mockedAxios as any).request.mock.calls[1][0].method).toBe("patch");
  });
});
