/**
 * Regressão do incidente de 29/07/2026 — Shopee `upload_invoice_doc` 404.
 *
 * O que estes testes travam:
 *  1. o PATH (módulo `order`, não `logistics`) — a causa raiz;
 *  2. o CONTRATO do corpo (multipart, campo `file`, `file_type` inteiro);
 *  3. a NORMALIZAÇÃO do erro — nunca mais "Request failed with status code".
 *
 * Todos falham no código anterior.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.hoisted(() => {
  process.env.SHOPEE_PARTNER_ID = "2000001";
  process.env.SHOPEE_PARTNER_KEY = "a".repeat(64);
  process.env.SHOPEE_SANDBOX = "true";
});

import axios from "axios";
import { ShopeeApiService } from "../shopee-api.service";
import { MarketplaceIntegrationError } from "../../shipping/integration-error";

vi.mock("axios");
const mockedAxios = axios as unknown as {
  request: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  isAxiosError: (e: unknown) => boolean;
};

/** Aguarda a promise e devolve o erro já tipado (falha se ela resolver). */
async function catchIntegrationError(
  p: Promise<unknown>,
): Promise<MarketplaceIntegrationError> {
  try {
    await p;
  } catch (e) {
    return e as MarketplaceIntegrationError;
  }
  throw new Error("esperava um erro, mas a promise resolveu");
}

/** Erro no formato que o axios produz — o que o catch real recebe. */
function axiosError(status: number, data: unknown) {
  return {
    isAxiosError: true,
    message: `Request failed with status code ${status}`,
    response: { status, data },
    config: { url: "https://partner.test-stable.shopeemobile.com/x" },
  };
}

