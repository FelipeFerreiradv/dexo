/**
 * Orquestração do módulo de Etiqueta de Envio (ML + Shopee).
 *
 * Fluxo por pedido: resolveContext (pedido + conta + NF-e autorizada de
 * produção, com guardas) → seleciona o adapter pela plataforma →
 * ensureInvoiceSent → ensureReadyToShip → getLabelPdf → persiste em
 * ShipmentLabel + storage. Estilo espelhado em OrderUseCase (classe estática,
 * logs "[Shipping] ...", erros não-bloqueantes em lote).
 *
 * Aditivo: não toca emissão de NF-e, OAuth, importação ou sync.
 */
import prisma from "../../lib/prisma";
import { NfeRepository } from "../../repositories/nfe.repository";
import {
  shipmentLabelRepository,
  type ShipmentLabelRecord,
} from "../../repositories/shipment-label.repository";
import { FiscalStorageService } from "../../fiscal/storage/fiscal-storage.service";
import { ShippingLabelStorageService } from "../shipping/shipping-label-storage.service";
import { getShippingProvider } from "../shipping/provider-factory";
import { composeA4, mergePdfs } from "../shipping/pdf-merge";
import {
  ShippingLabelError,
  type LabelSize,
  type ShippingOrderContext,
  type ShippingPlatform,
} from "../shipping/shipping-label.types";

export interface GenerateLabelResult {
  record: ShipmentLabelRecord;
  pdf: Buffer;
  /** true quando devolveu a etiqueta já gerada (idempotência), sem novas chamadas. */
  reused: boolean;
}

export interface BatchLabelFailure {
  orderId: string;
  code?: string;
  error: string;
}

export interface BatchLabelResult {
  /** PDF único combinado de todas as etiquetas geradas (null se nenhuma). */
  pdf: Buffer | null;
  /** Quantidade de etiquetas geradas com sucesso. */
  count: number;
  failures: BatchLabelFailure[];
}

export class ShippingLabelUseCase {
  private static nfeRepo = new NfeRepository();
  private static fiscalStorage = new FiscalStorageService();
  private static labelStorage = new ShippingLabelStorageService();

  /**
   * Resolve pedido + conta + NF-e autorizada de produção e aplica as guardas.
   * Lança ShippingLabelError com `code` específico para a rota traduzir.
   */
  static async resolveContext(
    userId: string,
    orderId: string,
  ): Promise<ShippingOrderContext> {
    const order = await prisma.order.findFirst({
      where: { id: orderId, marketplaceAccount: { userId } },
      select: {
        id: true,
        externalOrderId: true,
        marketplaceAccountId: true,
        marketplaceAccount: {
          select: {
            id: true,
            platform: true,
            accessToken: true,
            refreshToken: true,
            externalUserId: true,
            shopId: true,
          },
        },
      },
    });
    if (!order || !order.marketplaceAccount) {
      throw new ShippingLabelError("ORDER_NOT_FOUND", "Pedido não encontrado");
    }

    const prodNfe = await this.nfeRepo.findAuthorizedByOrderId(
      userId,
      orderId,
      "PRODUCAO",
    );
    if (!prodNfe) {
      const anyNfe = await this.nfeRepo.findAuthorizedByOrderId(
        userId,
        orderId,
      );
      if (anyNfe) {
        throw new ShippingLabelError(
          "NFE_HOMOLOGACAO",
          "A NF-e autorizada do pedido é de homologação. Emita uma NF-e de produção antes de gerar a etiqueta.",
        );
      }
      throw new ShippingLabelError(
        "NFE_NOT_FOUND",
        "Pedido sem NF-e autorizada de produção. Emita e autorize a NF-e antes de gerar a etiqueta.",
      );
    }
    if (prodNfe.modelo !== "55") {
      throw new ShippingLabelError(
        "NFE_NOT_FOUND",
        "A NF-e do pedido não é modelo 55 — não aceita pelo marketplace.",
      );
    }
    if (!prodNfe.xmlAutorizadoPath) {
      throw new ShippingLabelError(
        "NFE_XML_MISSING",
        "XML autorizado da NF-e ainda não disponível. Tente novamente em instantes.",
      );
    }
    const xmlBuf = await this.fiscalStorage.readFile(prodNfe.xmlAutorizadoPath);
    if (!xmlBuf) {
      throw new ShippingLabelError(
        "NFE_XML_MISSING",
        "Arquivo do XML autorizado não encontrado no storage.",
      );
    }

    const acc = order.marketplaceAccount;
    return {
      order: {
        id: order.id,
        externalOrderId: order.externalOrderId,
        marketplaceAccountId: order.marketplaceAccountId,
      },
      account: {
        id: acc.id,
        platform: acc.platform as ShippingPlatform,
        accessToken: acc.accessToken,
        refreshToken: acc.refreshToken,
        externalUserId: acc.externalUserId,
        shopId: acc.shopId,
      },
      nfe: {
        id: prodNfe.id,
        chaveAcesso: prodNfe.chaveAcesso ?? "",
        xmlAutorizadoPath: prodNfe.xmlAutorizadoPath,
        xml: xmlBuf.toString("utf-8"),
      },
    };
  }

