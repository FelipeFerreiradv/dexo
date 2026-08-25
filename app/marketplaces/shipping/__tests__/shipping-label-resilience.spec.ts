/**
 * Resiliência do módulo de etiqueta — correções do incidente de 29/07/2026.
 *
 * Cada bloco liga EXPLICITAMENTE o seu kill-switch (na suíte eles nascem
 * desligados, para os specs anteriores continuarem byte-idênticos). Em produção
 * o default é o oposto: ligados.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { ShippingLabelUseCase } from "../../usecases/shipping-label.usecase";
import prisma from "../../../lib/prisma";
import { NfeRepository } from "../../../repositories/nfe.repository";
import { shipmentLabelRepository } from "../../../repositories/shipment-label.repository";
import { FiscalStorageService } from "../../../fiscal/storage/fiscal-storage.service";
import { ShippingLabelStorageService } from "../shipping-label-storage.service";
import { MlShippingLabelProvider } from "../../services/ml-shipping.service";
import { ShopeeShippingLabelProvider } from "../../services/shopee-shipping.service";
import { ShopeeApiService } from "../../services/shopee-api.service";
import { ShopeeOAuthService } from "../../services/shopee-oauth.service";
import { ShippingLabelError } from "../shipping-label.types";
import {
  MarketplaceIntegrationError,
  toUserFacingMessage,
} from "../integration-error";
import {
  isMarketplaceAuthError,
  isTransientProviderError,
  ShippingAuthRetry,
  withTransientRetry,
} from "../auth-retry";
import { PDFDocument } from "pdf-lib";

async function makeRealPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.addPage([283, 425]).drawRectangle({ x: 5, y: 5, width: 273, height: 415 });
  return Buffer.from(await doc.save());
}

const ORDER_ROW = {
  id: "order1",
  externalOrderId: "EXT1",
  marketplaceAccountId: "acc1",
  marketplaceAccount: {
    id: "acc1",
    platform: "MERCADO_LIVRE",
    accessToken: "tok",
    refreshToken: "ref",
    externalUserId: "seller1",
    shopId: null,
  },
};

const PROD_NFE = {
  id: "nfe1",
  chaveAcesso: "1".repeat(44),
  xmlAutorizadoPath: "/fake/xml-autorizado/nfe1.xml",
  ambiente: "PRODUCAO",
  modelo: "55",
  status: "AUTHORIZED",
};

async function captureError(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return e;
  }
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.spyOn(prisma.order, "findFirst").mockResolvedValue(ORDER_ROW as never);
  vi.spyOn(NfeRepository.prototype, "findAuthorizedByOrderId").mockResolvedValue(
    PROD_NFE as never,
  );
  vi.spyOn(FiscalStorageService.prototype, "readFile").mockResolvedValue(
    Buffer.from("<nfeProc>...</nfeProc>", "utf-8"),
  );
  vi.spyOn(shipmentLabelRepository, "findByOrderId").mockResolvedValue(null);
  vi.spyOn(shipmentLabelRepository, "upsert").mockImplementation(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (orderId: string, data: any) =>
      ({
        id: "sl1",
        orderId,
        provider: data.provider ?? "MERCADO_LIVRE",
        shipmentId: data.shipmentId ?? null,
        trackingNumber: data.trackingNumber ?? null,
        labelStatus: data.labelStatus ?? "NONE",
        labelSize: data.labelSize ?? null,
        labelPdfPath: data.labelPdfPath ?? null,
        labelError: data.labelError ?? null,
        invoiceSentAt: data.invoiceSentAt ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }) as never,
  );
  vi.spyOn(
    ShippingLabelStorageService.prototype,
    "saveLabelPdf",
  ).mockResolvedValue("/fake/etiquetas/order1-A4.pdf");
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...ORIGINAL_ENV };
});

// ─────────────────────────────────────────────────────────────────────────────
describe("erro de provider vira PROVIDER_ERROR (HTTP 502), não 500 opaco", () => {
  it("MarketplaceIntegrationError é convertido e a mensagem é legível", async () => {
    vi.spyOn(
      MlShippingLabelProvider.prototype,
      "ensureInvoiceSent",
    ).mockRejectedValue(
      new MarketplaceIntegrationError("cru", {
        marketplace: "SHOPEE",
        operation: "shopee.order.upload_invoice_doc",
        step: "upload_invoice_doc",
        httpStatus: 404,
        providerErrorCode: "error_not_found",
        orderSn: "EXT1",
      }),
    );

    const err = await captureError(
      ShippingLabelUseCase.generateLabelForOrder("u1", "order1", "A4"),
    );

    expect(err).toBeInstanceOf(ShippingLabelError);
    // PROVIDER_ERROR é o único code que a rota mapeia para 502.
    expect((err as ShippingLabelError).code).toBe("PROVIDER_ERROR");
    const msg = (err as ShippingLabelError).message;
    expect(msg).not.toContain("Request failed with status code");
    expect(msg).toContain("enviar a NF-e");
    expect(msg).toContain("EXT1");
  });

  it("a mensagem ao usuário nomeia etapa, pedido, marketplace e referência", () => {
    const msg = toUserFacingMessage(
      new MarketplaceIntegrationError("x", {
        marketplace: "SHOPEE",
        operation: "shopee.order.upload_invoice_doc",
        step: "upload_invoice_doc",
        httpStatus: 400,
        providerMessage: "Upload is not accepted after shipment is arranged.",
        providerRequestId: "req-77",
        orderSn: "2607290P63B8P8",
      }),
    );
    expect(msg).toBe(
      "Falha ao enviar a NF-e do pedido 2607290P63B8P8 na Shopee: " +
        "Upload is not accepted after shipment is arranged. (referência Shopee: req-77)",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("pré-checagem do XML (SHIPPING_LABEL_PRECHECKS)", () => {
  beforeEach(() => {
    process.env.SHIPPING_LABEL_PRECHECKS_DISABLED = "0";
  });

  it("XML vazio falha ANTES de tocar o marketplace", async () => {
    vi.spyOn(FiscalStorageService.prototype, "readFile").mockResolvedValue(
      Buffer.from("", "utf-8"),
    );
    const invoice = vi.spyOn(
      MlShippingLabelProvider.prototype,
      "ensureInvoiceSent",
    );

    const err = await captureError(
      ShippingLabelUseCase.generateLabelForOrder("u1", "order1", "A4"),
    );

    expect((err as ShippingLabelError).code).toBe("NFE_XML_MISSING");
    expect(invoice).not.toHaveBeenCalled();
  });

  it("arquivo que é JSON travestido de .xml falha com mensagem clara", async () => {
    // Corresponde ao bug conhecido do buscarXml, que grava JSON no .xml.
    vi.spyOn(FiscalStorageService.prototype, "readFile").mockResolvedValue(
      Buffer.from('{"status":"autorizado"}', "utf-8"),
    );
    const err = await captureError(
      ShippingLabelUseCase.generateLabelForOrder("u1", "order1", "A4"),
    );
    expect((err as ShippingLabelError).code).toBe("NFE_XML_MISSING");
    expect((err as ShippingLabelError).message).toContain("inválido");
  });

  it("XML válido passa pela checagem", async () => {
    vi.spyOn(
      MlShippingLabelProvider.prototype,
      "ensureInvoiceSent",
    ).mockResolvedValue(undefined);
    vi.spyOn(
      MlShippingLabelProvider.prototype,
      "ensureReadyToShip",
    ).mockResolvedValue({ ready: true, shipmentId: "s1" });
    vi.spyOn(MlShippingLabelProvider.prototype, "getLabelPdf").mockResolvedValue(
      await makeRealPdf(),
    );

    const res = await ShippingLabelUseCase.generateLabelForOrder(
      "u1",
      "order1",
      "A4",
    );
    expect(res.record.labelStatus).toBe("GENERATED");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("lock por pedido (SHIPPING_LABEL_LOCK)", () => {
  beforeEach(() => {
    process.env.SHIPPING_LABEL_LOCK_DISABLED = "0";
  });

  it("duas emissões simultâneas do mesmo pedido não duplicam o pipeline", async () => {
    const pdf = await makeRealPdf();
    let invoiceCalls = 0;
    vi.spyOn(
      MlShippingLabelProvider.prototype,
      "ensureInvoiceSent",
    ).mockImplementation(async () => {
      invoiceCalls++;
      await new Promise((r) => setTimeout(r, 20));
    });
    vi.spyOn(
      MlShippingLabelProvider.prototype,
      "ensureReadyToShip",
    ).mockResolvedValue({ ready: true, shipmentId: "s1" });
    vi.spyOn(MlShippingLabelProvider.prototype, "getLabelPdf").mockResolvedValue(
      pdf,
    );

    // A segunda chamada entra depois que a primeira gravou GENERATED, então a
    // idempotência a atende do cache em vez de refazer as chamadas externas.
    let stored: { labelStatus: string; labelSize: string } | null = null;
    vi.spyOn(shipmentLabelRepository, "findByOrderId").mockImplementation(
      async () => stored as never,
    );
    const upsert = shipmentLabelRepository.upsert as unknown as ReturnType<
      typeof vi.fn
    >;
    const originalUpsert = upsert.getMockImplementation()!;
    upsert.mockImplementation(async (orderId: string, data: any) => {
      const row = await originalUpsert(orderId, data);
      if (data.labelStatus === "GENERATED") {
        stored = row as never;
      }
      return row;
    });
    vi.spyOn(
      ShippingLabelStorageService.prototype,
      "readFile",
    ).mockResolvedValue(pdf);

    const [a, b] = await Promise.all([
      ShippingLabelUseCase.generateLabelForOrder("u1", "order1", "A4"),
      ShippingLabelUseCase.generateLabelForOrder("u1", "order1", "A4"),
    ]);

    expect(invoiceCalls).toBe(1);
    expect([a.reused, b.reused].sort()).toEqual([false, true]);
  });

  it("falha da primeira não derruba a segunda que estava na fila", async () => {
    const pdf = await makeRealPdf();
    let calls = 0;
    vi.spyOn(
      MlShippingLabelProvider.prototype,
      "ensureInvoiceSent",
    ).mockImplementation(async () => {
      calls++;
      if (calls === 1) throw new Error("falha da primeira");
    });
    vi.spyOn(
      MlShippingLabelProvider.prototype,
      "ensureReadyToShip",
    ).mockResolvedValue({ ready: true, shipmentId: "s1" });
    vi.spyOn(MlShippingLabelProvider.prototype, "getLabelPdf").mockResolvedValue(
      pdf,
    );

    const results = await Promise.allSettled([
      ShippingLabelUseCase.generateLabelForOrder("u1", "order1", "A4"),
      ShippingLabelUseCase.generateLabelForOrder("u1", "order1", "A4"),
    ]);

    expect(results[0].status).toBe("rejected");
    expect(results[1].status).toBe("fulfilled");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("retry só de transitório (SHIPPING_LABEL_RETRY)", () => {
  beforeEach(() => {
    process.env.SHIPPING_LABEL_RETRY_DISABLED = "0";
  });

  it("classifica 429/5xx/rede como transitório e 4xx como definitivo", () => {
    const mk = (status: number) =>
      new MarketplaceIntegrationError("x", {
        marketplace: "SHOPEE",
        operation: "op",
        httpStatus: status,
      });
    expect(isTransientProviderError(mk(503))).toBe(true);
    expect(isTransientProviderError(mk(429))).toBe(true);
    expect(isTransientProviderError(mk(404))).toBe(false);
    expect(isTransientProviderError(mk(400))).toBe(false);
    expect(isTransientProviderError({ code: "ECONNRESET" })).toBe(true);
    // Erro sem classificação NÃO é retentado (conservador de propósito).
    expect(isTransientProviderError(new Error("boom"))).toBe(false);
  });

  it("retenta 5xx e devolve o sucesso da tentativa seguinte", async () => {
    let attempts = 0;
    const result = await withTransientRetry(async () => {
      attempts++;
      if (attempts < 3) {
        throw new MarketplaceIntegrationError("instável", {
          marketplace: "SHOPEE",
          operation: "op",
          httpStatus: 503,
        });
      }
      return "ok";
    });
    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });

  it("NÃO retenta 404 — retentar um path errado nunca resolveria", async () => {
    let attempts = 0;
    await expect(
      withTransientRetry(async () => {
        attempts++;
        throw new MarketplaceIntegrationError("not found", {
          marketplace: "SHOPEE",
          operation: "op",
          httpStatus: 404,
          providerErrorCode: "error_not_found",
        });
      }),
    ).rejects.toBeInstanceOf(MarketplaceIntegrationError);
    expect(attempts).toBe(1);
  });

  it("desligado pelo kill-switch: uma tentativa só", async () => {
    process.env.SHIPPING_LABEL_RETRY_DISABLED = "1";
    let attempts = 0;
    await expect(
      withTransientRetry(async () => {
        attempts++;
        throw new MarketplaceIntegrationError("instável", {
          marketplace: "SHOPEE",
          operation: "op",
          httpStatus: 503,
        });
      }),
    ).rejects.toBeTruthy();
    expect(attempts).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("Shopee: upload recusado após envio arranjado é não-bloqueante", () => {
  beforeEach(() => {
    process.env.SHOPEE_INVOICE_ARRANGED_TOLERANT_DISABLED = "0";
  });

  const ctx = {
    order: { id: "o1", externalOrderId: "2504ABC", marketplaceAccountId: "a1" },
    account: {
      id: "a1",
      platform: "SHOPEE" as const,
      accessToken: "tok",
      refreshToken: "ref",
      externalUserId: null,
      shopId: 123,
    },
    nfe: {
      id: "n1",
      chaveAcesso: "1".repeat(44),
      xmlAutorizadoPath: "/x.xml",
      xml: "<nfeProc/>",
    },
  };

  it('"not accepted after shipment is arranged" não interrompe o fluxo', async () => {
    vi.spyOn(ShopeeApiService, "uploadInvoiceDoc").mockRejectedValue(
      new MarketplaceIntegrationError(
        "shopee.order.upload_invoice_doc recusado: Upload invoice failed. Upload is not accepted after shipment is arranged.",
        {
          marketplace: "SHOPEE",
          operation: "shopee.order.upload_invoice_doc",
          httpStatus: 200,
          providerErrorCode: "error_param",
        },
      ),
    );

    await expect(
      new ShopeeShippingLabelProvider().ensureInvoiceSent(ctx),
    ).resolves.toBeUndefined();
  });

  it("qualquer outra falha do upload continua propagando", async () => {
    vi.spyOn(ShopeeApiService, "uploadInvoiceDoc").mockRejectedValue(
      new MarketplaceIntegrationError("outra coisa", {
        marketplace: "SHOPEE",
        operation: "shopee.order.upload_invoice_doc",
        httpStatus: 500,
      }),
    );
    await expect(
      new ShopeeShippingLabelProvider().ensureInvoiceSent(ctx),
    ).rejects.toBeInstanceOf(MarketplaceIntegrationError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("Shopee: get_shipping_document_parameter (SHOPEE_LABEL_DOC_PARAM)", () => {
  beforeEach(() => {
    process.env.SHOPEE_LABEL_DOC_PARAM_DISABLED = "0";
  });

  const ctx = {
    order: { id: "o1", externalOrderId: "2504ABC", marketplaceAccountId: "a1" },
    account: {
      id: "a1",
      platform: "SHOPEE" as const,
      accessToken: "tok",
      refreshToken: "ref",
      externalUserId: null,
      shopId: 123,
    },
    nfe: {
      id: "n1",
      chaveAcesso: "1".repeat(44),
      xmlAutorizadoPath: "/x.xml",
      xml: "<nfeProc/>",
    },
  };

  it("troca o tipo pedido pelo sugerido quando a transportadora não aceita", async () => {
    vi.spyOn(
      ShopeeApiService,
      "getShippingDocumentParameter",
    ).mockResolvedValue({
      suggested: "THERMAL_AIR_WAYBILL",
      selectable: ["THERMAL_AIR_WAYBILL"],
    });
    const create = vi
      .spyOn(ShopeeApiService, "createShippingDocument")
      .mockResolvedValue(undefined);
    vi.spyOn(ShopeeApiService, "getShippingDocumentResult").mockResolvedValue([
      { order_sn: "2504ABC", status: "READY" },
    ]);
    const download = vi
      .spyOn(ShopeeApiService, "downloadShippingDocument")
      .mockResolvedValue(Buffer.from("%PDF"));

    await new ShopeeShippingLabelProvider().getLabelPdf([ctx], { size: "A4" });

    // Pediu A4 (NORMAL_AIR_WAYBILL) mas só há térmica disponível.
    expect(create.mock.calls[0][3]).toBe("THERMAL_AIR_WAYBILL");
    expect(download.mock.calls[0][3]).toBe("THERMAL_AIR_WAYBILL");
  });

  it("consulta indisponível não quebra o fluxo (best-effort)", async () => {
    vi.spyOn(
      ShopeeApiService,
      "getShippingDocumentParameter",
    ).mockRejectedValue(new Error("indisponível"));
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
});

// ─────────────────────────────────────────────────────────────────────────────
describe("falha no refresh de token também vira erro tipado", () => {
  // Achado ao testar localmente: o 401 dispara o refresh, e os *OAuthService
  // lançam Error PURO. Sem conversão isso escapava do envelopamento e voltava
  // como HTTP 500 com o texto cru — a mesma classe de defeito do incidente,
  // só que pelo caminho do OAuth.
  it("Error puro do OAuth vira MarketplaceIntegrationError com step token_refresh", async () => {
    const account = {
      id: "a1",
      platform: "SHOPEE" as const,
      accessToken: "tok",
      refreshToken: "ref",
      externalUserId: null,
      shopId: 123,
    };

    vi.spyOn(ShopeeOAuthService, "refreshAccessToken").mockRejectedValue(
      new Error(
        "Erro ao renovar token: Request Source IP (1.2.3.4) is undeclared.",
      ),
    );

    const err = await captureError(
      ShippingAuthRetry.shopee(account, async () => {
        const e = new Error("unauthorized");
        (e as { status?: number }).status = 401;
        throw e;
      }),
    );

    expect(err).toBeInstanceOf(MarketplaceIntegrationError);
    const typed = err as MarketplaceIntegrationError;
    expect(typed.step).toBe("token_refresh");
    expect(typed.operation).toBe("shopee.oauth.refresh_token");

    // O motivo real precisa sobreviver até a mensagem do lojista — era o que
    // se perdia quando um Error puro chegava sem `providerMessage`.
    const msg = toUserFacingMessage(typed);
    expect(msg).toContain("renovar a autorização da conta");
    expect(msg).toContain("is undeclared");
    expect(msg).not.toContain("não houve resposta");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("403 que não é de token não dispara refresh", () => {
  // Achado no teste local: a Shopee devolve HTTP 403 `source_ip_undeclared`
  // quando o IP não está na whitelist. Tratar como erro de auth disparava um
  // refresh inútil E fazia a mensagem final culpar a "autorização da conta",
  // mandando o usuário consertar a coisa errada.
  it("source_ip_undeclared NÃO é erro de auth", () => {
    const err = new MarketplaceIntegrationError("x", {
      marketplace: "SHOPEE",
      operation: "shopee.order.upload_invoice_doc",
      httpStatus: 403,
      providerErrorCode: "source_ip_undeclared",
    });
    expect(isMarketplaceAuthError(err)).toBe(false);
  });

  it("401/403 de token continuam sendo erro de auth", () => {
    const tokenErr = new MarketplaceIntegrationError("x", {
      marketplace: "SHOPEE",
      operation: "op",
      httpStatus: 401,
      providerErrorCode: "error_auth",
    });
    expect(isMarketplaceAuthError(tokenErr)).toBe(true);
  });

  it("não refresca e propaga o motivo real do IP", async () => {
    const account = {
      id: "a1",
      platform: "SHOPEE" as const,
      accessToken: "tok",
      refreshToken: "ref",
      externalUserId: null,
      shopId: 123,
    };
    const refresh = vi.spyOn(ShopeeOAuthService, "refreshAccessToken");

    const err = await captureError(
      ShippingAuthRetry.shopee(account, async () => {
        throw new MarketplaceIntegrationError(
          "shopee.order.upload_invoice_doc falhou (HTTP 403): Request Source IP (1.2.3.4) is undeclared.",
          {
            marketplace: "SHOPEE",
            operation: "shopee.order.upload_invoice_doc",
            step: "upload_invoice_doc",
            httpStatus: 403,
            providerErrorCode: "source_ip_undeclared",
            providerMessage: "Request Source IP (1.2.3.4) is undeclared.",
          },
        );
      }),
    );

    expect(refresh).not.toHaveBeenCalled();
    const msg = toUserFacingMessage(err as MarketplaceIntegrationError);
    expect(msg).toContain("is undeclared");
    expect(msg).not.toContain("renovar a autorização");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("erro com .status numérico vira 502, erro de programação continua 500", () => {
  it("Error puro com .status (makeAuthenticatedRequest) vira PROVIDER_ERROR", async () => {
    const raw = new Error("Shopee API 403: alguma coisa");
    (raw as { status?: number }).status = 403;
    vi.spyOn(
      MlShippingLabelProvider.prototype,
      "ensureInvoiceSent",
    ).mockRejectedValue(raw);

    const err = await captureError(
      ShippingLabelUseCase.generateLabelForOrder("u1", "order1", "A4"),
    );
    expect((err as ShippingLabelError).code).toBe("PROVIDER_ERROR");
  });

  it("TypeError (bug nosso) NÃO vira 502 — continua visível como erro real", async () => {
    vi.spyOn(
      MlShippingLabelProvider.prototype,
      "ensureInvoiceSent",
    ).mockRejectedValue(new TypeError("x is not a function"));

    const err = await captureError(
      ShippingLabelUseCase.generateLabelForOrder("u1", "order1", "A4"),
    );
    expect(err).toBeInstanceOf(TypeError);
    expect(err).not.toBeInstanceOf(ShippingLabelError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
/**
 * Incidente de 25/08/2026, ponta a ponta. O pedido 2608221M2DR72U ficou preso
 * em labelStatus=ERROR porque as DUAS primeiras etapas recusam pelo mesmo
 * motivo — o envio ja foi arranjado pelo nosso proprio ship_order na tentativa
 * anterior — mas so a primeira tolerava isso.
 *
 * Este teste percorre o pipeline inteiro com os corpos REAIS da Shopee e exige
 * que o pedido chegue a GENERATED sem nunca passar por ERROR.
 */
