import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Falha na RENOVAÇÃO do token adia a baixa em vez de apagá-la.
 *
 * Produção, 16/09/2026: durante a pane da partner key da Shopee a mensagem
 * chegava como "Erro ao renovar token: partner key has expired" — sem 401/403
 * no texto, não casava o vocabulário de autenticação e o job queimava as 6
 * tentativas. 8 baixas foram APAGADAS assim e 3 anúncios seguiram no ar sem
 * saldo.
 */

vi.mock("@/app/lib/prisma", () => ({
  default: {
    $queryRaw: vi.fn(),
    stockSyncJob: {
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
    productListing: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock("@/app/marketplaces/usecases/sync.usercase", () => ({
  SyncUseCase: {
    syncProductStock: vi.fn(),
  },
}));

vi.mock("@/app/services/system-log.service", () => ({
  SystemLogService: {
    logError: vi.fn().mockResolvedValue(undefined),
  },
}));

import prisma from "@/app/lib/prisma";
import { SyncUseCase } from "@/app/marketplaces/usecases/sync.usercase";
import { StockSyncRetryService } from "@/app/marketplaces/services/stock-sync-retry.service";

async function falhaComMensagem(message: string, platform: string) {
  (prisma as any).$queryRaw.mockResolvedValue([
    {
      id: "job-1",
      productId: "prod-1",
      listingId: "lst-1",
      platform,
      targetStock: 0,
      attempts: 2,
      status: "PENDING",
    },
  ]);
  (prisma as any).productListing.findMany.mockResolvedValue([
    { id: "lst-1", externalListingId: "ext-lst-1" },
  ]);
  (SyncUseCase.syncProductStock as any).mockResolvedValue([
    {
      success: false,
      productId: "prod-1",
      externalListingId: "ext-lst-1",
      error: message,
    },
  ]);

  await StockSyncRetryService.runOnce();
}

describe("StockSyncRetryService — falha ao renovar token", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it.each([
    ["Shopee, pane da partner key", "Erro ao renovar token: partner key has expired", "SHOPEE"],
    ["Shopee, assinatura recusada", "Erro ao renovar token: Wrong sign", "SHOPEE"],
    ["Shopee, IP fora da whitelist", "Erro ao renovar token: Request Source IP (1.2.3.4) is undeclared.", "SHOPEE"],
  ])("%s → adia sem apagar e sem consumir tentativa", async (_rotulo, mensagem, platform) => {
    await falhaComMensagem(mensagem, platform);

    expect((prisma as any).stockSyncJob.deleteMany).not.toHaveBeenCalled();
    expect((prisma as any).stockSyncJob.update).not.toHaveBeenCalled();
    const call = (prisma as any).stockSyncJob.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: "job-1" });
    expect(call.data.attempts).toBeUndefined();
    expect(call.data.nextRunAt).toBeInstanceOf(Date);
    expect(call.data.lastError).toContain("auth_pendente");
  });

  it.each([
    ["loja desvinculada", "Erro ao renovar token: Partner and shop has no linked."],
    ["refresh_token vencido", "Erro ao renovar token: Your refresh_token expired."],
  ])(
    "%s (autorização morta) segue o caminho de antes: consome tentativa, não espera para sempre",
    async (_rotulo, mensagem) => {
      // Esperar para sempre ressincronizaria o produto inteiro a cada 30 min
      // numa loja que não volta sem nova autorização.
      await falhaComMensagem(mensagem, "SHOPEE");

      const call = (prisma as any).stockSyncJob.update.mock.calls[0][0];
      expect(call.data.attempts).toBe(3);
      expect((prisma as any).stockSyncJob.updateMany).not.toHaveBeenCalled();
    },
  );

  it("renovação recusada por token revogado continua terminal", async () => {
    await falhaComMensagem("Erro ao renovar token: invalid_token: token revoked", "SHOPEE");

    expect((prisma as any).stockSyncJob.deleteMany).toHaveBeenCalledTimes(1);
    expect((prisma as any).stockSyncJob.updateMany).not.toHaveBeenCalled();
  });

  it("controle: erro comum sem vocabulário de auth segue o backoff normal", async () => {
    await falhaComMensagem("Shopee: status is abnormal", "SHOPEE");

    const call = (prisma as any).stockSyncJob.update.mock.calls[0][0];
    expect(call.data.attempts).toBe(3);
    expect((prisma as any).stockSyncJob.updateMany).not.toHaveBeenCalled();
  });
});
