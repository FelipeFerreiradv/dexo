/**
 * Interface única do Adapter/Strategy de etiqueta de envio. Um adapter por
 * marketplace (ML/Shopee), selecionado pela plataforma do pedido. O usecase
 * orquestra: ensureInvoiceSent → ensureReadyToShip → getLabelPdf.
 */
import type {
  LabelSize,
  ShipReadiness,
  ShippingOrderContext,
  ShippingPlatform,
} from "./shipping-label.types";

export interface ShippingLabelProvider {
  readonly platform: ShippingPlatform;

  /** Envia a NF-e autorizada ao marketplace. Deve ser idempotente. */
  ensureInvoiceSent(ctx: ShippingOrderContext): Promise<void>;

  /**
   * Verifica se o envio está liberado para imprimir (ML: substatus;
   * Shopee: ship_order + parâmetros). Não lança quando apenas "ainda não
   * liberado" — devolve `{ ready: false, reason }`.
   */
  ensureReadyToShip(ctx: ShippingOrderContext): Promise<ShipReadiness>;

  /**
   * Baixa o PDF da etiqueta para 1+ pedidos (lote). Todos os contexts devem ser
   * da mesma plataforma.
   */
  getLabelPdf(
    ctxs: ShippingOrderContext[],
    opts: { size: LabelSize },
  ): Promise<Buffer>;
}