beforeEach(() => {
  (mockedAxios as any).request = vi.fn();
  (mockedAxios as any).post = vi.fn();
  (mockedAxios as any).isAxiosError = (e: any) => !!e && e.isAxiosError === true;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("uploadInvoiceDoc — contrato HTTP", () => {
  it("usa o módulo `order`, NUNCA `logistics` (causa raiz do 404)", async () => {
    (mockedAxios as any).post.mockResolvedValue({ data: { error: "" } });
    await ShopeeApiService.uploadInvoiceDoc("tok", 123, "2504ABC", "<nfeProc/>");

    const [url] = (mockedAxios as any).post.mock.calls[0];
    expect(url).toContain("/api/v2/order/upload_invoice_doc");
    expect(url).not.toContain("logistics/upload_invoice_doc");
  });

  it("snapshot da URL: host + path + params assinados (trava regressão de base URL)", async () => {
    (mockedAxios as any).post.mockResolvedValue({ data: { error: "" } });
    await ShopeeApiService.uploadInvoiceDoc("tok", 123, "2504ABC", "<nfeProc/>");

    const url = new URL((mockedAxios as any).post.mock.calls[0][0]);
    expect(url.host).toBe("partner.test-stable.shopeemobile.com");
    expect(url.pathname).toBe("/api/v2/order/upload_invoice_doc");
    expect([...url.searchParams.keys()].sort()).toEqual([
      "access_token",
      "partner_id",
      "shop_id",
      "sign",
      "timestamp",
    ]);
  });

  it("manda file_type INTEIRO e o arquivo no campo `file`", async () => {
    (mockedAxios as any).post.mockResolvedValue({ data: { error: "" } });
    await ShopeeApiService.uploadInvoiceDoc("tok", 123, "2504ABC", "<nfeProc/>");

    // O form-data serializa os campos no buffer; inspecionar o corpo bruto é a
    // forma de afirmar nome do campo e valor sem depender da API interna dele.
    const form = (mockedAxios as any).post.mock.calls[0][1];
    const body = form.getBuffer().toString("utf-8");

    expect(body).toContain('name="order_sn"');
    expect(body).toContain("2504ABC");
    expect(body).toContain('name="file_type"');
    // A Shopee recusa a string: "normal_invoice can not be parsed to integer".
    expect(body).not.toContain("normal_invoice");
    expect(body).toMatch(/name="file_type"\r?\n\r?\n\d+/);
    // O campo do arquivo chama-se `file`; com `invoice_file` a Shopee responde
    // "file is a required field".
    expect(body).toContain('name="file"');
    expect(body).not.toContain('name="invoice_file"');
  });
});

describe("uploadInvoiceDoc — normalização de erro", () => {
  it("404 com {error:'error_not_found'} vira erro tipado, sem texto cru do axios", async () => {
    (mockedAxios as any).post.mockRejectedValue(
      // Corpo REAL capturado da Shopee em 04/08/2026: tem `error`, não tem
      // `message` — era exatamente por isso que o código caía no
      // `error.message` genérico do axios.
      axiosError(404, { error: "error_not_found" }),
    );

    let caught: unknown;
    try {
      await ShopeeApiService.uploadInvoiceDoc("tok", 123, "2504ABC", "<x/>");
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(MarketplaceIntegrationError);
    const err = caught as MarketplaceIntegrationError;
    expect(err.marketplace).toBe("SHOPEE");
    expect(err.operation).toBe("shopee.order.upload_invoice_doc");
    expect(err.step).toBe("upload_invoice_doc");
    expect(err.httpStatus).toBe(404);
    expect(err.providerErrorCode).toBe("error_not_found");
    expect(err.orderSn).toBe("2504ABC");
    expect(err.shopId).toBe(123);
    expect(err.endpoint).toContain("/api/v2/order/upload_invoice_doc");
    // O sintoma que o lojista viu na tela não pode mais existir.
    expect(err.message).not.toContain("Request failed with status code");
    expect(err.message).toContain("error_not_found");
  });

  it("HTTP 200 com {error:'error_param'} é FALHA, não sucesso", async () => {
    (mockedAxios as any).post.mockResolvedValue({
      data: {
        error: "error_param",
        message: "Wrong parameters, detail: parameter type error.",
        request_id: "req-123",
      },
    });

    let caught: unknown;
    try {
      await ShopeeApiService.uploadInvoiceDoc("tok", 123, "2504ABC", "<x/>");
    } catch (e) {
      caught = e;
    }

    const err = caught as MarketplaceIntegrationError;
    expect(err).toBeInstanceOf(MarketplaceIntegrationError);
    expect(err.providerErrorCode).toBe("error_param");
    expect(err.providerRequestId).toBe("req-123");
    // 200-com-erro não é transitório: retentar não muda nada.
    expect(err.isTransient).toBe(false);
  });

  it("preserva o request_id da Shopee (é o que o suporte deles pede)", async () => {
    (mockedAxios as any).post.mockRejectedValue(
      axiosError(400, { error: "error_param", request_id: "abc-req-999" }),
    );
    const err = await catchIntegrationError(
      ShopeeApiService.uploadInvoiceDoc("tok", 123, "2504ABC", "<x/>"),
    );

    expect(err.providerRequestId).toBe("abc-req-999");
  });

  it("NÃO vaza access_token, sign nem partner_id na mensagem, no endpoint ou no log", async () => {
    (mockedAxios as any).post.mockRejectedValue(
      axiosError(404, { error: "error_not_found" }),
    );
    const err = await catchIntegrationError(
      ShopeeApiService.uploadInvoiceDoc(
        "tok-super-secreto",
        123,
        "2504ABC",
        "<x/>",
      ),
    );

    const exposed = JSON.stringify(err.toLogFields()) + err.message;
    expect(exposed).not.toContain("tok-super-secreto");
    expect(exposed).not.toContain("2000001"); // partner_id
    expect(exposed).not.toContain("a".repeat(64)); // partner_key
    expect(err.endpoint).toContain("access_token=***");
    expect(err.endpoint).toContain("sign=***");
  });

  it("classifica transitório x determinístico para o retry decidir", async () => {
    (mockedAxios as any).post.mockRejectedValue(axiosError(503, {}));
    const transient = await catchIntegrationError(
      ShopeeApiService.uploadInvoiceDoc("t", 1, "A", "<x/>"),
    );
    expect(transient.isTransient).toBe(true);

    (mockedAxios as any).post.mockRejectedValue(
      axiosError(404, { error: "error_not_found" }),
    );
    const deterministic = await catchIntegrationError(
      ShopeeApiService.uploadInvoiceDoc("t", 1, "A", "<x/>"),
    );
    expect(deterministic.isTransient).toBe(false);
    expect(deterministic.isDeterministic4xx).toBe(true);
  });
});

describe("downloadShippingDocument — corpo e resposta", () => {
  it("manda shipping_document_type só na RAIZ, não repetido por item", async () => {
    (mockedAxios as any).post.mockResolvedValue({
      data: Buffer.from("%PDF-1.4 etiqueta"),
    });
    await ShopeeApiService.downloadShippingDocument(
      "tok",
      123,
      [{ order_sn: "A1" }],
      "NORMAL_AIR_WAYBILL",
    );

    const body = (mockedAxios as any).post.mock.calls[0][1];
    expect(body.shipping_document_type).toBe("NORMAL_AIR_WAYBILL");
    expect(body.order_list).toEqual([{ order_sn: "A1" }]);
    expect(body.order_list[0].shipping_document_type).toBeUndefined();
  });

  it("resposta JSON de erro travestida de PDF vira erro tipado", async () => {
    // A Shopee devolve HTTP 200 + JSON quando recusa o download. Sem esta
    // checagem o JSON era salvo em disco como se fosse a etiqueta.
    (mockedAxios as any).post.mockResolvedValue({
      data: Buffer.from(
        JSON.stringify({
          error: "logistics.shipping_document_should_print_first",
          message: "The package should print first.",
          request_id: "r-1",
        }),
      ),
    });

    const err = await catchIntegrationError(
      ShopeeApiService.downloadShippingDocument(
        "tok",
        123,
        [{ order_sn: "A1" }],
        "NORMAL_AIR_WAYBILL",
      ),
    );

    expect(err).toBeInstanceOf(MarketplaceIntegrationError);
    expect(err.providerErrorCode).toBe(
      "logistics.shipping_document_should_print_first",
    );
  });
});
