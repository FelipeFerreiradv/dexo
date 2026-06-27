/**
 * Adapter de etiqueta de envio da Shopee (Open Platform v2 — logistics).
 *
 * Diferença-chave p/ o ML: aqui a etiqueta é assíncrona (create → result(poll)
 * → download) e o ship_order exige escolher coleta/postagem. Os métodos de
 * logistics vivem em ShopeeApiService (públicos; makeAuthenticatedRequest é
 * private). Token/refresh via ShippingAuthRetry.shopee.
 *
 * Shapes a confirmar em homologação (SHOPEE_SANDBOX=true).
 */
import { ShopeeApiService } from "./shopee-api.service";
import { ShippingAuthRetry } from "../shipping/auth-retry";
import type { ShippingLabelProvider } from "../shipping/shipping-label.provider";
import {
  ShippingLabelError,
  type LabelSize,
  type ShipReadiness,
  type ShippingOrderContext,
  type ShippingPlatform,
} from "../shipping/shipping-label.types";

interface ShopeeShippingOpts {
  pollMaxAttempts?: number;
  pollDelayMs?: number;
}

export class ShopeeShippingLabelProvider implements ShippingLabelProvider {
  readonly platform: ShippingPlatform = "SHOPEE";

  constructor(private opts: ShopeeShippingOpts = {}) {}

  private get pollMaxAttempts(): number {
    return this.opts.pollMaxAttempts ?? 8;
  }
  private get pollDelayMs(): number {
    return this.opts.pollDelayMs ?? 1500;
  }
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private docTypeFor(size: LabelSize): string {
    return size === "THERMAL" ? "THERMAL_AIR_WAYBILL" : "NORMAL_AIR_WAYBILL";
  }

  /**
   * Decide pickup vs dropoff a partir do get_shipping_parameter. Regra:
   * dropoff quando suportado e pickup não é exigido (mais simples, sem slot);
   * senão pickup com o 1º endereço/slot disponível.
   */
  private buildShipBody(
    orderSn: string,
    param: Record<string, any>,
  ): { order_sn: string; pickup?: any; dropoff?: any } {
    const infoNeeded = param?.info_needed ?? {};
    const pickupNeeded =
      Array.isArray(infoNeeded.pickup) && infoNeeded.pickup.length > 0;

    if (!pickupNeeded) {
      const dropoff: Record<string, any> = {};
      const branch = param?.dropoff?.branch_list?.[0];
      if (branch?.branch_id) dropoff.branch_id = branch.branch_id;
      return { order_sn: orderSn, dropoff };
    }

    const addr =
      param?.pickup?.address_list?.find((a: any) =>
        a?.address_flag?.includes?.("pickup_address"),
      ) ?? param?.pickup?.address_list?.[0];
    const pickup: Record<string, any> = {};
    if (addr?.address_id) pickup.address_id = addr.address_id;
    const timeId =
      addr?.time_slot_list?.[0]?.pickup_time_id ??
      param?.pickup?.time_slot_list?.[0]?.pickup_time_id;
    if (timeId) pickup.pickup_time_id = timeId;
    return { order_sn: orderSn, pickup };
  }

  private isAlreadyArranged(error: unknown): boolean {
    const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
    const code = (
      (error as { shopeeError?: string })?.shopeeError ?? ""
    ).toLowerCase();
    return (
      /already|has been|arranged|logistics_status|ready/.test(msg) ||
      /logistics/.test(code)
    );
  }

  async ensureInvoiceSent(ctx: ShippingOrderContext): Promise<void> {
    // upload_invoice_doc envia/atualiza — re-chamar é idempotente (update).
    await ShippingAuthRetry.shopee(ctx.account, (token, shopId) =>
      ShopeeApiService.uploadInvoiceDoc(
        token,
        shopId,
        ctx.order.externalOrderId,
        ctx.nfe.xml,
      ),
    );
  }

  async ensureReadyToShip(ctx: ShippingOrderContext): Promise<ShipReadiness> {
    return ShippingAuthRetry.shopee(ctx.account, async (token, shopId) => {
      const orderSn = ctx.order.externalOrderId;
      const param = await ShopeeApiService.getShippingParameter(
        token,
        shopId,
        orderSn,
      );
      const body = this.buildShipBody(orderSn, param);
      try {
        await ShopeeApiService.shipOrder(token, shopId, body);
      } catch (error) {
        // Já arranjado → segue. Senão, ainda não liberado (ex.: NF-e validando
        // na SEFAZ) → não-pronto com a mensagem da Shopee.
        if (!this.isAlreadyArranged(error)) {
          return {
            ready: false,
            reason: error instanceof Error ? error.message : String(error),
            shipmentId: orderSn,
          };
        }
      }
      let tracking: string | null = null;
      try {
        tracking = await ShopeeApiService.getTrackingNumber(
          token,
          shopId,
          orderSn,
        );
      } catch {
        // tracking pode ainda não estar disponível — não bloqueia
      }
      return { ready: true, shipmentId: orderSn, trackingNumber: tracking };
    });
  }

  async getLabelPdf(
    ctxs: ShippingOrderContext[],
    opts: { size: LabelSize },
  ): Promise<Buffer> {
    if (ctxs.length === 0) {
      throw new ShippingLabelError(
        "PROVIDER_ERROR",
        "Nenhum pedido para gerar etiqueta.",
      );
    }
    const account = ctxs[0].account;
    const docType = this.docTypeFor(opts.size);
    const orderList = ctxs.map((c) => ({ order_sn: c.order.externalOrderId }));

    return ShippingAuthRetry.shopee(account, async (token, shopId) => {
      await ShopeeApiService.createShippingDocument(
        token,
        shopId,
        orderList,
        docType,
      );

      let ready = false;
      for (let i = 0; i < this.pollMaxAttempts; i++) {
        const results = await ShopeeApiService.getShippingDocumentResult(
          token,
          shopId,
          orderList,
          docType,
        );
        if (results.some((r) => r.status === "FAILED")) {
          throw new ShippingLabelError(
            "PROVIDER_ERROR",
            "Shopee falhou ao gerar o documento de envio (status FAILED).",
          );
        }
        if (
          results.length > 0 &&
          results.every((r) => r.status === "READY")
        ) {
          ready = true;
          break;
        }
        await this.sleep(this.pollDelayMs);
      }
      if (!ready) {
        throw new ShippingLabelError(
          "NOT_READY",
          "Documento de envio da Shopee ainda não está pronto. Tente novamente em instantes.",
        );
      }

      return ShopeeApiService.downloadShippingDocument(
        token,
        shopId,
        orderList,
        docType,
      );
    });
  }
}
