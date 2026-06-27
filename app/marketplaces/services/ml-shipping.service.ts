/**
 * Adapter de etiqueta de envio do Mercado Livre (Mercado Envios 2).
 *
 * Mesmo padrão axios + Bearer de MLApiService; erros carregam `.status` para o
 * ShippingAuthRetry.ml detectar 401/403 e refrescar o token. siteId fixo "MLB"
 * (não há coluna de siteId em MarketplaceAccount).
 *
 * Endpoints (a confirmar em homologação com test users — ML não tem base de
 * sandbox separada):
 *  - GET  /orders/{order_id}                    → shipping.id
 *  - GET  /shipments/{shipment_id}              → status / substatus / tracking
 *  - POST /shipments/{shipment_id}/invoice_data?siteId=MLB  (XML autorizado)
 *  - GET  /shipment_labels?shipment_ids=...&response_type=pdf  (PDF, até 50 ids)
 */
import axios from "axios";
import { ML_CONSTANTS } from "../mercado-livre/ml-constants";
import { ShippingAuthRetry } from "../shipping/auth-retry";
import type { ShippingLabelProvider } from "../shipping/shipping-label.provider";
import {
  ShippingLabelError,
  type LabelSize,
  type ShipReadiness,
  type ShippingOrderContext,
  type ShippingPlatform,
} from "../shipping/shipping-label.types";

/** Subconjunto do shipment do ML que o módulo usa. */
export interface MLShipment {
  id: number;
  status: string | null;
  substatus: string | null;
  tracking_number?: string | null;
}

function mlError(prefix: string, error: unknown): Error {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const data = error.response?.data as
      | { message?: string; error?: string }
      | undefined;
    const msg = data?.message || data?.error || error.message;
    const e = new Error(`${prefix}: ${msg}`);
    (e as { status?: number }).status = status;
    (e as { responseData?: unknown }).responseData = data;
    return e;
  }
  return new Error(
    `${prefix}: ${error instanceof Error ? error.message : String(error)}`,
  );
}

