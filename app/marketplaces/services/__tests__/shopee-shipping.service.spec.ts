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
import { MarketplaceIntegrationError } from "../../shipping/integration-error";
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

/**
 * Incidente de 25/08/2026: o pedido 2608221M2DR72U (e outros 13) ficou preso em
 * labelStatus=ERROR porque o get_shipping_parameter — PRIMEIRA etapa da cadeia —
 * recusa depois que o envio foi arranjado. E quem arranja o envio e o nosso
 * proprio ship_order, na tentativa anterior: o pipeline se auto-tranca.
 *
 * Os erros abaixo sao os corpos REAIS medidos contra a Shopee de producao, com
 * os codigos reais (error_other / error_param). Repare que os dois codigos sao
 * baldes genericos — e por isso que o casamento e pelo texto.
 */
describe("ShopeeShippingLabelProvider — get_shipping_parameter recusado após o envio arranjado", () => {
  const ORIGINAL = process.env.SHOPEE_SHIPPING_PARAM_TOLERANT_DISABLED;

  beforeEach(() => {
    process.env.SHOPEE_SHIPPING_PARAM_TOLERANT_DISABLED = "0";
  });

  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env.SHOPEE_SHIPPING_PARAM_TOLERANT_DISABLED;
    } else {
      process.env.SHOPEE_SHIPPING_PARAM_TOLERANT_DISABLED = ORIGINAL;
    }
  });

  /** Corpo real da Shopee: HTTP 200 com `error` preenchido. */
  const recusa = (code: string, message: string) =>
    new MarketplaceIntegrationError(
      `shopee.logistics.get_shipping_parameter recusado pela SHOPEE: ${message}`,
      {
        marketplace: "SHOPEE",
        operation: "shopee.logistics.get_shipping_parameter",
        step: "get_shipping_parameter",
        httpStatus: 200,
        providerErrorCode: code,
        providerMessage: message,
        orderSn: "2504ABC",
        shopId: 123,
      },
    );

  const NAO_REMARCAVEL = () =>
    recusa("error_other", "Package OFG241055916134686 not eligible for rescheduling");
  const JA_DESPACHADO = () =>
    recusa(
      "error_param",
      "Shipping parameters can only be obtained when package is ready to be shipped",
    );

  it("pronto quando a Shopee diz 'not eligible for rescheduling' e há rastreio", async () => {
    vi.spyOn(ShopeeApiService, "getShippingParameter").mockRejectedValue(
      NAO_REMARCAVEL(),
    );
    const ship = vi.spyOn(ShopeeApiService, "shipOrder");
    vi.spyOn(ShopeeApiService, "getTrackingNumber").mockResolvedValue(
      "BR267967530076P",
    );

    const r = await new ShopeeShippingLabelProvider().ensureReadyToShip(ctx);
    expect(r.ready).toBe(true);
    expect(r.trackingNumber).toBe("BR267967530076P");
    expect(r.shipmentId).toBe("2504ABC");
    // Não há o que arranjar: o envio já foi arranjado.
    expect(ship).not.toHaveBeenCalled();
  });

  it("pronto também na outra frase, 'can only be obtained when package is ready to be shipped'", async () => {
    vi.spyOn(ShopeeApiService, "getShippingParameter").mockRejectedValue(
      JA_DESPACHADO(),
    );
    const ship = vi.spyOn(ShopeeApiService, "shipOrder");
    vi.spyOn(ShopeeApiService, "getTrackingNumber").mockResolvedValue("BR2601S");

    const r = await new ShopeeShippingLabelProvider().ensureReadyToShip(ctx);
    expect(r.ready).toBe(true);
    expect(r.trackingNumber).toBe("BR2601S");
    expect(ship).not.toHaveBeenCalled();
  });

  it("NÃO pronto (e sem marcar erro) quando não há rastreio para confirmar", async () => {
    vi.spyOn(ShopeeApiService, "getShippingParameter").mockRejectedValue(
      JA_DESPACHADO(),
    );
    const ship = vi.spyOn(ShopeeApiService, "shipOrder");
    vi.spyOn(ShopeeApiService, "getTrackingNumber").mockResolvedValue(null);

    const r = await new ShopeeShippingLabelProvider().ensureReadyToShip(ctx);
    expect(r.ready).toBe(false);
    expect(r.reason).toContain("ready to be shipped");
    expect(r.shipmentId).toBe("2504ABC");
    expect(ship).not.toHaveBeenCalled();
  });

  it("rastreio VAZIO conta como ausência — é o que a Shopee devolve logo após o ship_order", async () => {
    vi.spyOn(ShopeeApiService, "getShippingParameter").mockRejectedValue(
      NAO_REMARCAVEL(),
    );
    vi.spyOn(ShopeeApiService, "getTrackingNumber").mockResolvedValue("   ");

    const r = await new ShopeeShippingLabelProvider().ensureReadyToShip(ctx);
    expect(r.ready).toBe(false);
  });

  it("falha do get_tracking_number não vira sucesso silencioso", async () => {
    vi.spyOn(ShopeeApiService, "getShippingParameter").mockRejectedValue(
      NAO_REMARCAVEL(),
    );
    vi.spyOn(ShopeeApiService, "getTrackingNumber").mockRejectedValue(
      new Error("indisponível"),
    );

    const r = await new ShopeeShippingLabelProvider().ensureReadyToShip(ctx);
    expect(r.ready).toBe(false);
  });

  it("falha GENUÍNA do get_shipping_parameter continua propagando", async () => {
    vi.spyOn(ShopeeApiService, "getShippingParameter").mockRejectedValue(
      recusa("error_param", "Order does not exist"),
    );
    const ship = vi.spyOn(ShopeeApiService, "shipOrder");

    await expect(
      new ShopeeShippingLabelProvider().ensureReadyToShip(ctx),
    ).rejects.toBeInstanceOf(MarketplaceIntegrationError);
    expect(ship).not.toHaveBeenCalled();
  });

  it('"not ready" NÃO é tolerado — significa o oposto de "já arranjado"', async () => {
    vi.spyOn(ShopeeApiService, "getShippingParameter").mockRejectedValue(
      recusa("error_param", "Package is not ready"),
    );
    await expect(
      new ShopeeShippingLabelProvider().ensureReadyToShip(ctx),
    ).rejects.toBeInstanceOf(MarketplaceIntegrationError);
  });

  it("kill-switch =1 restaura exatamente o comportamento anterior", async () => {
    process.env.SHOPEE_SHIPPING_PARAM_TOLERANT_DISABLED = "1";
    vi.spyOn(ShopeeApiService, "getShippingParameter").mockRejectedValue(
      NAO_REMARCAVEL(),
    );
    const tracking = vi.spyOn(ShopeeApiService, "getTrackingNumber");

    await expect(
      new ShopeeShippingLabelProvider().ensureReadyToShip(ctx),
    ).rejects.toBeInstanceOf(MarketplaceIntegrationError);
    expect(tracking).not.toHaveBeenCalled();
  });
});

