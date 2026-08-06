import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import prisma from "@/app/lib/prisma";
import { ListingRepository } from "@/app/marketplaces/repositories/listing.repository";
import { MLApiService } from "@/app/marketplaces/services/ml-api.service";
import { ListingUseCase } from "@/app/marketplaces/usecases/listing.usercase";
import { SyncUseCase } from "@/app/marketplaces/usecases/sync.usercase";
import { SystemLogService } from "@/app/services/system-log.service";

/**
 * Encerramento do anúncio ANTIGO depois de uma republicação UP.
 *
 * O painel do ML agrupa os itens da mesma família e SOMA o
 * `available_quantity` — inclusive o dos fechados. Medido no anúncio que
 * originou o relato: MLB7319037094 ficou `closed` com `available_quantity: 1`,
 * e a vendedora, que tem UMA peça, passou a ver "Estoque: 2 un.".
 */
const OLD_ID = "MLB7319037094";
const NEW_ID = "MLB7319051094";

const args = {
  userId: "user-1",
  productId: "prod-1",
  accountId: "acct-1",
  accessToken: "tok",
  oldExternalListingId: OLD_ID,
  currentItem: {
    id: OLD_ID,
    status: "active",
    category_id: "MLB101763",
    title: "Porta Dianteira Direita Byd Dolphin Plus 2024 2025 2026",
  } as any,
  newTitle: "PORTA DIANTEIRA DIREITA BYD DOLPHIN PLUS 2024 2025 2026",
};

describe("republishUpListing → zera o estoque do anuncio antigo antes de fechar", () => {
  let updateSpy: any;
  let warnLogSpy: any;

  beforeEach(() => {
    process.env.ML_UP_REPUBLISH_ZERO_OLD_STOCK_DISABLED = "0";

    vi.spyOn(ListingRepository, "findByExternalListingId").mockResolvedValue({
      id: "listing-1",
      externalListingId: OLD_ID,
    } as any);
    vi.spyOn(ListingRepository, "updateListing").mockResolvedValue({} as any);
    vi.spyOn(
      ListingRepository,
      "revertRepublishPlaceholder",
    ).mockResolvedValue("reverted");
    vi.spyOn(SyncUseCase as any, "extractMlSettingsFromItem").mockReturnValue({});
    vi.spyOn(ListingUseCase, "createMLListing").mockResolvedValue({
      success: true,
      externalListingId: NEW_ID,
      listingId: "listing-1",
    } as any);
    vi.spyOn(prisma.syncLog, "create").mockResolvedValue({} as any);
    warnLogSpy = vi
      .spyOn(SystemLogService, "logWarning")
      .mockResolvedValue({} as any);
    updateSpy = vi
      .spyOn(MLApiService, "updateItem")
      .mockResolvedValue({ id: OLD_ID } as any);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ML_UP_REPUBLISH_ZERO_OLD_STOCK_DISABLED;
  });

  const itemDepois = (over: Record<string, unknown>) =>
    vi.spyOn(MLApiService, "getItemDetails").mockResolvedValue({
      id: OLD_ID,
      status: "closed",
      available_quantity: 0,
      ...over,
    } as any);

  it("manda DOIS PUTs, nessa ordem: zera o estoque e so entao fecha", async () => {
    itemDepois({});

    const r = await SyncUseCase.republishUpListing(args);

    expect(r.republished).toBe(true);
    expect(updateSpy).toHaveBeenCalledTimes(2);
    expect(updateSpy.mock.calls[0][1]).toBe(OLD_ID);
    expect(updateSpy.mock.calls[0][2]).toEqual({ available_quantity: 0 });
    expect(updateSpy.mock.calls[1][2]).toEqual({ status: "closed" });
    // Nunca combinados num so body: o ML poderia aplicar o status e ignorar a
    // quantidade, que e exatamente o silencio que estamos eliminando.
    for (const call of updateSpy.mock.calls) {
      const body = call[2] as Record<string, unknown>;
      expect(
        "available_quantity" in body && "status" in body,
        "estoque e status nao podem ir no mesmo PUT",
      ).toBe(false);
    }
  });

  it("confirmado closed com estoque zero: nao registra diagnostico", async () => {
    itemDepois({});

    await SyncUseCase.republishUpListing(args);

    expect(warnLogSpy).not.toHaveBeenCalled();
    expect(prisma.syncLog.create).not.toHaveBeenCalled();
  });

  it("CASO DO VIDEO: fechado mas ainda com estoque 1 => registra ML_UP_REPUBLISH_ORPHAN", async () => {
    itemDepois({ available_quantity: 1 });

    const r = await SyncUseCase.republishUpListing(args);

    // A republicacao em si nao falha — o anuncio novo esta vivo.
    expect(r.republished).toBe(true);
    expect(warnLogSpy).toHaveBeenCalledTimes(1);
    const [action, , options] = warnLogSpy.mock.calls[0];
    expect(action).toBe("ML_UP_REPUBLISH_ORPHAN");
    expect(options).toMatchObject({ userId: "user-1", resourceId: "prod-1" });
    expect(options.details).toMatchObject({
      oldExternalListingId: OLD_ID,
      newExternalListingId: NEW_ID,
      verifiedStatus: "closed",
      verifiedQuantity: 1,
    });
    // WARNING, nunca FAILURE: FAILURE dispara checkAndAlertTokenHealth e
    // geraria alerta falso de "reconecte a conta".
    const syncLogArgs = (prisma.syncLog.create as any).mock.calls[0][0];
    expect(syncLogArgs.data.status).toBe("WARNING");
  });

  it("falha ao zerar nao impede o fechamento nem derruba a republicacao", async () => {
    updateSpy.mockReset();
    updateSpy
      .mockRejectedValueOnce(new Error("400 bad request"))
      .mockResolvedValue({ id: OLD_ID } as any);
    itemDepois({ available_quantity: 2 });

    const r = await SyncUseCase.republishUpListing(args);

    expect(r.republished).toBe(true);
    // O fechamento foi tentado mesmo com a zeragem falhando.
    expect(updateSpy.mock.calls[1][2]).toEqual({ status: "closed" });
    expect(warnLogSpy.mock.calls[0][2].details.zeroError).toContain(
      "400 bad request",
    );
  });

  it("erro idempotente (ja fechado) conta como sucesso", async () => {
    updateSpy.mockReset();
    updateSpy.mockRejectedValue(new Error("Item is already closed"));
    itemDepois({});

    await SyncUseCase.republishUpListing(args);

    expect(warnLogSpy).not.toHaveBeenCalled();
  });

  it("GET de verificacao falhando registra o diagnostico em vez de sumir", async () => {
    vi.spyOn(MLApiService, "getItemDetails").mockRejectedValue(
      new Error("timeout na verificacao"),
    );

    await SyncUseCase.republishUpListing(args);

    expect(warnLogSpy).toHaveBeenCalledTimes(1);
    expect(warnLogSpy.mock.calls[0][2].details.verifyError).toContain(
      "timeout na verificacao",
    );
  });

  it("kill-switch: volta a so fechar, sem zerar nem verificar", async () => {
    process.env.ML_UP_REPUBLISH_ZERO_OLD_STOCK_DISABLED = "1";
    const getSpy = itemDepois({});

    await SyncUseCase.republishUpListing(args);

    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy.mock.calls[0][2]).toEqual({ status: "closed" });
    expect(getSpy).not.toHaveBeenCalled();
    expect(warnLogSpy).not.toHaveBeenCalled();
  });
});
