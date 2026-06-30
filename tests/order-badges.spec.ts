import { describe, it, expect } from "vitest";

import {
  getPlatformLabel,
  platformBadgeClassName,
} from "@/app/pedidos/lib/order-badges";

describe("order-badges — rótulo/cor de plataforma (Magalu)", () => {
  it("getPlatformLabel cobre ML/Shopee/Magalu + fallback cru", () => {
    expect(getPlatformLabel("MERCADO_LIVRE")).toBe("Mercado Livre");
    expect(getPlatformLabel("SHOPEE")).toBe("Shopee");
    expect(getPlatformLabel("MAGALU")).toBe("Magalu");
    expect(getPlatformLabel("OUTRO")).toBe("OUTRO");
  });

  it("platformBadgeClassName: Magalu=azul, ML=amarelo, Shopee=laranja, resto=''", () => {
    expect(platformBadgeClassName("MAGALU")).toContain("blue");
    expect(platformBadgeClassName("MERCADO_LIVRE")).toContain("yellow");
    expect(platformBadgeClassName("SHOPEE")).toContain("orange");
    expect(platformBadgeClassName("DESCONHECIDO")).toBe("");
    expect(platformBadgeClassName(undefined)).toBe("");
  });
});
