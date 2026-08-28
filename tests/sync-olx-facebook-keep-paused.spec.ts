import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Platform } from "@prisma/client";

// ──────────────────────────────────────────────────────────
// DURABILIDADE da pausa na OLX e no Facebook.
//
// Em ML, Shopee e Magalu a pausa se sustenta sozinha: item pausado pelo
// vendedor não é reaberto por um empurrão de quantidade, e `unlist_item` /
// `active:false` também não se desfazem sozinhos.
//
// OLX e Facebook são o oposto: CADA passada de sync com estoque positivo
// republica (a OLX nem tem API de quantidade — publicar É sincronizar). Sem uma
// guarda, a pausa aplicada no cancelamento duraria até o próximo tique do
// `StockReconciliationService` — 15 minutos —, porque ele re-enfileira qualquer
// produto com `StockLog` na última hora, e o estorno acabou de escrever um.
//
// O caso que dá valor a este arquivo é o CONTROLE NEGATIVO: com a preferência
// LIGADA a republicação TEM de acontecer. Sem ele, uma guarda larga demais
// (que parasse de republicar para todo mundo) passaria despercebida.
// ──────────────────────────────────────────────────────────

vi.mock("@/app/lib/prisma", () => ({
  default: {
    product: { findUnique: vi.fn() },
    productListing: { findUnique: vi.fn() },
    syncLog: { create: vi.fn(), count: vi.fn() },
    systemLog: { findFirst: vi.fn(), create: vi.fn() },
    marketplaceAccount: { findUnique: vi.fn() },
    user: { findMany: vi.fn() },
  },
}));

import prisma from "@/app/lib/prisma";
import { SyncUseCase } from "@/app/marketplaces/usecases/sync.usercase";
import { ListingRepository } from "@/app/marketplaces/repositories/listing.repository";
import { OlxApiService } from "@/app/marketplaces/services/olx-api.service";
import { FacebookApiService } from "@/app/marketplaces/services/facebook-api.service";

const SKU = "FAROL-77";
const OWNER = "tenant-1";

/**
 * Anúncio `paused` = fomos NÓS que o tiramos do ar (é o que
 * `updateListingStatus` grava). É o único estado que a guarda protege: `error`
 * e `closed` continuam com o retry de sempre.
 */
const listingOlx = {
  id: "l-olx",
  externalListingId: SKU,
  status: "paused",
  marketplaceAccount: {
    id: "acc-olx",
    userId: OWNER,
    platform: Platform.OLX,
    accessToken: "tok-olx",
    accountName: "Conta OLX",
    olxSellerPhone: "11999999999",
    olxSellerZipcode: "01001000",
  },
};

const listingFb = {
  id: "l-fb",
  externalListingId: SKU,
  status: "paused",
  marketplaceAccount: {
    id: "acc-fb",
    userId: OWNER,
    platform: Platform.FACEBOOK,
    accessToken: "tok-fb",
    accountName: "Conta FB",
    fbCatalogId: "cat-fb",
  },
};

function produto(listings: any[]) {
  return {
    id: "prod-1",
    name: "Farol Direito Gol 2012",
    sku: SKU,
    // Estoque POSITIVO: a peça voltou pelo cancelamento. É o gatilho da
    // republicação que a guarda precisa conter.
    stock: 1,
    price: 250,
    brand: "VW",
    model: "Gol",
    year: "2012",
    quality: "SUCATA",
    imageUrl: "https://img.example/1.jpg",
    imageUrls: ["https://img.example/1.jpg"],
    olxCategoryId: 555,
    listings,
  };
}

/** `pref` indefinido = usuário ausente do resultado (fail-open). */
function comPreferencia(pref?: boolean | null) {
  (prisma as any).user.findMany.mockResolvedValue(
    pref === undefined
      ? []
      : [{ id: OWNER, reopenListingsOnSaleCancel: pref, parent: null }],
  );
}

