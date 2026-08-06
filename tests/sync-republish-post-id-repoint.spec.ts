import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import prisma from "@/app/lib/prisma";
import { MLApiService } from "@/app/marketplaces/services/ml-api.service";
import { ListingUseCase } from "@/app/marketplaces/usecases/listing.usercase";
import { SyncUseCase } from "@/app/marketplaces/usecases/sync.usercase";

/**
 * `externalListingId` é PARÂMETRO de syncMLProductData e nunca era
 * reatribuído. Depois de uma republicação, a linha do banco já aponta para o
 * anúncio NOVO (o createMLListing reusa a linha), mas tudo que roda depois
 * continuava endereçando o MLB ANTIGO, já fechado:
 *
 *  - `resendCompatibilitiesIfNeeded` recebia `listingId` da linha NOVA e
 *    `itemId` do anúncio VELHO, gravando compatSyncedAt/compatDiagnostics do
 *    item fechado na linha do anúncio novo — corrupção silenciosa;
 *  - o log de sucesso e o SyncResult devolviam um MLB que não existe mais.
 */
const OLD_ID = "MLB-antigo";
const NEW_ID = "MLB-novo";

const itemUp = {
  id: OLD_ID,
  status: "active",
  available_quantity: 1,
  price: 100,
  title: "Farol Dianteiro Direito Palio 2015",
  family_name: "Farol Dianteiro Direito Palio 2015",
  user_product_id: "MLBU-1",
  sold_quantity: 0,
  has_bids: false,
};

const produto = {
  id: "prod-1",
  sku: "SKU-1",
  name: "PORTA TRASEIRA ESQUERDA GOL G5",
  price: 150,
  stock: 1,
  compatibilities: [],
};

describe("syncMLProductData → reaponta o id apos republicar", () => {
  let compatSpy: any;

  beforeEach(() => {
    process.env.ML_COMPAT_RESEND_ON_EDIT_ENABLED = "true";
    vi.spyOn(prisma.syncLog, "create").mockResolvedValue({} as any);
    vi.spyOn(prisma.productListing, "findFirst").mockResolvedValue({
      id: "listing-1",
    } as any);
    vi.spyOn(MLApiService, "getItemDetails").mockResolvedValue(itemUp as any);
    vi.spyOn(MLApiService, "updateItem").mockResolvedValue(itemUp as any);
    vi.spyOn(MLApiService, "upsertDescription").mockResolvedValue({} as any);
    compatSpy = vi
      .spyOn(ListingUseCase, "resendCompatibilitiesIfNeeded")
      .mockResolvedValue({} as any);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ML_COMPAT_RESEND_ON_EDIT_ENABLED;
  });

  const rodar = () =>
    (SyncUseCase as any).syncMLProductData(
      produto,
      OLD_ID,
      { id: "acc-1", accessToken: "tok", userId: "user-1" },
      "listing-1",
    );

  it("apos republicar: nao reenvia compatibilidade para o anuncio fechado", async () => {
    vi.spyOn(SyncUseCase, "republishUpListing").mockResolvedValue({
      republished: true,
      newExternalListingId: NEW_ID,
    } as any);

    await rodar();

    // O createMLListing ja anexou e VERIFICOU as compatibilidades do anuncio
    // novo; reenviar aqui so escreveria diagnostico cruzado.
    expect(compatSpy).not.toHaveBeenCalled();
  });

  it("apos republicar: o log de sucesso e o resultado carregam o MLB NOVO", async () => {
    vi.spyOn(SyncUseCase, "republishUpListing").mockResolvedValue({
      republished: true,
      newExternalListingId: NEW_ID,
    } as any);

    const r = await rodar();

    expect(r.externalListingId).toBe(NEW_ID);
    const logArgs = (prisma.syncLog.create as any).mock.calls.at(-1)[0];
    expect(logArgs.data.payload.externalListingId).toBe(NEW_ID);
  });

  it("sem republicacao o comportamento fica inalterado", async () => {
    // Mesmo produto e mesmo item, mas o titulo remoto ja bate: nao republica.
    vi.spyOn(MLApiService, "getItemDetails").mockResolvedValue({
      ...itemUp,
      family_name: "PORTA TRASEIRA ESQUERDA GOL G5",
      title: "Porta Traseira Esquerda Gol G5 Traseira Esquerda",
    } as any);
    const republishSpy = vi.spyOn(SyncUseCase, "republishUpListing");

    const r = await rodar();

    expect(republishSpy).not.toHaveBeenCalled();
    expect(compatSpy).toHaveBeenCalledTimes(1);
    expect(compatSpy.mock.calls[0][0]).toMatchObject({ itemId: OLD_ID });
    expect(r.externalListingId).toBe(OLD_ID);
  });
});
