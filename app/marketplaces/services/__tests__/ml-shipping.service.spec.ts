import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import axios from "axios";
import {
  MlShippingService,
  MlShippingLabelProvider,
} from "../ml-shipping.service";
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

describe("MlShippingService (HTTP de baixo nível)", () => {
  it("getOrderShippingId → GET /orders/{id} com Bearer e devolve shipping.id", async () => {
    (mockedAxios as any).get.mockResolvedValue({
      data: { id: 1, shipping: { id: 42 } },
    });
    const id = await MlShippingService.getOrderShippingId("tok", "ORD1");
    expect(id).toBe(42);
    const [url, config] = (mockedAxios as any).get.mock.calls[0];
    expect(url).toContain("/orders/ORD1");
    expect(config.headers.Authorization).toBe("Bearer tok");
  });

  it("getOrderShippingId → null quando o pedido não tem shipping.id", async () => {
    (mockedAxios as any).get.mockResolvedValue({ data: { id: 1, shipping: {} } });
    expect(await MlShippingService.getOrderShippingId("tok", "ORD1")).toBeNull();
  });

  it("sendInvoiceData → POST /shipments/{id}/invoice_data?siteId=MLB com XML", async () => {
    await MlShippingService.sendInvoiceData("tok", "SHIP1", "<nfeProc/>");
    const [url, body, config] = (mockedAxios as any).post.mock.calls[0];
    expect(url).toContain("/shipments/SHIP1/invoice_data");
    expect(url).toContain("siteId=MLB");
    expect(body).toBe("<nfeProc/>");
    expect(config.headers["Content-Type"]).toBe("application/xml");
    expect(config.headers.Authorization).toBe("Bearer tok");
  });

  it("getLabelsPdf → GET /shipment_labels com ids e response_type=pdf (arraybuffer)", async () => {
    (mockedAxios as any).get.mockResolvedValue({
      data: Buffer.from("%PDF-1.4 etiqueta"),
    });
    const pdf = await MlShippingService.getLabelsPdf("tok", ["10", "20"], "pdf");
    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect(pdf.toString()).toContain("%PDF");
    const [url, config] = (mockedAxios as any).get.mock.calls[0];
    expect(url).toContain("/shipment_labels?shipment_ids=10,20");
    expect(url).toContain("response_type=pdf");
    expect(config.responseType).toBe("arraybuffer");
  });

  it("erro de auth (401) é repassado com .status para o refresh detectar", async () => {
    (mockedAxios as any).get.mockRejectedValue({
      isAxiosError: true,
      response: { status: 401, data: { message: "invalid token" } },
      message: "Request failed",
    });
    let caught: any;
    try {
      await MlShippingService.getShipment("tok", "SHIP1");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught.status).toBe(401);
  });
});

describe("MlShippingLabelProvider", () => {
  const ctx: ShippingOrderContext = {
    order: { id: "o1", externalOrderId: "EXT1", marketplaceAccountId: "acc1" },
    account: {
      id: "acc1",
      platform: "MERCADO_LIVRE",
      accessToken: "tok",
      refreshToken: "ref",
      externalUserId: "seller1",
      shopId: null,
    },
    nfe: {
      id: "nfe1",
      chaveAcesso: "1".repeat(44),
      xmlAutorizadoPath: "/x.xml",
      xml: "<nfeProc/>",
    },
  };

  it("ensureInvoiceSent envia a NF-e quando substatus=invoice_pending", async () => {
    vi.spyOn(MlShippingService, "getOrderShippingId").mockResolvedValue(999);
    vi.spyOn(MlShippingService, "getShipment").mockResolvedValue({
      id: 999,
      status: "ready_to_ship",
      substatus: "invoice_pending",
    });
    const send = vi
      .spyOn(MlShippingService, "sendInvoiceData")
      .mockResolvedValue(undefined);

    await new MlShippingLabelProvider().ensureInvoiceSent(ctx);
    expect(send).toHaveBeenCalledWith("tok", "999", "<nfeProc/>");
  });

  it("ensureInvoiceSent NÃO reenvia quando já está ready_to_print", async () => {
    vi.spyOn(MlShippingService, "getOrderShippingId").mockResolvedValue(999);
    vi.spyOn(MlShippingService, "getShipment").mockResolvedValue({
      id: 999,
      status: "ready_to_ship",
      substatus: "ready_to_print",
    });
    const send = vi.spyOn(MlShippingService, "sendInvoiceData");

    await new MlShippingLabelProvider().ensureInvoiceSent(ctx);
    expect(send).not.toHaveBeenCalled();
  });

  it("ensureReadyToShip: pronto quando substatus=ready_to_print", async () => {
    vi.spyOn(MlShippingService, "getOrderShippingId").mockResolvedValue(999);
    vi.spyOn(MlShippingService, "getShipment").mockResolvedValue({
      id: 999,
      status: "ready_to_ship",
      substatus: "ready_to_print",
      tracking_number: "TRK1",
    });
    const r = await new MlShippingLabelProvider().ensureReadyToShip(ctx);
    expect(r.ready).toBe(true);
    expect(r.shipmentId).toBe("999");
    expect(r.trackingNumber).toBe("TRK1");
  });

  it("ensureReadyToShip: NÃO pronto quando substatus=invoice_pending (reason)", async () => {
    vi.spyOn(MlShippingService, "getOrderShippingId").mockResolvedValue(999);
    vi.spyOn(MlShippingService, "getShipment").mockResolvedValue({
      id: 999,
      status: "ready_to_ship",
      substatus: "invoice_pending",
    });
    const r = await new MlShippingLabelProvider({
      pollMaxAttempts: 2,
      pollDelayMs: 0,
    }).ensureReadyToShip(ctx);
    expect(r.ready).toBe(false);
    expect(r.reason).toBe("invoice_pending");
  });

  it("getLabelPdf resolve shipment ids e devolve o PDF", async () => {
    vi.spyOn(MlShippingService, "getOrderShippingId").mockResolvedValue(999);
    const getLabels = vi
      .spyOn(MlShippingService, "getLabelsPdf")
      .mockResolvedValue(Buffer.from("%PDF label"));

    const pdf = await new MlShippingLabelProvider().getLabelPdf([ctx], {
      size: "A4",
    });
    expect(pdf.toString()).toContain("%PDF label");
    expect(getLabels).toHaveBeenCalledWith("tok", ["999"], "pdf");
  });

  it("SHIPMENT_NOT_FOUND quando o pedido não tem shipment", async () => {
    vi.spyOn(MlShippingService, "getOrderShippingId").mockResolvedValue(null);
    let caught: unknown;
    try {
      await new MlShippingLabelProvider().ensureReadyToShip(ctx);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ShippingLabelError);
    expect((caught as ShippingLabelError).code).toBe("SHIPMENT_NOT_FOUND");
  });
});