beforeEach(() => {
  vi.clearAllMocks();

  (prisma as any).productListing.findUnique.mockResolvedValue(null);
  (prisma as any).syncLog.create.mockResolvedValue({});
  (prisma as any).syncLog.count.mockResolvedValue(0);
  (prisma as any).systemLog.findFirst.mockResolvedValue(null);
  (prisma as any).systemLog.create.mockResolvedValue({});
  (prisma as any).marketplaceAccount.findUnique.mockResolvedValue(null);

  vi.spyOn(OlxApiService, "deleteAd").mockResolvedValue({
    statusCode: 0,
  } as any);
  vi.spyOn(OlxApiService, "submitImport").mockResolvedValue({
    statusCode: 0,
  } as any);
  vi.spyOn(OlxApiService, "pollImportUntilDone").mockResolvedValue(null as any);

  vi.spyOn(FacebookApiService, "setAvailability").mockResolvedValue({
    handles: ["h1"],
  } as any);
  vi.spyOn(FacebookApiService, "pollBatchUntilDone").mockResolvedValue(
    null as any,
  );

  vi.spyOn(ListingRepository, "updateStatus").mockResolvedValue({} as any);
  vi.spyOn(ListingRepository, "updateListing").mockResolvedValue({} as any);
  vi.spyOn(ListingRepository, "updateStatusLean").mockResolvedValue({} as any);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("OLX — republicação x preferência de reabertura", () => {
  beforeEach(() => {
    (prisma as any).product.findUnique.mockResolvedValue(produto([listingOlx]));
  });

  it("DESLIGADA: não republica, e o anúncio segue fora do ar", async () => {
    comPreferencia(false);
    const [res] = await SyncUseCase.syncProductStock("prod-1");

    expect(OlxApiService.submitImport).not.toHaveBeenCalled();
    expect(ListingRepository.updateListing).not.toHaveBeenCalled();
    expect(res.success).toBe(true);
    expect((res as any).skipReason).toBe("olx_reopen_disabled_by_preference");
  });

  it("CONTROLE NEGATIVO — LIGADA: republica, como sempre fez", async () => {
    comPreferencia(true);
    await SyncUseCase.syncProductStock("prod-1");

    expect(OlxApiService.submitImport).toHaveBeenCalledTimes(1);
    expect(ListingRepository.updateListing).toHaveBeenCalledWith(
      "l-olx",
      expect.objectContaining({ status: "active" }),
    );
  });

  it("FAIL-OPEN: preferência ilegível ⇒ republica", async () => {
    comPreferencia(undefined);
    await SyncUseCase.syncProductStock("prod-1");
    expect(OlxApiService.submitImport).toHaveBeenCalledTimes(1);
  });

  it("a guarda só olha `paused` — `error` continua no retry de sempre", async () => {
    // 140 dos 140 anúncios OLX de produção estão em `error`. Alargar a guarda
    // para eles pararia o retry de publicação, que não tem nada a ver com a
    // preferência.
    comPreferencia(false);
    (prisma as any).product.findUnique.mockResolvedValue(
      produto([{ ...listingOlx, status: "error" }]),
    );
    await SyncUseCase.syncProductStock("prod-1");
    expect(OlxApiService.submitImport).toHaveBeenCalledTimes(1);
  });

  it("estoque ZERO continua despublicando, preferência ou não", async () => {
    // O veto é unidirecional: ele impede VOLTAR ao ar, nunca impede SAIR.
    comPreferencia(false);
    (prisma as any).product.findUnique.mockResolvedValue({
      ...produto([{ ...listingOlx, status: "active" }]),
      stock: 0,
    });
    await SyncUseCase.syncProductStock("prod-1");
    expect(OlxApiService.deleteAd).toHaveBeenCalledTimes(1);
  });
});

describe("Facebook — disponibilidade x preferência de reabertura", () => {
  beforeEach(() => {
    (prisma as any).product.findUnique.mockResolvedValue(produto([listingFb]));
  });

  it("DESLIGADA: não volta para `in stock`", async () => {
    comPreferencia(false);
    const [res] = await SyncUseCase.syncProductStock("prod-1");

    expect(FacebookApiService.setAvailability).not.toHaveBeenCalled();
    expect(res.success).toBe(true);
    expect((res as any).skipReason).toBe(
      "facebook_reopen_disabled_by_preference",
    );
  });

  it("CONTROLE NEGATIVO — LIGADA: volta para `in stock`", async () => {
    comPreferencia(true);
    await SyncUseCase.syncProductStock("prod-1");

    expect(FacebookApiService.setAvailability).toHaveBeenCalledWith(
      "tok-fb",
      SKU,
      "in stock",
      expect.objectContaining({ quantity: 1 }),
    );
  });

  it("FAIL-OPEN: preferência ilegível ⇒ volta para `in stock`", async () => {
    comPreferencia(undefined);
    await SyncUseCase.syncProductStock("prod-1");
    expect(FacebookApiService.setAvailability).toHaveBeenCalledTimes(1);
  });

  it("estoque ZERO continua marcando `out of stock`", async () => {
    comPreferencia(false);
    (prisma as any).product.findUnique.mockResolvedValue({
      ...produto([{ ...listingFb, status: "active" }]),
      stock: 0,
    });
    await SyncUseCase.syncProductStock("prod-1");
    expect(FacebookApiService.setAvailability).toHaveBeenCalledWith(
      "tok-fb",
      SKU,
      "out of stock",
      expect.objectContaining({ quantity: 0 }),
    );
  });
});

describe("EGRESS — a preferência não vira consulta repetida dentro do laço", () => {
  it("um produto com 3 anúncios OLX do mesmo dono lê a preferência UMA vez", async () => {
    // Regra 5 da casa: pré-carga em lote no lugar de consultas repetidas dentro
    // de laços. `syncAllStock` varre TODOS os anúncios de UMA conta — sempre o
    // mesmo dono —, então sem o memo por invocação a mesma linha de `User`
    // seria lida uma vez por anúncio.
    comPreferencia(false);
    (prisma as any).product.findUnique.mockResolvedValue(
      produto([
        { ...listingOlx, id: "l-1", externalListingId: "A1" },
        { ...listingOlx, id: "l-2", externalListingId: "A2" },
        { ...listingOlx, id: "l-3", externalListingId: "A3" },
      ]),
    );

    const res = await SyncUseCase.syncProductStock("prod-1");

    expect(res).toHaveLength(3);
    expect(OlxApiService.submitImport).not.toHaveBeenCalled();
    expect((prisma as any).user.findMany).toHaveBeenCalledTimes(1);
  });

  it("anúncio que NÃO está `paused` não gera consulta nenhuma", async () => {
    // O caminho comum — 140 dos 140 anúncios OLX de produção estão em `error`.
    comPreferencia(false);
    (prisma as any).product.findUnique.mockResolvedValue(
      produto([{ ...listingOlx, status: "error" }]),
    );

    await SyncUseCase.syncProductStock("prod-1");

    expect((prisma as any).user.findMany).not.toHaveBeenCalled();
  });

  it("a leitura pede só os 3 booleanos, nunca a linha do usuário", async () => {
    // Regra 1: nenhuma leitura sem seleção explícita em caminho recorrente. A
    // linha de `User` é larga e é lida pelo authMiddleware a cada requisição.
    comPreferencia(false);
    (prisma as any).product.findUnique.mockResolvedValue(produto([listingOlx]));

    await SyncUseCase.syncProductStock("prod-1");

    const arg = (prisma as any).user.findMany.mock.calls[0][0];
    expect(arg.select).toEqual({
      id: true,
      reopenListingsOnSaleCancel: true,
      parent: { select: { reopenListingsOnSaleCancel: true } },
    });
    expect(arg.include).toBeUndefined();
  });
});
describe("ISOLAMENTO entre tenants", () => {
  it("a conta de outro dono não herda a decisão", async () => {
    (prisma as any).product.findUnique.mockResolvedValue(
      produto([
        { ...listingOlx, marketplaceAccount: { ...listingOlx.marketplaceAccount, userId: "tenant-B" } },
      ]),
    );
    // Só o tenant-1 desligou; a conta é do tenant-B, que nem aparece no mapa.
    (prisma as any).user.findMany.mockResolvedValue([
      { id: OWNER, reopenListingsOnSaleCancel: false, parent: null },
    ]);

    await SyncUseCase.syncProductStock("prod-1");
    expect(OlxApiService.submitImport).toHaveBeenCalledTimes(1);
  });
});
