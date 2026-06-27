/**
 * Factory do Adapter/Strategy: seleciona o provider pela plataforma do pedido
 * (MarketplaceAccount.platform).
 */
import type { ShippingLabelProvider } from "./shipping-label.provider";
import {
  ShippingLabelError,
  type ShippingPlatform,
} from "./shipping-label.types";
import { MlShippingLabelProvider } from "../services/ml-shipping.service";
import { ShopeeShippingLabelProvider } from "../services/shopee-shipping.service";

export function getShippingProvider(
  platform: ShippingPlatform | string,
): ShippingLabelProvider {
  switch (platform) {
    case "MERCADO_LIVRE":
      return new MlShippingLabelProvider();
    case "SHOPEE":
      return new ShopeeShippingLabelProvider();
    default:
      throw new ShippingLabelError(
        "UNSUPPORTED_PLATFORM",
        `Plataforma não suportada para etiqueta: ${platform}`,
      );
  }
}
