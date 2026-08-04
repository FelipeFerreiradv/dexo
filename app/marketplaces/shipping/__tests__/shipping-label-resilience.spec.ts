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
import { ShippingLabelError } from "../shipping-label.types";
import {
  MarketplaceIntegrationError,
  toUserFacingMessage,
} from "../integration-error";
import {
  isTransientProviderError,
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
