import { describe, it, expect } from "vitest";
import { getShippingProvider } from "../provider-factory";
import { MlShippingLabelProvider } from "../../services/ml-shipping.service";
import { ShopeeShippingLabelProvider } from "../../services/shopee-shipping.service";
import { MagaluShippingLabelProvider } from "../../services/magalu-shipping.service";
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

  it("retorna o adapter da Magalu", () => {
    const p = getShippingProvider("MAGALU");
    expect(p).toBeInstanceOf(MagaluShippingLabelProvider);
    expect(p.platform).toBe("MAGALU");
  });

  it.each(["OLX", "FACEBOOK"] as const)(
    "lança mensagem de venda manual para %s (sem API de pedido/checkout)",
    (platform) => {
      let err: unknown;
      try {
        getShippingProvider(platform);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ShippingLabelError);
      expect((err as ShippingLabelError).code).toBe("UNSUPPORTED_PLATFORM");
      // Mensagem específica (não o genérico "Plataforma não suportada").
      expect((err as ShippingLabelError).message).toMatch(
        /não fornece etiqueta.*[Rr]egistre a venda manualmente/,
      );
    },
  );

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