/**
 * Segundo modo de falha do mesmo incidente: o create_shipping_document recusa
 * enquanto a Shopee ainda prepara o documento. E temporario — ela mesma manda
 * tentar de novo — mas virava labelStatus=ERROR permanente em 9 dos 17 pedidos
 * presos.
 */
describe("ShopeeShippingLabelProvider — documento de envio ainda não está pronto", () => {
  const ORIGINAL = process.env.SHOPEE_LABEL_NOT_READY_TOLERANT_DISABLED;

  beforeEach(() => {
    process.env.SHOPEE_LABEL_NOT_READY_TOLERANT_DISABLED = "0";
  });

  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env.SHOPEE_LABEL_NOT_READY_TOLERANT_DISABLED;
    } else {
      process.env.SHOPEE_LABEL_NOT_READY_TOLERANT_DISABLED = ORIGINAL;
    }
  });

  /** Corpo real: erro de topo generico, motivo enterrado no result_list. */
  const naoPronto = (opts: { comCodigo: boolean }) => {
    const err = new MarketplaceIntegrationError(
      "shopee.logistics.create_shipping_document recusado pela SHOPEE: All failed, please check result_list for detail",
      {
        marketplace: "SHOPEE",
        operation: "shopee.logistics.create_shipping_document",
        step: "create_shipping_document",
        httpStatus: 200,
        providerErrorCode: "common.batch_api_all_failed",
        providerMessage: "All failed, please check result_list for detail",
        shopId: 123,
      },
    );
    if (opts.comCodigo) {
      (err as unknown as { shopeeFailError?: string }).shopeeFailError =
        "logistics.package_can_not_print";
    }
    (err as unknown as { shopeeFailMessage?: string }).shopeeFailMessage =
      "The package can not print now.  Detail: The document is not yet ready for printing. Please try again later.";
    return err;
  };

  it("vira NOT_READY, não PROVIDER_ERROR — o pedido não é marcado como erro", async () => {
    vi.spyOn(ShopeeApiService, "createShippingDocument").mockRejectedValue(
      naoPronto({ comCodigo: true }),
    );
    const result = vi.spyOn(ShopeeApiService, "getShippingDocumentResult");

    let caught: unknown;
    try {
      await new ShopeeShippingLabelProvider().getLabelPdf([ctx], {
        size: "THERMAL",
      });
    } catch (e) {
      caught = e;
    }
    expect((caught as ShippingLabelError).code).toBe("NOT_READY");
    expect((caught as ShippingLabelError).message).toContain(
      "Tente novamente em alguns instantes",
    );
    expect(result).not.toHaveBeenCalled();
  });

  it("reconhece pela mensagem mesmo quando o fail_error não vem", async () => {
    vi.spyOn(ShopeeApiService, "createShippingDocument").mockRejectedValue(
      naoPronto({ comCodigo: false }),
    );
    let caught: unknown;
    try {
      await new ShopeeShippingLabelProvider().getLabelPdf([ctx], {
        size: "THERMAL",
      });
    } catch (e) {
      caught = e;
    }
    expect((caught as ShippingLabelError).code).toBe("NOT_READY");
  });

  it("outra falha do create continua propagando como antes", async () => {
    const outro = new MarketplaceIntegrationError(
      "shopee.logistics.create_shipping_document recusado pela SHOPEE: invalid document type",
      {
        marketplace: "SHOPEE",
        operation: "shopee.logistics.create_shipping_document",
        step: "create_shipping_document",
        httpStatus: 200,
        providerErrorCode: "error_param",
      },
    );
    vi.spyOn(ShopeeApiService, "createShippingDocument").mockRejectedValue(
      outro,
    );
    await expect(
      new ShopeeShippingLabelProvider().getLabelPdf([ctx], { size: "THERMAL" }),
    ).rejects.toBeInstanceOf(MarketplaceIntegrationError);
  });

  it("kill-switch =1 restaura exatamente o comportamento anterior", async () => {
    process.env.SHOPEE_LABEL_NOT_READY_TOLERANT_DISABLED = "1";
    vi.spyOn(ShopeeApiService, "createShippingDocument").mockRejectedValue(
      naoPronto({ comCodigo: true }),
    );
    await expect(
      new ShopeeShippingLabelProvider().getLabelPdf([ctx], { size: "THERMAL" }),
    ).rejects.toBeInstanceOf(MarketplaceIntegrationError);
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

  it("createShippingDocument → expõe o fail_error enterrado no result_list", async () => {
    // Corpo real da Shopee: erro generico na raiz, motivo real la dentro.
    (mockedAxios as any).request.mockResolvedValue({
      data: {
        error: "common.batch_api_all_failed",
        message: "All failed, please check result_list for detail",
        response: {
          result_list: [
            {
              order_sn: "2504ABC",
              fail_error: "logistics.package_can_not_print",
              fail_message:
                "The package can not print now.  Detail: The document is not yet ready for printing. Please try again later.",
            },
          ],
        },
      },
    });

    let caught: unknown;
    try {
      await ShopeeApiService.createShippingDocument(
        "tok",
        123,
        [{ order_sn: "2504ABC" }],
        "THERMAL_AIR_WAYBILL",
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(MarketplaceIntegrationError);
    expect(
      (caught as unknown as { shopeeFailError?: string }).shopeeFailError,
    ).toBe("logistics.package_can_not_print");
    expect(
      (caught as unknown as { shopeeFailMessage?: string }).shopeeFailMessage,
    ).toContain("not yet ready for printing");
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

  it("uploadInvoiceDoc → POST multipart para /api/v2/ORDER/upload_invoice_doc", async () => {
    (mockedAxios as any).post.mockResolvedValue({ data: { error: "" } });
    await ShopeeApiService.uploadInvoiceDoc("tok", 123, "2504ABC", "<nfeProc/>");
    const [url, body] = (mockedAxios as any).post.mock.calls[0];

    // REGRESSÃO 29/07/2026: este endpoint é do módulo `order`. Enquanto
    // apontava para `logistics` a Shopee devolvia 404 error_not_found e a
    // etiqueta era impossível. A asserção anterior deste teste congelava o
    // path errado — ela afirmava a suposição, não o contrato.
    expect(url).toContain("/api/v2/order/upload_invoice_doc");
    expect(url).not.toContain("/api/v2/logistics/upload_invoice_doc");
    // body é um FormData (form-data): possui getHeaders()
    expect(typeof (body as any).getHeaders).toBe("function");
  });
});
