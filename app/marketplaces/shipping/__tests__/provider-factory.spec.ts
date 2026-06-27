import { describe, it, expect } from "vitest";
import { getShippingProvider } from "../provider-factory";
import { MlShippingLabelProvider } from "../../services/ml-shipping.service";
import { ShopeeShippingLabelProvider } from "../../services/shopee-shipping.service";
import { ShippingLabelError } from "../shipping-label.types";

describe("getShippingProvider", () => {
  it("retorna o adapter do Mercado Livre", () => {
    const p = getShippingProvider("MERCADO_LIVRE");
    expect(p).toBeInstanceOf(MlShippingLabelProvider);
    expect(p.platform).toBe("MERCADO_LIVRE");
  });

  it("retorna o adapter da Shopee", () => {
    const p = getShippingProvider("SHOPEE");
    expect(p).toBeInstanceOf(ShopeeShippingLabelProvider);
    expect(p.platform).toBe("SHOPEE");
  });

  it("lança UNSUPPORTED_PLATFORM para plataforma desconhecida", () => {
    let err: unknown;
    try {
      getShippingProvider("AMAZON");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ShippingLabelError);
    expect((err as ShippingLabelError).code).toBe("UNSUPPORTED_PLATFORM");
  });
});
