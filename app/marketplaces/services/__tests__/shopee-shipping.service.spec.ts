import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Define as credenciais ANTES dos imports — SHOPEE_CONSTANTS captura o env no
// load do módulo, e a assinatura/validação dependem disso.
vi.hoisted(() => {
  process.env.SHOPEE_PARTNER_ID = "2000001";
  process.env.SHOPEE_PARTNER_KEY = "a".repeat(64);
  process.env.SHOPEE_SANDBOX = "true";
});

import axios from "axios";
import { ShopeeApiService } from "../shopee-api.service";
import { ShopeeShippingLabelProvider } from "../shopee-shipping.service";
import { ShippingLabelError } from "../../shipping/shipping-label.types";
import type { ShippingOrderContext } from "../../shipping/shipping-label.types";

vi.mock("axios");
const mockedAxios = axios as unknown as {
  request: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  isAxiosError: (e: unknown) => boolean;
};

const ctx: ShippingOrderContext = {
  order: { id: "o1", externalOrderId: "2504ABC", marketplaceAccountId: "acc1" },
  account: {
    id: "acc1",
    platform: "SHOPEE",
    accessToken: "tok",
    refreshToken: "ref",
    externalUserId: null,
    shopId: 123,
  },
  nfe: {
    id: "nfe1",
    chaveAcesso: "1".repeat(44),
    xmlAutorizadoPath: "/x.xml",
    xml: "<nfeProc/>",
  },
};

beforeEach(() => {
  (mockedAxios as any).request = vi.fn();
  (mockedAxios as any).post = vi.fn();
  (mockedAxios as any).isAxiosError = (e: any) => !!e && e.isAxiosError === true;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ShopeeShippingLabelProvider", () => {
  it("ensureInvoiceSent envia a NF-e via uploadInvoiceDoc", async () => {
    const up = vi
      .spyOn(ShopeeApiService, "uploadInvoiceDoc")
      .mockResolvedValue(undefined);
    await new ShopeeShippingLabelProvider().ensureInvoiceSent(ctx);
    // assinatura: (token, shopId, orderSn, xml)
    expect(up).toHaveBeenCalledWith("tok", 123, "2504ABC", "<nfeProc/>");
  });

  it("ensureReadyToShip escolhe DROPOFF quando pickup não é exigido", async () => {
    vi.spyOn(ShopeeApiService, "getShippingParameter").mockResolvedValue({
      info_needed: { dropoff: [] },
      dropoff: { branch_list: [{ branch_id: 7 }] },
    });
    const ship = vi
      .spyOn(ShopeeApiService, "shipOrder")
      .mockResolvedValue(undefined);
    vi.spyOn(ShopeeApiService, "getTrackingNumber").mockResolvedValue("TRK9");

    const r = await new ShopeeShippingLabelProvider().ensureReadyToShip(ctx);
    expect(r.ready).toBe(true);
    expect(r.trackingNumber).toBe("TRK9");
    expect(r.shipmentId).toBe("2504ABC");
    const body = ship.mock.calls[0][2];
    expect(body.dropoff).toEqual({ branch_id: 7 });
    expect(body.pickup).toBeUndefined();
  });

  it("ensureReadyToShip escolhe PICKUP quando exigido (address_id + pickup_time_id)", async () => {
    vi.spyOn(ShopeeApiService, "getShippingParameter").mockResolvedValue({
      info_needed: { pickup: ["address_id", "pickup_time_id"] },
      pickup: {
        address_list: [
          {
            address_id: 55,
            address_flag: ["pickup_address"],
            time_slot_list: [{ pickup_time_id: "T9" }],
          },
        ],
      },
    });
    const ship = vi
      .spyOn(ShopeeApiService, "shipOrder")
      .mockResolvedValue(undefined);
    vi.spyOn(ShopeeApiService, "getTrackingNumber").mockResolvedValue(null);

    await new ShopeeShippingLabelProvider().ensureReadyToShip(ctx);
    const body = ship.mock.calls[0][2];
    expect(body.pickup).toEqual({ address_id: 55, pickup_time_id: "T9" });
    expect(body.dropoff).toBeUndefined();
  });

  it("ensureReadyToShip → não pronto quando ship_order falha (NF-e validando)", async () => {
    vi.spyOn(ShopeeApiService, "getShippingParameter").mockResolvedValue({});
    vi.spyOn(ShopeeApiService, "shipOrder").mockRejectedValue(
      new Error("NF-e em validação na SEFAZ"),
    );
    const r = await new ShopeeShippingLabelProvider().ensureReadyToShip(ctx);
    expect(r.ready).toBe(false);
    expect(r.reason).toContain("validação");
  });

  it("ensureReadyToShip → pronto quando ship_order diz 'already arranged'", async () => {
    vi.spyOn(ShopeeApiService, "getShippingParameter").mockResolvedValue({});
    vi.spyOn(ShopeeApiService, "shipOrder").mockRejectedValue(
      new Error("Order already arranged shipment"),
    );
    vi.spyOn(ShopeeApiService, "getTrackingNumber").mockResolvedValue("TRK9");
    const r = await new ShopeeShippingLabelProvider().ensureReadyToShip(ctx);
    expect(r.ready).toBe(true);
  });

  it("getLabelPdf: create → result READY → download (THERMAL → THERMAL_AIR_WAYBILL)", async () => {
    const create = vi
      .spyOn(ShopeeApiService, "createShippingDocument")
      .mockResolvedValue(undefined);
    vi.spyOn(ShopeeApiService, "getShippingDocumentResult").mockResolvedValue([
      { order_sn: "2504ABC", status: "READY" },
    ]);
    vi.spyOn(ShopeeApiService, "downloadShippingDocument").mockResolvedValue(
      Buffer.from("%PDF shopee"),
    );

    const pdf = await new ShopeeShippingLabelProvider().getLabelPdf([ctx], {
      size: "THERMAL",
    });
    expect(pdf.toString()).toContain("%PDF shopee");
    expect(create).toHaveBeenCalledWith(
      "tok",
      123,
      [{ order_sn: "2504ABC" }],
      "THERMAL_AIR_WAYBILL",
    );
  });

  it("getLabelPdf: A4 → NORMAL_AIR_WAYBILL", async () => {
    const create = vi
      .spyOn(ShopeeApiService, "createShippingDocument")
      .mockResolvedValue(undefined);
    vi.spyOn(ShopeeApiService, "getShippingDocumentResult").mockResolvedValue([
      { order_sn: "2504ABC", status: "READY" },
    ]);
    vi.spyOn(ShopeeApiService, "downloadShippingDocument").mockResolvedValue(
      Buffer.from("%PDF"),
    );
    await new ShopeeShippingLabelProvider().getLabelPdf([ctx], { size: "A4" });
    expect(create.mock.calls[0][3]).toBe("NORMAL_AIR_WAYBILL");
  });

  it("getLabelPdf: status FAILED → PROVIDER_ERROR", async () => {
    vi.spyOn(ShopeeApiService, "createShippingDocument").mockResolvedValue(
      undefined,
    );
    vi.spyOn(ShopeeApiService, "getShippingDocumentResult").mockResolvedValue([
      { order_sn: "2504ABC", status: "FAILED" },
    ]);
    const dl = vi.spyOn(ShopeeApiService, "downloadShippingDocument");

    let caught: unknown;
    try {
      await new ShopeeShippingLabelProvider().getLabelPdf([ctx], { size: "A4" });
    } catch (e) {
      caught = e;
    }
    expect((caught as ShippingLabelError).code).toBe("PROVIDER_ERROR");
    expect(dl).not.toHaveBeenCalled();
  });

  it("getLabelPdf: NOT_READY após esgotar as tentativas de poll", async () => {
    vi.spyOn(ShopeeApiService, "createShippingDocument").mockResolvedValue(
      undefined,
    );
    vi.spyOn(ShopeeApiService, "getShippingDocumentResult").mockResolvedValue([
      { order_sn: "2504ABC", status: "PROCESSING" },
    ]);
    const dl = vi.spyOn(ShopeeApiService, "downloadShippingDocument");

    const provider = new ShopeeShippingLabelProvider({
      pollMaxAttempts: 2,
      pollDelayMs: 0,
    });
    let caught: unknown;
    try {
      await provider.getLabelPdf([ctx], { size: "A4" });
    } catch (e) {
      caught = e;
    }
    expect((caught as ShippingLabelError).code).toBe("NOT_READY");
    expect(dl).not.toHaveBeenCalled();
  });
});