describe("Shopee: consulta de opções de envio recusada após o envio arranjado", () => {
  const SHOPEE_ORDER = {
    id: "order1",
    externalOrderId: "2608221M2DR72U",
    marketplaceAccountId: "acc1",
    marketplaceAccount: {
      id: "acc1",
      platform: "SHOPEE",
      accessToken: "tok",
      refreshToken: "ref",
      externalUserId: null,
      shopId: 1322438439,
    },
  };

  beforeEach(() => {
    process.env.SHOPEE_INVOICE_ARRANGED_TOLERANT_DISABLED = "0";
    process.env.SHOPEE_SHIPPING_PARAM_TOLERANT_DISABLED = "0";
    vi.spyOn(prisma.order, "findFirst").mockResolvedValue(SHOPEE_ORDER as never);
  });

  it("o pedido preso sai de ERROR e chega a GENERATED, sem chamar ship_order", async () => {
    vi.spyOn(ShopeeApiService, "uploadInvoiceDoc").mockRejectedValue(
      new MarketplaceIntegrationError(
        "shopee.order.upload_invoice_doc recusado pela SHOPEE: Upload invoice failed. Upload is not accepted after shipment is arranged.",
        {
          marketplace: "SHOPEE",
          operation: "shopee.order.upload_invoice_doc",
          step: "upload_invoice_doc",
          httpStatus: 200,
          providerErrorCode: "error_param",
        },
      ),
    );
    vi.spyOn(ShopeeApiService, "getShippingParameter").mockRejectedValue(
      new MarketplaceIntegrationError(
        "shopee.logistics.get_shipping_parameter recusado pela SHOPEE: Package OFG241055916134686 not eligible for rescheduling",
        {
          marketplace: "SHOPEE",
          operation: "shopee.logistics.get_shipping_parameter",
          step: "get_shipping_parameter",
          httpStatus: 200,
          providerErrorCode: "error_other",
          providerMessage:
            "Package OFG241055916134686 not eligible for rescheduling",
          orderSn: "2608221M2DR72U",
        },
      ),
    );
    const ship = vi.spyOn(ShopeeApiService, "shipOrder");
    vi.spyOn(ShopeeApiService, "getTrackingNumber").mockResolvedValue(
      "BR267967530076P",
    );
    vi.spyOn(ShopeeApiService, "createShippingDocument").mockResolvedValue(
      undefined,
    );
    vi.spyOn(ShopeeApiService, "getShippingDocumentResult").mockResolvedValue([
      { order_sn: "2608221M2DR72U", status: "READY" },
    ]);
    vi.spyOn(ShopeeApiService, "downloadShippingDocument").mockResolvedValue(
      await makeRealPdf(),
    );
    const upsert = vi.spyOn(shipmentLabelRepository, "upsert");

    const r = await ShippingLabelUseCase.generateLabelForOrder(
      "u1",
      "order1",
      "THERMAL",
    );

    expect(r.record.labelStatus).toBe("GENERATED");
    expect(r.pdf.subarray(0, 4).toString()).toBe("%PDF");
    // O envio já estava arranjado: não há o que arranjar de novo.
    expect(ship).not.toHaveBeenCalled();
    // E em nenhum momento o pedido foi marcado como erro.
    const statuses = upsert.mock.calls.map((c) => (c[1] as any).labelStatus);
    expect(statuses).not.toContain("ERROR");
    expect(statuses).toContain("READY_TO_PRINT");
  });

  it("sem rastreio o pedido para em NOT_READY (409) em vez de virar ERROR", async () => {
    vi.spyOn(ShopeeApiService, "uploadInvoiceDoc").mockResolvedValue(
      undefined as never,
    );
    vi.spyOn(ShopeeApiService, "getShippingParameter").mockRejectedValue(
      new MarketplaceIntegrationError(
        "shopee.logistics.get_shipping_parameter recusado pela SHOPEE: Shipping parameters can only be obtained when package is ready to be shipped",
        {
          marketplace: "SHOPEE",
          operation: "shopee.logistics.get_shipping_parameter",
          step: "get_shipping_parameter",
          httpStatus: 200,
          providerErrorCode: "error_param",
          providerMessage:
            "Shipping parameters can only be obtained when package is ready to be shipped",
          orderSn: "2608221M2DR72U",
        },
      ),
    );
    vi.spyOn(ShopeeApiService, "getTrackingNumber").mockResolvedValue(null);
    const create = vi.spyOn(ShopeeApiService, "createShippingDocument");
    const upsert = vi.spyOn(shipmentLabelRepository, "upsert");

    const err = await captureError(
      ShippingLabelUseCase.generateLabelForOrder("u1", "order1", "THERMAL"),
    );

    expect((err as ShippingLabelError).code).toBe("NOT_READY");
    expect(create).not.toHaveBeenCalled();
    const statuses = upsert.mock.calls.map((c) => (c[1] as any).labelStatus);
    expect(statuses).not.toContain("ERROR");
  });

  it("kill-switch =1: volta a falhar como antes, com PROVIDER_ERROR", async () => {
    process.env.SHOPEE_SHIPPING_PARAM_TOLERANT_DISABLED = "1";
    vi.spyOn(ShopeeApiService, "uploadInvoiceDoc").mockResolvedValue(
      undefined as never,
    );
    vi.spyOn(ShopeeApiService, "getShippingParameter").mockRejectedValue(
      new MarketplaceIntegrationError(
        "shopee.logistics.get_shipping_parameter recusado pela SHOPEE: Package OFG… not eligible for rescheduling",
        {
          marketplace: "SHOPEE",
          operation: "shopee.logistics.get_shipping_parameter",
          step: "get_shipping_parameter",
          httpStatus: 200,
          providerErrorCode: "error_other",
          providerMessage: "Package OFG… not eligible for rescheduling",
          orderSn: "2608221M2DR72U",
        },
      ),
    );

    const err = await captureError(
      ShippingLabelUseCase.generateLabelForOrder("u1", "order1", "THERMAL"),
    );

    expect((err as ShippingLabelError).code).toBe("PROVIDER_ERROR");
    expect((err as ShippingLabelError).message).toContain(
      "consultar as opções de envio",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("orçamento de tempo (SHIPPING_LABEL_TIME_BUDGET)", () => {
  it("estourar o orçamento vira NOT_READY (409), não 504 do proxy", async () => {
    process.env.SHIPPING_LABEL_TIME_BUDGET_DISABLED = "0";
    process.env.SHIPPING_LABEL_BUDGET_MS = "30";

    vi.spyOn(
      MlShippingLabelProvider.prototype,
      "ensureInvoiceSent",
    ).mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });
    const ready = vi.spyOn(
      MlShippingLabelProvider.prototype,
      "ensureReadyToShip",
    );

    const err = await captureError(
      ShippingLabelUseCase.generateLabelForOrder("u1", "order1", "A4"),
    );

    expect((err as ShippingLabelError).code).toBe("NOT_READY");
    expect(ready).not.toHaveBeenCalled();
  });
});
