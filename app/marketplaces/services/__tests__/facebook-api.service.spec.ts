import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import axios from "axios";
import { FacebookApiService } from "../facebook-api.service";

vi.mock("axios");
const mockedAxios = axios as unknown as {
  post: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  isAxiosError: (e: unknown) => boolean;
};

const CATALOG = "cat-123";

beforeEach(() => {
  (mockedAxios as any).post = vi
    .fn()
    .mockResolvedValue({ data: { handles: ["h1"] } });
  (mockedAxios as any).get = vi.fn().mockResolvedValue({
    data: { data: [{ handle: "h1", status: "finished" }] },
  });
  (mockedAxios as any).isAxiosError = (e: any) =>
    !!e && e.isAxiosError === true;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("FacebookApiService", () => {
  it("submitItemsBatch → POST /{catalog}/items_batch com Bearer + item_type", async () => {
    await FacebookApiService.submitItemsBatch(
      "access-tok",
      [{ method: "CREATE", data: { id: "SKU1", name: "Peça" } }],
      { catalogId: CATALOG, allowUpsert: true },
    );
    const [url, body, cfg] = (mockedAxios as any).post.mock.calls[0];
    expect(url).toContain(`/${CATALOG}/items_batch`);
    expect(body.item_type).toBe("PRODUCT_ITEM");
    expect(body.requests).toHaveLength(1);
    expect(body.allow_upsert).toBe(true);
    // Meta USA Authorization Bearer (≠ OLX que manda token no corpo)
    expect(cfg.headers.Authorization).toBe("Bearer access-tok");
  });

  it("upsertItem → método CREATE com allow_upsert true", async () => {
    await FacebookApiService.upsertItem(
      "tok",
      "SKU1",
      { name: "Peça" },
      { catalogId: CATALOG },
    );
    const body = (mockedAxios as any).post.mock.calls[0][1];
    expect(body.requests[0].method).toBe("CREATE");
    expect(body.requests[0].data.id).toBe("SKU1");
    expect(body.requests[0].retailer_id).toBeUndefined();
    expect(body.allow_upsert).toBe(true);
  });

  it("setAvailability → UPDATE availability (+quantity), não delete", async () => {
    await FacebookApiService.setAvailability("tok", "SKU1", "out of stock", {
      catalogId: CATALOG,
      quantity: 0,
    });
    const body = (mockedAxios as any).post.mock.calls[0][1];
    expect(body.requests[0].method).toBe("UPDATE");
    expect(body.requests[0].data.availability).toBe("out of stock");
    expect(body.requests[0].data.quantity_to_sell_on_facebook).toBe(0);
  });

  it("deleteItem → método DELETE com o retailer_id", async () => {
    await FacebookApiService.deleteItem("tok", "SKU1", { catalogId: CATALOG });
    const body = (mockedAxios as any).post.mock.calls[0][1];
    expect(body.requests[0].method).toBe("DELETE");
    expect(body.requests[0].data.id).toBe("SKU1");
    expect(body.requests[0].retailer_id).toBeUndefined();
  });

  // ─────────────────────────────────────────────────────────────
  // A trava que faltava. Os quatro caminhos montavam o request cada um por si,
  // e três ficaram certos enquanto o publish ficou errado — a Meta responde
  // HTTP 200 com "Can not find required field id" no corpo, então nada
  // estourava. Verificado contra o catálogo real em 19/08/2026.
  // ─────────────────────────────────────────────────────────────
  it("TODOS os caminhos põem o id DENTRO de data, e nenhum usa retailer_id", async () => {
    const chamadas: Array<[string, () => Promise<unknown>]> = [
      [
        "upsertItem",
        () =>
          FacebookApiService.upsertItem(
            "tok",
            "SKU1",
            { name: "P" },
            { catalogId: CATALOG },
          ),
      ],
      [
        "updateItem",
        () =>
          FacebookApiService.updateItem(
            "tok",
            "SKU1",
            { name: "P" },
            { catalogId: CATALOG },
          ),
      ],
      [
        "setAvailability",
        () =>
          FacebookApiService.setAvailability("tok", "SKU1", "in stock", {
            catalogId: CATALOG,
          }),
      ],
      [
        "deleteItem",
        () =>
          FacebookApiService.deleteItem("tok", "SKU1", { catalogId: CATALOG }),
      ],
    ];

    for (const [nome, executar] of chamadas) {
      (mockedAxios as any).post.mockClear();
      await executar();
      const req = (mockedAxios as any).post.mock.calls[0][1].requests[0];
      expect(req.data?.id, `${nome}: o id tem que estar em data`).toBe("SKU1");
      expect(
        req.retailer_id,
        `${nome}: retailer_id no nível do request é recusado pela Meta`,
      ).toBeUndefined();
    }
  });

  it("checkBatchStatus → GET check_batch_request_status?handle=", async () => {
    await FacebookApiService.checkBatchStatus("tok", "h1", {
      catalogId: CATALOG,
    });
    const [url, cfg] = (mockedAxios as any).get.mock.calls[0];
    expect(url).toContain("/check_batch_request_status");
    expect(url).toContain("handle=h1");
    expect(cfg.headers.Authorization).toBe("Bearer tok");
  });

  it("submitItemsBatch lança quando validation_status traz erros (200 + rejeição)", async () => {
    (mockedAxios as any).post = vi.fn().mockResolvedValue({
      data: {
        handles: ["h1"],
        validation_status: [
          { retailer_id: "SKU1", errors: [{ message: "invalid category" }] },
        ],
      },
    });
    await expect(
      FacebookApiService.upsertItem(
        "tok",
        "SKU1",
        { name: "x" },
        { catalogId: CATALOG },
      ),
    ).rejects.toThrow(/invalid category/);
  });

  it("pollBatchUntilDone retorna a entry finished (best-effort por handle)", async () => {
    (mockedAxios as any).get = vi.fn().mockResolvedValue({
      data: { data: [{ handle: "h1", status: "finished" }] },
    });
    const entry = await FacebookApiService.pollBatchUntilDone("tok", "h1", {
      catalogId: CATALOG,
      intervalMs: 1,
      maxAttempts: 2,
    });
    expect(entry?.status).toBe("finished");
  });

  it("pollBatchUntilDone expõe status 'error' (rejeição assíncrona)", async () => {
    (mockedAxios as any).get = vi.fn().mockResolvedValue({
      data: {
        data: [
          { handle: "h1", status: "error", errors: [{ message: "boom" }] },
        ],
      },
    });
    const entry = await FacebookApiService.pollBatchUntilDone("tok", "h1", {
      catalogId: CATALOG,
      intervalMs: 1,
      maxAttempts: 2,
    });
    expect(entry?.status).toBe("error");
    expect(entry?.errors).toHaveLength(1);
  });
});
