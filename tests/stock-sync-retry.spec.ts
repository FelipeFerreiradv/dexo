import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import { SystemLogService } from "@/app/services/system-log.service";
import { StockSyncRetryService } from "@/app/marketplaces/services/stock-sync-retry.service";

const makeJob = (overrides: Partial<any> = {}) => ({
  id: "job-1",
  productId: "prod-1",
  listingId: "lst-1",
  platform: "SHOPEE",
  targetStock: 5,
  attempts: 0,
  status: "PENDING",
  ...overrides,
});

describe("StockSyncRetryService.runOnce", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sem opt-in retorna antes de reservar qualquer job", async () => {
    const enabled = process.env.BACKGROUND_WORKERS_ENABLED;
    const disabled = process.env.BACKGROUND_WORKERS_DISABLED;
    delete process.env.BACKGROUND_WORKERS_ENABLED;
    delete process.env.BACKGROUND_WORKERS_DISABLED;
    try {
      await StockSyncRetryService.runOnce();
      expect((prisma as any).$queryRaw).not.toHaveBeenCalled();
      expect(SyncUseCase.syncProductStock).not.toHaveBeenCalled();
    } finally {
      if (enabled === undefined) delete process.env.BACKGROUND_WORKERS_ENABLED;
      else process.env.BACKGROUND_WORKERS_ENABLED = enabled;
      if (disabled === undefined) delete process.env.BACKGROUND_WORKERS_DISABLED;
      else process.env.BACKGROUND_WORKERS_DISABLED = disabled;
    }
  });

  it("deleta o job quando syncProductStock retorna success", async () => {
    (prisma as any).$queryRaw.mockResolvedValue([makeJob()]);
    (prisma as any).productListing.findMany.mockResolvedValue([
      { id: "lst-1", externalListingId: "ext-lst-1" },
    ]);
    (SyncUseCase.syncProductStock as any).mockResolvedValue([
      {
        success: true,
        productId: "prod-1",
        externalListingId: "ext-lst-1",
        platform: "SHOPEE",
      },
    ]);

    await StockSyncRetryService.runOnce();

    // Prod usa deleteMany (idempotente — não lança P2025 se outro tick já
    // removeu o job). Ver app/marketplaces/services/stock-sync-retry.service.ts:132.
    expect((prisma as any).stockSyncJob.deleteMany).toHaveBeenCalledWith({
      where: { id: "job-1" },
    });
    expect((prisma as any).stockSyncJob.update).not.toHaveBeenCalled();
  });

  it("incrementa attempts e aplica backoff em falha transitória", async () => {
    (prisma as any).$queryRaw.mockResolvedValue([
      makeJob({ attempts: 1 }),
    ]);
    (prisma as any).productListing.findMany.mockResolvedValue([
      { id: "lst-1", externalListingId: "ext-lst-1" },
    ]);
    (SyncUseCase.syncProductStock as any).mockResolvedValue([
      {
        success: false,
        productId: "prod-1",
        externalListingId: "ext-lst-1",
        platform: "SHOPEE",
        error: "timeout",
      },
    ]);

    await StockSyncRetryService.runOnce();

    const call = (prisma as any).stockSyncJob.update.mock.calls[0][0];
    expect(call.where).toEqual({ id: "job-1" });
    expect(call.data.attempts).toBe(2);
    expect(call.data.lastError).toBe("timeout");
    expect(call.data.nextRunAt).toBeInstanceOf(Date);
  });

  it("deleta o job e dispara logError em erro terminal (token revoked)", async () => {
    (prisma as any).$queryRaw.mockResolvedValue([makeJob()]);
    (prisma as any).productListing.findMany.mockResolvedValue([
      { id: "lst-1", externalListingId: "ext-lst-1" },
    ]);
    (SyncUseCase.syncProductStock as any).mockResolvedValue([
      {
        success: false,
        productId: "prod-1",
        externalListingId: "ext-lst-1",
        platform: "SHOPEE",
        error: "invalid_token: token revoked",
      },
    ]);

    await StockSyncRetryService.runOnce();

    // Prod usa deleteMany (idempotente — não lança P2025 se outro tick já
    // removeu o job). Ver app/marketplaces/services/stock-sync-retry.service.ts:132.
    expect((prisma as any).stockSyncJob.deleteMany).toHaveBeenCalledWith({
      where: { id: "job-1" },
    });
    expect(SystemLogService.logError).toHaveBeenCalledWith(
      "STOCK_SYNC_FAILED",
      expect.stringContaining("lst-1"),
      expect.objectContaining({
        resource: "ProductListing",
        resourceId: "lst-1",
      }),
    );
  });

  it("erro terminal da OLX (REFUSED_*) ⇒ markFailed, NÃO queima as 6 tentativas", async () => {
    (prisma as any).$queryRaw.mockResolvedValue([
      makeJob({ platform: "OLX" }),
    ]);
    (prisma as any).productListing.findMany.mockResolvedValue([
      { id: "lst-1", externalListingId: "ext-lst-1" },
    ]);
    (SyncUseCase.syncProductStock as any).mockResolvedValue([
      {
        success: false,
        productId: "prod-1",
        externalListingId: "ext-lst-1",
        platform: "OLX",
        error: "OLX recusou o import: REFUSED_SUSPECT_PRICE",
      },
    ]);

    await StockSyncRetryService.runOnce();

    // Terminal ⇒ apaga o job (deleteMany) + logError; NÃO incrementa attempts.
    expect((prisma as any).stockSyncJob.deleteMany).toHaveBeenCalledWith({
      where: { id: "job-1" },
    });
    expect((prisma as any).stockSyncJob.update).not.toHaveBeenCalled();
    expect(SystemLogService.logError).toHaveBeenCalled();
  });

  it("agrupa jobs por productId e chama syncProductStock uma vez por produto", async () => {
    (prisma as any).$queryRaw.mockResolvedValue([
      makeJob({ id: "job-a", listingId: "lst-a" }),
      makeJob({ id: "job-b", listingId: "lst-b" }),
      makeJob({ id: "job-c", productId: "prod-2", listingId: "lst-c" }),
    ]);
    (prisma as any).productListing.findMany.mockImplementation(
      ({ where }: any) =>
        Promise.resolve(
          where.id.in.map((id: string) => ({
            id,
            externalListingId: `ext-${id}`,
          })),
        ),
    );
    (SyncUseCase.syncProductStock as any).mockImplementation(
      (productId: string) =>
        Promise.resolve([
          {
            success: true,
            productId,
            externalListingId: `ext-lst-${productId === "prod-1" ? "a" : "c"}`,
            platform: "SHOPEE",
          },
          ...(productId === "prod-1"
            ? [
                {
                  success: true,
                  productId,
                  externalListingId: "ext-lst-b",
                  platform: "SHOPEE",
                },
              ]
            : []),
        ]),
    );

    await StockSyncRetryService.runOnce();

    expect(SyncUseCase.syncProductStock).toHaveBeenCalledTimes(2);
    expect(SyncUseCase.syncProductStock).toHaveBeenCalledWith("prod-1");
    expect(SyncUseCase.syncProductStock).toHaveBeenCalledWith("prod-2");
  });

  it("kill-switch (integration_disabled): reagenda sem apagar nem consumir tentativa", async () => {
    (prisma as any).$queryRaw.mockResolvedValue([makeJob()]);
    (prisma as any).productListing.findMany.mockResolvedValue([
      { id: "lst-1", externalListingId: "ext-lst-1" },
    ]);
    (SyncUseCase.syncProductStock as any).mockResolvedValue([
      {
        success: true,
        productId: "prod-1",
        externalListingId: "ext-lst-1",
        platform: "OLX",
        skipped: true,
        skipReason: "integration_disabled",
      },
    ]);

    await StockSyncRetryService.runOnce();

    // Não apaga o job (senão a baixa da peça vendida some e vira oversell ao
    // religar) nem consome tentativa: só empurra o nextRunAt via updateMany.
    expect((prisma as any).stockSyncJob.deleteMany).not.toHaveBeenCalled();
    expect((prisma as any).stockSyncJob.update).not.toHaveBeenCalled();
    const call = (prisma as any).stockSyncJob.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: "job-1" });
    expect(call.data.attempts).toBeUndefined();
    expect(call.data.nextRunAt).toBeInstanceOf(Date);
  });

  it("retorna cedo quando não há jobs pendentes", async () => {
    (prisma as any).$queryRaw.mockResolvedValue([]);

    await StockSyncRetryService.runOnce();

    expect(SyncUseCase.syncProductStock).not.toHaveBeenCalled();
    expect((prisma as any).stockSyncJob.update).not.toHaveBeenCalled();
  });

  it("a leitura da fila é um CLAIM atômico: SKIP LOCKED + lease, nunca findMany", async () => {
    (prisma as any).$queryRaw.mockResolvedValue([]);

    await StockSyncRetryService.runOnce();

    // Dois processos rodam esta fila (dexo-api e dexo-sync-orders) e a trava
    // em memória é por processo. Sem o claim no banco, o MESMO job podia ser
    // pego duas vezes e escrever em dobro no marketplace.
    const sql = (prisma as any).$queryRaw.mock.calls[0][0].join("?");
    expect(sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(sql).toContain("RETURNING");
    expect(sql).toContain("interval '90 seconds'");
    expect((prisma as any).stockSyncJob.findMany).not.toHaveBeenCalled();
  });

  /**
   * FALHA DE AUTENTICAÇÃO NÃO PODE APAGAR A BAIXA.
   *
   * Token expirado não diz que a baixa é impossível — diz que não pode ser
   * feita agora. Antes desta entrega, `unauthorized` estava no vocabulário
   * terminal e o job era APAGADO na primeira ocorrência; as outras formas
   * ("invalid access token", "401") queimavam as seis tentativas e terminavam
   * no mesmo lugar.
   *
   * Medido em produção em 15/09/2026, últimos 60 dias: 140 falhas de
   * autenticação em ~97 anúncios e ZERO jobs sobreviventes. Dos anúncios
   * atingidos, 38 seguem no ar vendendo peça sem saldo.
   */
  describe("falha de autenticação: adia, nunca apaga", () => {
    const falhaComMensagem = async (message: string, platform = "MERCADO_LIVRE") => {
      (prisma as any).$queryRaw.mockResolvedValue([
        makeJob({ platform }),
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
    };

    it.each([
      ["unauthorized", "Request failed: unauthorized"],
      ["invalid access token", "invalid access token"],
      ["401", "Erro ao atualizar estoque: status 401"],
      ["invalid_token", "invalid_token: expired"],
    ])(
      "%s não apaga o job — adia mantendo a tentativa",
      async (_rotulo, message) => {
        await falhaComMensagem(message);

        // O ponto inteiro desta entrega: a baixa continua na fila.
        expect((prisma as any).stockSyncJob.deleteMany).not.toHaveBeenCalled();
        // E não queima tentativa: `update` é o caminho do backoff comum.
        expect((prisma as any).stockSyncJob.update).not.toHaveBeenCalled();

        const call = (prisma as any).stockSyncJob.updateMany.mock.calls[0][0];
        expect(call.where).toEqual({ id: "job-1" });
        expect(call.data.attempts).toBeUndefined();
        expect(call.data.nextRunAt).toBeInstanceOf(Date);
        expect(call.data.lastError).toContain("auth_pendente");
      },
    );

    it("token revogado continua terminal: renovar não traz o acesso de volta", async () => {
      await falhaComMensagem("token revoked by user");

      expect((prisma as any).stockSyncJob.deleteMany).toHaveBeenCalledTimes(1);
      expect(SystemLogService.logError).toHaveBeenCalledWith(
        "STOCK_SYNC_FAILED",
        expect.any(String),
        expect.any(Object),
      );
    });

    it("mensagem com os DOIS vocabulários: revogação vence a espera", async () => {
      // O canal manda "invalid_token: token revoked" — carrega o vocabulário
      // de autenticação E o de revogação. Se a espera decidisse primeiro, uma
      // conta revogada de propósito ficaria com job imortal na fila.
      await falhaComMensagem("invalid_token: token revoked");

      expect((prisma as any).stockSyncJob.deleteMany).toHaveBeenCalledTimes(1);
      expect((prisma as any).stockSyncJob.updateMany).not.toHaveBeenCalled();
    });

    it("anúncio inexistente continua terminal: não há o que reprocessar", async () => {
      await falhaComMensagem("item_not_found");

      expect((prisma as any).stockSyncJob.deleteMany).toHaveBeenCalledTimes(1);
    });

    it("o kill-switch segue funcionando como antes, com a mensagem dele", async () => {
      (prisma as any).$queryRaw.mockResolvedValue([makeJob()]);
      (prisma as any).productListing.findMany.mockResolvedValue([
        { id: "lst-1", externalListingId: "ext-lst-1" },
      ]);
      (SyncUseCase.syncProductStock as any).mockResolvedValue([
        {
          success: true,
          productId: "prod-1",
          externalListingId: "ext-lst-1",
          platform: "OLX",
          skipped: true,
          skipReason: "integration_disabled",
        },
      ]);

      await StockSyncRetryService.runOnce();

      const call = (prisma as any).stockSyncJob.updateMany.mock.calls[0][0];
      expect(call.data.lastError).toContain("integration_disabled");
      expect(call.data.lastError).not.toContain("auth_pendente");
    });
  });
});