/** Cliente HTTP de baixo nível do Mercado Envios (estático, sem estado). */
export class MlShippingService {
  /** GET /orders/{order_id} → shipping.id (ou null se o pedido não tem envio). */
  static async getOrderShippingId(
    accessToken: string,
    orderId: string,
  ): Promise<number | null> {
    try {
      const resp = await axios.get(
        `${ML_CONSTANTS.API_URL}/orders/${orderId}`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          timeout: 10000,
        },
      );
      const id = resp.data?.shipping?.id;
      if (id == null) return null;
      return typeof id === "number" ? id : Number(id);
    } catch (error) {
      throw mlError("Erro ao obter envio do pedido", error);
    }
  }

  /** GET /shipments/{id} → status/substatus/tracking. */
  static async getShipment(
    accessToken: string,
    shipmentId: string,
  ): Promise<MLShipment> {
    try {
      const resp = await axios.get(
        `${ML_CONSTANTS.API_URL}/shipments/${shipmentId}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "x-format-new": "true",
          },
          timeout: 10000,
        },
      );
      return resp.data as MLShipment;
    } catch (error) {
      throw mlError("Erro ao consultar envio no Mercado Livre", error);
    }
  }

  /**
   * POST /shipments/{id}/invoice_data?siteId=MLB com o XML autorizado no corpo.
   * Aceita apenas NF-e modelo 55 de produção (validado a montante pelo usecase).
   */
  static async sendInvoiceData(
    accessToken: string,
    shipmentId: string,
    xml: string,
  ): Promise<void> {
    try {
      await axios.post(
        `${ML_CONSTANTS.API_URL}/shipments/${shipmentId}/invoice_data?siteId=MLB`,
        xml,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/xml",
          },
          timeout: 15000,
        },
      );
    } catch (error) {
      throw mlError("Erro ao enviar NF-e ao Mercado Livre", error);
    }
  }

  /**
   * GET /shipment_labels?shipment_ids=...&response_type=pdf → PDF (bytes).
   * Aceita até 50 ids separados por vírgula (1 request → 1 PDF com N etiquetas).
   */
  static async getLabelsPdf(
    accessToken: string,
    shipmentIds: string[],
    responseType = "pdf",
  ): Promise<Buffer> {
    try {
      const url = `${ML_CONSTANTS.API_URL}/shipment_labels?shipment_ids=${shipmentIds.join(
        ",",
      )}&response_type=${responseType}`;
      const resp = await axios.get(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
        responseType: "arraybuffer",
        timeout: 30000,
      });
      return Buffer.from(resp.data as ArrayBuffer);
    } catch (error) {
      throw mlError("Erro ao baixar etiqueta do Mercado Livre", error);
    }
  }
}

export class MlShippingLabelProvider implements ShippingLabelProvider {
  readonly platform: ShippingPlatform = "MERCADO_LIVRE";

  constructor(
    private opts: { pollMaxAttempts?: number; pollDelayMs?: number } = {},
  ) {}

  private get pollMaxAttempts(): number {
    return this.opts.pollMaxAttempts ?? 5;
  }
  private get pollDelayMs(): number {
    return this.opts.pollDelayMs ?? 3000;
  }
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Cache do shipment_id por pedido (evita reconsultar GET /orders no fluxo). */
  private shipmentIdCache = new Map<string, string>();

  private async resolveShipmentId(ctx: ShippingOrderContext): Promise<string> {
    const key = ctx.order.externalOrderId;
    const cached = this.shipmentIdCache.get(key);
    if (cached) return cached;
    const id = await ShippingAuthRetry.ml(ctx.account, (token) =>
      MlShippingService.getOrderShippingId(token, ctx.order.externalOrderId),
    );
    if (id == null) {
      throw new ShippingLabelError(
        "SHIPMENT_NOT_FOUND",
        "Pedido sem envio (shipment) no Mercado Livre.",
      );
    }
    const value = String(id);
    this.shipmentIdCache.set(key, value);
    return value;
  }

  private invoiceAlreadyHandled(shipment: MLShipment): boolean {
    const sub = (shipment.substatus ?? "").toLowerCase();
    const st = (shipment.status ?? "").toLowerCase();
    return (
      ["ready_to_print", "printed"].includes(sub) ||
      ["shipped", "delivered"].includes(st)
    );
  }

  private isReadyToPrint(
    status: string | null,
    substatus: string | null,
  ): boolean {
    const sub = (substatus ?? "").toLowerCase();
    const st = (status ?? "").toLowerCase();
    if (["ready_to_print", "printed"].includes(sub)) return true;
    if (["shipped", "delivered"].includes(st)) return true;
    return false;
  }

  async ensureInvoiceSent(ctx: ShippingOrderContext): Promise<void> {
    const shipmentId = await this.resolveShipmentId(ctx);
    const shipment = await ShippingAuthRetry.ml(ctx.account, (token) =>
      MlShippingService.getShipment(token, shipmentId),
    );
    // Idempotência: se a etiqueta já está pronta/impressa/enviada, a nota já foi
    // processada — não reenvia (ML bloqueia alteração após impressão).
    if (this.invoiceAlreadyHandled(shipment)) return;
    await ShippingAuthRetry.ml(ctx.account, (token) =>
      MlShippingService.sendInvoiceData(token, shipmentId, ctx.nfe.xml),
    );
  }

  async ensureReadyToShip(ctx: ShippingOrderContext): Promise<ShipReadiness> {
    const shipmentId = await this.resolveShipmentId(ctx);
    let status: string | null = null;
    let substatus: string | null = null;
    let trackingNumber: string | null = null;
    // Poll curto: o ML leva alguns segundos para processar a NF-e enviada
    // (substatus invoice_pending → ready_to_print). Tenta algumas vezes antes de
    // devolver "não pronto" — assim o usuário não precisa re-clicar.
    for (let attempt = 0; attempt < this.pollMaxAttempts; attempt++) {
      const shipment = await ShippingAuthRetry.ml(ctx.account, (token) =>
        MlShippingService.getShipment(token, shipmentId),
      );
      status = shipment.status ?? null;
      substatus = shipment.substatus ?? null;
      trackingNumber = shipment.tracking_number ?? null;
      if (this.isReadyToPrint(status, substatus)) {
        return { ready: true, status, substatus, shipmentId, trackingNumber };
      }
      if (attempt < this.pollMaxAttempts - 1) await this.sleep(this.pollDelayMs);
    }
    return {
      ready: false,
      reason: substatus ?? status ?? "aguardando liberação",
      status,
      substatus,
      shipmentId,
      trackingNumber,
    };
  }

  async getLabelPdf(
    ctxs: ShippingOrderContext[],
    _opts: { size: LabelSize },
  ): Promise<Buffer> {
    if (ctxs.length === 0) {
      throw new ShippingLabelError(
        "PROVIDER_ERROR",
        "Nenhum pedido para gerar etiqueta.",
      );
    }
    // O lote por conta é garantido a montante (Fase 6 agrupa por conta). Usamos
    // o token da 1ª conta — todos os shipment_ids do request devem ser do mesmo
    // vendedor. ML retorna 10x15 em PDF tanto p/ A4 quanto térmico; a composição
    // A4 (3 por folha) é aplicada na Fase 6 — por isso `size` não muda a chamada.
    const account = ctxs[0].account;
    const ids: string[] = [];
    for (const ctx of ctxs) {
      ids.push(await this.resolveShipmentId(ctx));
    }
    return ShippingAuthRetry.ml(account, (token) =>
      MlShippingService.getLabelsPdf(token, ids, "pdf"),
    );
  }
}
