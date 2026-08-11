import { beforeEach, describe, expect, it, vi } from "vitest";
import { Platform } from "@prisma/client";

vi.hoisted(() => {
  process.env.OLX_SELLER_PHONE = "21999998888";
  process.env.OLX_SELLER_ZIPCODE = "20000000";
});

vi.mock("@/app/lib/prisma", () => ({
  default: {
    product: { findUnique: vi.fn() },
    productListing: { findUnique: vi.fn().mockResolvedValue(null) },
    syncLog: { create: vi.fn().mockResolvedValue({}) },
  },
}));

vi.mock("../../services/olx-api.service", () => ({
  OlxApiService: {
    deleteAd: vi.fn().mockResolvedValue({ statusCode: 0 }),
    submitImport: vi.fn().mockResolvedValue({ statusCode: 0, token: "tk" }),
    // null = sem recusa no import assíncrono.
    pollImportUntilDone: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock("../../repositories/listing.repository", () => ({
  ListingRepository: {
    updateStatus: vi.fn().mockResolvedValue({}),
    updateListing: vi.fn().mockResolvedValue({}),
  },
}));

import prisma from "@/app/lib/prisma";
import { OlxApiService } from "../../services/olx-api.service";
import { ListingRepository } from "../../repositories/listing.repository";
import { SyncUseCase } from "../sync.usercase";

function productWith(stock: number, listingStatus?: string) {
  return {
    id: "prod-1",
    name: "Farol Direito Gol 2012",
    sku: "SKU1",
    stock,
    price: 200,
    brand: "VW",
    model: "Gol",
    year: "2012",
    quality: "SUCATA",
    // Produto precisa de imagem p/ republicar (guarda no build).
    imageUrl: "https://img.example/1.jpg",
    imageUrls: ["https://img.example/1.jpg"],
    olxCategoryId: 555, // categoria explícita → resolve offline
    listings: [
      {
        id: "listing-1",
        externalListingId: "SKU1",
        externalSku: "SKU1",
        status: listingStatus,
        marketplaceAccount: {
          id: "acc-olx",
          platform: Platform.OLX,
          accessToken: "olx-token",
        },
      },
    ],
  };
}

describe("SyncUseCase.syncProductStock — plataforma OLX", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (OlxApiService.deleteAd as any).mockResolvedValue({ statusCode: 0 });
    (OlxApiService.submitImport as any).mockResolvedValue({
      statusCode: 0,
      token: "tk",
    });
    (OlxApiService.pollImportUntilDone as any).mockResolvedValue(null);
    (ListingRepository.updateStatus as any).mockResolvedValue({});
    (ListingRepository.updateListing as any).mockResolvedValue({});
    (prisma as any).syncLog.create.mockResolvedValue({});
  });

  it("estoque 0 → deleteAd (despublica) e marca listing paused", async () => {
    (prisma as any).product.findUnique.mockResolvedValue(productWith(0));

    const results = await SyncUseCase.syncProductStock("prod-1");

    expect(OlxApiService.deleteAd).toHaveBeenCalledWith("olx-token", "SKU1");
    expect(OlxApiService.submitImport).not.toHaveBeenCalled();
    expect(ListingRepository.updateStatus).toHaveBeenCalledWith(
      "listing-1",
      "paused",
    );
    expect(results[0].success).toBe(true);
  });

  it("estoque > 0 e anúncio FORA do ar → republica (insert mesmo id) e marca active", async () => {
    // listing sem status (= saiu do ar) → deve republicar.
    (prisma as any).product.findUnique.mockResolvedValue(productWith(5));

    const results = await SyncUseCase.syncProductStock("prod-1");

    expect(OlxApiService.submitImport).toHaveBeenCalledTimes(1);
    const [token, adList] = (OlxApiService.submitImport as any).mock.calls[0];
    expect(token).toBe("olx-token");
    expect(adList[0].operation).toBe("insert");
    expect(adList[0].id).toBe("SKU1"); // mesmo id (idempotência da edição)
    expect(OlxApiService.deleteAd).not.toHaveBeenCalled();
    // Poll null (nada aceito ainda) ⇒ persiste só o status, sem tocar
    // olxListId/permalink (o spread os omite p/ não zerar o já capturado).
    expect(ListingRepository.updateListing).toHaveBeenCalledWith("listing-1", {
      status: "active",
    });
    expect(results[0].success).toBe(true);
  });

  it("estoque > 0 FORA do ar + poll aceito → repopula olxListId/permalink REAIS", async () => {
    (prisma as any).product.findUnique.mockResolvedValue(productWith(5));
    // Poll devolve o anúncio aceito com o list_id/url reais.
    (OlxApiService.pollImportUntilDone as any).mockResolvedValue({
      autoupload_status: "done",
      ads: {
        SKU1: { status: "accepted", operation: "insert", list_id: "999", url: "https://olx/999" },
      },
    });

    const results = await SyncUseCase.syncProductStock("prod-1");

    expect(ListingRepository.updateListing).toHaveBeenCalledWith("listing-1", {
      status: "active",
      olxListId: "999",
      permalink: "https://olx/999",
    });
    expect(results[0].success).toBe(true);
  });

  it("estoque > 0 e anúncio JÁ ativo → NO-OP (não republica, não destrói o anúncio)", async () => {
    // O bug original: republicava o anúncio inteiro no sync de estoque, zerando
    // preço/foto/qualidade. Agora estoque>0 + ativo = nada a fazer.
    (prisma as any).product.findUnique.mockResolvedValue(
      productWith(5, "active"),
    );

    const results = await SyncUseCase.syncProductStock("prod-1");

    expect(OlxApiService.submitImport).not.toHaveBeenCalled();
    expect(OlxApiService.deleteAd).not.toHaveBeenCalled();
    expect(results[0].success).toBe(true);
    expect((results[0] as any).skipped).toBe(true);
  });

  it("estoque 0 e anúncio JÁ paused → NO-OP (não re-executa deleteAd)", async () => {
    // A baixa já foi refletida (paused). Sem o no-op, cada rodada de sync
    // re-chamava deleteAd à toa.
    (prisma as any).product.findUnique.mockResolvedValue(
      productWith(0, "paused"),
    );

    const results = await SyncUseCase.syncProductStock("prod-1");

    expect(OlxApiService.deleteAd).not.toHaveBeenCalled();
    expect(OlxApiService.submitImport).not.toHaveBeenCalled();
    expect(results[0].success).toBe(true);
    expect((results[0] as any).skipped).toBe(true);
    expect((results[0] as any).skipReason).toBe("olx_listing_already_paused");
  });

  it("estoque > 0 e anúncio PENDING → NO-OP (recém-publicado, não republica)", async () => {
    // Anúncio nasce "pending" (fila de revisão da OLX). Sem tratar pending como
    // no-op, todo "Sincronizar estoque" republicaria o anúncio inteiro.
    (prisma as any).product.findUnique.mockResolvedValue(
      productWith(5, "pending"),
    );

    const results = await SyncUseCase.syncProductStock("prod-1");

    expect(OlxApiService.submitImport).not.toHaveBeenCalled();
    expect(OlxApiService.deleteAd).not.toHaveBeenCalled();
    expect(results[0].success).toBe(true);
    expect((results[0] as any).skipped).toBe(true);
  });

  it("NÃO cai no default 'plataforma não suportada' (o case OLX existe)", async () => {
    (prisma as any).product.findUnique.mockResolvedValue(productWith(0));
    const results = await SyncUseCase.syncProductStock("prod-1");
    expect(results[0].error).toBeUndefined();
  });

  it("C4: kill-switch OLX_INTEGRATION_DISABLED=1 ⇒ no-op (não chama OlxApiService)", async () => {
    // Antes o kill-switch não cobria o caminho de estoque (sync.usercase não
    // importava integration-flags): com a flag ligada o operador achava que
    // parou, mas o maior volume de chamadas outbound continuava saindo.
    (prisma as any).product.findUnique.mockResolvedValue(productWith(0));
    process.env.OLX_INTEGRATION_DISABLED = "1";
    try {
      const results = await SyncUseCase.syncProductStock("prod-1");
      expect(OlxApiService.deleteAd).not.toHaveBeenCalled();
      expect(OlxApiService.submitImport).not.toHaveBeenCalled();
      expect(results[0].success).toBe(true);
      expect((results[0] as any).skipped).toBe(true);
      expect((results[0] as any).skipReason).toBe("integration_disabled");
    } finally {
      delete process.env.OLX_INTEGRATION_DISABLED;
    }
  });
});
