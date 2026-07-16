import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SyncUseCase } from "@/app/marketplaces/usecases/sync.usercase";
import { ListingRepository } from "@/app/marketplaces/repositories/listing.repository";
import { ListingUseCase } from "@/app/marketplaces/usecases/listing.usercase";
import { MLApiService } from "@/app/marketplaces/services/ml-api.service";

/**
 * Republicação de anúncio UP (catálogo): quando o createMLListing falha, o
 * revert precisa DESLIGAR o retry.
 *
 * A cadeia do bug:
 *   1. republishUpListing troca o externalListingId por um placeholder e chama
 *      createMLListing, que REUSA a mesma linha do par (produto, conta).
 *   2. createMLListing falha (ex.: family_name/PART_NUMBER) e sua escada grava
 *      `retryEnabled: true` NESSA MESMA LINHA.
 *   3. O revert restaura o MLB antigo (vivo e ativo no ML) + status active —
 *      mas, sem o reset, deixa `retryEnabled: true`.
 *   4. O ListingRetryService considera a linha candidata (o filtro dele passa
 *      por retryEnabled e NÃO exige prefixo PENDING_) e chama createItem →
 *      cria um anúncio DUPLICADO no ML e deixa o antigo órfão (vivo lá, sem
 *      linha aqui, pois o sucesso sobrescreve o externalListingId).
 *
 * O guard de preço quebrado mascarava isso: reprovava todo candidato antes do
 * createItem. Ao consertá-lo, este caminho destrava — daí o reset ser
 * pré-requisito.
 */

const OLD_ID = "MLB123456789";

const listingRow = { id: "listing-1", externalListingId: OLD_ID } as any;

const currentItem = {
  id: OLD_ID,
  status: "active",
  category_id: "MLB1744",
  title: "Farol Dianteiro",
} as any;

const args = {
  userId: "user-1",
  productId: "prod-1",
  accountId: "acct-1",
  accessToken: "tok",
  oldExternalListingId: OLD_ID,
  currentItem,
  newTitle: "Farol Dianteiro Gol G5",
};

/** Última chamada de updateListing que restaurou o MLB antigo. */
const revertCall = () =>
  (ListingRepository.updateListing as any).mock.calls.find(
    (c: any[]) => c[1]?.externalListingId === OLD_ID,
  );

describe("republishUpListing — revert desliga o retry", () => {
  beforeEach(() => {
    vi.spyOn(ListingRepository, "findByExternalListingId").mockResolvedValue(
      listingRow,
    );
    vi.spyOn(ListingRepository, "updateListing").mockResolvedValue({} as any);
    vi.spyOn(SyncUseCase as any, "extractMlSettingsFromItem").mockReturnValue({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("desliga retryEnabled quando createMLListing LANÇA", async () => {
    vi.spyOn(ListingUseCase, "createMLListing").mockRejectedValue(
      new Error("Erro ao criar item: family_name"),
    );

    await expect(SyncUseCase.republishUpListing(args)).rejects.toThrow();

    const call = revertCall();
    expect(call, "o revert deve restaurar o MLB antigo").toBeTruthy();
    expect(call[1]).toMatchObject({
      externalListingId: OLD_ID,
      status: "active",
      // Sem isto, o cron recria o anúncio e duplica no ML.
      retryEnabled: false,
      nextRetryAt: null,
    });
  });

  it("desliga retryEnabled quando createMLListing retorna success=false", async () => {
    vi.spyOn(ListingUseCase, "createMLListing").mockResolvedValue({
      success: false,
      error: "Erro ao criar item: missing_required [PART_NUMBER]",
    } as any);

    await expect(SyncUseCase.republishUpListing(args)).rejects.toThrow();

    const call = revertCall();
    expect(call).toBeTruthy();
    expect(call[1]).toMatchObject({
      externalListingId: OLD_ID,
      status: "active",
      retryEnabled: false,
      nextRetryAt: null,
    });
  });

  it("preserva o caminho feliz: republicação bem-sucedida não reverte", async () => {
    vi.spyOn(ListingUseCase, "createMLListing").mockResolvedValue({
      success: true,
      externalListingId: "MLB999999999",
      listingId: "listing-1",
    } as any);
    // O caminho feliz fecha o anúncio antigo no ML.
    vi.spyOn(MLApiService, "updateItem").mockResolvedValue({
      id: OLD_ID,
      status: "closed",
    } as any);

    const result = await SyncUseCase.republishUpListing(args);

    expect(result.republished).toBe(true);
    expect(result.newExternalListingId).toBe("MLB999999999");
    // Nenhum revert para o id antigo no caminho feliz.
    expect(revertCall()).toBeFalsy();
  });
});
