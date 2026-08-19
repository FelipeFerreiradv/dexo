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
import { MagaluShippingLabelProvider } from "../services/magalu-shipping.service";

export function getShippingProvider(
  platform: ShippingPlatform | string,
): ShippingLabelProvider {
  switch (platform) {
    case "MERCADO_LIVRE":
      return new MlShippingLabelProvider();
    case "SHOPEE":
      return new ShopeeShippingLabelProvider();
    case "MAGALU":
      return new MagaluShippingLabelProvider();
    case "OLX":
    case "FACEBOOK":
      // OLX (autoupload) e Catálogo Meta não têm API de pedido/checkout no
      // Brasil, logo não emitem etiqueta. Mensagem específica em vez do genérico.
      throw new ShippingLabelError(
        "UNSUPPORTED_PLATFORM",
        `${platform === "OLX" ? "A OLX" : "O Facebook"} não fornece etiqueta de envio: a plataforma não tem pedido/checkout no Brasil. Registre a venda manualmente.`,
      );
    default:
      throw new ShippingLabelError(
        "UNSUPPORTED_PLATFORM",
        `Plataforma não suportada para etiqueta: ${platform}`,
      );
  }
}
