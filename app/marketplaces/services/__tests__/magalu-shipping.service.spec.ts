import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import axios from "axios";
import {
  MagaluShippingService,
  MagaluShippingLabelProvider,
  extractDeliveryIds,
} from "../magalu-shipping.service";
import { MagaluApiService } from "../magalu-api.service";
import { ShippingLabelError } from "../../shipping/shipping-label.types";
import type { ShippingOrderContext } from "../../shipping/shipping-label.types";

vi.mock("axios");
const mockedAxios = axios as unknown as {
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  isAxiosError: (e: unknown) => boolean;
};

beforeEach(() => {
  (mockedAxios as any).get = vi.fn();
  (mockedAxios as any).post = vi.fn().mockResolvedValue({ data: {} });
  (mockedAxios as any).isAxiosError = (e: any) => !!e && e.isAxiosError === true;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("extractDeliveryIds (parsing defensivo)", () => {
  it("lê deliveries[].id", () => {
    expect(
      extractDeliveryIds({ deliveries: [{ id: "D1" }, { id: "D2" }] } as any),
    ).toEqual(["D1", "D2"]);
  });

  it("aceita packages[]/shipments[] e o objeto único delivery, deduplicando", () => {
    expect(
      extractDeliveryIds({
        packages: [{ id: "P1" }],
        shipments: [{ id: "P1" }, { id: "S2" }],
        delivery: { id: "DX" },
      } as any),
    ).toEqual(["P1", "S2", "DX"]);
  });

  it("devolve [] quando não há entrega", () => {
    expect(extractDeliveryIds({ id: "ORD" } as any)).toEqual([]);
  });
});

describe("MagaluShippingService (HTTP de baixo nível)", () => {
  it("generateLabels → POST no endpoint de logística com channel/deliveries/label e Bearer", async () => {
    (mockedAxios as any).post.mockResolvedValue({
      data: { label: { signed_url: "https://x/y.pdf" } },
    });
    const resp = await MagaluShippingService.generateLabels(
      "tok",
      "CH1",
      ["D1", "D2"],
      { format: "pdf", type: "summary" },
    );
    expect(resp.label?.signed_url).toBe("https://x/y.pdf");
    const [url, body, config] = (mockedAxios as any).post.mock.calls[0];
    expect(url).toContain("/seller/v1/logistics/shipping-labels");
    expect(body.channel.id).toBe("CH1");
    expect(body.deliveries).toEqual([{ id: "D1" }, { id: "D2" }]);
    expect(body.label).toEqual({ format: "pdf", type: "summary" });
    expect(config.headers.Authorization).toBe("Bearer tok");
  });

  it("downloadLabel → GET na signed_url (arraybuffer, sem Authorization)", async () => {
    (mockedAxios as any).get.mockResolvedValue({
      data: Buffer.from("%PDF-1.4 etiqueta magalu"),
    });
    const pdf = await MagaluShippingService.downloadLabel("https://x/y.pdf");
    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect(pdf.toString()).toContain("%PDF");
    const [url, config] = (mockedAxios as any).get.mock.calls[0];
    expect(url).toBe("https://x/y.pdf");
    expect(config.responseType).toBe("arraybuffer");
    expect(config.headers?.Authorization).toBeUndefined();
  });

  it("erro de auth (401) é repassado com .status para o refresh detectar", async () => {
    (mockedAxios as any).post.mockRejectedValue({
      isAxiosError: true,
      response: { status: 401, data: { message: "invalid token" } },
      message: "Request failed",
    });
    let caught: any;
    try {
      await MagaluShippingService.generateLabels("tok", "CH1", ["D1"], {
        format: "pdf",
        type: "summary",
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught.status).toBe(401);
  });
});

describe("MagaluShippingLabelProvider", () => {
  const ctx: ShippingOrderContext = {
    order: { id: "o1", externalOrderId: "EXT1", marketplaceAccountId: "acc1" },
    account: {
      id: "acc1",
      platform: "MAGALU",
      accessToken: "tok",
      refreshToken: "ref",
      externalUserId: "GENPUB.tenant",
      shopId: null,
    },
    nfe: {
      id: "nfe1",
      chaveAcesso: "1".repeat(44),
      xmlAutorizadoPath: "/x.xml",
      xml: "<nfeProc/>",
    },
  };

  it("ensureInvoiceSent é no-op (não chama a API)", async () => {
    const getMe = vi.spyOn(MagaluApiService, "getMe");
    const getOrder = vi.spyOn(MagaluApiService, "getOrder");
    await new MagaluShippingLabelProvider().ensureInvoiceSent(ctx);
    expect(getMe).not.toHaveBeenCalled();
    expect(getOrder).not.toHaveBeenCalled();
  });

  it("ensureReadyToShip: pronto quando o pedido tem entrega (shipmentId = 1ª)", async () => {
    vi.spyOn(MagaluApiService, "getOrder").mockResolvedValue({
      id: "EXT1",
      deliveries: [{ id: "DLV1" }],
    } as any);
    const r = await new MagaluShippingLabelProvider().ensureReadyToShip(ctx);
    expect(r.ready).toBe(true);
    expect(r.shipmentId).toBe("DLV1");
  });

  it("ensureReadyToShip: NÃO pronto quando o pedido não tem entrega", async () => {
    vi.spyOn(MagaluApiService, "getOrder").mockResolvedValue({
      id: "EXT1",
    } as any);
    const r = await new MagaluShippingLabelProvider().ensureReadyToShip(ctx);
    expect(r.ready).toBe(false);
    expect(r.reason).toContain("entrega");
  });

  it("getLabelPdf resolve channel + delivery ids e devolve o PDF baixado", async () => {
    vi.spyOn(MagaluApiService, "getMe").mockResolvedValue({
      channel: { id: "CH1" },
    } as any);
    vi.spyOn(MagaluApiService, "getOrder").mockResolvedValue({
      id: "EXT1",
      deliveries: [{ id: "DLV1" }],
    } as any);
    const gen = vi
      .spyOn(MagaluShippingService, "generateLabels")
      .mockResolvedValue({ label: { signed_url: "https://x/y.pdf" } });
    const dl = vi
      .spyOn(MagaluShippingService, "downloadLabel")
      .mockResolvedValue(Buffer.from("%PDF magalu label"));

    const pdf = await new MagaluShippingLabelProvider().getLabelPdf([ctx], {
      size: "A4",
    });
    expect(pdf.toString()).toContain("%PDF magalu label");
    expect(gen).toHaveBeenCalledWith("tok", "CH1", ["DLV1"], {
      format: "pdf",
      type: "summary",
    });
    expect(dl).toHaveBeenCalledWith("https://x/y.pdf");
  });

  it("getLabelPdf lança PROVIDER_ERROR quando a Magalu não devolve signed_url", async () => {
    vi.spyOn(MagaluApiService, "getMe").mockResolvedValue({
      channel: { id: "CH1" },
    } as any);
    vi.spyOn(MagaluApiService, "getOrder").mockResolvedValue({
      id: "EXT1",
      deliveries: [{ id: "DLV1" }],
    } as any);
    vi.spyOn(MagaluShippingService, "generateLabels").mockResolvedValue({
      label: {},
    });
    let caught: unknown;
    try {
      await new MagaluShippingLabelProvider().getLabelPdf([ctx], { size: "A4" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ShippingLabelError);
    expect((caught as ShippingLabelError).code).toBe("PROVIDER_ERROR");
  });

  it("getLabelPdf lança SHIPMENT_NOT_FOUND quando o pedido não tem entrega", async () => {
    vi.spyOn(MagaluApiService, "getMe").mockResolvedValue({
      channel: { id: "CH1" },
    } as any);
    vi.spyOn(MagaluApiService, "getOrder").mockResolvedValue({
      id: "EXT1",
    } as any);
    let caught: unknown;
    try {
      await new MagaluShippingLabelProvider().getLabelPdf([ctx], { size: "A4" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ShippingLabelError);
    expect((caught as ShippingLabelError).code).toBe("SHIPMENT_NOT_FOUND");
  });
});
