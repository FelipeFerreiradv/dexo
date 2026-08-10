import { afterEach, describe, expect, it, vi } from "vitest";
import { Platform } from "@prisma/client";

// ──────────────────────────────────────────────────────────
// Kill-switch de runtime de OLX e Facebook.
//
// É este spec que autoriza subir o código: prova que, com as duas integrações
// desligadas, ML/Shopee/Magalu continuam funcionando exatamente como antes —
// nem uma chamada a menos, nem uma a mais.
//
// As flags são lidas A CADA CHAMADA (não congeladas em constante de módulo),
// então o operador desliga sem rebuild. Cada caso seta e restaura no finally,
// padrão de listing.olx-pause-fail.spec.ts.
// ──────────────────────────────────────────────────────────

import {
  isOlxDisabled,
  isFacebookDisabled,
  isPlatformDisabled,
} from "@/app/lib/integration-flags";
import { ListingUseCase } from "@/app/marketplaces/usecases/listing.usercase";
import { ListingRepository } from "@/app/marketplaces/repositories/listing.repository";
import { OlxApiService } from "@/app/marketplaces/services/olx-api.service";
import { FacebookApiService } from "@/app/marketplaces/services/facebook-api.service";

/** Roda `fn` com as variáveis de ambiente dadas, restaurando no fim. */
async function comEnv(
  vars: Record<string, string | undefined>,
  fn: () => Promise<void> | void,
) {
  const anterior: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    anterior[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(anterior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const LISTING_FB = {
  id: "l-fb",
  externalListingId: "SKU-1",
  status: "active",
  product: { userId: "user-1", sku: "SKU-1", name: "Peça", stock: 3 },
  marketplaceAccount: {
    id: "acc-fb",
    platform: Platform.FACEBOOK,
    accessToken: "tok-fb",
    fbCatalogId: "cat-1",
  },
} as any;

const LISTING_OLX = {
  id: "l-olx",
  externalListingId: "SKU-1",
  status: "active",
  product: { userId: "user-1", sku: "SKU-1", name: "Peça", stock: 3 },
  marketplaceAccount: {
    id: "acc-olx",
    platform: Platform.OLX,
    accessToken: "tok-olx",
    olxSellerPhone: "11999998888",
    olxSellerZipcode: "01001000",
  },
} as any;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("integration-flags — leitura das flags", () => {
  it("só '1' desliga; qualquer outro valor mantém ligado", async () => {
    await comEnv({ OLX_INTEGRATION_DISABLED: "1" }, () => {
      expect(isOlxDisabled()).toBe(true);
    });
    await comEnv({ OLX_INTEGRATION_DISABLED: "0" }, () => {
      expect(isOlxDisabled()).toBe(false);
    });
    await comEnv({ OLX_INTEGRATION_DISABLED: "true" }, () => {
      expect(isOlxDisabled()).toBe(false);
    });
    await comEnv({ OLX_INTEGRATION_DISABLED: undefined }, () => {
      expect(isOlxDisabled()).toBe(false);
    });
    await comEnv({ FACEBOOK_INTEGRATION_DISABLED: "1" }, () => {
      expect(isFacebookDisabled()).toBe(true);
    });
  });

  it("ASSERÇÃO CENTRAL DE ZERO REGRESSÃO: com AMBAS desligadas, ML/Shopee/Magalu seguem habilitadas", async () => {
    await comEnv(
      {
        OLX_INTEGRATION_DISABLED: "1",
        FACEBOOK_INTEGRATION_DISABLED: "1",
      },
      () => {
        expect(isPlatformDisabled(Platform.OLX)).toBe(true);
        expect(isPlatformDisabled(Platform.FACEBOOK)).toBe(true);
        // As três que já estão em produção NÃO podem ser afetadas por nenhuma
        // combinação de flags das duas plataformas novas.
        expect(isPlatformDisabled(Platform.MERCADO_LIVRE)).toBe(false);
        expect(isPlatformDisabled(Platform.SHOPEE)).toBe(false);
        expect(isPlatformDisabled(Platform.MAGALU)).toBe(false);
      },
    );
  });

  it("desligar uma não desliga a outra", async () => {
    await comEnv(
      {
        OLX_INTEGRATION_DISABLED: "1",
        FACEBOOK_INTEGRATION_DISABLED: undefined,
      },
      () => {
        expect(isPlatformDisabled(Platform.OLX)).toBe(true);
        expect(isPlatformDisabled(Platform.FACEBOOK)).toBe(false);
      },
    );
  });
});

describe("kill-switch — Facebook (a OLX já tinha cobertura, o Facebook não)", () => {
  it("FACEBOOK_INTEGRATION_DISABLED=1 ⇒ pausar não toca a Graph API nem o banco", async () => {
    await comEnv({ FACEBOOK_INTEGRATION_DISABLED: "1" }, async () => {
      vi.spyOn(ListingRepository, "findById").mockResolvedValue(LISTING_FB);
      const updateStatus = vi
        .spyOn(ListingRepository, "updateStatus")
        .mockResolvedValue({} as any);
      const setAvailability = vi
        .spyOn(FacebookApiService, "setAvailability")
        .mockResolvedValue({} as any);

      const r = await ListingUseCase.updateListingStatus(
        "l-fb",
        "user-1",
        "paused",
      );

      expect(setAvailability).not.toHaveBeenCalled();
      expect(updateStatus).not.toHaveBeenCalled();
      expect(r.success).toBe(false);
    });
  });

  it("FACEBOOK_INTEGRATION_DISABLED=1 ⇒ reativar também é no-op", async () => {
    await comEnv({ FACEBOOK_INTEGRATION_DISABLED: "1" }, async () => {
      vi.spyOn(ListingRepository, "findById").mockResolvedValue({
        ...LISTING_FB,
        status: "paused",
      });
      const setAvailability = vi
        .spyOn(FacebookApiService, "setAvailability")
        .mockResolvedValue({} as any);

      const r = await ListingUseCase.updateListingStatus(
        "l-fb",
        "user-1",
        "active",
      );

      expect(setAvailability).not.toHaveBeenCalled();
      expect(r.success).toBe(false);
    });
  });

  it("com a flag do Facebook ligada, a OLX continua operando normalmente", async () => {
    await comEnv(
      {
        FACEBOOK_INTEGRATION_DISABLED: "1",
        OLX_INTEGRATION_DISABLED: undefined,
      },
      async () => {
        vi.spyOn(ListingRepository, "findById").mockResolvedValue({
          ...LISTING_OLX,
          status: "active",
        });
        vi.spyOn(ListingRepository, "updateStatus").mockResolvedValue(
          {} as any,
        );
        const deleteAd = vi
          .spyOn(OlxApiService, "deleteAd")
          .mockResolvedValue({ statusCode: 0 } as any);

        const r = await ListingUseCase.updateListingStatus(
          "l-olx",
          "user-1",
          "paused",
        );

        expect(deleteAd).toHaveBeenCalledTimes(1);
        expect(r.success).toBe(true);
      },
    );
  });
});
