import { describe, expect, it } from "vitest";
import { Platform } from "@prisma/client";

import { accountScopedAutodetectSku } from "@/app/marketplaces/lib/autodetect-synthetic-sku";

const BASE = {
  platform: Platform.MERCADO_LIVRE,
  accountId: "account-a",
  externalListingId: "SHARED-123",
};

describe("accountScopedAutodetectSku", () => {
  it("é determinístico e respeita o limite de 32 caracteres", () => {
    const first = accountScopedAutodetectSku("prefixo-muito-longo", BASE);
    const second = accountScopedAutodetectSku("prefixo-muito-longo", BASE);

    expect(first).toBe(second);
    expect(first.length).toBeLessThanOrEqual(32);
    expect(first).toMatch(/^PREFIXO-[a-f0-9]{24}$/);
  });

  it("isola o mesmo externalListingId entre contas", () => {
    const first = accountScopedAutodetectSku("VAAPT", BASE);
    const second = accountScopedAutodetectSku("VAAPT", {
      ...BASE,
      accountId: "account-b",
    });

    expect(first).not.toBe(second);
  });

  it("isola o mesmo externalListingId entre plataformas", () => {
    const first = accountScopedAutodetectSku("VAAPT", BASE);
    const second = accountScopedAutodetectSku("VAAPT", {
      ...BASE,
      platform: Platform.SHOPEE,
    });

    expect(first).not.toBe(second);
  });
});
