import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { ShippingLabelUseCase } from "../../usecases/shipping-label.usecase";
import prisma from "../../../lib/prisma";
import { NfeRepository } from "../../../repositories/nfe.repository";
import { shipmentLabelRepository } from "../../../repositories/shipment-label.repository";
import { FiscalStorageService } from "../../../fiscal/storage/fiscal-storage.service";
import { ShippingLabelStorageService } from "../shipping-label-storage.service";
import { MlShippingLabelProvider } from "../../services/ml-shipping.service";
import { ShippingLabelError } from "../shipping-label.types";
import { PDFDocument } from "pdf-lib";

// PDF real de 1 página (necessário quando o fluxo compõe/merge — A4/lote).
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

describe("ShippingLabelUseCase", () => {
  beforeEach(() => {
    vi.spyOn(prisma.order, "findFirst").mockResolvedValue(ORDER_ROW as never);
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
          provider: (data.provider as string) ?? "MERCADO_LIVRE",
          shipmentId: (data.shipmentId as string) ?? null,
          trackingNumber: (data.trackingNumber as string) ?? null,
          labelStatus: (data.labelStatus as string) ?? "NONE",
          labelSize: (data.labelSize as string) ?? null,
          labelPdfPath: (data.labelPdfPath as string) ?? null,
          labelError: (data.labelError as string) ?? null,
          invoiceSentAt: (data.invoiceSentAt as Date) ?? null,
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
  });

  // ── Guardas (resolveContext) ──

  it("ORDER_NOT_FOUND quando o pedido não é do usuário", async () => {
    vi.spyOn(prisma.order, "findFirst").mockResolvedValue(null as never);
    const err = await captureError(
      ShippingLabelUseCase.generateLabelForOrder("u1", "order1", "A4"),
    );
    expect(err).toBeInstanceOf(ShippingLabelError);
    expect((err as ShippingLabelError).code).toBe("ORDER_NOT_FOUND");
  });

  it("NFE_NOT_FOUND quando não há NF-e autorizada", async () => {
    vi.spyOn(NfeRepository.prototype, "findAuthorizedByOrderId").mockResolvedValue(
      null,
    );
    const err = await captureError(
      ShippingLabelUseCase.generateLabelForOrder("u1", "order1", "A4"),
    );
    expect((err as ShippingLabelError).code).toBe("NFE_NOT_FOUND");
  });

  it("NFE_HOMOLOGACAO quando só há NF-e autorizada de homologação", async () => {
    vi.spyOn(NfeRepository.prototype, "findAuthorizedByOrderId").mockImplementation(
      async (_u: string, _o: string, ambiente?: string) =>
        ambiente === "PRODUCAO"
          ? null
          : ({ ...PROD_NFE, ambiente: "HOMOLOGACAO" } as never),
    );
    const err = await captureError(
      ShippingLabelUseCase.generateLabelForOrder("u1", "order1", "A4"),
    );
    expect((err as ShippingLabelError).code).toBe("NFE_HOMOLOGACAO");
  });

  it("NFE_XML_MISSING quando a NF-e de produção não tem xmlAutorizadoPath", async () => {
    vi.spyOn(NfeRepository.prototype, "findAuthorizedByOrderId").mockResolvedValue(
      { ...PROD_NFE, xmlAutorizadoPath: null } as never,
    );
    const err = await captureError(
      ShippingLabelUseCase.generateLabelForOrder("u1", "order1", "A4"),
    );
    expect((err as ShippingLabelError).code).toBe("NFE_XML_MISSING");
  });

  // ── Orquestração (com adapter mockado) ──

  it("happy path: envia NF-e, fica pronto, gera PDF e persiste GENERATED", async () => {
    vi.spyOn(NfeRepository.prototype, "findAuthorizedByOrderId").mockResolvedValue(
      PROD_NFE as never,
    );
    const sent = vi
      .spyOn(MlShippingLabelProvider.prototype, "ensureInvoiceSent")
      .mockResolvedValue(undefined);
    vi.spyOn(
      MlShippingLabelProvider.prototype,
      "ensureReadyToShip",
    ).mockResolvedValue({ ready: true, shipmentId: "S1", trackingNumber: "T1" });
    vi.spyOn(MlShippingLabelProvider.prototype, "getLabelPdf").mockResolvedValue(
      Buffer.from("%PDF label", "utf-8"),
    );

    const res = await ShippingLabelUseCase.generateLabelForOrder(
      "u1",
      "order1",
      "THERMAL",
    );

    expect(sent).toHaveBeenCalledOnce();
    expect(res.reused).toBe(false);
    expect(res.record.labelStatus).toBe("GENERATED");
    expect(res.record.labelPdfPath).toBe("/fake/etiquetas/order1-A4.pdf");
    expect(res.pdf.toString()).toContain("%PDF label");
    expect(shipmentLabelRepository.upsert).toHaveBeenCalledWith(
      "order1",
      expect.objectContaining({ labelStatus: "GENERATED", labelSize: "THERMAL" }),
    );
  });

  it("NOT_READY quando o marketplace ainda não liberou (mantém INVOICE_SENT)", async () => {
    vi.spyOn(NfeRepository.prototype, "findAuthorizedByOrderId").mockResolvedValue(
      PROD_NFE as never,
    );
    vi.spyOn(
      MlShippingLabelProvider.prototype,
      "ensureInvoiceSent",
    ).mockResolvedValue(undefined);
    vi.spyOn(
      MlShippingLabelProvider.prototype,
      "ensureReadyToShip",
    ).mockResolvedValue({ ready: false, reason: "invoice_pending" });
    const getPdf = vi.spyOn(
      MlShippingLabelProvider.prototype,
      "getLabelPdf",
    );

    const err = await captureError(
      ShippingLabelUseCase.generateLabelForOrder("u1", "order1", "A4"),
    );
    expect((err as ShippingLabelError).code).toBe("NOT_READY");
    expect(getPdf).not.toHaveBeenCalled();
    expect(shipmentLabelRepository.upsert).toHaveBeenCalledWith(
      "order1",
      expect.objectContaining({ labelStatus: "INVOICE_SENT" }),
    );
  });

  it("idempotência: reaproveita etiqueta GENERATED do mesmo tamanho", async () => {
    vi.spyOn(NfeRepository.prototype, "findAuthorizedByOrderId").mockResolvedValue(
      PROD_NFE as never,
    );
    vi.spyOn(shipmentLabelRepository, "findByOrderId").mockResolvedValue({
      id: "sl1",
      orderId: "order1",
      provider: "MERCADO_LIVRE",
      shipmentId: "S1",
      trackingNumber: "T1",
      labelStatus: "GENERATED",
      labelSize: "A4",
      labelPdfPath: "/fake/etiquetas/order1-A4.pdf",
      labelError: null,
      invoiceSentAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    vi.spyOn(
      ShippingLabelStorageService.prototype,
      "readFile",
    ).mockResolvedValue(Buffer.from("%PDF cached", "utf-8"));
    const sent = vi.spyOn(
      MlShippingLabelProvider.prototype,
      "ensureInvoiceSent",
    );

    const res = await ShippingLabelUseCase.generateLabelForOrder(
      "u1",
      "order1",
      "A4",
    );
    expect(res.reused).toBe(true);
    expect(res.pdf.toString()).toContain("%PDF cached");
    expect(sent).not.toHaveBeenCalled();
  });

  it("lote: falhas parciais não derrubam os demais", async () => {
    vi.spyOn(NfeRepository.prototype, "findAuthorizedByOrderId").mockResolvedValue(
      PROD_NFE as never,
    );
    vi.spyOn(prisma.order, "findFirst").mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((args: any) =>
        Promise.resolve(
          args?.where?.id === "bad" ? null : ORDER_ROW,
        )) as never,
    );
    vi.spyOn(
      MlShippingLabelProvider.prototype,
      "ensureInvoiceSent",
    ).mockResolvedValue(undefined);
    vi.spyOn(
      MlShippingLabelProvider.prototype,
      "ensureReadyToShip",
    ).mockResolvedValue({ ready: true });
    vi.spyOn(MlShippingLabelProvider.prototype, "getLabelPdf").mockResolvedValue(
      await makeRealPdf(),
    );

    const res = await ShippingLabelUseCase.generateLabelsBatch(
      "u1",
      ["order1", "bad"],
      "A4",
    );
    expect(res.count).toBe(1);
    expect(Buffer.isBuffer(res.pdf)).toBe(true);
    expect(res.failures).toHaveLength(1);
    expect(res.failures[0]).toMatchObject({
      orderId: "bad",
      code: "ORDER_NOT_FOUND",
    });
  });
});