  /**
   * Envia a NF-e ao marketplace, garante a liberação e baixa o PDF CRU (10×15
   * do provedor). Persiste o andamento (INVOICE_SENT/READY_TO_PRINT). Em
   * NOT_READY lança (estado segue INVOICE_SENT); outras falhas marcam ERROR.
   * Não compõe A4 nem salva o arquivo final — isso é do finalizeLabel.
   */
  private static async produceRawLabel(
    ctx: ShippingOrderContext,
    size: LabelSize,
  ): Promise<Buffer> {
    const provider = getShippingProvider(ctx.account.platform);
    const orderId = ctx.order.id;
    try {
      await provider.ensureInvoiceSent(ctx);
      await shipmentLabelRepository.upsert(orderId, {
        provider: ctx.account.platform,
        labelStatus: "INVOICE_SENT",
        invoiceSentAt: new Date(),
        labelError: null,
      });

      const readiness = await provider.ensureReadyToShip(ctx);
      if (!readiness.ready) {
        await shipmentLabelRepository.upsert(orderId, {
          provider: ctx.account.platform,
          labelStatus: "INVOICE_SENT",
          shipmentId: readiness.shipmentId ?? undefined,
          trackingNumber: readiness.trackingNumber ?? undefined,
        });
        throw new ShippingLabelError(
          "NOT_READY",
          readiness.reason ??
            "Aguardando liberação do marketplace para impressão da etiqueta.",
        );
      }

      await shipmentLabelRepository.upsert(orderId, {
        provider: ctx.account.platform,
        labelStatus: "READY_TO_PRINT",
        shipmentId: readiness.shipmentId ?? undefined,
        trackingNumber: readiness.trackingNumber ?? undefined,
      });

      return await provider.getLabelPdf([ctx], { size });
    } catch (error) {
      if (error instanceof ShippingLabelError && error.code === "NOT_READY") {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[Shipping] Falha ao gerar etiqueta do pedido ${orderId}: ${message}`,
      );
      await shipmentLabelRepository
        .upsert(orderId, {
          provider: ctx.account.platform,
          labelStatus: "ERROR",
          labelError: message.slice(0, 500),
        })
        .catch(() => {
          /* registrar ERROR é best-effort */
        });
      throw error;
    }
  }

  /** Compõe (A4 = 1 etiqueta por folha) + salva + marca GENERATED. */
  private static async finalizeLabel(
    userId: string,
    ctx: ShippingOrderContext,
    raw: Buffer,
    size: LabelSize,
  ): Promise<GenerateLabelResult> {
    const orderId = ctx.order.id;
    const pdf = size === "A4" ? await composeA4(raw, 1) : raw;
    const pdfPath = await this.labelStorage.saveLabelPdf(
      userId,
      orderId,
      size,
      pdf,
    );
    const record = await shipmentLabelRepository.upsert(orderId, {
      provider: ctx.account.platform,
      labelStatus: "GENERATED",
      labelSize: size,
      labelPdfPath: pdfPath,
      labelError: null,
    });
    return { record, pdf, reused: false };
  }

  /**
   * Gera (ou reaproveita) a etiqueta de um pedido. Idempotente: se já houver
   * etiqueta GENERATED do mesmo tamanho e o arquivo existir, devolve-a sem novas
   * chamadas. A4 = composição em folha A4 (1 etiqueta); térmico = 10×15 cru.
   */
  static async generateLabelForOrder(
    userId: string,
    orderId: string,
    size: LabelSize,
  ): Promise<GenerateLabelResult> {
    const ctx = await this.resolveContext(userId, orderId);

    const existing = await shipmentLabelRepository.findByOrderId(orderId);
    if (
      existing?.labelStatus === "GENERATED" &&
      existing.labelSize === size &&
      existing.labelPdfPath
    ) {
      const cached = await this.labelStorage.readFile(existing.labelPdfPath);
      if (cached) {
        return { record: existing, pdf: cached, reused: true };
      }
    }

    const raw = await this.produceRawLabel(ctx, size);
    return this.finalizeLabel(userId, ctx, raw, size);
  }

  /**
   * Lote: processa cada pedido isoladamente (falhas em `failures[]` sem derrubar
   * os demais) e devolve UM PDF combinado. THERMAL = etiquetas 10×15 em
   * sequência; A4 = composição 3 por folha. Cada pedido também é salvo
   * individualmente (permite baixar depois pelo detalhe do pedido).
   */
  static async generateLabelsBatch(
    userId: string,
    orderIds: string[],
    size: LabelSize,
  ): Promise<BatchLabelResult> {
    const raws: Buffer[] = [];
    const failures: BatchLabelFailure[] = [];
    for (const orderId of orderIds) {
      try {
        const ctx = await this.resolveContext(userId, orderId);
        const raw = await this.produceRawLabel(ctx, size);
        await this.finalizeLabel(userId, ctx, raw, size);
        raws.push(raw);
      } catch (error) {
        failures.push({
          orderId,
          code: error instanceof ShippingLabelError ? error.code : undefined,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    let pdf: Buffer | null = null;
    if (raws.length > 0) {
      const merged = await mergePdfs(raws);
      pdf = size === "A4" ? await composeA4(merged, 3) : merged;
    }
    return { pdf, count: raws.length, failures };
  }

  /** Lê o PDF de etiqueta já gerado do pedido (escopo multi-tenant por userId). */
  static async getStoredLabelPdf(
    userId: string,
    orderId: string,
  ): Promise<{ pdf: Buffer; record: ShipmentLabelRecord } | null> {
    const owned = await prisma.order.findFirst({
      where: { id: orderId, marketplaceAccount: { userId } },
      select: { id: true },
    });
    if (!owned) {
      throw new ShippingLabelError("ORDER_NOT_FOUND", "Pedido não encontrado");
    }
    const record = await shipmentLabelRepository.findByOrderId(orderId);
    if (!record?.labelPdfPath) return null;
    const pdf = await this.labelStorage.readFile(record.labelPdfPath);
    if (!pdf) return null;
    return { pdf, record };
  }
}
