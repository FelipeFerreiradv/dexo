/**
 * Adapter de etiqueta de envio do Mercado Livre (Mercado Envios 2).
 *
 * ESQUELETO (Fase 2): a interface e a seleção por plataforma já funcionam; as
 * chamadas reais (`GET /shipments/{id}`, `POST /shipments/{id}/invoice_data?
 * siteId=MLB`, `GET /shipment_labels?shipment_ids=...&response_type=pdf`) com
 * refresh/retry entram na Fase 3, usando o mesmo padrão axios + Bearer de
 * MLApiService e o ShippingAuthRetry.ml.
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
  "Adapter Mercado Livre da etiqueta ainda não implementado (Fase 3)";

export class MlShippingLabelProvider implements ShippingLabelProvider {
  readonly platform: ShippingPlatform = "MERCADO_LIVRE";

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
