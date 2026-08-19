import { beforeEach, describe, expect, it, vi } from "vitest";
import { Platform } from "@prisma/client";

vi.mock("@/app/lib/prisma", () => ({
  default: {
    product: { findUnique: vi.fn() },
    syncLog: { create: vi.fn().mockResolvedValue({}) },
  },
}));

vi.mock("../../services/facebook-api.service", () => ({
  FacebookApiService: {
    setAvailability: vi.fn().mockResolvedValue({ handles: ["h1"] }),
    upsertItem: vi.fn().mockResolvedValue({ handles: ["h1"] }),
    // null = sem erro no lote → o confirm não lança.
    pollBatchUntilDone: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock("../../repositories/listing.repository", () => ({
  ListingRepository: {
    updateStatus: vi.fn().mockResolvedValue({}),
    // O espelho de status do Facebook passou a usar a variante ENXUTA, atrás de
    // guarda de novidade — o mesmo desenho do Mercado Livre. `updateStatus` é
    // um `update` sem `select`: devolvia as ~46 colunas do ProductListing (com
    // os 20 `*Override` e os JSONBs) a cada anúncio da varredura, mesmo quando
    // nada mudava. Os casos abaixo continuam provando o que sempre provaram —
    // que o Facebook NÃO deleta e que o status local acaba certo.
    updateStatusLean: vi.fn().mockResolvedValue({}),
  },
}));

import prisma from "@/app/lib/prisma";
import { FacebookApiService } from "../../services/facebook-api.service";
import { ListingRepository } from "../../repositories/listing.repository";
import { SyncUseCase } from "../sync.usercase";

function productWith(stock: number, statusLocal?: string) {
  return {
    id: "prod-1",
    name: "Farol Direito Gol 2012",
    sku: "SKU1",
    stock,
    price: 200,
    brand: "VW",
    listings: [
      {
        id: "listing-1",
        externalListingId: "SKU1",
        externalSku: "SKU1",
        status: statusLocal,
        marketplaceAccount: {
          id: "acc-fb",
          platform: Platform.FACEBOOK,
          accessToken: "fb-token",
          // Catálogo por conta é obrigatório: sem ele o sync bloqueia (não cai
          // no catálogo global do .env, que colidiria entre tenants).
          fbCatalogId: "cat-fb",
        },
      },
    ],
  };
}

describe("SyncUseCase.syncProductStock — plataforma FACEBOOK", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (FacebookApiService.setAvailability as any).mockResolvedValue({
      handles: ["h1"],
    });
    (FacebookApiService.pollBatchUntilDone as any).mockResolvedValue(null);
    (ListingRepository.updateStatus as any).mockResolvedValue({});
    (prisma as any).syncLog.create.mockResolvedValue({});
  });

  it("estoque 0 → availability 'out of stock' (NÃO delete) e listing paused", async () => {
    (prisma as any).product.findUnique.mockResolvedValue(productWith(0));

    const results = await SyncUseCase.syncProductStock("prod-1");

    expect(FacebookApiService.setAvailability).toHaveBeenCalledWith(
      "fb-token",
      "SKU1",
      "out of stock",
      { quantity: 0, catalogId: "cat-fb" },
    );
    expect(ListingRepository.updateStatusLean).toHaveBeenCalledWith(
      "listing-1",
      "paused",
    );
    expect(results[0].success).toBe(true);
  });

  it("estoque > 0 → availability 'in stock' (+quantity) e listing active", async () => {
    (prisma as any).product.findUnique.mockResolvedValue(productWith(5));

    const results = await SyncUseCase.syncProductStock("prod-1");

    expect(FacebookApiService.setAvailability).toHaveBeenCalledWith(
      "fb-token",
      "SKU1",
      "in stock",
      { quantity: 5, catalogId: "cat-fb" },
    );
    expect(ListingRepository.updateStatusLean).toHaveBeenCalledWith(
      "listing-1",
      "active",
    );
    expect(results[0].success).toBe(true);
  });

  it("NÃO cai no default 'plataforma não suportada' (o case FACEBOOK existe)", async () => {
    (prisma as any).product.findUnique.mockResolvedValue(productWith(0));
    const results = await SyncUseCase.syncProductStock("prod-1");
    expect(results[0].error).toBeUndefined();
  });

  describe("guarda de novidade — não regrava status que já está certo", () => {
    it("estoque 0 com o anúncio JÁ pausado: nenhuma escrita de status", async () => {
      (prisma as any).product.findUnique.mockResolvedValue(
        productWith(0, "paused"),
      );

      const results = await SyncUseCase.syncProductStock("prod-1");

      expect(ListingRepository.updateStatusLean).not.toHaveBeenCalled();
      expect(ListingRepository.updateStatus).not.toHaveBeenCalled();
      // ⚠️ A guarda vale para a ESCRITA no banco, não para a chamada externa:
      // o status local pode estar defasado em relação ao catálogo da Meta, e
      // pular o envio exigiria o mesmo cuidado do `forceRemote`. Este assert
      // trava essa fronteira — se alguém transformar a guarda num no-op do
      // envio, o caso falha.
      expect(FacebookApiService.setAvailability).toHaveBeenCalled();
      expect(results[0].success).toBe(true);
    });

    it("estoque > 0 com o anúncio JÁ ativo: nenhuma escrita de status", async () => {
      (prisma as any).product.findUnique.mockResolvedValue(
        productWith(5, "active"),
      );

      const results = await SyncUseCase.syncProductStock("prod-1");

      expect(ListingRepository.updateStatusLean).not.toHaveBeenCalled();
      expect(results[0].success).toBe(true);
    });

    it("status local DIFERENTE do alvo continua sendo gravado", async () => {
      // Controle negativo: sem ele os dois casos acima passariam mesmo se a
      // gravação tivesse sumido de vez.
      (prisma as any).product.findUnique.mockResolvedValue(
        productWith(0, "active"),
      );

      await SyncUseCase.syncProductStock("prod-1");

      expect(ListingRepository.updateStatusLean).toHaveBeenCalledWith(
        "listing-1",
        "paused",
      );
    });
  });
});