describe("ShopeeApiService — logistics (HTTP de baixo nível)", () => {
  it("getShippingParameter → GET get_shipping_parameter com order_sn", async () => {
    (mockedAxios as any).request.mockResolvedValue({
      data: { error: "", message: "", response: { info_needed: {} } },
    });
    const r = await ShopeeApiService.getShippingParameter("tok", 123, "2504ABC");
    expect(r).toEqual({ info_needed: {} });
    const cfg = (mockedAxios as any).request.mock.calls[0][0];
    expect(cfg.method).toBe("GET");
    expect(cfg.url).toContain("/api/v2/logistics/get_shipping_parameter");
    expect(cfg.url).toContain("order_sn=2504ABC");
    expect(cfg.url).toContain("sign=");
  });

  it("downloadShippingDocument → POST binário (arraybuffer) devolve Buffer", async () => {
    (mockedAxios as any).post.mockResolvedValue({
      data: Buffer.from("%PDF-1.4 shopee"),
    });
    const pdf = await ShopeeApiService.downloadShippingDocument(
      "tok",
      123,
      [{ order_sn: "2504ABC" }],
      "NORMAL_AIR_WAYBILL",
    );
    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect(pdf.toString()).toContain("%PDF");
    const [url, , config] = (mockedAxios as any).post.mock.calls[0];
    expect(url).toContain("/api/v2/logistics/download_shipping_document");
    expect(config.responseType).toBe("arraybuffer");
  });

  it("uploadInvoiceDoc → POST multipart para upload_invoice_doc", async () => {
    (mockedAxios as any).post.mockResolvedValue({ data: { error: "" } });
    await ShopeeApiService.uploadInvoiceDoc("tok", 123, "2504ABC", "<nfeProc/>");
    const [url, body] = (mockedAxios as any).post.mock.calls[0];
    expect(url).toContain("/api/v2/logistics/upload_invoice_doc");
    // body é um FormData (form-data): possui getHeaders()
    expect(typeof (body as any).getHeaders).toBe("function");
  });
});
