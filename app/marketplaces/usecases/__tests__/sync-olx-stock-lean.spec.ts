import { beforeEach, describe, expect, it, vi } from "vitest";
import { Platform } from "@prisma/client";

// Regressão do "Sincronizar estoque" da OLX:
// syncAllStock carrega o produto ENXUTO ({id,sku,stock,name,...}) e chamava
// OlxPayloadBuilderService.build → submitImport reenviando o anúncio inteiro
// (preço 0, sem foto, "usado"), reportando sucesso. O fix torna a republicação
// um NO-OP quando o anúncio já está ativo. Este teste prova ZERO submitImport.

vi.hoisted(() => {
  process.env.OLX_SELLER_PHONE = "21999998888";
  process.env.OLX_SELLER_ZIPCODE = "20000000";
});

vi.mock("@/app/lib/prisma", () => ({
  default: {
    marketplaceAccount: { findMany: vi.fn() },
    productListing: { findMany: vi.fn(), findUnique: vi.fn() },
    product: { findUnique: vi.fn() },
    syncLog: { create: vi.fn().mockResolvedValue({}) },
  },
}));

vi.mock("../../services/olx-api.service", () => ({
  OlxApiService: {
    deleteAd: vi.fn().mockResolvedValue({ statusCode: 0 }),
    submitImport: vi.fn().mockResolvedValue({ statusCode: 0, token: "tk" }),
    pollImportUntilDone: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock("../../repositories/listing.repository", () => ({
  ListingRepository: { updateStatus: vi.fn().mockResolvedValue({}) },
}));

vi.mock("../../repositories/marketplace.repository", () => ({
  MarketplaceRepository: {
    findAllByUserIdAndPlatform: vi.fn(),
  },
}));

import prisma from "@/app/lib/prisma";
import { OlxApiService } from "../../services/olx-api.service";
import { MarketplaceRepository } from "../../repositories/marketplace.repository";
import { SyncUseCase } from "../sync.usercase";

const account = {
  id: "acc-olx",
  platform: Platform.OLX,
  accessToken: "olx-token",
  olxSellerPhone: null,
  olxSellerZipcode: null,
};

// Produto ENXUTO, exatamente como syncAllStock projeta para a OLX. Sem preço
// real/imagens é irrelevante: com o anúncio ativo o fix NÃO republica.
function leanListing(status: string) {
  return {
    id: "listing-1",
    externalListingId: "SKU1",
    status,
    product: { id: "prod-1", sku: "SKU1", stock: 5, name: "Farol Gol" },
    marketplaceAccount: account,
  };
}

describe("SyncUseCase.syncAllStock — OLX com produto enxuto", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (MarketplaceRepository.findAllByUserIdAndPlatform as any).mockResolvedValue([
      account,
    ]);
    (prisma as any).syncLog.create.mockResolvedValue({});
    (OlxApiService.submitImport as any).mockResolvedValue({
      statusCode: 0,
      token: "tk",
    });
    (OlxApiService.deleteAd as any).mockResolvedValue({ statusCode: 0 });
  });

  it("anúncio ativo + estoque > 0 → ZERO submitImport (no-op, não destrói o anúncio)", async () => {
    (prisma as any).productListing.findMany.mockResolvedValue([
      leanListing("active"),
    ]);

    const result = await SyncUseCase.syncAllStock("user-1", Platform.OLX);

    // O ponto do teste: o builder/submitImport NUNCA é chamado no caminho enxuto.
    expect(OlxApiService.submitImport).not.toHaveBeenCalled();
    expect(OlxApiService.deleteAd).not.toHaveBeenCalled();
    expect(result.successful).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.results[0].skipped).toBe(true);
  });

  it("nunca chama submitImport com preço 0 / sem imagem (guarda dura)", async () => {
    // Anúncio fora do ar (paused) → tentaria republicar; o produto enxuto não
    // tem imagem, então a guarda LANÇA em vez de publicar um anúncio zerado.
    (prisma as any).productListing.findMany.mockResolvedValue([
      leanListing("paused"),
    ]);
    // Reload do produto completo continua sem imagem (cenário-veneno).
    (prisma as any).product.findUnique.mockResolvedValue({
      id: "prod-1",
      sku: "SKU1",
      stock: 5,
      name: "Farol Gol",
      price: 200,
      imageUrl: null,
      imageUrls: [],
      quality: "SUCATA",
    });
    (prisma as any).productListing.findUnique.mockResolvedValue(null);

    const result = await SyncUseCase.syncAllStock("user-1", Platform.OLX);

    expect(OlxApiService.submitImport).not.toHaveBeenCalled();
    expect(result.failed).toBe(1);
  });
});
