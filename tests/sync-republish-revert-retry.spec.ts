import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import prisma from "@/app/lib/prisma";
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

/**
 * Chamada de revert. Desde a correção do estoque órfão, o revert passa por
 * `revertRepublishPlaceholder` — um compare-and-swap que só grava se a linha
 * ainda estiver no placeholder — em vez de um `updateListing` cego. O reset do
 * retry mudou de lugar (vive dentro do repositório agora), NÃO deixou de
 * existir: ver o describe do repositório no fim deste arquivo.
 */
const revertCall = () =>
  (ListingRepository.revertRepublishPlaceholder as any).mock.calls.find(
    (c: any[]) => c[2] === OLD_ID,
  );

describe("republishUpListing — revert desliga o retry", () => {
  beforeEach(() => {
    vi.spyOn(ListingRepository, "findByExternalListingId").mockResolvedValue(
      listingRow,
    );
    vi.spyOn(ListingRepository, "updateListing").mockResolvedValue({} as any);
    vi.spyOn(
      ListingRepository,
      "revertRepublishPlaceholder",
    ).mockResolvedValue("reverted");
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
    expect(call[0]).toBe("listing-1");
    expect(call[1]).toMatch(/^PENDING_REPUBLISH_/);
    expect(call[3]).toBe("active");
  });

  it("o swap para o placeholder JA desliga o retry", async () => {
    // Se a linha vinha com retryEnabled: true, o placeholder entraria na fila
    // do ListingRetryService DURANTE a republicação e o cron criaria um
    // anúncio duplicado em paralelo.
    vi.spyOn(ListingUseCase, "createMLListing").mockRejectedValue(
      new Error("qualquer"),
    );

    await expect(SyncUseCase.republishUpListing(args)).rejects.toThrow();

    const swap = (ListingRepository.updateListing as any).mock.calls.find(
      (c: any[]) => String(c[1]?.externalListingId).startsWith("PENDING_"),
    );
    expect(swap).toBeTruthy();
    expect(swap[1]).toMatchObject({
      status: "pending",
      retryEnabled: false,
      nextRetryAt: null,
    });
  });

  it("nao sobrescreve a linha quando outro caminho ja gravou o MLB novo", async () => {
    (
      ListingRepository.revertRepublishPlaceholder as any
    ).mockResolvedValue("already_changed");
    vi.spyOn(ListingUseCase, "createMLListing").mockRejectedValue(
      new Error("qualquer"),
    );

    await expect(SyncUseCase.republishUpListing(args)).rejects.toThrow();

    // Nenhum updateListing restaurando o id antigo: sobrescrever deixaria o
    // anúncio criado em paralelo órfão no ML.
    const sobrescreveu = (
      ListingRepository.updateListing as any
    ).mock.calls.find((c: any[]) => c[1]?.externalListingId === OLD_ID);
    expect(sobrescreveu).toBeFalsy();
  });

  it("marca terminal quando o MLB antigo ja foi tomado por outra linha (P2002)", async () => {
    (ListingRepository.revertRepublishPlaceholder as any).mockResolvedValue(
      "id_taken",
    );
    vi.spyOn(ListingUseCase, "createMLListing").mockRejectedValue(
      new Error("qualquer"),
    );

    await expect(SyncUseCase.republishUpListing(args)).rejects.toThrow();

    const terminal = (ListingRepository.updateListing as any).mock.calls.find(
      (c: any[]) => String(c[1]?.lastError || "").startsWith("[TERMINAL]"),
    );
    expect(
      terminal,
      "sem isto o placeholder fica preso para sempre (24 casos em producao)",
    ).toBeTruthy();
    expect(terminal[1]).toMatchObject({
      status: "error",
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
    expect(call[2]).toBe(OLD_ID);
    expect(call[3]).toBe("active");
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

describe("ListingRepository.revertRepublishPlaceholder — o compare-and-swap", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const updateMany = () =>
    vi.spyOn(prisma.productListing, "updateMany") as any;

  it("desliga retryEnabled ao restaurar — a garantia que o cron nao duplique", async () => {
    const spy = updateMany().mockResolvedValue({ count: 1 } as any);

    const r = await ListingRepository.revertRepublishPlaceholder(
      "listing-1",
      "PENDING_REPUBLISH_MLB123_1",
      OLD_ID,
      "active",
    );

    expect(r).toBe("reverted");
    expect(spy.mock.calls[0][0]).toMatchObject({
      // O placeholder no WHERE é o compare-and-swap: sem ele, um sucesso
      // concorrente seria sobrescrito com o MLB antigo.
      where: { id: "listing-1", externalListingId: "PENDING_REPUBLISH_MLB123_1" },
      data: {
        externalListingId: OLD_ID,
        status: "active",
        retryEnabled: false,
        nextRetryAt: null,
      },
    });
  });

  it("devolve already_changed quando a linha ja saiu do placeholder", async () => {
    updateMany().mockResolvedValue({ count: 0 } as any);

    await expect(
      ListingRepository.revertRepublishPlaceholder("l", "PENDING_X", OLD_ID, "active"),
    ).resolves.toBe("already_changed");
  });

  it("devolve id_taken em P2002 em vez de propagar e prender o placeholder", async () => {
    updateMany().mockRejectedValue(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
    );

    await expect(
      ListingRepository.revertRepublishPlaceholder("l", "PENDING_X", OLD_ID, "active"),
    ).resolves.toBe("id_taken");
  });

  it("propaga erro que nao seja P2002", async () => {
    updateMany().mockRejectedValue(new Error("conexao caiu"));

    await expect(
      ListingRepository.revertRepublishPlaceholder("l", "PENDING_X", OLD_ID, "active"),
    ).rejects.toThrow("conexao caiu");
  });
});
