/**
 * Adapter de etiqueta de envio da Shopee (Open Platform v2 — módulo logistics).
 *
 * ESQUELETO (Fase 2): a interface e a seleção por plataforma já funcionam. Na
 * Fase 4 entram os métodos de logistics (como `static` PÚBLICOS em
 * ShopeeApiService, ao lado de getLogisticsChannelList, pois
 * makeAuthenticatedRequest é private): upload_invoice_doc → get_shipping_parameter
 * → ship_order → create_shipping_document → get_shipping_document_result (poll
 * READY) → download_shipping_document, com ShippingAuthRetry.shopee.
 */
import type { ShippingLabelProvider } from "../shipping/shipping-label.provider";
import {
  ShippingLabelError,
  type LabelSize,
  type ShipReadiness,
  type ShippingOrderContext,
  type ShippingPlatform,
} from "../shipping/shipping-label.types";

const NOT_IMPLEMENTED =
  "Adapter Shopee da etiqueta ainda não implementado (Fase 4)";

export class ShopeeShippingLabelProvider implements ShippingLabelProvider {
  readonly platform: ShippingPlatform = "SHOPEE";

  async ensureInvoiceSent(_ctx: ShippingOrderContext): Promise<void> {
    throw new ShippingLabelError("PROVIDER_ERROR", NOT_IMPLEMENTED);
  }

  async ensureReadyToShip(_ctx: ShippingOrderContext): Promise<ShipReadiness> {
    throw new ShippingLabelError("PROVIDER_ERROR", NOT_IMPLEMENTED);
  }

  async getLabelPdf(
    _ctxs: ShippingOrderContext[],
    _opts: { size: LabelSize },
  ): Promise<Buffer> {
    throw new ShippingLabelError("PROVIDER_ERROR", NOT_IMPLEMENTED);
  }
}
